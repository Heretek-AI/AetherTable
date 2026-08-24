"""SSE-reassembly for non-streaming chat-completions call sites.

Contract under test (bug found against https://llm.heretek.one/v1):
some OpenAI-compatible proxies respond `content-type: text/event-stream`
EVEN to non-streaming requests — HTTP 200 with `data: {...}` frames carrying
`choices[0].delta.content`. Previously every non-streaming call site did
`resp.json()` on that body, blew up, and silently degraded.

New contract:
- When the response content-type contains "text/event-stream", the client
  reassembles the assistant message from the SSE frames (delta.content,
  falling back to full message.content frames, terminating `data: [DONE]`)
  and feeds the reassembled text through the SAME JSON extraction as before.
- Normal JSON bodies behave byte-for-byte identically to before.
- The JSONL observability record honestly tags SSE responses with
  `"transport": "sse_reassembled"` (JSON bodies get `"transport": "json"`).
- Malformed / empty SSE fails HONESTLY: complete_json returns None and the
  record says so; generate_narrative reports degraded=true.
- No unit test touches the network: httpx.AsyncClient is monkeypatched.
"""

import asyncio
import json

import pytest

from vtt_orchestrator.routing import llm_client as llm_client_module
from vtt_orchestrator.routing.llm_client import LLMConfig, LLMStreamingGateway


# ---------------------------------------------------------------------------
# Wire fakes
# ---------------------------------------------------------------------------

def _delta_frame(content: str) -> str:
    return (
        "data: "
        + json.dumps(
            {"choices": [{"index": 0, "delta": {"role": "assistant", "content": content}}]}
        )
        + "\n\n"
    )


def _message_frame(content: str) -> str:
    """Some proxies send whole assistant messages per frame instead of deltas."""
    return (
        "data: "
        + json.dumps(
            {
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ]
            }
        )
        + "\n\n"
    )


def _sse_body(*frames: str) -> str:
    return "".join(frames) + "data: [DONE]\n\n"


class _FakeResponse:
    def __init__(self, text: str, content_type: str = "application/json", status_code: int = 200,
                 json_body: dict = None):
        self._text = text
        self._json_body = json_body
        self.status_code = status_code
        self.headers = {"content-type": content_type}

    @property
    def text(self) -> str:
        return self._text

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self) -> dict:
        if self._json_body is not None:
            return self._json_body
        # Faithful to real httpx behaviour against an SSE body: it explodes.
        raise ValueError(f"Expecting value: line 1 column 1 (char 0); body starts {_text_head(self._text)!r}")


def _text_head(text: str) -> str:
    return text[:60]


class _FakeAsyncClient:
    """httpx.AsyncClient stand-in serving canned raw bodies in order."""

    responses: list = []
    calls: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None, **kwargs):
        type(self).calls.append({"url": url, "payload": json})
        return type(self).responses.pop(0)


def _install_responses(monkeypatch, responses) -> type:
    patched = type(
        "_PatchedSSEClient",
        (_FakeAsyncClient,),
        {"responses": list(responses), "calls": []},
    )
    monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", patched)
    return patched


def _live_config(monkeypatch):
    monkeypatch.setenv("LLM_API", "http://fake-llm.test/v1")
    monkeypatch.setenv("LLM_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "test-model")
    for var in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OLLAMA_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


def _make_gateway(monkeypatch, log_path) -> LLMStreamingGateway:
    _live_config(monkeypatch)
    monkeypatch.setattr(llm_client_module, "LLM_LOG_PATH", log_path)
    return LLMStreamingGateway(LLMConfig())


def _read_records(path) -> list:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


CLASSIFICATION_JSON = '{"intent_type": "MECHANICAL_INVOCATION", "confidence": 0.91}'


# ---------------------------------------------------------------------------
# complete_json over SSE
# ---------------------------------------------------------------------------

class TestCompleteJsonSSE:
    def test_chunked_delta_frames_are_reassembled(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        # Split the JSON payload across three delta chunks.
        a, b, c = CLASSIFICATION_JSON[:20], CLASSIFICATION_JSON[20:45], CLASSIFICATION_JSON[45:]
        _install_responses(
            monkeypatch,
            [_FakeResponse(_sse_body(_delta_frame(a), _delta_frame(b), _delta_frame(c)),
                           content_type="text/event-stream")],
        )

        parsed = asyncio.run(gw.complete_json("sys", "user"))

        assert parsed == {"intent_type": "MECHANICAL_INVOCATION", "confidence": 0.91}

    def test_full_message_frames_fall_back_to_message_content(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        _install_responses(
            monkeypatch,
            [_FakeResponse(_sse_body(_message_frame(CLASSIFICATION_JSON)),
                           content_type="text/event-stream")],
        )

        parsed = asyncio.run(gw.complete_json("sys", "user"))

        assert parsed == {"intent_type": "MECHANICAL_INVOCATION", "confidence": 0.91}

    def test_sse_content_type_with_uppercase_is_detected(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        _install_responses(
            monkeypatch,
            [_FakeResponse(_sse_body(_delta_frame(CLASSIFICATION_JSON)),
                           content_type="Text/Event-Stream; charset=utf-8")],
        )

        parsed = asyncio.run(gw.complete_json("sys", "user"))

        assert parsed is not None

    def test_malformed_sse_returns_none_honestly(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        garbage = "data: not-json-at-all\n\nevent: error\n\n: keepalive comment\n\ndata: [DONE]\n\n"
        _install_responses(
            monkeypatch,
            [_FakeResponse(garbage, content_type="text/event-stream")],
        )

        assert asyncio.run(gw.complete_json("sys", "user")) is None
        records = _read_records(tmp_path / "llm.jsonl")
        assert records[-1]["parsed_ok"] is False
        assert records[-1]["transport"] == "sse_reassembled"

    def test_empty_stream_returns_none(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        _install_responses(
            monkeypatch,
            [_FakeResponse("data: [DONE]\n\n", content_type="text/event-stream")],
        )

        assert asyncio.run(gw.complete_json("sys", "user")) is None


# ---------------------------------------------------------------------------
# Observability contract
# ---------------------------------------------------------------------------

class TestTransportLogging:
    def test_jsonl_record_marks_sse_transport(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        _install_responses(
            monkeypatch,
            [_FakeResponse(_sse_body(_delta_frame(CLASSIFICATION_JSON)),
                           content_type="text/event-stream")],
        )

        asyncio.run(gw.complete_json("sys", "user"))

        record = _read_records(tmp_path / "llm.jsonl")[-1]
        assert record["kind"] == "classify_json"
        assert record["transport"] == "sse_reassembled"
        assert record["parsed_ok"] is True

    def test_normal_json_body_unmarked_and_unchanged(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        body = {
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": CLASSIFICATION_JSON},
                 "finish_reason": "stop"}
            ]
        }
        resp = _FakeResponse(json.dumps(body), content_type="application/json", json_body=body)
        # JSON path must go through .json(), never the SSE reassembler.
        _install_responses(monkeypatch, [resp])

        parsed = asyncio.run(gw.complete_json("sys", "user"))

        assert parsed == {"intent_type": "MECHANICAL_INVOCATION", "confidence": 0.91}
        record = _read_records(tmp_path / "llm.jsonl")[-1]
        assert record["transport"] != "sse_reassembled"


# ---------------------------------------------------------------------------
# Other non-streaming call sites
# ---------------------------------------------------------------------------

class TestCompleteWithToolsSSE:
    def test_tool_call_deltas_are_merged(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        tc1 = {
            "choices": [{"index": 0, "delta": {
                "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                "function": {"name": "roll_dice", "arguments": ""}}],
            }}]
        }
        tc2 = {
            "choices": [{"index": 0, "delta": {
                "tool_calls": [{"index": 0, "function": {"arguments": '{"dice": "d20"}'}}],
            }}]
        }
        body = _sse_body(
            _delta_frame('{"partial'),
            "data: " + json.dumps(tc1) + "\n\n",
            "data: " + json.dumps(tc2) + "\n\n",
        )
        _install_responses(monkeypatch, [_FakeResponse(body, content_type="text/event-stream")])

        message = asyncio.run(gw.complete_with_tools([{"role": "user", "content": "hi"}], tools=[]))

        assert message["content"] == '{"partial'
        assert len(message["tool_calls"]) == 1
        assert message["tool_calls"][0]["id"] == "call_1"
        assert message["tool_calls"][0]["function"]["name"] == "roll_dice"
        assert message["tool_calls"][0]["function"]["arguments"] == '{"dice": "d20"}'
        record = _read_records(tmp_path / "llm.jsonl")[-1]
        assert record["kind"] == "tools"
        assert record["transport"] == "sse_reassembled"

    def test_tools_over_normal_json_still_works(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        body = {
            "choices": [
                {"index": 0,
                 "message": {"role": "assistant", "content": None,
                             "tool_calls": [{"id": "call_x", "type": "function",
                                             "function": {"name": "f", "arguments": "{}"}}]},
                 "finish_reason": "tool_calls"}
            ]
        }
        _install_responses(
            monkeypatch,
            [_FakeResponse(json.dumps(body), content_type="application/json", json_body=body)],
        )

        message = asyncio.run(gw.complete_with_tools([], tools=[]))

        assert message["tool_calls"][0]["id"] == "call_x"
        record = _read_records(tmp_path / "llm.jsonl")[-1]
        assert record["transport"] != "sse_reassembled"


class TestGenerateNarrativeSSE:
    def test_narrative_reassembled_from_deltas_not_degraded(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        _install_responses(
            monkeypatch,
            [_FakeResponse(
                _sse_body(_delta_frame("The orc "), _delta_frame("swings "), _delta_frame("wildly.")),
                content_type="text/event-stream",
            )],
        )

        result = asyncio.run(
            gw.generate_narrative("I attack", {"action_name": "Attack", "is_hit": True, "total_damage": 5})
        )

        assert result["degraded"] is False
        assert result["narrative"] == "The orc swings wildly."

    def test_malformed_sse_degrades_honestly(self, monkeypatch, tmp_path):
        gw = _make_gateway(monkeypatch, tmp_path / "llm.jsonl")
        _install_responses(
            monkeypatch,
            [_FakeResponse("data: garbage-not-json\n\ndata: [DONE]\n\n",
                           content_type="text/event-stream")],
        )

        result = asyncio.run(
            gw.generate_narrative("I attack", {"action_name": "Attack", "is_hit": True, "total_damage": 5})
        )

        assert result["degraded"] is True
        assert result["reason"]
