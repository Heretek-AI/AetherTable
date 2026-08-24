import os
import json
import time
import asyncio
from typing import Dict, Any, AsyncGenerator, Optional, List
import httpx


LLM_LOG_PATH = os.environ.get("LLM_LOG_PATH", "logs/llm_calls.jsonl")

# Sentinel yielded as the FIRST item of a degraded (deterministic fallback)
# narrative stream: ("__DEGRADED__", reason). Gateways detect the tuple and
# must surface honest degradation metadata to clients instead of silently
# passing fabricated narration off as real LLM output.
DEGRADED_MARKER = "__DEGRADED__"


def extract_json_object(raw: Any) -> Optional[Dict[str, Any]]:
    """Defensively pull the first JSON object out of a model message.

    Tolerates markdown code fences, leading prose, and trailing chatter.
    Returns None when nothing parseable remains — callers must treat that as
    an upstream failure, never as a valid classification.
    """
    if not isinstance(raw, str):
        return None
    candidate = raw.strip()
    # Strip ```json ... ``` / ``` ... ``` fences if present.
    if candidate.startswith("```"):
        candidate = candidate.strip("`")
        if candidate.lower().startswith("json"):
            candidate = candidate[4:]
        candidate = candidate.strip()
    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else None
    except (ValueError, TypeError):
        pass
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(candidate[start:end + 1])
            return parsed if isinstance(parsed, dict) else None
        except (ValueError, TypeError):
            return None
    return None


def _response_is_sse(resp: Any) -> bool:
    """True when the upstream answered a NON-streaming request with SSE.

    Some OpenAI-compatible proxies (verified against llm.heretek.one/v1)
    respond `content-type: text/event-stream` even when `stream` was not
    requested — HTTP 200 with `data: {...}` frames wrapping the real JSON.
    Calling `.json()` on such a body always raises, so every non-streaming
    call site must check this BEFORE parsing.
    """
    try:
        content_type = resp.headers.get("content-type", "")
    except AttributeError:
        return False
    return "text/event-stream" in content_type.lower()


def _reassemble_sse_message(body_text: str) -> Dict[str, Any]:
    """Rebuild one assistant message from an SSE frame body.

    Handles both streaming-style frames (`choices[0].delta.content` fragments,
    tool_call argument chunks merged by index) and proxy quirks that carry a
    full `choices[0].message.content` per frame. `data: [DONE]`, comments,
    and unparseable frames are skipped; if nothing usable arrives the caller
    sees an empty content / no tool_calls — an honest failure, not a guess.
    """
    content_parts: List[str] = []
    tool_calls: Dict[int, Dict[str, Any]] = {}

    def _absorb_tool_call(slot: Dict[str, Any], fragment: Dict[str, Any]) -> None:
        if fragment.get("id"):
            slot["id"] = fragment["id"]
        if fragment.get("type"):
            slot["type"] = fragment["type"]
        fn = fragment.get("function") or {}
        name = fn.get("name")
        if name:
            current = slot["function"]["name"]
            # Providers either send the whole name once or stream it forward.
            slot["function"]["name"] = (
                name if name.startswith(current) else current + name
            )
        args = fn.get("arguments")
        if isinstance(args, str):
            slot["function"]["arguments"] += args

    def _absorb_fragment(fragment: Dict[str, Any]) -> None:
        if not isinstance(fragment, dict):
            return
        content = fragment.get("content")
        if isinstance(content, str):
            content_parts.append(content)
        for tc in fragment.get("tool_calls") or []:
            index = tc.get("index", 0) if isinstance(tc, dict) else 0
            slot = tool_calls.setdefault(
                index,
                {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
            )
            _absorb_tool_call(slot, tc if isinstance(tc, dict) else {})

    for line in (body_text or "").splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue  # comments ("event:", ": keepalive"), blanks, etc.
        payload = line[len("data:"):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            frame = json.loads(payload)
        except (ValueError, TypeError):
            continue  # malformed frame — skip honestly
        choices = frame.get("choices") if isinstance(frame, dict) else None
        for choice in choices or []:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict):
                _absorb_fragment(message)
            delta = choice.get("delta")
            if isinstance(delta, dict):
                _absorb_fragment(delta)

    reassembled: Dict[str, Any] = {
        "role": "assistant",
        "content": "".join(content_parts) or None,
    }
    if tool_calls:
        reassembled["tool_calls"] = [
            tool_calls[index] for index in sorted(tool_calls)
        ]
    return reassembled


def _log_llm_call(record: Dict[str, Any]) -> None:
    """Appends one structured JSONL record per upstream LLM interaction.

    Durable run artifact for the campaign harness; complements (does not
    replace) mitmproxy-level capture of the wire traffic.
    """
    try:
        directory = os.path.dirname(LLM_LOG_PATH)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(LLM_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, default=str) + "\n")
    except OSError:
        pass  # observability must never break inference


class ToolCallRound:
    """One assistant message that requests tool executions."""

    def __init__(self, tool_calls: List[Dict[str, Any]], content: Optional[str] = None):
        self.tool_calls = tool_calls
        self.content = content


class LLMConfig:
    """
    Resolves LLM Provider configuration from environment variables and organization secrets.
    Precedence:
    1. LLM_KEY, LLM_API, LLM_MODEL (GitHub Organization Secrets)
    2. OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / OLLAMA_BASE_URL
    3. Deterministic Mock Fallback (if no API keys are provided)
    """

    def __init__(self):
        self.api_key: Optional[str] = (
            os.getenv("LLM_KEY")
            or os.getenv("OPENAI_API_KEY")
            or os.getenv("ANTHROPIC_API_KEY")
            or os.getenv("GEMINI_API_KEY")
        )
        self.base_url: str = (
            os.getenv("LLM_API")
            or os.getenv("OLLAMA_BASE_URL")
            or "https://api.openai.com/v1"
        )
        self.model: str = (
            os.getenv("LLM_MODEL")
            or ("claude-3-5-sonnet" if os.getenv("ANTHROPIC_API_KEY") else "gpt-4o")
        )
        self.is_mock: bool = not bool(self.api_key)


class LLMStreamingGateway:
    """
    Unified LLM Streaming Gateway supporting token-by-token Server-Sent Events (SSE),
    Outlines/Pydantic logit constraints, and deterministic offline fallbacks.
    """

    def __init__(self, config: Optional[LLMConfig] = None):
        self.config = config or LLMConfig()

    async def complete_with_tools(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """One non-streaming chat-completions round with function/tool schemas.

        Returns the raw assistant message dict, which may contain either
        `content` or `tool_calls` per the OpenAI-compatible contract.
        Raises RuntimeError when only mock mode is configured — a tool-calling
        agent must NEVER silently fall back to canned strings. Also raises
        ``RuntimeError("LLM_UPSTREAM_EMPTY: ...")`` when the response carries
        neither assistant content nor tool_calls (e.g. an SSE body of only
        ``data: [DONE]``) — an empty turn is an upstream failure, not an
        answer.
        """
        if self.config.is_mock:
            raise RuntimeError(
                "NO_LLM_KEY: configure LLM_KEY/OPENAI_API_KEY for the tool-calling agent"
            )

        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.config.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "max_tokens": 600,
            "temperature": 0.4,
        }
        endpoint = f"{self.config.base_url.rstrip('/')}/chat/completions"
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(endpoint, headers=headers, json=payload)
                latency_ms = (time.perf_counter() - started) * 1000.0
                resp.raise_for_status()
                if _response_is_sse(resp):
                    # Proxy answered a non-streaming request with SSE frames.
                    transport = "sse_reassembled"
                    data = {"choices": [{"message": _reassemble_sse_message(resp.text)}]}
                else:
                    transport = "json"
                    data = resp.json()
            message = data["choices"][0]["message"]
            has_tool_calls = bool(message.get("tool_calls"))
            content = message.get("content")
            has_content = isinstance(content, str) and bool(content.strip())
            if not has_tool_calls and not has_content:
                # An empty turn (e.g. an SSE body carrying only `data: [DONE]`
                # reassembles to content=None / no tool_calls) is an UPSTREAM
                # FAILURE, not a valid "say nothing" answer. Raising here —
                # instead of returning a blank message — stops the tool agent
                # from reporting status COMPLETED with empty narration.
                raise RuntimeError(
                    f"LLM_UPSTREAM_EMPTY: {transport} response carried neither "
                    "assistant content nor tool_calls"
                )
            _log_llm_call({
                "ts": time.time(),
                "kind": "tools",
                "model": self.config.model,
                "base_url": self.config.base_url,
                "latency_ms": round(latency_ms, 1),
                "status": resp.status_code,
                "transport": transport,
                "tool_calls_emitted": len(message.get("tool_calls") or []),
                "prompt_chars": len(json.dumps(messages)),
                "response_chars": len(message.get("content") or ""),
                "response_excerpt": (message.get("content") or "")[:2000],
            })
            return message
        except Exception as exc:
            _log_llm_call({
                "ts": time.time(),
                "kind": "tools",
                "model": self.config.model,
                "base_url": self.config.base_url,
                "latency_ms": round((time.perf_counter() - started) * 1000.0, 1),
                "status": getattr(locals().get("resp"), "status_code", None),
                "error": f"{type(exc).__name__}: {exc}"[:2000],
                "prompt_chars": len(json.dumps(messages)),
            })
            raise

    async def complete_json(
        self,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 200,
        timeout_s: float = 8.0,
    ) -> Optional[Dict[str, Any]]:
        """One non-streaming chat-completions round that must answer with JSON.

        Returns the parsed JSON object, or None on ANY failure: mock mode (no
        key configured), HTTP error, transport exception, or unparseable body.
        Callers must treat None as "upstream unavailable" and fall back to
        their deterministic path — this helper never raises.
        """
        if self.config.is_mock:
            return None

        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.0,
            # Request JSON output only; endpoints that ignore response_format
            # are still handled by extract_json_object on the reply text.
            "response_format": {"type": "json_object"},
        }
        endpoint = f"{self.config.base_url.rstrip('/')}/chat/completions"
        started = time.perf_counter()
        resp_status = None
        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                resp = await client.post(endpoint, headers=headers, json=payload)
                resp_status = getattr(resp, "status_code", None)
                resp.raise_for_status()
                if _response_is_sse(resp):
                    # Proxy answered a non-streaming request with SSE frames;
                    # .json() would raise on that body. Reassemble instead.
                    transport = "sse_reassembled"
                    raw_content = _reassemble_sse_message(resp.text).get("content")
                else:
                    transport = "json"
                    raw_content = ((resp.json().get("choices") or [{}])[0].get("message") or {}).get("content")
            parsed = extract_json_object(raw_content)
            _log_llm_call({
                "ts": time.time(),
                "kind": "classify_json",
                "model": self.config.model,
                "base_url": self.config.base_url,
                "latency_ms": round((time.perf_counter() - started) * 1000.0, 1),
                "status": resp_status,
                "transport": transport,
                "prompt_chars": len(system_prompt) + len(user_prompt),
                "response_excerpt": (raw_content or "")[:2000],
                "parsed_ok": parsed is not None,
            })
            return parsed
        except Exception as exc:
            _log_llm_call({
                "ts": time.time(),
                "kind": "classify_json",
                "model": self.config.model,
                "base_url": self.config.base_url,
                "latency_ms": round((time.perf_counter() - started) * 1000.0, 1),
                "status": resp_status,
                "error": f"{type(exc).__name__}: {exc}"[:2000],
                "prompt_chars": len(system_prompt) + len(user_prompt),
            })
            return None

    async def stream_narrative(
        self,
        user_intent: str,
        engine_payload: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[Any, None]:
        """
        Yields SSE formatted chunks: `data: {"token": "...", "done": false}\n\n`

        Honest degradation contract: when the live upstream fails (or is not
        configured), the FIRST yielded item is the sentinel tuple
        `(DEGRADED_MARKER, reason)` so gateways can tag every subsequent
        fallback frame as degraded instead of passing canned narration off as
        genuine LLM output.
        """
        context = context or {}
        action_name = engine_payload.get("action_name", "Action")
        is_hit = engine_payload.get("is_hit", True)
        total_dmg = engine_payload.get("total_damage", 0)
        srd_tail = self._srd_tail(context)

        # If real API key is present, attempt live upstream OpenAI-compatible streaming
        degradation_reason: Optional[str] = None
        if self.config.is_mock:
            degradation_reason = "mock_mode: no LLM key configured"
        else:
            try:
                system_prompt = (
                    "You are the Encounter Dungeon Master for an authoritative Virtual Tabletop. "
                    "Narrate the resolved combat action vividly in 2-3 sentences based strictly on the deterministic engine facts. "
                    "Do not contradict the engine payload."
                )
                user_prompt = (
                    f"Player Action: {user_intent}\n"
                    f"Engine Resolution: {action_name}, Hit: {is_hit}, Damage: {total_dmg} HP.\n"
                    f"Context: {json.dumps(context)}"
                )

                headers = {
                    "Authorization": f"Bearer {self.config.api_key}",
                    "Content-Type": "application/json",
                }
                payload = {
                    "model": self.config.model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "stream": True,
                    "max_tokens": 150,
                    "temperature": 0.7,
                }

                endpoint = f"{self.config.base_url.rstrip('/')}/chat/completions"
                stream_started = time.perf_counter()
                streamed_chars = 0
                async with httpx.AsyncClient(timeout=10.0) as client:
                    async with client.stream("POST", endpoint, headers=headers, json=payload) as response:
                        if response.status_code == 200:
                            async for line in response.aiter_lines():
                                if line.startswith("data: ") and not line.startswith("data: [DONE]"):
                                    try:
                                        chunk_json = json.loads(line[6:])
                                        delta = chunk_json.get("choices", [{}])[0].get("delta", {})
                                        token = delta.get("content", "")
                                        streamed_chars += len(token)
                                        if token:
                                            yield f"data: {json.dumps({'token': token, 'done': False})}\n\n"
                                    except Exception:
                                        continue
                            yield f"data: {json.dumps({'token': '', 'done': True})}\n\n"
                            _log_llm_call({
                                "ts": time.time(),
                                "kind": "stream",
                                "model": self.config.model,
                                "base_url": self.config.base_url,
                                "latency_ms": round((time.perf_counter() - stream_started) * 1000.0, 1),
                                "status": 200,
                                "prompt_chars": len(user_prompt),
                                "response_chars": streamed_chars,
                            })
                            return
                        _log_llm_call({
                            "ts": time.time(),
                            "kind": "stream",
                            "model": self.config.model,
                            "base_url": self.config.base_url,
                            "status": response.status_code,
                            "error": "non-200 streaming response",
                        })
                        degradation_reason = (
                            f"llm_upstream_http_{response.status_code}"
                        )
            except Exception as e:
                # Structured record + smooth failover to deterministic mock.
                _log_llm_call({
                    "ts": time.time(),
                    "kind": "stream",
                    "model": self.config.model,
                    "base_url": self.config.base_url,
                    "status": None,
                    "error": f"{type(e).__name__}: {e}"[:2000],
                })
                degradation_reason = f"llm_upstream_error: {str(e)[:200]}"

        # Honest-degradation marker BEFORE any fallback token: the gateway can
        # detect this tuple and tag every downstream frame as degraded.
        if degradation_reason:
            yield (DEGRADED_MARKER, degradation_reason)

        # High-Speed Deterministic Generator Fallback
        for tok in self._canned_tokens(action_name, is_hit, total_dmg, srd_tail):
            await asyncio.sleep(0.02)  # Simulate 50 tokens/sec streaming
            yield f"data: {json.dumps({'token': tok, 'done': False})}\n\n"

        yield f"data: {json.dumps({'token': '', 'done': True})}\n\n"

    @staticmethod
    def _srd_tail(context: Dict[str, Any]) -> list:
        """SRD compendium facts woven into offline narration so even the
        deterministic generator stays faithful to the stat blocks."""
        srd_tail: list = []
        for fact in (context or {}).get("srd", [])[:2]:
            if fact.get("type") == "monster":
                actions = ", ".join(fact.get("action_names", [])[:2]) or "melee attacks"
                srd_tail.extend([
                    f"The {fact['name']} ", f"looms ", "over ", "the ",
                    f"battlefield ", f"(AC {fact.get('ac')}, HP {fact.get('hp')}) ",
                    f"trading ", f"{actions}! ",
                ])
            elif fact.get("type") == "spell":
                srd_tail.extend([
                    f"{fact['name']} ", f"is ", f"a {fact.get('level_name')} ",
                    f"{fact.get('school')} ", f"spell ", f"— ", f"{fact.get('snippet', '')} ",
                ])
        return srd_tail

    @staticmethod
    def _canned_tokens(
        action_name: str, is_hit: bool, total_dmg: Any, srd_tail: list
    ) -> list:
        if is_hit:
            tokens = [
                "With ", "unwavering ", "conviction, ", "the ", "strike ", f"of {action_name} ",
                "rips ", "through ", "the ", "gloom, ", "landing ", "with ", "shattering ",
                f"force ", "for ", f"{total_dmg} damage! ", "The ", "target ", "reels ", "backward ",
                "as ", "shards ", "of ", "armor ", "scatter ", "across ", "the ", "stone ", "flags."
            ]
        else:
            tokens = [
                "Lunging ", "forward ", "with ", f"{action_name}, ", "the ", "blow ", "scrapes ",
                "harmlessly ", "across ", "the ", "iron-banded ", "shield ", "with ", "a ",
                "shower ", "of ", "defiant ", "sparks!"
            ]

        if srd_tail:
            tokens = tokens + ["\n\n"] + srd_tail

        return tokens

    async def generate_narrative(
        self,
        user_intent: str,
        engine_payload: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Non-streaming narrative generation with an honest degradation flag.

        Returns `{"narrative": str, "degraded": bool, ...}`. When the upstream
        LLM is unavailable (mock mode, HTTP failure, or exception), the
        deterministic fallback text is returned with `"degraded": true` and a
        `"reason"` so callers never mistake canned narration for model output.
        """
        context = context or {}
        action_name = engine_payload.get("action_name", "Action")
        is_hit = engine_payload.get("is_hit", True)
        total_dmg = engine_payload.get("total_damage", 0)

        if not self.config.is_mock:
            started = time.perf_counter()
            try:
                payload = {
                    "model": self.config.model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are the Encounter Dungeon Master for an "
                                "authoritative Virtual Tabletop. Narrate the resolved "
                                "action in 2-3 sentences based strictly on the "
                                "deterministic engine facts. Do not contradict the "
                                "engine payload."
                            ),
                        },
                        {
                            "role": "user",
                            "content": (
                                f"Player Action: {user_intent}\n"
                                f"Engine Resolution: {action_name}, Hit: {is_hit}, "
                                f"Damage: {total_dmg} HP.\n"
                                f"Context: {json.dumps(context)}"
                            ),
                        },
                    ],
                    "max_tokens": 200,
                    "temperature": 0.7,
                }
                headers = {
                    "Authorization": f"Bearer {self.config.api_key}",
                    "Content-Type": "application/json",
                }
                endpoint = f"{self.config.base_url.rstrip('/')}/chat/completions"
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(endpoint, headers=headers, json=payload)
                    resp.raise_for_status()
                    if _response_is_sse(resp):
                        # Proxy answered a non-streaming request with SSE frames.
                        transport = "sse_reassembled"
                        narrative = _reassemble_sse_message(resp.text).get("content") or ""
                        if not narrative.strip():
                            # Malformed/empty stream: degrade honestly instead of
                            # returning degraded=False with blank narration.
                            raise ValueError("sse_reassembly_produced_no_content")
                    else:
                        transport = "json"
                        narrative = resp.json()["choices"][0]["message"]["content"] or ""
                _log_llm_call({
                    "ts": time.time(),
                    "kind": "generate_narrative",
                    "model": self.config.model,
                    "base_url": self.config.base_url,
                    "latency_ms": round((time.perf_counter() - started) * 1000.0, 1),
                    "status": resp.status_code,
                    "transport": transport,
                    "response_chars": len(narrative),
                })
                return {"narrative": narrative, "degraded": False}
            except Exception as e:
                _log_llm_call({
                    "ts": time.time(),
                    "kind": "generate_narrative",
                    "model": self.config.model,
                    "base_url": self.config.base_url,
                    "status": getattr(locals().get("resp"), "status_code", None),
                    "error": f"{type(e).__name__}: {e}"[:2000],
                })
                reason = f"llm_upstream_error: {str(e)[:200]}"
        else:
            reason = "mock_mode: no LLM key configured"

        narrative = "".join(
            self._canned_tokens(action_name, is_hit, total_dmg, self._srd_tail(context))
        )
        return {"narrative": narrative, "degraded": True, "reason": reason}
