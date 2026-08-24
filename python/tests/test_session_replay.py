"""Tests for GET /api/v1/engine/session-replay — portable replay export.

Turns one engine session's event ledger into a human-auditable artifact:
every event is projected to {sequence_id, actor_id, event_type, is_reverted,
summary}, where the summary is derived ONLY from fields genuinely present in
the engine payload (missing fields render as omitted/null — never defaults,
never fabrication). Unknown event types pass through honestly with their raw
payload as the summary. Served as a browser download via Content-Disposition.

The engine is monkeypatched here: these tests pin the GATEWAY contract
(auth, projection honesty, error mapping), not the Rust ledger itself.
"""

import json
import time
import uuid
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.server import app, _sign_token

client = TestClient(app)

SESSION_ID = "11111111-2222-3333-4444-555555555555"

ATTACKER = "aaaaaaaa-0000-0000-0000-000000000001"
TARGET = "bbbbbbbb-0000-0000-0000-000000000002"


def _token(user_id: str = "player-9", role: str = "player") -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _event(seq: int, event_type: str, payload: dict, *, actor: str = ATTACKER,
           is_reverted: bool = False) -> dict:
    return {
        "sequence_id": seq,
        "actor_id": actor,
        "event_type": event_type,
        "payload": payload,
        "is_reverted": is_reverted,
        "state_hash": f"hash-{seq}",
        "timestamp": "2026-08-24T00:00:00Z",
    }


def _crafted_session() -> dict:
    """A ledger exercising every summary branch plus honesty edge cases."""
    return {
        "session_id": SESSION_ID,
        "campaign_id": "cccccccc-0000-0000-0000-000000000003",
        "entities": {},
        "combat": {"in_combat": True, "round": 4, "turn_index": 1, "order": []},
        "ledger": {
            "current_sequence": 8,
            "events": [
                _event(1, "SESSION_CREATED", {"name": "Doom of Vane"}),
                _event(2, "TURN_ADVANCED", {"round": 4, "condition_ticks": []}),
                # Hit with full payload -> "A hit B for N (HP→X)"
                _event(3, "ATTACK_RESOLVED", {
                    "attacker_id": ATTACKER, "target_id": TARGET,
                    "is_hit": True, "total_damage": 7,
                    "target_hp_remaining": 13, "natural_roll": 14,
                }),
                # Miss keeps its own verb and the zero damage the engine sent
                _event(4, "ATTACK_RESOLVED", {
                    "attacker_id": TARGET, "target_id": ATTACKER,
                    "is_hit": False, "total_damage": 0,
                    "target_hp_remaining": 30,
                }),
                # Partial payload: NO ids, NO hp -> none may be fabricated
                _event(5, "ATTACK_RESOLVED", {"is_hit": True, "total_damage": 5}),
                _event(6, "HEALED", {
                    "target_id": TARGET, "amount": 5, "hp_remaining": 18,
                }, actor=TARGET),
                # Rewound by an X-card: still exported, flagged, not dropped
                _event(7, "DAMAGE_APPLIED", {
                    "target_id": ATTACKER, "amount": 6, "hp_remaining": 12,
                }, actor=TARGET, is_reverted=True),
                # Unknown future event type: passes through with raw payload
                _event(8, "RITUAL_CHARGED", {"ritual": "dawnbreaker", "charges": 2}),
            ],
        },
    }


def _export(token: str | None = None, session_id: str = SESSION_ID):
    params = {"session_id": session_id}
    if token is not None:
        params["token"] = token
    return client.get("/api/v1/engine/session-replay", params=params)


@pytest.fixture()
def patched_ledger(monkeypatch):
    captured: dict = {}

    async def fake_engine_request(method, path, payload=None, *, actor=None):
        captured.update({"method": method, "path": path, "payload": payload})
        captured["actor"] = actor
        return _crafted_session()

    monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
    return captured


class TestReplayExport:
    def test_route_exists_and_exports_attachment(self, patched_ledger):
        resp = _export(_token())
        assert resp.status_code == 200
        disposition = resp.headers["content-disposition"]
        assert disposition.startswith("attachment")
        expected_name = f"replay-{SESSION_ID}-4.json"
        assert expected_name in disposition

    def test_top_level_shape(self, patched_ledger):
        resp = _export(_token())
        body = json.loads(resp.content)
        assert set(body) == {"session_id", "exported_at", "round", "event_count", "events"}
        assert body["session_id"] == SESSION_ID
        assert body["round"] == 4
        assert body["event_count"] == 8
        assert len(body["events"]) == 8
        # exported_at is a real ISO-8601 timestamp, not a placeholder
        datetime.fromisoformat(body["exported_at"])

    def test_events_projected_to_exact_schema(self, patched_ledger):
        body = json.loads(_export(_token()).content)
        for event in body["events"]:
            assert set(event) == {
                "sequence_id", "actor_id", "event_type", "is_reverted", "summary",
            }

    def test_attack_summary_derived_from_real_payload_values(self, patched_ledger):
        body = json.loads(_export(_token()).content)
        hit = next(e for e in body["events"] if e["sequence_id"] == 3)
        assert hit["summary"] == f"{ATTACKER} hit {TARGET} for 7 (HP→13)"
        miss = next(e for e in body["events"] if e["sequence_id"] == 4)
        assert miss["summary"] == f"{TARGET} missed {ATTACKER} for 0 (HP→30)"

    def test_partial_payload_never_fabricates_fields(self, patched_ledger):
        """Sequence 5 carries only is_hit+damage: no ids and no HP may be
        invented, and the absent HP segment is omitted rather than defaulted."""
        body = json.loads(_export(_token()).content)
        partial = next(e for e in body["events"] if e["sequence_id"] == 5)
        assert partial["summary"] == "for 5"
        assert ATTACKER not in partial["summary"]
        assert "HP" not in partial["summary"]

    def test_other_known_event_types_summarize(self, patched_ledger):
        body = json.loads(_export(_token()).content)
        by_seq = {e["sequence_id"]: e for e in body["events"]}
        assert by_seq[1]["summary"] == "session created: Doom of Vane"
        assert by_seq[2]["summary"] == "round advanced to 4"
        assert by_seq[6]["summary"] == f"{TARGET} healed for 5 (HP→18)"

    def test_reverted_event_flagged_not_dropped(self, patched_ledger):
        """An X-card rewind must stay visible to auditors, marked as reverted."""
        body = json.loads(_export(_token()).content)
        reverted = next(e for e in body["events"] if e["sequence_id"] == 7)
        assert reverted["is_reverted"] is True
        # Summary names the payload's target_id (ATTACKER took the wound),
        # not the event actor — values come from the payload only.
        assert reverted["summary"] == f"{ATTACKER} took 6 damage (HP→12)"
        active = next(e for e in body["events"] if e["sequence_id"] == 3)
        assert active["is_reverted"] is False

    def test_unknown_event_type_passes_through_with_raw_payload(self, patched_ledger):
        body = json.loads(_export(_token()).content)
        unknown = next(e for e in body["events"] if e["sequence_id"] == 8)
        assert unknown["event_type"] == "RITUAL_CHARGED"
        assert unknown["summary"] == json.dumps(
            {"ritual": "dawnbreaker", "charges": 2}, sort_keys=True
        )

    def test_engine_get_forwards_caller_identity(self, patched_ledger):
        resp = _export(_token("player-9", "player"))
        assert resp.status_code == 200
        assert patched_ledger["method"] == "GET"
        assert patched_ledger["path"] == f"/api/v1/sessions/{SESSION_ID}"
        assert patched_ledger["actor"] == {"user_id": "player-9", "role": "player"}

    def test_gm_identity_forwarded(self, patched_ledger):
        assert _export(_token("gm-1", "gm")).status_code == 200
        assert patched_ledger["actor"] == {"user_id": "gm-1", "role": "gm"}


class TestReplayAuth:
    def test_invalid_token_is_unauthorized(self, patched_ledger):
        assert _export("not.a.valid.token").status_code == 401

    def test_missing_token_is_rejected(self, patched_ledger):
        assert _export(None).status_code == 422


class TestReplayErrorMapping:
    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(
            engine_client, "ENGINE_API_URL", "http://localhost:59999"
        )
        resp = _export(_token())
        assert resp.status_code == 502
        assert "unreachable" in resp.json()["detail"].lower()

    def test_unknown_session_maps_engine_error_verbatim(self, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(404, '{"error": "Session not found"}')

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = _export(_token())
        assert resp.status_code == 404
        assert resp.json()["detail"] == {"error": "Session not found"}

    def test_session_without_combat_state_reports_null_round(self, monkeypatch):
        """Honesty: a session with no combat state exports round=null and a
        filename that admits it instead of inventing round 1."""

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            session = _crafted_session()
            session.pop("combat")
            return session

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = _export(_token())
        assert resp.status_code == 200
        body = json.loads(resp.content)
        assert body["round"] is None
        assert f"replay-{SESSION_ID}-unknown.json" in resp.headers["content-disposition"]
