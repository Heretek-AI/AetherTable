"""LLM-assisted intent classification (backlog item 4.8).

Contract under test:
- `IntentClassificationRouter.classify_with_llm()` prompts the configured
  chat-completions endpoint (LLM_API/LLM_KEY/LLM_MODEL) and maps the reply onto
  the SAME IntentType values the deterministic keyword router emits.
- SAFETY_TRIGGER always wins: if EITHER the keyword matcher or the LLM labels
  the utterance a safety trigger, the final classification is
  SAFETY_INTERVENTION regardless of confidence.
- Any LLM failure (malformed JSON, unknown label, HTTP error, kill switch
  VTT_LLM_CLASSIFIER=0, or no API key configured) falls back to the keyword
  classifier silently, tagged `"classifier": "keyword_fallback"` with lowered
  confidence, never raising.
- No unit test touches the network: the HTTP layer (httpx.AsyncClient) is
  monkeypatched with an in-process fake.
"""

import json

import pytest

from vtt_orchestrator.routing import llm_client as llm_client_module
from vtt_orchestrator.routing.llm_client import LLMConfig, LLMStreamingGateway
from vtt_orchestrator.schemas.models import IntentType


# ---------------------------------------------------------------------------
# HTTP-layer fakes
# ---------------------------------------------------------------------------

def _chat_completion_payload(content: str) -> dict:
    """OpenAI-compatible chat-completions response body."""
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "model": "test-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
    }


class _FakeResponse:
    def __init__(self, body: dict, status_code: int = 200):
        self._body = body
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self) -> dict:
        return self._body


class _FakeAsyncClient:
    """httpx.AsyncClient stand-in serving canned completion bodies."""

    bodies: list = []
    calls: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None, **kwargs):
        type(self).calls.append({"url": url, "payload": json})
        body = type(self).bodies.pop(0)
        return _FakeResponse(body)


class _NeverCalledAsyncClient(_FakeAsyncClient):
    async def post(self, *args, **kwargs):
        raise AssertionError("network call attempted when it must not be")


def _install_upstream(monkeypatch, contents, client_cls=_FakeAsyncClient):
    """Point httpx.AsyncClient at a fake serving the given message contents."""
    bodies = [_chat_completion_payload(c) if isinstance(c, str) else c for c in contents]
    patched_cls = type("_PatchedClient", (client_cls,), {"bodies": bodies, "calls": []})
    monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", patched_cls)
    return patched_cls


def _live_config(monkeypatch):
    monkeypatch.setenv("LLM_API", "http://fake-llm.test/v1")
    monkeypatch.setenv("LLM_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "test-model")
    # Ensure no ambient provider key leaks in from the developer environment.
    for var in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OLLAMA_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


def _make_router(monkeypatch, live: bool = True) -> "tuple":
    if live:
        _live_config(monkeypatch)
    else:
        for var in ("LLM_API", "LLM_KEY", "LLM_MODEL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
            monkeypatch.delenv(var, raising=False)
        monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    gateway = LLMStreamingGateway(LLMConfig())
    from vtt_orchestrator.routing.intent_router import IntentClassificationRouter

    router = IntentClassificationRouter(llm_gateway=gateway)
    return router, gateway


NEUTRAL_IC = "I lean on the tavern rail and describe the storm outside in character"


class TestLLMPath:
    def test_valid_json_returns_llm_classified_intent(self, monkeypatch):
        router, _ = _make_router(monkeypatch)
        # Keywords alone would say IN_CHARACTER_DIALOGUE here; the LLM disagrees.
        _install_upstream(monkeypatch, ['{"intent_type": "MECHANICAL_INVOCATION", "confidence": 0.91}'])

        decision = asyncio_run(router.classify_with_llm(NEUTRAL_IC))

        assert decision["classifier"] == "llm"
        assert decision["classification"].intent_type is IntentType.MECHANICAL_INVOCATION
        assert decision["confidence"] == pytest.approx(0.91)
        assert decision["fallback_reason"] is None

    def test_json_wrapped_in_code_fence_is_parsed(self, monkeypatch):
        router, _ = _make_router(monkeypatch)
        fenced = 'Sure! ```json\n{"intent_type": "OUT_OF_CHARACTER", "confidence": 0.9}\n```'
        _install_upstream(monkeypatch, [fenced])

        decision = asyncio_run(router.classify_with_llm("brb pizza"))

        assert decision["classifier"] == "llm"
        assert decision["classification"].intent_type is IntentType.OUT_OF_CHARACTER


class TestFallbacks:
    def test_malformed_json_falls_back_to_keywords(self, monkeypatch):
        router, _ = _make_router(monkeypatch)
        _install_upstream(monkeypatch, ['this is not json {{{'])

        decision = asyncio_run(router.classify_with_llm("brb pizza"))
        keyword = router.classify_utterance("brb pizza")

        assert decision["classifier"] == "keyword_fallback"
        assert decision["classification"].intent_type is keyword.intent_type
        assert decision["fallback_reason"]
        # Degraded confidence must be strictly LOWER than the keyword result.
        assert decision["confidence"] < keyword.confidence

    def test_http_error_falls_back_to_keywords(self, monkeypatch):
        router, _ = _make_router(monkeypatch)

        class _FailingClient(_FakeAsyncClient):
            async def post(self, *args, **kwargs):
                raise RuntimeError("connection reset")

        monkeypatch.setattr(
            llm_client_module.httpx, "AsyncClient",
            type("_Fail", (_FailingClient,), {"bodies": [], "calls": []}),
        )

        decision = asyncio_run(router.classify_with_llm("brb pizza"))

        assert decision["classifier"] == "keyword_fallback"
        assert decision["fallback_reason"]

    def test_unknown_intent_label_falls_back_to_keywords(self, monkeypatch):
        router, _ = _make_router(monkeypatch)
        _install_upstream(monkeypatch, ['{"intent_type": "RULE_OF_COOL", "confidence": 0.99}'])

        decision = asyncio_run(router.classify_with_llm(NEUTRAL_IC))

        assert decision["classifier"] == "keyword_fallback"
        assert decision["classification"].intent_type is router.classify_utterance(NEUTRAL_IC).intent_type

    def test_no_key_environment_falls_back_silently(self, monkeypatch):
        router, gateway = _make_router(monkeypatch, live=False)
        assert gateway.config.is_mock is True

        decision = asyncio_run(router.classify_with_llm("brb pizza"))

        assert decision["classifier"] == "keyword_fallback"
        assert decision["fallback_reason"]
        assert decision["classification"].intent_type is IntentType.OUT_OF_CHARACTER

    def test_kill_switch_forces_keyword_only_without_network(self, monkeypatch):
        router, _ = _make_router(monkeypatch, live=False)
        monkeypatch.setenv("VTT_LLM_CLASSIFIER", "0")
        monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", _NeverCalledAsyncClient)

        decision = asyncio_run(router.classify_with_llm("brb pizza"))

        assert decision["classifier"] == "keyword_fallback"
        assert decision["fallback_reason"]
        assert decision["classification"].intent_type is IntentType.OUT_OF_CHARACTER

    def test_kill_switch_accepts_other_values_as_enabled(self, monkeypatch):
        router, _ = _make_router(monkeypatch, live=False)
        monkeypatch.setenv("VTT_LLM_CLASSIFIER", "true")
        # No key configured anyway -> still silent fallback, never a crash.
        decision = asyncio_run(router.classify_with_llm("brb pizza"))
        assert decision["classification"].intent_type is IntentType.OUT_OF_CHARACTER


class TestSafetyPrecedence:
    def test_keyword_safety_beats_llm_disagreement(self, monkeypatch):
        router, _ = _make_router(monkeypatch)
        # LLM confidently claims plain dialogue on an X-card utterance.
        _install_upstream(monkeypatch, ['{"intent_type": "IN_CHARACTER_DIALOGUE", "confidence": 0.99}'])

        decision = asyncio_run(router.classify_with_llm("we need an x-card please"))

        assert decision["classification"].intent_type is IntentType.SAFETY_INTERVENTION
        # Final label provenance is the deterministic path (safety precedence).
        assert decision["classifier"] == "keyword_fallback"
        assert "safety_precedence" in decision["fallback_reason"]

    def test_llm_safety_beats_keyword_disagreement(self, monkeypatch):
        router, _ = _make_router(monkeypatch)
        # No safety keyword fires; the LLM flags it as a safety trigger anyway.
        _install_upstream(monkeypatch, ['{"intent_type": "SAFETY_INTERVENTION", "confidence": 0.97}'])

        decision = asyncio_run(router.classify_with_llm(NEUTRAL_IC))

        assert decision["classification"].intent_type is IntentType.SAFETY_INTERVENTION
        assert decision["classifier"] == "llm"

    def test_llm_safety_beats_keyword_mechanical_match(self, monkeypatch):
        router, _ = _make_router(monkeypatch)
        _install_upstream(monkeypatch, ['{"intent_type": "SAFETY_INTERVENTION", "confidence": 0.8}'])

        decision = asyncio_run(router.classify_with_llm("I attack the training dummy"))

        assert decision["classification"].intent_type is IntentType.SAFETY_INTERVENTION

    def test_keyword_safety_short_circuits_without_llm_call(self, monkeypatch):
        router, _ = _make_router(monkeypatch)
        patched = _install_upstream(monkeypatch, [])

        decision = asyncio_run(router.classify_with_llm("lines and veils"))

        assert decision["classification"].intent_type is IntentType.SAFETY_INTERVENTION
        assert patched.calls == []


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)
