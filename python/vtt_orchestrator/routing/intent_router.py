import os
import time
import re
from typing import Dict, Any, Optional
from ..schemas.models import IntentType, IntentClassificationResult
from .llm_client import LLMConfig, LLMStreamingGateway


# Env kill-switch: VTT_LLM_CLASSIFIER=0 (or "false") forces keyword-only
# classification; any other value leaves LLM assist enabled.
LLM_CLASSIFIER_KILL_SWITCH_ENV = "VTT_LLM_CLASSIFIER"

# Confidence applied to keyword results when the LLM path FAILED (bad JSON,
# HTTP error). Purely informational degradation marking — never applied to a
# confident deterministic safety hit.
FALLBACK_CONFIDENCE_SCALE = 0.7

# Tolerated aliases for the canonical IntentType labels the LLM is asked to
# emit. RULE_OF_COOL has no enum counterpart and is deliberately NOT mapped:
# unknown labels fall back to keywords instead of being silently reshaped.
_INTENT_ALIASES = {
    "OOC_DIALOGUE": IntentType.OUT_OF_CHARACTER,
    "IC_DIALOGUE": IntentType.IN_CHARACTER_DIALOGUE,
    "SAFETY_TRIGGER": IntentType.SAFETY_INTERVENTION,
}


def _kill_switch_enabled() -> bool:
    return os.environ.get(LLM_CLASSIFIER_KILL_SWITCH_ENV, "1").strip().lower() not in {"0", "false", "off"}


class IntentClassificationRouter:
    """
    Sub-150ms Semantic Intent Classification Router with Fallback & Circuit Breaker.

    Deterministic keyword fast-path first; an OPTIONAL LLM-assisted classifier
    (`classify_with_llm`) consults the configured chat-completions endpoint and
    falls back to keywords on any failure. SAFETY_INTERVENTION always wins,
    whichever classifier produced it.
    """

    def __init__(
        self,
        confidence_threshold: float = 0.70,
        latency_budget_ms: float = 150.0,
        llm_gateway: Optional[LLMStreamingGateway] = None,
    ):
        self.confidence_threshold = confidence_threshold
        self.latency_budget_ms = latency_budget_ms
        self._llm_gateway = llm_gateway

        # Pattern definitions for ultra-low-latency deterministic fast path (<5ms)
        self.safety_patterns = [
            r"\b(x-card|xcard|safety pause|lines and veils|fast forward|rewind scene|content warning)\b"
        ]
        self.mechanical_patterns = [
            r"\b(cast|cast spell|attack|strike|shoot|slash|swing|hit|fireball|magic missile|misty step)\b",
            r"\b(move to|dash to|walk to|run to|jump|leap|climb to|fly to)\b",
            r"\b(make a|roll|check|saving throw|perception|athletics|acrobatics|stealth|initiative)\b",
            r"\b(drink potion|equip|unequip|reload|take cover|hide)\b",
        ]
        self.lore_patterns = [
            r"\b(is my|was my|know that|remember that|lore indicates|the legend of|the history of|father was|ruler of)\b",
            r"\b(secret tunnel|faction|baron|keep|temple|ancient tomb|bloodline)\b",
        ]
        self.ooc_patterns = [
            r"\b(pass the|pizza|soda|brb|be right back|afk|bathroom|what page|dice fell|discord|mic check)\b",
        ]

    @property
    def llm_gateway(self) -> LLMStreamingGateway:
        """Lazily constructed so env vars set after import are still honored."""
        if self._llm_gateway is None:
            self._llm_gateway = LLMStreamingGateway(LLMConfig())
        return self._llm_gateway

    def classify_utterance(self, utterance: str, speaker_id: str = "player_1") -> IntentClassificationResult:
        start_time = time.perf_counter()
        clean_text = utterance.strip().lower()

        # 1. Check Safety
        for pat in self.safety_patterns:
            if re.search(pat, clean_text, re.IGNORECASE):
                latency = (time.perf_counter() - start_time) * 1000.0
                return IntentClassificationResult(
                    intent_type=IntentType.SAFETY_INTERVENTION,
                    confidence=0.99,
                    raw_utterance=utterance,
                    extracted_parameters={"trigger_type": "X_CARD"},
                    speaker_id=speaker_id,
                    latency_ms=latency,
                )

        # 2. Check Mechanical Fast Path
        for pat in self.mechanical_patterns:
            match = re.search(pat, clean_text, re.IGNORECASE)
            if match:
                params = self._extract_mechanical_params(utterance)
                latency = (time.perf_counter() - start_time) * 1000.0
                return IntentClassificationResult(
                    intent_type=IntentType.MECHANICAL_INVOCATION,
                    confidence=0.92,
                    raw_utterance=utterance,
                    extracted_parameters=params,
                    speaker_id=speaker_id,
                    latency_ms=latency,
                )

        # 3. Check Lore Assertions
        for pat in self.lore_patterns:
            if re.search(pat, clean_text, re.IGNORECASE):
                params = self._extract_lore_params(utterance)
                latency = (time.perf_counter() - start_time) * 1000.0
                return IntentClassificationResult(
                    intent_type=IntentType.LORE_ASSERTION,
                    confidence=0.85,
                    raw_utterance=utterance,
                    extracted_parameters=params,
                    speaker_id=speaker_id,
                    latency_ms=latency,
                )

        # 4. Check OOC Table Talk
        for pat in self.ooc_patterns:
            if re.search(pat, clean_text, re.IGNORECASE):
                latency = (time.perf_counter() - start_time) * 1000.0
                return IntentClassificationResult(
                    intent_type=IntentType.OUT_OF_CHARACTER,
                    confidence=0.88,
                    raw_utterance=utterance,
                    extracted_parameters={},
                    speaker_id=speaker_id,
                    latency_ms=latency,
                )

        # 5. Default to In-Character Dialogue / Banter
        latency = (time.perf_counter() - start_time) * 1000.0
        return IntentClassificationResult(
            intent_type=IntentType.IN_CHARACTER_DIALOGUE,
            confidence=0.75,
            raw_utterance=utterance,
            extracted_parameters={"dialogue": utterance},
            speaker_id=speaker_id,
            latency_ms=latency,
        )

    async def classify_with_llm(
        self, utterance: str, speaker_id: str = "player_1"
    ) -> Dict[str, Any]:
        """LLM-assisted classification with deterministic fallback.

        Prompts the configured chat-completions endpoint (LLM_API / LLM_KEY /
        LLM_MODEL) to label the utterance with one IntentType value and a
        confidence, then merges that with the keyword classifier.

        Returns a small dict (IntentClassificationResult itself is a strict
        Pydantic model, so the provenance metadata lives OUTSIDE it):

            {
                "classification":  IntentClassificationResult,
                "intent_type":     IntentType,
                "confidence":      float in [0, 1],
                "classifier":      "llm" | "keyword_fallback",
                                   # provenance of the FINAL label:
                                   # "llm"             -> valid LLM JSON won
                                   # "keyword_fallback"-> deterministic path
                                   #    (kill switch, no key, invalid LLM
                                   #     output, or keyword safety hit)
                "fallback_reason": None | str,
            }

        SAFETY PRECEDENCE: if either the keyword matcher or the LLM labels the
        utterance SAFETY_INTERVENTION, the final classification is
        SAFETY_INTERVENTION regardless of confidence. A keyword safety hit
        short-circuits before any network call.

        This method never raises: every LLM-side failure degrades silently to
        keywords. On genuine LLM FAILURE (invalid/missing JSON, HTTP error) the
        keyword confidence is scaled down by FALLBACK_CONFIDENCE_SCALE so
        downstream consumers can see the answer is degraded.
        """
        start_time = time.perf_counter()

        def _finish(result: IntentClassificationResult, classifier: str, reason: Optional[str]) -> Dict[str, Any]:
            return {
                "classification": result,
                "intent_type": result.intent_type,
                "confidence": result.confidence,
                "classifier": classifier,
                "fallback_reason": reason,
            }

        # 1. Deterministic fast path — safety hits win outright, no network.
        keyword_result = self.classify_utterance(utterance, speaker_id)
        if keyword_result.intent_type is IntentType.SAFETY_INTERVENTION:
            return _finish(keyword_result, "keyword_fallback", "safety_precedence_keyword_match")

        # 2. Kill switch forces keyword-only.
        if not _kill_switch_enabled():
            return _finish(keyword_result, "keyword_fallback", f"{LLM_CLASSIFIER_KILL_SWITCH_ENV}=0")

        # 3. No key configured (mock mode): silent fallback.
        gateway = self.llm_gateway
        if gateway.config.is_mock:
            return _finish(keyword_result, "keyword_fallback", "mock_mode: no LLM key configured")

        # 4. Consult the LLM.
        system_prompt = (
            "You are an intent classifier for a virtual tabletop session. "
            "Classify the player's utterance into EXACTLY ONE of these labels:\n"
            + "\n".join(f"- {item.value}" for item in IntentType)
            + "\n\nRespond with ONLY a single JSON object of the form "
            '{"intent_type": "<LABEL>", "confidence": <float between 0 and 1>}. '
            "No prose, no markdown."
        )
        parsed = await gateway.complete_json(system_prompt, f"Utterance: {utterance}")
        if parsed is None:
            degraded = self._degrade_confidence(keyword_result)
            return _finish(degraded, "keyword_fallback", "llm_unavailable_or_unparseable")

        raw_label = parsed.get("intent_type")
        intent_type = self._normalize_label(raw_label)
        if intent_type is None:
            degraded = self._degrade_confidence(keyword_result)
            return _finish(degraded, "keyword_fallback", f"llm_unknown_intent_type: {str(raw_label)[:60]}")

        confidence = self._clamp_confidence(parsed.get("confidence"))

        # SAFETY RULE: the LLM flagging safety overrides ANY keyword outcome.
        if intent_type is IntentType.SAFETY_INTERVENTION:
            llm_safety = self._build_result(
                IntentType.SAFETY_INTERVENTION, confidence, utterance, speaker_id, start_time,
                {"source": "llm", "raw_label": str(raw_label), "trigger_type": "LLM_SAFETY"},
            )
            return _finish(llm_safety, "llm", None)

        # Valid non-safety LLM label wins over the keyword guess.
        llm_result = self._build_result(
            intent_type, confidence,
            utterance, speaker_id, start_time,
            {"source": "llm", "raw_label": str(raw_label)},
        )
        return _finish(llm_result, "llm", None)

    @staticmethod
    def _normalize_label(raw: Any) -> Optional[IntentType]:
        if not isinstance(raw, str):
            return None
        label = raw.strip().upper().replace("-", "_").replace(" ", "_")
        try:
            return IntentType(label)
        except ValueError:
            return _INTENT_ALIASES.get(label)

    @staticmethod
    def _clamp_confidence(raw: Any, default: float = 0.6) -> float:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return default
        return min(1.0, max(0.0, value))

    @staticmethod
    def _degrade_confidence(keyword_result: IntentClassificationResult) -> IntentClassificationResult:
        """Keyword answer re-issued at lowered confidence after LLM failure."""
        return keyword_result.model_copy(
            update={
                "confidence": round(keyword_result.confidence * FALLBACK_CONFIDENCE_SCALE, 4),
                "extracted_parameters": {
                    **keyword_result.extracted_parameters,
                    "classifier_fallback": True,
                },
            }
        )

    def _build_result(
        self,
        intent_type: IntentType,
        confidence: float,
        utterance: str,
        speaker_id: str,
        start_time: float,
        extra_params: Optional[Dict[str, Any]] = None,
    ) -> IntentClassificationResult:
        return IntentClassificationResult(
            intent_type=intent_type,
            confidence=min(1.0, max(0.0, float(confidence))),
            raw_utterance=utterance,
            extracted_parameters=extra_params or {},
            speaker_id=speaker_id,
            latency_ms=(time.perf_counter() - start_time) * 1000.0,
        )

    def _extract_mechanical_params(self, text: str) -> Dict[str, Any]:
        params = {}
        clean = text.lower()

        if "fireball" in clean:
            params["action"] = "cast_spell"
            params["spell_id"] = "spell_fireball"
        elif "magic missile" in clean:
            params["action"] = "cast_spell"
            params["spell_id"] = "spell_magic_missile"
        elif "misty step" in clean:
            params["action"] = "cast_spell"
            params["spell_id"] = "spell_misty_step"
        elif "attack" in clean or "strike" in clean or "slash" in clean:
            params["action"] = "attack"
            params["action_name"] = "Melee/Ranged Attack"
        elif "move" in clean or "dash" in clean or "walk" in clean:
            params["action"] = "move"

        return params

    def _extract_lore_params(self, text: str) -> Dict[str, Any]:
        return {
            "assertion_text": text,
            "epistemic_tier": "PROPOSED_FACT",
        }
