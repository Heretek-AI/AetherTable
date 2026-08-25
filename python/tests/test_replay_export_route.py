"""Tests for GET /api/v1/sessions/{id}/replay/export?format=json|markdown.

The canonical session replay export (PILLAR-2/9 backlog gap): one authenticated
route that turns a session's hash-chained event ledger into either structured
JSON (verbatim events + metadata) or a human-readable markdown transcript
(turn-by-turn, actions resolved, outcomes, X-card rewinds marked).

Projection discipline (documented decision):

*   gm / admin  -> FULL export: verbatim engine events, exact HP/damage numbers.
*   player      -> PROJECTED export: auditable summaries only, no raw payloads,
                    so hidden-entity stat detail can never ride along.
*   spectator   -> 403 (no export at all; the live state route gives spectators
                    redacted views, but a portable artifact leaves the table).
*   any other    -> 403 (fails closed). Anonymous -> 401.

Honesty gates: an empty ledger exports honestly empty (never fabricated
rounds or placeholder rows), and a ledger over the size cap exports the first
chunk WITH an explicit truncation marker and omission counts rather than
silently clipping.

The engine is monkeypatched: these tests pin the GATEWAY contract, not the
Rust ledger itself.
"""

import json
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator import server as server_module
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


def _crafted_session(events=None) -> dict:
    """A ledger exercising every summary branch plus honesty edge cases."""
    if events is None:
        events = [
            _event(1, "SESSION_CREATED", {"name": "Doom of Vane"}),
            _event(2, "TURN_ADVANCED", {"round": 4, "condition_ticks": []}),
            _event(3, "ATTACK_RESOLVED", {
                "attacker_id": ATTACKER, "target_id": TARGET,
                "is_hit": True, "total_damage": 7,
                "target_hp_remaining": 13, "natural_roll": 14,
            }),
            _event(4, "HEALED", {"target_id": TARGET, "amount": 5, "hp_remaining": 18},
                   actor=TARGET),
            # Rewound by an X-card: exported, marked, never silently dropped.
            _event(5, "DAMAGE_APPLIED", {
                "target_id": ATTACKER, "amount": 6, "hp_remaining": 12,
            }, actor=TARGET, is_reverted=True),
        ]
    return {
        "session_id": SESSION_ID,
        "campaign_id": "cccccccc-0000-0000-0000-000000000003",
        "session_name": "Doom of Vane",
        "entities": {},
        "combat": {"in_combat": True, "round": 4, "turn_index": 1, "order": []},
        "ledger": {"current_sequence": len(events), "events": events},
    }


def _export(token=None, session_id: str = SESSION_ID, fmt: str | None = None):
    params: dict = {}
    if token is not None:
        params["token"] = token
    if fmt is not None:
        params["format"] = fmt
    return client.get(f"/api/v1/sessions/{session_id}/replay/export", params=params)


@pytest.fixture()
def patched_ledger(monkeypatch):
    captured: dict = {}

    async def fake_engine_request(method, path, payload=None, *, actor=None):
        captured.update({"method": method, "path": path, "payload": payload})
        captured["actor"] = actor
        return _crafted_session()

    monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
    return captured


class TestExportAuthMatrix:
    def test_anonymous_is_unauthorized(self, patched_ledger):
        assert _export(None).status_code == 401

    def test_invalid_token_is_unauthorized(self, patched_ledger):
        assert _export("not.a.valid.token").status_code == 401

    def test_spectator_is_forbidden(self, patched_ledger):
        assert _export(_token("watcher-1", "spectator")).status_code == 403

    def test_unrecognized_role_fails_closed(self, patched_ledger):
        assert _export(_token("x-1", "minion")).status_code == 403

    def test_player_is_authorized(self, patched_ledger):
        assert _export(_token("player-9", "player")).status_code == 200

    def test_gm_is_authorized(self, patched_ledger):
        assert _export(_token("gm-1", "gm")).status_code == 200

    def test_admin_is_authorized(self, patched_ledger):
        assert _export(_token("root-1", "admin")).status_code == 200

    def test_caller_identity_forwarded_to_engine(self, patched_ledger):
        assert _export(_token("gm-1", "gm")).status_code == 200
        assert patched_ledger["method"] == "GET"
        assert patched_ledger["path"] == f"/api/v1/sessions/{SESSION_ID}"
        assert patched_ledger["actor"] == {"user_id": "gm-1", "role": "gm"}

    def test_invalid_format_rejected(self, patched_ledger):
        assert _export(_token(), fmt="pdf").status_code == 422


class TestJsonFormat:
    def test_gm_json_shape_and_full_projection(self, patched_ledger):
        resp = _export(_token("gm-1", "gm"), fmt="json")
        assert resp.status_code == 200
        body = json.loads(resp.content)
        for key in ("session_id", "exported_at", "round", "role", "projection",
                    "event_count", "exported_event_count", "truncated", "events"):
            assert key in body, f"missing metadata key {key}"
        assert body["session_id"] == SESSION_ID
        assert body["round"] == 4
        assert body["role"] == "gm"
        assert body["projection"] == "full"
        assert body["event_count"] == 5
        assert body["exported_event_count"] == 5
        assert body["truncated"] is False

    def test_gm_events_are_verbatim_engine_payloads(self, patched_ledger):
        """FULL means verbatim: every field the engine attached stays."""
        body = json.loads(_export(_token("gm-1", "gm"), fmt="json").content)
        hit = next(e for e in body["events"] if e["sequence_id"] == 3)
        assert hit["event_type"] == "ATTACK_RESOLVED"
        assert hit["payload"]["total_damage"] == 7
        assert hit["state_hash"] == "hash-3"

    def test_player_json_is_projected_no_raw_payloads(self, patched_ledger):
        body = json.loads(_export(_token("player-9", "player"), fmt="json").content)
        assert body["projection"] == "projected"
        for event in body["events"]:
            assert set(event) == {
                "sequence_id", "actor_id", "event_type", "is_reverted", "summary",
            }
            assert "payload" not in event and "state_hash" not in event
        hit = next(e for e in body["events"] if e["sequence_id"] == 3)
        assert f"{ATTACKER} hit {TARGET} for 7 (HP→13)" == hit["summary"]

    def test_json_served_as_attachment_download(self, patched_ledger):
        resp = _export(_token(), fmt="json")
        assert resp.headers["content-type"].startswith("application/json")
        assert resp.headers["content-disposition"].startswith("attachment")
        assert f"replay-{SESSION_ID}-4.json" in resp.headers["content-disposition"]

    def test_default_format_is_json(self, patched_ledger):
        resp = _export(_token())
        assert resp.headers["content-type"].startswith("application/json")


class TestMarkdownFormat:
    def test_markdown_headers_and_disposition(self, patched_ledger):
        resp = _export(_token("gm-1", "gm"), fmt="markdown")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/markdown")
        assert resp.headers["content-disposition"].startswith("attachment")
        assert f"replay-{SESSION_ID}-4.md" in resp.headers["content-disposition"]
        text = resp.content.decode()
        assert text.startswith("# Session Replay")

    def test_markdown_metadata_block_is_honest(self, patched_ledger):
        text = _export(_token("gm-1", "gm"), fmt="markdown").content.decode()
        assert SESSION_ID in text
        assert "Round 4" in text or "round: 4" in text.lower()
        assert "5" in text  # event count appears somewhere

    def test_markdown_transcribes_turns_and_outcomes(self, patched_ledger):
        text = _export(_token("gm-1", "gm"), fmt="markdown").content.decode()
        # Turn-by-turn grouping from TURN_ADVANCED.
        assert "## Round 4" in text
        # Actions resolved with outcomes derived from real payload values.
        assert f"{ATTACKER} hit {TARGET} for 7 (HP→13)" in text
        assert f"{TARGET} healed for 5 (HP→18)" in text

    def test_markdown_marks_xcard_rewind(self, patched_ledger):
        text = _export(_token("gm-1", "gm"), fmt="markdown").content.decode()
        assert "X-CARD" in text.upper()
        # The rewound wound itself stays visible, flagged as reverted.
        assert f"{ATTACKER} took 6 damage (HP→12)" in text

    def test_markdown_never_leaks_raw_payload_json_for_players(self, patched_ledger):
        text = _export(_token("player-9", "player"), fmt="markdown").content.decode()
        assert "state_hash" not in text
        assert '"payload"' not in text


class TestEmptySessionHonesty:
    def test_empty_ledger_exports_honestly_empty_json(self, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            session = _crafted_session(events=[])
            session.pop("combat")  # no combat ever began
            return session

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = _export(_token("gm-1", "gm"), fmt="json")
        assert resp.status_code == 200
        body = json.loads(resp.content)
        assert body["events"] == []
        assert body["event_count"] == 0
        assert body["exported_event_count"] == 0
        assert body["round"] is None  # never invent round 1
        assert body["truncated"] is False

    def test_empty_ledger_markdown_admits_it(self, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            session = _crafted_session(events=[])
            session.pop("combat")
            return session

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        text = _export(_token("gm-1", "gm"), fmt="markdown").content.decode()
        assert "0" in text  # zero events stated, not papered over
        assert "no events" in text.lower()


class TestSizeCapHonesty:
    @pytest.fixture()
    def tiny_cap(self, monkeypatch):
        monkeypatch.setattr(server_module, "_MAX_REPLAY_EXPORT_EVENTS", 3)

    def _oversized_session(self) -> dict:
        events = [
            _event(i, "TURN_ADVANCED", {"round": i}) for i in range(1, 9)
        ]
        return _crafted_session(events=events)

    def test_json_truncated_with_marker_and_counts(self, patched_ledger, tiny_cap,
                                                   monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request",
            _engine_stub(self._oversized_session()),
        )
        body = json.loads(
            _export(_token("gm-1", "gm"), fmt="json").content
        )
        assert body["event_count"] == 8          # what the ledger holds
        assert body["exported_event_count"] == 3  # what this artifact carries
        assert body["truncated"] is True
        assert body["omitted_event_count"] == 5
        assert len(body["events"]) == 3
        assert body["truncation_marker"]  # human-readable note, non-empty

    def test_markdown_carries_visible_truncation_marker(self, patched_ledger,
                                                        tiny_cap, monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request",
            _engine_stub(self._oversized_session()),
        )
        text = _export(_token("gm-1", "gm"), fmt="markdown").content.decode()
        assert "TRUNCATED" in text.upper()
        assert "8" in text and "3" in text  # total vs exported both stated


class TestErrorMapping:
    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request", _engine_raise(
                engine_client.EngineUnavailableError("unreachable"))
        )
        resp = _export(_token("gm-1", "gm"))
        assert resp.status_code == 502

    def test_unknown_session_maps_engine_error_verbatim(self, monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request", _engine_raise(
                engine_client.EngineRejectedError(404, '{"error": "Session not found"}'))
        )
        resp = _export(_token("gm-1", "gm"))
        assert resp.status_code == 404
        assert resp.json()["detail"] == {"error": "Session not found"}


def _engine_stub(session: dict):
    async def fake(method, path, payload=None, *, actor=None):
        return session
    return fake


def _engine_raise(exc: Exception):
    async def fake(method, path, payload=None, *, actor=None):
        raise exc
    return fake
