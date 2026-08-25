"""Tests for the PILLAR-3 death-save audit extension.

The audit is a python-side aggregator that walks a session's exported
ledger events and reports, per token, WHEN and HOW a creature reached 0 HP
and what followed: death-save rolls, immediate instant-death, mid-recovery
'in_progress' episodes. It is offered as an opt-in `include=death_audit`
flag on the existing replay-export route so callers who don't want it skip
the work.

The aggregator derives EVERY claim from fields genuinely present in the
engine's event payloads — honest emptiness is reported when damage events
that would trigger the audit are absent (the export is a projection, not
the live engine state).
"""

import json
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator import server as server_module
from vtt_orchestrator.death_audit import build_death_audit
from vtt_orchestrator.server import app, _sign_token

client = TestClient(app)

SESSION_ID = "11111111-2222-3333-4444-555555555555"
ATTACKER = "aaaaaaaa-0000-0000-0000-000000000001"
TARGET = "bbbbbbbb-0000-0000-0000-000000000002"


# WIRE-SHAPE CONTRACT (audit A4/F1 regression guard): fixtures here MUST
# mirror what the Rust engine actually emits, not what is convenient for
# python. Two rules, both verified against the engine source:
#
#   1. ``actor_id`` is a TOP-LEVEL GameEvent field
#      (crates/vtt-core/src/event_log.rs::GameEvent) set by
#      EventSourcingLedger::append_event — it is NEVER a payload key.
#   2. DEATH_SAVE_RESOLVED payloads carry EXACTLY these keys (copied
#      verbatim from crates/vtt-server/src/server.rs, the death-save route):
#      outcome, natural_roll, successes, failures, is_stabilized, is_dead.
#
# Any fixture that stuffs identity or unknown keys into a payload encodes a
# fictional wire shape and will green-light an aggregator the engine breaks.


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


def _session(events: list) -> dict:
    return {
        "session_id": SESSION_ID,
        "campaign_id": "cccccccc-0000-0000-0000-000000000003",
        "session_name": "Test",
        "entities": {},
        "combat": {"in_combat": True, "round": 1, "turn_index": 0, "order": []},
        "ledger": {"current_sequence": len(events), "events": events},
    }


def _zero_events() -> list:
    return [
        _event(1, "SESSION_CREATED", {"name": "Quiet night"}),
        _event(2, "TURN_ADVANCED", {"round": 1, "condition_ticks": []}),
    ]


def _stabilized_events() -> list:
    """Target dropped to 0 HP by an attack, then 3 successful death saves."""
    return [
        _event(1, "SESSION_CREATED", {"name": "Doom of Vane"}),
        _event(2, "TURN_ADVANCED", {"round": 1}),
        # The fatal blow: target_hp_remaining lands exactly at 0.
        _event(3, "ATTACK_RESOLVED", {
            "attacker_id": ATTACKER, "target_id": TARGET,
            "is_hit": True, "is_critical_hit": False,
            "natural_roll": 17, "total_damage": 12,
            "target_hp_remaining": 0,
            "target_is_conscious": False, "target_is_dead": False,
        }),
        _event(4, "DEATH_SAVE_RESOLVED",
               _death_save_payload(15, "PENDING", successes=1), actor=TARGET),
        _event(5, "DEATH_SAVE_RESOLVED",
               _death_save_payload(12, "PENDING", successes=2), actor=TARGET),
        _event(6, "DEATH_SAVE_RESOLVED",
               _death_save_payload(18, "STABILIZED", successes=3), actor=TARGET),
    ]


def _died_events() -> list:
    """Target dropped to 0 HP and three failures killed them."""
    return [
        _event(1, "SESSION_CREATED", {"name": "Last Breath"}),
        _event(2, "TURN_ADVANCED", {"round": 1}),
        _event(3, "ATTACK_RESOLVED", {
            "attacker_id": ATTACKER, "target_id": TARGET,
            "is_hit": True, "is_critical_hit": False,
            "natural_roll": 18, "total_damage": 9,
            "target_hp_remaining": 0,
            "target_is_conscious": False, "target_is_dead": False,
        }),
        _event(4, "DEATH_SAVE_RESOLVED",
               _death_save_payload(7, "PENDING", failures=1), actor=TARGET),
        _event(5, "DEATH_SAVE_RESOLVED",
               _death_save_payload(1, "DEAD", failures=3), actor=TARGET),
    ]


def _death_save_payload(natural_roll: int, outcome: str, *, successes: int = 0,
                        failures: int = 0) -> dict:
    """Verbatim DEATH_SAVE_RESOLVED payload keys from the engine's death-save
    route (crates/vtt-server/src/server.rs). Nothing else is ever in there —
    notably NOT actor_id, which is a top-level GameEvent field."""
    return {
        "outcome": outcome,
        "natural_roll": natural_roll,
        "successes": successes,
        "failures": failures,
        "is_stabilized": outcome == "STABILIZED",
        "is_dead": outcome == "DEAD",
    }


def _real_engine_shape_events() -> list:
    """Fixture derived directly from engine emission.

    The target is dropped to 0 HP by an ATTACK_RESOLVED event (top-level
    actor_id = attacker, payload.target_id = target), then two DEATH_SAVE_
    RESOLVED events fire with top-level actor_id = TARGET and the exact
    six-key payload the Rust server serializes. This is the shape
    EventSourcingLedger::append_event actually produces; if this fixture
    ever stops resolving, the audit has drifted from real emission again.
    """
    return [
        _event(1, "SESSION_CREATED", {"name": "Real Wire"}),
        _event(3, "ATTACK_RESOLVED", {
            "attacker_id": ATTACKER, "target_id": TARGET,
            "is_hit": True, "is_critical_hit": False,
            "natural_roll": 17, "total_damage": 12,
            "target_hp_remaining": 0,
            "target_is_conscious": False, "target_is_dead": False,
        }),
        # Top-level actor_id is the dying token; payload carries no identity.
        _event(4, "DEATH_SAVE_RESOLVED",
               _death_save_payload(15, "PENDING", successes=1), actor=TARGET),
        _event(6, "DEATH_SAVE_RESOLVED",
               _death_save_payload(18, "STABILIZED", successes=3), actor=TARGET),
    ]


def _in_progress_events() -> list:
    """Two successes so far, still alive and dying."""
    return [
        _event(1, "SESSION_CREATED", {"name": "Slim Hope"}),
        _event(2, "TURN_ADVANCED", {"round": 1}),
        _event(3, "DAMAGE_APPLIED", {
            "target_id": TARGET, "amount": 10,
            "hp_remaining": 0, "instant_death": False,
        }, actor=ATTACKER),
        _event(4, "DEATH_SAVE_RESOLVED",
               _death_save_payload(14, "PENDING", successes=1), actor=TARGET),
        _event(5, "DEATH_SAVE_RESOLVED",
               _death_save_payload(16, "PENDING", successes=2), actor=TARGET),
    ]


def _instant_death_events() -> list:
    """Monstrous damage (>max_hp excess) → instant_death flag, no saves."""
    return [
        _event(1, "SESSION_CREATED", {"name": "Finality"}),
        _event(2, "TURN_ADVANCED", {"round": 1}),
        _event(3, "DAMAGE_APPLIED", {
            "target_id": TARGET, "amount": 80,
            "hp_remaining": 0, "instant_death": True,
        }, actor=ATTACKER),
    ]


# --- Pure-function aggregator tests ------------------------------------------

class TestAggregatorHonesty:
    def test_empty_session_returns_honest_unavailable_note(self):
        report = build_death_audit([])
        assert report["available"] is False
        assert report["entries"] == []
        # The note has to be PRESENT, not omitted, because absence would
        # invite readers to assume no audit was run at all.
        assert isinstance(report["note"], str) and report["note"]
        assert "damage" in report["note"].lower() or "trigger" in report["note"].lower()

    def test_no_damage_events_returns_honest_unavailable_note(self):
        events = _zero_events()
        report = build_death_audit(events)
        assert report["available"] is False
        assert report["entries"] == []

    def test_session_with_only_damage_above_zero_is_not_a_trigger(self):
        events = [
            _event(1, "ATTACK_RESOLVED", {
                "attacker_id": ATTACKER, "target_id": TARGET,
                "is_hit": True, "total_damage": 5,
                "target_hp_remaining": 7,
            }),
        ]
        report = build_death_audit(events)
        assert report["available"] is False  # never dropped to 0
        assert report["entries"] == []


class TestStabilized:
    def test_target_dropped_then_three_successes_stabilizes(self):
        report = build_death_audit(_stabilized_events())
        assert report["available"] is True
        assert len(report["entries"]) == 1
        entry = report["entries"][0]
        assert entry["token_id"] == TARGET
        assert entry["outcome"] == "stabilized"
        assert entry["instant_death"] is False
        assert entry["trigger_at_sequence"] == 3
        # All three saves belong to this entry.
        rolls = [a["roll"] for a in entry["save_attempts"]]
        assert rolls == [15, 12, 18]
        kinds = [a["kind"] for a in entry["save_attempts"]]
        assert all(k == "success" for k in kinds)
        results = [a["result"] for a in entry["save_attempts"]]
        assert results[-1] == "STABILIZED"


class TestDied:
    def test_three_failures_kill_the_token(self):
        report = build_death_audit(_died_events())
        entry = report["entries"][0]
        assert entry["token_id"] == TARGET
        assert entry["outcome"] == "died"
        kinds = [a["kind"] for a in entry["save_attempts"]]
        assert "failure" in kinds


class TestRealEngineEventShape:
    """Regression for audit A4/F1: the audit read token identity from
    event.payload.actor_id, a key the engine never puts in payloads.
    Every real ledger therefore produced in_progress forever."""

    def test_real_shape_fixture_resolves_stabilized(self):
        report = build_death_audit(_real_engine_shape_events())
        assert report["available"] is True
        entry = report["entries"][0]
        assert entry["token_id"] == TARGET
        assert entry["outcome"] == "stabilized"
        # Both saves attributed to the dying token, not dropped on the floor.
        rolls = [a["roll"] for a in entry["save_attempts"]]
        assert rolls == [15, 18]

    def test_payload_actor_id_is_never_the_lookup_source(self):
        # Even when a payload carries a (fictional) actor_id key, the
        # top-level field wins — that is the field the engine sets.
        events = _real_engine_shape_events()
        for event in events:
            if event["event_type"] == "DEATH_SAVE_RESOLVED":
                event["payload"]["actor_id"] = "payload-lies"
        report = build_death_audit(events)
        assert report["entries"][0]["token_id"] == TARGET


class TestInProgress:
    def test_two_successes_yield_in_progress_outcome(self):
        report = build_death_audit(_in_progress_events())
        entry = report["entries"][0]
        assert entry["outcome"] == "in_progress"
        assert len(entry["save_attempts"]) == 2


class TestInstantDeath:
    def test_monstrous_damage_creates_died_entry_with_no_save_attempts(self):
        report = build_death_audit(_instant_death_events())
        entry = report["entries"][0]
        assert entry["token_id"] == TARGET
        assert entry["outcome"] == "died"
        assert entry["instant_death"] is True
        assert entry["save_attempts"] == []
        assert entry["trigger_at_sequence"] == 3


# --- Route-level wiring ------------------------------------------------------

def _token(user_id: str = "player-9", role: str = "player") -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _export(token=None, *, include: str | None = None, fmt: str = "json"):
    params: dict = {"format": fmt}
    if token is not None:
        params["token"] = token
    if include is not None:
        params["include"] = include
    return client.get(f"/api/v1/sessions/{SESSION_ID}/replay/export", params=params)


def _stub_engine(monkeypatch, events):
    session = _session(events)

    async def fake(method, path, payload=None, *, actor=None):
        return session

    monkeypatch.setattr(engine_client, "engine_request", fake)


class TestRouteIncludeFlag:
    def test_default_export_omits_death_audit_key(self, monkeypatch):
        _stub_engine(monkeypatch, _stabilized_events())
        body = json.loads(_export(_token("gm-1", "gm")).content)
        assert "death_audit" not in body

    def test_unknown_include_flag_rejected(self, monkeypatch):
        _stub_engine(monkeypatch, _stabilized_events())
        assert _export(_token("gm-1", "gm"), include="loot_drop").status_code == 422

    def test_include_death_audit_adds_section_to_json(self, monkeypatch):
        _stub_engine(monkeypatch, _stabilized_events())
        body = json.loads(_export(_token("gm-1", "gm"), include="death_audit").content)
        assert "death_audit" in body
        assert body["death_audit"]["available"] is True
        assert len(body["death_audit"]["entries"]) == 1

    def test_include_death_audit_adds_section_to_markdown(self, monkeypatch):
        _stub_engine(monkeypatch, _stabilized_events())
        text = _export(_token("gm-1", "gm"), include="death_audit",
                       fmt="markdown").content.decode()
        assert "Death Save" in text
        assert TARGET in text
        assert "stabilized" in text.lower()

    def test_zero_damage_session_audit_admits_empty_honestly(self, monkeypatch):
        _stub_engine(monkeypatch, _zero_events())
        body = json.loads(
            _export(_token("gm-1", "gm"), include="death_audit").content
        )
        audit = body["death_audit"]
        assert audit["available"] is False
        assert audit["entries"] == []
        assert audit["note"]