"""Phase-2 honesty tests: the world inspector audits LIVE engine state.

Covers:
- client-supplied entity counts are ignored when a session id grounds the audit
- lethality fields come from the live entity, not the payload (a narrated
  death of a living target is rejected even if the payload claims death)
- ghost targets and unreachable engines refuse to audit
- the streaming path never emits unaudited sentences
"""

import json
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.server import _sign_token, app, _engine_ground_truth

client = TestClient(app)


def _gm_headers() -> dict:
    """Valid gm token: the orchestrator turn/stream routes are authenticated
    (any seat may narrate; gm here keeps the fixture role-agnostic)."""
    return {
        "Authorization": "Bearer "
        + _sign_token(
            {"user_id": "usr_audit_gm", "role": "gm", "exp": time.time() + 600}
        )
    }

ALIVE_TARGET = {
    "target_hp_remaining": 25,
    "target_is_conscious": True,
    "target_is_dead": False,
}


def _ground(entities=None, entity_count=None):
    """Engine-shaped live session snapshot: EntityState uses current_hp /
    is_conscious / is_dead; the gateway maps those to target_* audit keys."""
    goblin_state = {"name": "Goblin", "current_hp": 25, "is_conscious": True, "is_dead": False}
    ents = {"11111111-1111-1111-1111-111111111111": dict(goblin_state)}
    for extra in entities or []:
        ents[extra] = {"name": f"e{extra[:4]}", "current_hp": 10,
                       "is_conscious": True, "is_dead": False}
    return {"entity_count": entity_count or len(ents), "entities": ents}


def _request(**overrides):
    base = {
        "user_intent": "I strike the goblin",
        "turn_index": 1,
        "entity_id": "pc_thorin",
        "engine_execution_payload": {
            "action_name": "Greataxe",
            "is_hit": True,
            "total_damage": 5,
            # Client CLAIMS the target died...
            "target_hp_remaining": 0,
            "target_is_dead": True,
            "target_is_conscious": False,
        },
        "active_entity_count": 1,
        "previous_entity_count": 1,
    }
    base.update(overrides)
    return base


class TestGroundTruthOverride:
    def test_lying_counts_rejected_without_session(self):
        """Legacy path: inconsistent client counts are caught by Vector 2."""
        resp = client.post(
            "/api/v1/orchestrator/turn",
            headers=_gm_headers(),
            json=_request(active_entity_count=99, previous_entity_count=1),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "FALLBACK_COMMITTED"

    def test_payload_claimed_death_overridden_by_live_alive_target(self, monkeypatch):
        """The client says the target died; live state says 25 HP conscious.
        The auditor must trust the ENGINE and reject the death narrative."""
        async def fake_ground(session_id):
            return _ground(entity_count=3)
        monkeypatch.setattr("vtt_orchestrator.server._engine_ground_truth", fake_ground)

        resp = client.post(
            "/api/v1/orchestrator/turn",
            headers=_gm_headers(),
            json=_request(
                engine_session_id="22222222-2222-2222-2222-222222222222",
                target_entity_id="goblin",
            ),
        )
        assert resp.status_code == 200
        body = resp.json()

        # The grounded audit runs against the live payload (hp 25, alive), so
        # a truthful draft passes even though the client claimed a kill.
        assert body["status"] == "COMMITTED"
        report = body["audit_report"]
        assert report["passed"], report

    def test_narrated_death_of_living_target_is_rejected_when_grounded(self, monkeypatch):
        """With live state showing a healthy target, a lethal narrative must
        fail Vector 3 regardless of what the payload claimed."""
        async def fake_ground(session_id):
            return _ground(entity_count=3)
        monkeypatch.setattr("vtt_orchestrator.server._engine_ground_truth", fake_ground)

        class LethalDm:
            def generate_combat_draft(self, intent, payload, ctx):
                return "The greataxe connects and the goblin lies dead on the stone."

        monkeypatch.setattr(
            "vtt_orchestrator.server.dm_agent",
            LethalDm(),
        )

        resp = client.post(
            "/api/v1/orchestrator/turn",
            headers=_gm_headers(),
            json=_request(
                engine_session_id="22222222-2222-2222-2222-222222222222",
                target_entity_id="goblin",
            ),
        )
        body = resp.json()
        assert body["status"] == "FALLBACK_COMMITTED"
        history = body.get("audit_history") or []
        assert any(
            f["violation_type"] == "MATH_NARRATIVE_CONTRADICTION"
            for rpt in history
            for f in rpt.get("failures", [])
        ), "live-state lethality check must fire"

    def test_ghost_target_rejected(self, monkeypatch):
        async def fake_ground(session_id):
            return _ground(entity_count=3)
        monkeypatch.setattr("vtt_orchestrator.server._engine_ground_truth", fake_ground)

        resp = client.post(
            "/api/v1/orchestrator/turn",
            headers=_gm_headers(),
            json=_request(
                engine_session_id="22222222-2222-2222-2222-222222222222",
                target_entity_id="ancient-red-dragon",
            ),
        )
        assert resp.status_code == 409
        assert "GHOST_ENTITY" in resp.json()["detail"]

    def test_unreachable_engine_refuses_to_audit(self, monkeypatch):
        async def dead_ground(session_id):
            raise engine_client.EngineUnavailableError("connection refused")

        monkeypatch.setattr("vtt_orchestrator.server._engine_ground_truth", dead_ground)

        resp = client.post(
            "/api/v1/orchestrator/turn",
            headers=_gm_headers(),
            json=_request(engine_session_id="22222222-2222-2222-2222-222222222222"),
        )
        assert resp.status_code == 502
        assert "WORLD_INSPECTOR_UNAVAILABLE" in resp.json()["detail"]


class TestStreamingAuditBeforeYield:
    @staticmethod
    def _mock_stream(monkeypatch, tokens, grounded=False):
        if grounded:
            async def fake_ground(session_id):
                return _ground(entity_count=3)
            monkeypatch.setattr(
                "vtt_orchestrator.server._engine_ground_truth", fake_ground
            )

        def fake_stream(user_intent, engine_payload, context):
            async def gen():
                for tok in tokens:
                    yield "data: " + json.dumps({"token": tok, "done": False}) + "\n\n"
                yield "data: " + json.dumps({"token": "", "done": True}) + "\n\n"
            return gen()
        monkeypatch.setattr(
            "vtt_orchestrator.server.streaming_gateway.stream_narrative", fake_stream
        )

    def _collect(self, payload):
        frames = []
        with client.stream("POST", "/api/v1/narrative/stream", headers=_gm_headers(), json=payload) as resp:
            for line in resp.iter_lines():
                if line.startswith("data: "):
                    frames.append(json.loads(line[len("data: "):]))
        return frames

    def test_violating_sentence_never_emitted(self, monkeypatch):
        self._mock_stream(
            monkeypatch,
            [
                "The orc swings wildly. ",
                "The goblin drops dead where it stood. ",
                "The crowd erupts in cheers!",
            ],
            grounded=True,
        )
        frames = self._collect(
            _request(
                engine_session_id="22222222-2222-2222-2222-222222222222",
                target_entity_id="goblin",
            )
        )

        emitted_text = "".join(f.get("token", "") for f in frames)
        # The clean first sentence passes through...
        assert "swings wildly" in emitted_text
        # ...but the lethal sentence NEVER reaches the client (live state says
        # 25 HP), and neither does anything after the cut.
        assert "drops dead" not in emitted_text
        assert "crowd erupts" not in emitted_text
        assert frames[-1]["done"] is True

    def test_clean_stream_passes_through_intact(self, monkeypatch):
        self._mock_stream(
            monkeypatch,
            ["Steel rings out. ", "The goblin staggers but holds."],
        )
        frames = self._collect(_request())
        text = "".join(f.get("token", "") for f in frames)
        assert "staggers but holds" in text
        assert frames[-1]["done"] is True
