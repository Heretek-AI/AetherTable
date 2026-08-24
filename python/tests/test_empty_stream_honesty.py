"""Empty upstream answers must never masquerade as a completed agent turn.

Contract under test (audit note): when an SSE body carries only
``data: [DONE]`` (or otherwise reassembles to content=None / no tool_calls),
``complete_with_tools`` previously returned that blank message and
``EngineToolAgent.run_turn`` reported ``{"status": "COMPLETED",
"narration": ""}`` — masking an upstream failure as a successful empty turn.

New contract:
- ``complete_with_tools`` raises ``RuntimeError("LLM_UPSTREAM_EMPTY: ...")``
  when the response carries neither assistant content nor tool_calls.
- ``EngineToolAgent.run_turn`` surfaces that as an honest non-COMPLETED
  status ("LLM_UPSTREAM_EMPTY") — never COMPLETED with empty narration.
- Well-formed responses (content or tool_calls) are unchanged.
- No unit test touches the network: httpx.AsyncClient is monkeypatched.
"""

import asyncio
import json

from vtt_orchestrator.agents.tool_agent import EngineToolAgent
from vtt_orchestrator.routing import llm_client as llm_client_module
from vtt_orchestrator.routing.llm_client import LLMConfig, LLMStreamingGateway


class _FakeResponse:
    def __init__(self, text: str, content_type: str = "application/json",
                 status_code: int = 200, json_body: dict = None):
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
        raise ValueError(f"Expecting value ... body starts {self._text[:40]!r}")


def _install_responses(monkeypatch, responses) -> type:
    class _PatchedClient:
        _responses = list(responses)

        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, headers=None, json=None, **kwargs):
            return type(self)._responses.pop(0)

    monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", _PatchedClient)
    return _PatchedClient


def _live_gateway(monkeypatch, tmp_path) -> LLMStreamingGateway:
    monkeypatch.setenv("LLM_API", "http://fake-llm.test/v1")
    monkeypatch.setenv("LLM_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "test-model")
    for var in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OLLAMA_BASE_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(llm_client_module, "LLM_LOG_PATH", tmp_path / "llm.jsonl")
    return LLMStreamingGateway(LLMConfig())


DONE_ONLY_SSE = "data: [DONE]\n\n"


class TestCompleteWithToolsEmptyStream:
    def test_done_only_sse_raises_not_blank_message(self, monkeypatch, tmp_path):
        gw = _live_gateway(monkeypatch, tmp_path)
        _install_responses(
            monkeypatch,
            [_FakeResponse(DONE_ONLY_SSE, content_type="text/event-stream")],
        )

        try:
            message = asyncio.run(
                gw.complete_with_tools([{"role": "user", "content": "hi"}], tools=[])
            )
        except RuntimeError as exc:
            assert "LLM_UPSTREAM_EMPTY" in str(exc)
        else:
            raise AssertionError(
                f"empty SSE stream must not yield a usable message: {message!r}"
            )

    def test_json_body_with_no_content_and_no_tools_also_raises(self, monkeypatch, tmp_path):
        gw = _live_gateway(monkeypatch, tmp_path)
        body = {"choices": [{"index": 0, "message": {"role": "assistant", "content": None},
                             "finish_reason": "stop"}]}
        _install_responses(
            monkeypatch,
            [_FakeResponse(json.dumps(body), content_type="application/json",
                           json_body=body)],
        )

        try:
            asyncio.run(gw.complete_with_tools([], tools=[]))
        except RuntimeError as exc:
            assert "LLM_UPSTREAM_EMPTY" in str(exc)
        else:
            raise AssertionError("blank JSON assistant turn must fail honestly")

    def test_whitespace_only_content_counts_as_empty(self, monkeypatch, tmp_path):
        gw = _live_gateway(monkeypatch, tmp_path)
        _install_responses(
            monkeypatch,
            [_FakeResponse(
                "data: " + json.dumps(
                    {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "   "}}]}
                ) + "\n\ndata: [DONE]\n\n",
                content_type="text/event-stream",
            )],
        )

        try:
            asyncio.run(gw.complete_with_tools([], tools=[]))
        except RuntimeError as exc:
            assert "LLM_UPSTREAM_EMPTY" in str(exc)
        else:
            raise AssertionError("whitespace-only narration must not read as success")

    def test_failure_is_logged_to_jsonl(self, monkeypatch, tmp_path):
        log = tmp_path / "llm.jsonl"
        monkeypatch.setattr(llm_client_module, "LLM_LOG_PATH", log)
        gw = _live_gateway(monkeypatch, tmp_path)
        _install_responses(
            monkeypatch,
            [_FakeResponse(DONE_ONLY_SSE, content_type="text/event-stream")],
        )

        try:
            asyncio.run(gw.complete_with_tools([], tools=[]))
        except RuntimeError:
            pass
        records = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
        assert records and "LLM_UPSTREAM_EMPTY" in records[-1].get("error", "")

    def test_real_content_still_returns_normally(self, monkeypatch, tmp_path):
        gw = _live_gateway(monkeypatch, tmp_path)
        _install_responses(
            monkeypatch,
            [_FakeResponse(
                "data: " + json.dumps(
                    {"choices": [{"index": 0, "delta": {"content": "The goblin falls."}}]}
                ) + "\n\ndata: [DONE]\n\n",
                content_type="text/event-stream",
            )],
        )

        message = asyncio.run(gw.complete_with_tools([], tools=[]))
        assert message["content"] == "The goblin falls."


class TestAgentTurnEmptyStreamHonesty:
    def test_run_turn_never_reports_completed_on_empty_stream(self, monkeypatch, tmp_path):
        gw = _live_gateway(monkeypatch, tmp_path)
        _install_responses(
            monkeypatch,
            [_FakeResponse(DONE_ONLY_SSE, content_type="text/event-stream")],
        )
        agent = EngineToolAgent(gw)

        result = asyncio.run(agent.run_turn("I attack the goblin", session_id="s1"))

        assert result.get("status") != "COMPLETED"
        assert result.get("status") == "LLM_UPSTREAM_EMPTY"
        assert "LLM_UPSTREAM_EMPTY" in result.get("detail", "")
        # The masking failure mode this regression pins down:
        assert not (result.get("status") == "COMPLETED" and result.get("narration") == "")

    def test_completed_turn_with_narration_unchanged(self, monkeypatch, tmp_path):
        gw = _live_gateway(monkeypatch, tmp_path)
        _install_responses(
            monkeypatch,
            [_FakeResponse(
                "data: " + json.dumps(
                    {"choices": [{"index": 0, "delta": {"content": "You strike true."}}]}
                ) + "\n\ndata: [DONE]\n\n",
                content_type="text/event-stream",
            )],
        )
        agent = EngineToolAgent(gw)

        result = asyncio.run(agent.run_turn("I attack", session_id="s1"))

        assert result["status"] == "COMPLETED"
        assert result["narration"] == "You strike true."

    def test_no_key_still_reports_unavailable(self, monkeypatch, tmp_path):
        monkeypatch.delenv("LLM_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.setattr(llm_client_module, "LLM_LOG_PATH", tmp_path / "llm.jsonl")
        agent = EngineToolAgent(LLMStreamingGateway(LLMConfig()))

        result = asyncio.run(agent.run_turn("I attack", session_id="s1"))

        assert result["status"] == "UNAVAILABLE"
