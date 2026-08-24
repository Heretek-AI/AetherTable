"""Honest-degradation tests for the SSE narrative path.

Contract under test:
- when the LLM upstream fails (mock mode, non-200, or mid-stream exception),
  the deterministic fallback generator must be DETECTABLE by the gateway and
  the client: a leading {"degraded": true, "reason": ...} frame plus
  "degraded": true on every fallback content frame.
- the healthy LLM path must carry NO degraded flags at all.
- the non-streaming generate_narrative fallback dict carries "degraded": true.
"""

import json

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import llm_client
from vtt_orchestrator.routing.llm_client import LLMConfig, LLMStreamingGateway
from vtt_orchestrator.server import app, streaming_gateway

client = TestClient(app)


def _request():
    return {
        "user_intent": "I strike the goblin",
        "turn_index": 1,
        "entity_id": "pc_thorin",
        "engine_execution_payload": {
            "action_name": "Greataxe",
            "is_hit": True,
            "total_damage": 5,
            "target_hp_remaining": 25,
        },
        "active_entity_count": 1,
        "previous_entity_count": 1,
    }


def _collect_frames(payload):
    frames = []
    with client.stream("POST", "/api/v1/narrative/stream", json=payload) as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            if line.startswith("data: "):
                frames.append(json.loads(line[len("data: "):]))
    return frames


class _ExplodingUpstream:
    """httpx.AsyncClient stand-in whose stream() call always raises."""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def stream(self, *args, **kwargs):
        raise RuntimeError("upstream connection reset")


class TestDegradedStreamPath:
    def test_upstream_failure_marks_frames_degraded_and_still_finishes(
        self, monkeypatch
    ):
        """The live upstream raises; every emitted frame must honestly say so."""
        monkeypatch.setattr(streaming_gateway.config, "is_mock", False)
        monkeypatch.setattr(streaming_gateway.config, "api_key", "test-key")
        monkeypatch.setattr(llm_client.httpx, "AsyncClient", _ExplodingUpstream)

        frames = _collect_frames(_request())

        # A leading frame announces degradation with a reason.
        assert frames[0].get("degraded") is True, frames[0]
        assert frames[0].get("reason"), "degradation reason must be present"

        # Fallback narration still flows, but each frame is tagged degraded.
        text = "".join(f.get("token", "") for f in frames)
        assert len(text) > 20, "fallback narration should still be delivered"
        tagged = [f for f in frames if f.get("token")]
        assert tagged, "expected content frames"
        assert all(f.get("degraded") is True for f in tagged)

        # The stream still terminates with a done frame.
        assert frames[-1]["done"] is True
        assert frames[-1].get("degraded") is True

    def test_mock_mode_degrades_with_reason_up_front(self, monkeypatch):
        """No API key at all: degradation is known before any token is sent."""
        monkeypatch.setattr(streaming_gateway.config, "is_mock", True)

        frames = _collect_frames(_request())

        assert frames[0].get("degraded") is True
        assert frames[0].get("reason")
        assert frames[-1]["done"] is True


class TestHealthyStreamPath:
    def test_clean_stream_has_no_degraded_flags(self, monkeypatch):
        async def fake_ground(session_id):
            return {"entity_count": 1, "entities": {}}

        monkeypatch.setattr("vtt_orchestrator.server._engine_ground_truth", fake_ground)

        def fake_stream(user_intent, engine_payload, context):
            async def gen():
                yield "data: " + json.dumps(
                    {"token": "The axe bites deep. ", "done": False}
                ) + "\n\n"
                yield "data: " + json.dumps({"token": "", "done": True}) + "\n\n"

            return gen()

        monkeypatch.setattr(
            "vtt_orchestrator.server.streaming_gateway.stream_narrative", fake_stream
        )

        frames = _collect_frames(_request())

        assert any(f["done"] for f in frames)
        assert not any("degraded" in f for f in frames), frames


class TestGatewayMarker:
    async def test_fallback_generator_yields_detectable_marker_first(self, monkeypatch):
        gateway = LLMStreamingGateway(LLMConfig())
        assert gateway.config.is_mock is True

        chunks = [
            chunk
            async for chunk in gateway.stream_narrative(
                "I swing",
                {"action_name": "Swing", "is_hit": True, "total_damage": 3},
            )
        ]

        assert chunks[0][0] == "__DEGRADED__"
        assert isinstance(chunks[0][1], str) and chunks[0][1]
        # Remaining items are SSE strings ending with a done frame.
        assert all(isinstance(c, str) for c in chunks[1:])
        assert json.loads(chunks[-1][len("data: "):-2])["done"] is True


class TestNonStreamingFallback:
    async def test_generate_narrative_fallback_includes_degraded_true(self, monkeypatch):
        gateway = LLMStreamingGateway(LLMConfig())
        assert gateway.config.is_mock is True

        result = await gateway.generate_narrative(
            "I swing",
            {"action_name": "Swing", "is_hit": True, "total_damage": 3},
        )

        assert result["degraded"] is True
        assert result.get("reason")
        assert result["narrative"]

    async def test_generate_narrative_success_is_not_degraded(self, monkeypatch):
        class FakeClient:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, *a, **k):
                class Resp:
                    status_code = 200

                    def raise_for_status(self):
                        pass

                    def json(self):
                        return {
                            "choices": [
                                {"message": {"content": "Live model narration."}}
                            ]
                        }

                return Resp()

        gateway = LLMStreamingGateway(LLMConfig())
        monkeypatch.setattr(gateway.config, "is_mock", False)
        monkeypatch.setattr(gateway.config, "api_key", "test-key")
        monkeypatch.setattr(llm_client.httpx, "AsyncClient", FakeClient)

        result = await gateway.generate_narrative(
            "I swing",
            {"action_name": "Swing", "is_hit": True, "total_damage": 3},
        )

        assert result["narrative"] == "Live model narration."
        assert result["degraded"] is False
