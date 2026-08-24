"""Wire-up tests: classify_with_llm is actually called from the turn endpoint.

Audit remediation: iteration 10 shipped
`IntentClassificationRouter.classify_with_llm()` (tested in test_llm_intent.py)
but no route ever called it. These tests pin the orchestrator turn wiring:

- when an LLM key is configured and VTT_LLM_CLASSIFIER is not "0", the turn
  endpoint classifies via classify_with_llm and surfaces provenance as a
  top-level non-breaking `"classifier": "llm" | "keyword_fallback"` field;
- with the kill switch set to "0" OR no key configured, classification takes
  the pure deterministic keyword path — zero network attempts (httpx is
  monkeypatched to explode if touched) and zero behavior drift for
  unconfigured environments;
- SAFETY_INTERVENTION still wins end-to-end: an x-card utterance never reaches
  the engine/audit turn cycle, whichever classifier saw it.

The stream endpoints never classified before this change and are deliberately
left alone.
"""

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import llm_client as llm_client_module
from vtt_orchestrator.routing.intent_router import IntentClassificationRouter
from vtt_orchestrator.routing.llm_client import LLMConfig, LLMStreamingGateway
from vtt_orchestrator.server import app, router as server_router

client = TestClient(app)

MECHANICAL_PAYLOAD = {
    "user_intent": "I strike the goblin",
    "turn_index": 1,
    "entity_id": "pc_thorin",
    "engine_execution_payload": {
        "action_name": "Greataxe Strike",
        "is_hit": True,
        "total_damage": 11,
        "target_hp_remaining": 15,
        "target_is_conscious": True,
        "target_is_dead": False,
    },
    "active_entity_count": 4,
    "previous_entity_count": 4,
    "ingress_count": 0,
    "egress_count": 0,
}


# ---------------------------------------------------------------------------
# Fakes / helpers
# ---------------------------------------------------------------------------

class _NeverNetworkAsyncClient:
    """httpx.AsyncClient stand-in that detonates on ANY network attempt."""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, *args, **kwargs):
        raise AssertionError("network call attempted when it must not be")

    def stream(self, *args, **kwargs):
        raise AssertionError("network call attempted when it must not be")


class _FakeResponse:
    """Minimal httpx.Response stand-in for complete_json's usage."""

    def __init__(self, body: dict):
        self._body = body
        self.status_code = 200

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._body


class _CannedAsyncClient(_NeverNetworkAsyncClient):
    """Serves one canned chat-completions body, then explodes."""

    bodies = []

    async def post(self, url, headers=None, json=None, **kwargs):
        return _FakeResponse(type(self).bodies.pop(0))


def _completion(content: str) -> dict:
    return {
        "id": "chatcmpl-wire",
        "object": "chat.completion",
        "model": "test-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
    }


def _live_llm_env(monkeypatch):
    monkeypatch.setenv("LLM_API", "http://fake-llm.test/v1")
    monkeypatch.setenv("LLM_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "test-model")
    for var in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)


def _no_llm_env(monkeypatch):
    for var in ("LLM_API", "LLM_KEY", "LLM_MODEL", "OLLAMA_BASE_URL",
                "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture(autouse=True)
def _fresh_router_and_cache(monkeypatch):
    """Each test gets a pristine gateway slot and availability cache."""
    monkeypatch.delenv("VTT_LLM_CLASSIFIER", raising=False)
    server_router._llm_gateway = None
    from vtt_orchestrator.server import reset_llm_classifier_cache

    reset_llm_classifier_cache()
    yield
    server_router._llm_gateway = None


def _wire_gateway(monkeypatch, content=None):
    """Install a gateway whose HTTP layer serves `content` (or explodes)."""
    if content is None:
        patched = type("_ExplodeClient", (_NeverNetworkAsyncClient,), {})
    else:
        patched = type(
            "_CannedClient",
            (_CannedAsyncClient,),
            {"bodies": [_completion(content)]},
        )
    monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", patched)
    server_router._llm_gateway = LLMStreamingGateway(LLMConfig())


def _explode_network(monkeypatch):
    monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", _NeverNetworkAsyncClient)


# ---------------------------------------------------------------------------
# LLM path
# ---------------------------------------------------------------------------

class TestLLMWiredTurn:
    def test_turn_response_carries_llm_classifier(self, monkeypatch):
        # Keywords alone would call this IN_CHARACTER_DIALOGUE; the LLM says OOC.
        _live_llm_env(monkeypatch)
        from vtt_orchestrator.server import reset_llm_classifier_cache
        reset_llm_classifier_cache()
        _wire_gateway(monkeypatch, '{"intent_type": "OUT_OF_CHARACTER", "confidence": 0.9}')

        resp = client.post("/api/v1/orchestrator/turn", json={**MECHANICAL_PAYLOAD, "user_intent": "brb pizza"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["classifier"] == "llm"
        assert body["fallback_reason"] is None
        # The LLM label gates: OUT_OF_CHARACTER must NOT run the engine cycle.
        assert body["status"] != "COMMITTED"
        assert body["classified_intent"] == "OUT_OF_CHARACTER"

    def test_mechanical_llm_label_still_runs_full_cycle(self, monkeypatch):
        _live_llm_env(monkeypatch)
        from vtt_orchestrator.server import reset_llm_classifier_cache
        reset_llm_classifier_cache()
        _wire_gateway(monkeypatch, '{"intent_type": "MECHANICAL_INVOCATION", "confidence": 0.93}')

        resp = client.post("/api/v1/orchestrator/turn", json=MECHANICAL_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["classifier"] == "llm"
        assert body["status"] == "COMMITTED"


# ---------------------------------------------------------------------------
# Keyword fallback paths — no network, ever
# ---------------------------------------------------------------------------

class TestKeywordFallbackWiring:
    def test_no_key_configured_is_pure_keyword_zero_change(self, monkeypatch):
        _no_llm_env(monkeypatch)
        _explode_network(monkeypatch)

        resp = client.post("/api/v1/orchestrator/turn", json=MECHANICAL_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["classifier"] == "keyword_fallback"
        assert body["status"] == "COMMITTED"  # baseline behavior preserved
        assert body["fallback_reason"] is not None

    def test_kill_switch_forces_keyword_and_blocks_network(self, monkeypatch):
        _live_llm_env(monkeypatch)
        monkeypatch.setenv("VTT_LLM_CLASSIFIER", "0")
        from vtt_orchestrator.server import reset_llm_classifier_cache
        reset_llm_classifier_cache()
        _explode_network(monkeypatch)

        resp = client.post("/api/v1/orchestrator/turn", json=MECHANICAL_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["classifier"] == "keyword_fallback"
        assert body["status"] == "COMMITTED"

    def test_kill_switch_false_spelling_also_blocks(self, monkeypatch):
        _live_llm_env(monkeypatch)
        monkeypatch.setenv("VTT_LLM_CLASSIFIER", "false")
        from vtt_orchestrator.server import reset_llm_classifier_cache
        reset_llm_classifier_cache()
        _explode_network(monkeypatch)

        resp = client.post("/api/v1/orchestrator/turn", json=MECHANICAL_PAYLOAD)

        assert resp.status_code == 200
        assert resp.json()["classifier"] == "keyword_fallback"


# ---------------------------------------------------------------------------
# Safety precedence, end-to-end through the endpoint
# ---------------------------------------------------------------------------

class TestSafetyWinsEndToEnd:
    @pytest.mark.parametrize("kill_switch", [None, "0"])
    def test_xcard_utterance_never_reaches_engine_cycle(self, monkeypatch, kill_switch):
        _live_llm_env(monkeypatch)
        if kill_switch is not None:
            monkeypatch.setenv("VTT_LLM_CLASSIFIER", kill_switch)
        from vtt_orchestrator.server import reset_llm_classifier_cache
        reset_llm_classifier_cache()
        _explode_network(monkeypatch)

        resp = client.post(
            "/api/v1/orchestrator/turn",
            json={**MECHANICAL_PAYLOAD, "user_intent": "we need an x-card please"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["classified_intent"] == "SAFETY_INTERVENTION"
        assert body["status"] == "SAFETY_INTERVENTION"
        assert body["classifier"] == "keyword_fallback"

    def test_safety_wins_even_when_llm_path_enabled(self, monkeypatch):
        # Safety keyword hit short-circuits BEFORE the network inside
        # classify_with_llm; the canned upstream would have said MECHANICAL.
        _live_llm_env(monkeypatch)
        from vtt_orchestrator.server import reset_llm_classifier_cache
        reset_llm_classifier_cache()
        _wire_gateway(monkeypatch, '{"intent_type": "MECHANICAL_INVOCATION", "confidence": 0.99}')

        resp = client.post(
            "/api/v1/orchestrator/turn",
            json={**MECHANICAL_PAYLOAD, "user_intent": "lines and veils check"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["classified_intent"] == "SAFETY_INTERVENTION"
        assert body["status"] == "SAFETY_INTERVENTION"
