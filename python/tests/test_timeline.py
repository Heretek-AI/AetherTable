"""Tests for the session event timeline (Loop 3, iteration 26).

GET  /api/v1/sessions/{id}/timeline — merged feed of engine ledger events
                                     and narrative chat messages, paginated
                                     by cursor.
POST /api/v1/sessions/{id}/chat     — append one message to the session's
                                     narrative log.

Survey findings that shaped the test surface:

* Engine events carry a monotonic ``sequence_id`` (u64 from the Rust
  ``EventSourcingLedger``). The timeline namespaces them as ``e_<n>`` and
  narrative messages as ``n_<n>``.
* The React chat was client-local only before this iteration; the server
  side now anchors narrative messages in the gateway's storage. Chat
  append tests seed the storage directly to exercise the merge path.
* Hidden entities (``is_visible=False``) collapse to ``[Unknown]`` for
  non-GM viewers — the same projection matrix used by
  ``/api/v1/engine/session-state``.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.server import (
    app,
    _sign_token,
    storage_backend,
)
from vtt_orchestrator.timeline import (
    DEFAULT_LIMIT,
    _PRIVATE_CHANNELS,
    _PRIVATE_PLACEHOLDER,
    _UNKNOWN,
    decode_cursor,
    encode_cursor,
    filter_after_cursor,
    format_engine_event,
    format_narrative_message,
    merge_timeline,
    project_timeline_entry,
)

client = TestClient(app)

SESSION_ID = "11111111-2222-3333-4444-555555555555"

THORIN = "aaaaaaaa-0000-0000-0000-000000000001"
GOBLIN = "bbbbbbbb-0000-0000-0000-000000000002"
SPECTER = "cccccccc-0000-0000-0000-000000000003"


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _ts_ms(year: int, month: int, day: int, hour: int, minute: int = 0) -> int:
    """A small helper for stable test timestamps."""
    dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def _token(user_id: str, role: str = "player") -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _entity(name: str, *, entity_id: str = "", visible: bool = True) -> dict:
    return {
        "id": entity_id or str(uuid.uuid5(uuid.NAMESPACE_URL, name)),
        "name": name,
        "current_hp": 28,
        "max_hp": 28,
        "temp_hp": 0,
        "ac": 16,
        "position": [0.0, 0.0, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {"strength": 14},
        "attacks": [],
        "conditions": [],
        "is_conscious": True,
        "is_dead": False,
        "is_player": True,
        "is_visible": visible,
    }


def _event(
    seq: int,
    event_type: str,
    payload: dict,
    *,
    actor_id: str = THORIN,
    is_reverted: bool = False,
    timestamp_ms: int | None = None,
) -> dict:
    iso = _iso(timestamp_ms) if timestamp_ms is not None else _iso(_ts_ms(2026, 8, 26, 12, seq))
    return {
        "sequence_id": seq,
        "actor_id": actor_id,
        "event_type": event_type,
        "payload": payload,
        "is_reverted": is_reverted,
        "state_hash": f"hash-{seq}",
        "timestamp": iso,
    }


def _chat_message(
    seq: int,
    *,
    user_id: str = "alice",
    display_name: str = "Alice",
    role: str = "player",
    channel: str = "public",
    content: str = "Hello",
    timestamp_ms: int | None = None,
) -> dict:
    iso = _iso(timestamp_ms) if timestamp_ms is not None else _iso(
        _ts_ms(2026, 8, 26, 12, seq)
    )
    return {
        "sequence_id": seq,
        "session_id": SESSION_ID,
        "user_id": user_id,
        "display_name": display_name,
        "role": role,
        "channel": channel,
        "content": content,
        "created_at": iso,
    }


@pytest.fixture()
def roster() -> dict:
    """A roster with one visible hero and one hidden assassin."""
    return {
        THORIN: _entity("Thorin", entity_id=THORIN, visible=True),
        GOBLIN: _entity("Goblin Shaman", entity_id=GOBLIN, visible=False),
        SPECTER: _entity("Specter", entity_id=SPECTER, visible=True),
    }


def _patched_engine(monkeypatch, *, state: dict):
    """Replaces the engine proxy with a function that returns ``state``."""

    async def fake_engine_request(method, path, payload=None, *, actor=None):
        return state

    monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)


async def _seed_lobby(session_id: str = SESSION_ID, host_user_id: str = "alice"):
    """Inserts a lobby bound to ``session_id`` so the timeline gate recognizes it."""
    lobby = await storage_backend.create_lobby(
        host_user_id=host_user_id,
        host_display_name="Alice",
        name="Timeline Test Lobby",
        invite_code="ABC123",
    )
    await storage_backend.set_lobby_session(lobby["lobby_id"], session_id)
    return lobby


# ---------------------------------------------------------------------------
# Pure-function tests (no FastAPI)
# ---------------------------------------------------------------------------


class TestFormatterUnit:
    """The formatter is a pure function: it takes one event + a roster and
    returns one timeline entry. These tests exercise that contract without
    the FastAPI stack."""

    def test_engine_event_resolves_actor_name(self, roster):
        e = _event(1, "DELAY_TAKEN", {"entity_id": THORIN, "round": 3})
        entry = format_engine_event(e, roster=roster, privileged=True)
        assert entry["actor_name"] == "Thorin"
        assert entry["summary"] == "Thorin delays (round 3)"
        assert entry["sequence_id"] == "e_1"
        assert entry["kind"] == "engine"

    def test_combat_began_and_ended(self, roster):
        e1 = _event(1, "COMBAT_BEGAN", {"round": 1, "order": []})
        e2 = _event(2, "COMBAT_ENDED", {"rounds_fought": 4})
        assert format_engine_event(e1, roster=roster, privileged=True)["summary"] == "Combat begins"
        assert format_engine_event(e2, roster=roster, privileged=True)["summary"] == "Combat ends"

    def test_turn_advanced_includes_round(self, roster):
        e = _event(1, "TURN_ADVANCED", {"round": 4})
        out = format_engine_event(e, roster=roster, privileged=True)
        assert out["summary"] == "Round 4 begins"

    def test_condition_expired(self, roster):
        e = _event(1, "CONDITION_EXPIRED", {"condition": "Stunned"}, actor_id=THORIN)
        out = format_engine_event(e, roster=roster, privileged=True)
        assert out["summary"] == "Stunned wears off: Thorin"

    def test_condition_applied_with_source(self, roster):
        e = _event(
            1, "CONDITION_APPLIED",
            {"condition": "Stunned", "source_entity_id": SPECTER},
            actor_id=THORIN,
        )
        out = format_engine_event(e, roster=roster, privileged=True)
        assert out["summary"] == "Specter applies Stunned to Thorin"

    def test_attack_resolved_strips_numbers_for_spectator(self, roster):
        e = _event(
            1, "ATTACK_RESOLVED",
            {
                "attacker_id": THORIN, "target_id": GOBLIN,
                "is_hit": True, "total_damage": 7, "target_hp_remaining": 13,
            },
            actor_id=THORIN,
        )
        out = format_engine_event(e, roster=roster, privileged=False, redact_numbers=True)
        assert "7" not in out["summary"] and "13" not in out["summary"]
        assert "Thorin" in out["summary"] and "hits" in out["summary"]

    def test_attack_resolved_keeps_numbers_for_gm(self, roster):
        e = _event(
            1, "ATTACK_RESOLVED",
            {
                "attacker_id": THORIN, "target_id": GOBLIN,
                "is_hit": True, "total_damage": 7, "target_hp_remaining": 13,
            },
            actor_id=THORIN,
        )
        out = format_engine_event(e, roster=roster, privileged=True, redact_numbers=False)
        assert "for 7" in out["summary"] and "13" in out["summary"]

    def test_unknown_event_type_is_withheld_from_non_privileged(self, roster):
        e = _event(1, "MYSTERY_FUTURE", {"secret": 42})
        out = format_engine_event(e, roster=roster, privileged=False, redact_numbers=True)
        assert "42" not in out["summary"]
        assert "occurred" in out["summary"]

    def test_unknown_event_type_renders_payload_for_privileged(self, roster):
        e = _event(1, "MYSTERY_FUTURE", {"secret": 42})
        out = format_engine_event(e, roster=roster, privileged=True, redact_numbers=False)
        assert "42" in out["summary"]

    def test_narrative_message_carries_display_name(self):
        msg = _chat_message(1, display_name="Alice", content="I cast fireball")
        out = format_narrative_message(msg)
        assert out["kind"] == "narrative"
        assert out["sequence_id"] == "n_1"
        assert out["actor_name"] == "Alice"
        assert out["summary"] == "I cast fireball"

    def test_merge_sorts_by_created_at_ms(self, roster):
        e1 = _event(1, "COMBAT_BEGAN", {}, timestamp_ms=_ts_ms(2026, 8, 26, 12, 0))
        e2 = _event(2, "COMBAT_ENDED", {}, timestamp_ms=_ts_ms(2026, 8, 26, 12, 5))
        msg = _chat_message(
            1, content="I cast fireball",
            timestamp_ms=_ts_ms(2026, 8, 26, 12, 3),
        )
        merged = merge_timeline(
            [format_engine_event(e1, roster=roster, privileged=True),
             format_engine_event(e2, roster=roster, privileged=True)],
            [format_narrative_message(msg)],
        )
        # Combat begins → narrative line (12:03) → combat ends (12:05)
        assert [e["kind"] for e in merged] == ["engine", "narrative", "engine"]

    def test_cursor_roundtrip(self):
        encoded = encode_cursor({
            "sequence_id": "e_5",
            "created_at_ms": 1787745600000,
        })
        ms, seq = decode_cursor(encoded)
        assert ms == 1787745600000
        assert seq == "e_5"

    def test_filter_after_cursor_skips_seen_entries(self, roster):
        e1 = _event(1, "COMBAT_BEGAN", {}, timestamp_ms=_ts_ms(2026, 8, 26, 12, 0))
        e2 = _event(2, "COMBAT_ENDED", {}, timestamp_ms=_ts_ms(2026, 8, 26, 12, 5))
        entries = [
            format_engine_event(e1, roster=roster, privileged=True),
            format_engine_event(e2, roster=roster, privileged=True),
        ]
        first_page = filter_after_cursor(entries, cursor=None, limit=1)
        assert len(first_page) == 1
        cursor = encode_cursor(first_page[-1])
        second_page = filter_after_cursor(entries, cursor=cursor, limit=1)
        assert len(second_page) == 1
        assert second_page[0]["sequence_id"] == "e_2"


class TestProjectionRules:
    """Role-based projection of formatted entries."""

    def test_gm_sees_verbatim(self, roster):
        e = _event(
            1, "ATTACK_RESOLVED",
            {"attacker_id": THORIN, "target_id": GOBLIN, "is_hit": True,
             "total_damage": 7, "target_hp_remaining": 13},
        )
        entry = format_engine_event(e, roster=roster, privileged=True, redact_numbers=False)
        proj = project_timeline_entry(
            entry, role="gm", viewer_user_id="gm-1", roster=roster
        )
        assert proj["actor_name"] == "Thorin"
        assert "for 7" in proj["summary"]

    def test_player_sees_hidden_target_as_unknown(self, roster):
        e = _event(
            1, "ATTACK_RESOLVED",
            {"attacker_id": THORIN, "target_id": GOBLIN, "is_hit": True,
             "total_damage": 7, "target_hp_remaining": 13},
        )
        entry = format_engine_event(e, roster=roster, privileged=False, redact_numbers=False)
        proj = project_timeline_entry(
            entry, role="player", viewer_user_id="thorin", roster=roster
        )
        # Goblin is hidden in the roster → the target name is collapsed to [Unknown]
        # and the summary is replaced with the private placeholder.
        assert "Goblin" not in proj["summary"]
        assert proj["summary"] == _PRIVATE_PLACEHOLDER
        assert proj.get("is_private") is True

    def test_player_sees_visible_target(self, roster):
        e = _event(
            1, "ATTACK_RESOLVED",
            {"attacker_id": THORIN, "target_id": SPECTER, "is_hit": True,
             "total_damage": 7, "target_hp_remaining": 13},
        )
        entry = format_engine_event(e, roster=roster, privileged=False, redact_numbers=False)
        proj = project_timeline_entry(
            entry, role="player", viewer_user_id="thorin", roster=roster
        )
        assert "Specter" in proj["summary"]
        assert proj.get("is_private") is None

    def test_private_channel_collapses_for_player(self):
        msg = _chat_message(1, channel="gm", content="secret plan", display_name="GM")
        entry = format_narrative_message(msg)
        proj = project_timeline_entry(
            entry, role="player", viewer_user_id="alice", roster={}
        )
        assert proj["summary"] == _PRIVATE_PLACEHOLDER
        assert proj["actor_name"] == _UNKNOWN

    def test_private_channel_drops_for_spectator(self):
        msg = _chat_message(1, channel="gm", content="secret plan", display_name="GM")
        entry = format_narrative_message(msg)
        proj = project_timeline_entry(
            entry, role="spectator", viewer_user_id="watcher-1", roster={}
        )
        assert proj is None


# ---------------------------------------------------------------------------
# HTTP route tests
# ---------------------------------------------------------------------------


@pytest.fixture()
async def seeded_lobby():
    """Wires a real lobby binding for SESSION_ID before each test that needs it."""
    # The MemoryStore lobby/membership is process-wide — best-effort cleanup.
    try:
        lobby = await _seed_lobby(SESSION_ID, host_user_id="alice")
    except Exception:
        lobby = None
    yield lobby
    # Reset chat messages between tests so tests stay independent.
    if hasattr(storage_backend, "chat_messages"):
        storage_backend.chat_messages.clear()


@pytest.mark.asyncio
async def test_empty_timeline(seeded_lobby, monkeypatch):
    state = {
        "session_id": SESSION_ID,
        "entities": {},
        "combat": {},
        "ledger": {"current_sequence": 0, "events": []},
    }
    _patched_engine(monkeypatch, state=state)
    resp = client.get(
        f"/api/v1/sessions/{SESSION_ID}/timeline",
        params={"token": _token("alice", "player")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session_id"] == SESSION_ID
    assert body["entries"] == []
    assert body["next_cursor"] is None
    assert body["has_more"] is False


@pytest.mark.asyncio
async def test_mixed_narrative_and_engine_events_sorted(seeded_lobby, monkeypatch):
    """Narrative messages and engine events share the timeline in chronological order."""
    state = {
        "session_id": SESSION_ID,
        "entities": {
            THORIN: _entity("Thorin", entity_id=THORIN, visible=True),
        },
        "combat": {"in_combat": True, "round": 1},
        "ledger": {
            "current_sequence": 3,
            "events": [
                _event(1, "COMBAT_BEGAN", {}, timestamp_ms=_ts_ms(2026, 8, 26, 12, 0)),
                _event(2, "DELAY_TAKEN",
                       {"entity_id": THORIN, "round": 1},
                       timestamp_ms=_ts_ms(2026, 8, 26, 12, 2)),
                _event(3, "TURN_ADVANCED", {"round": 2},
                       timestamp_ms=_ts_ms(2026, 8, 26, 12, 4)),
            ],
        },
    }
    _patched_engine(monkeypatch, state=state)
    # Seed two narrative messages between the engine events.
    await storage_backend.append_chat_message(
        SESSION_ID, "alice", "Alice", "player", "public",
        "Here goes",
    )
    await storage_backend.append_chat_message(
        SESSION_ID, "bob", "Bob", "player", "public",
        "You too",
    )
    resp = client.get(
        f"/api/v1/sessions/{SESSION_ID}/timeline",
        params={"token": _token("alice", "player")},
    )
    assert resp.status_code == 200
    body = resp.json()
    # Three engine + two narrative = five entries.
    assert len(body["entries"]) == 5
    # Kinds appear in interleaved chronological order (engine events bookend
    # the chat lines because they have explicit timestamps and chat lines
    # append in real time after them).
    kinds = [e["kind"] for e in body["entries"]]
    assert "engine" in kinds and "narrative" in kinds
    # The merged feed is monotonic in created_at_ms.
    times = [e["created_at_ms"] for e in body["entries"]]
    assert times == sorted(times)


@pytest.mark.asyncio
async def test_hidden_entity_event_collapses_for_player(seeded_lobby, monkeypatch):
    """A CONDITION_APPLIED on a hidden target collapses to 'Something happens'."""
    state = {
        "session_id": SESSION_ID,
        "entities": {
            THORIN: _entity("Thorin", entity_id=THORIN, visible=True),
            GOBLIN: _entity("Goblin Shaman", entity_id=GOBLIN, visible=False),
            SPECTER: _entity("Specter", entity_id=SPECTER, visible=True),
        },
        "combat": {},
        "ledger": {
            "current_sequence": 1,
            "events": [
                _event(
                    1, "CONDITION_APPLIED",
                    {"condition": "Stunned", "source_entity_id": SPECTER},
                    actor_id=GOBLIN,
                    timestamp_ms=_ts_ms(2026, 8, 26, 12, 0),
                ),
            ],
        },
    }
    _patched_engine(monkeypatch, state=state)
    resp = client.get(
        f"/api/v1/sessions/{SESSION_ID}/timeline",
        params={"token": _token("alice", "player")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["entries"]) == 1
    entry = body["entries"][0]
    assert entry["summary"] == _PRIVATE_PLACEHOLDER
    assert "Goblin" not in entry["summary"]
    assert entry.get("is_private") is True


@pytest.mark.asyncio
async def test_gm_sees_hidden_entity_event_verbatim(seeded_lobby, monkeypatch):
    state = {
        "session_id": SESSION_ID,
        "entities": {
            GOBLIN: _entity("Goblin Shaman", entity_id=GOBLIN, visible=False),
            SPECTER: _entity("Specter", entity_id=SPECTER, visible=True),
        },
        "combat": {},
        "ledger": {
            "current_sequence": 1,
            "events": [
                _event(
                    1, "CONDITION_APPLIED",
                    {"condition": "Stunned", "source_entity_id": SPECTER},
                    actor_id=GOBLIN,
                    timestamp_ms=_ts_ms(2026, 8, 26, 12, 0),
                ),
            ],
        },
    }
    _patched_engine(monkeypatch, state=state)
    resp = client.get(
        f"/api/v1/sessions/{SESSION_ID}/timeline",
        params={"token": _token("gm-1", "gm")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["entries"]) == 1
    entry = body["entries"][0]
    assert "Goblin" in entry["summary"]
    assert "Specter" in entry["summary"]
    assert "Stunned" in entry["summary"]
    assert entry.get("is_private") is None


@pytest.mark.asyncio
async def test_cursor_pagination_round_trip(seeded_lobby, monkeypatch):
    """Walking the cursor yields disjoint pages until the feed is exhausted."""
    events = [
        _event(i, "TURN_ADVANCED", {"round": i},
               timestamp_ms=_ts_ms(2026, 8, 26, 12, i))
        for i in range(1, 6)
    ]
    state = {
        "session_id": SESSION_ID,
        "entities": {},
        "combat": {},
        "ledger": {"current_sequence": len(events), "events": events},
    }
    _patched_engine(monkeypatch, state=state)
    seen = []
    cursor = None
    while True:
        params = {"token": _token("alice", "player"), "limit": 2}
        if cursor:
            params["cursor"] = cursor
        resp = client.get(
            f"/api/v1/sessions/{SESSION_ID}/timeline", params=params
        )
        assert resp.status_code == 200
        body = resp.json()
        seen.extend(body["entries"])
        cursor = body["next_cursor"]
        if not cursor or not body["has_more"]:
            break
    assert len(seen) == 5
    seqs = [e["sequence_id"] for e in seen]
    assert seqs == sorted(seqs)


# ---------------------------------------------------------------------------
# Auth matrix
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_anon_is_401(seeded_lobby, monkeypatch):
    state = {"session_id": SESSION_ID, "entities": {},
             "combat": {}, "ledger": {"current_sequence": 0, "events": []}}
    _patched_engine(monkeypatch, state=state)
    resp = client.get(f"/api/v1/sessions/{SESSION_ID}/timeline")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_non_participant_is_403(seeded_lobby, monkeypatch):
    """A signed-in user who is not in the lobby gets 403, not 200."""
    state = {"session_id": SESSION_ID, "entities": {},
             "combat": {}, "ledger": {"current_sequence": 0, "events": []}}
    _patched_engine(monkeypatch, state=state)
    resp = client.get(
        f"/api/v1/sessions/{SESSION_ID}/timeline",
        params={"token": _token("outsider-1", "player")},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "TIMELINE_NOT_A_PARTICIPANT"


@pytest.mark.asyncio
async def test_unknown_session_is_404(seeded_lobby, monkeypatch):
    """Even a GM gets 404 when the engine session has no lobby binding."""
    state = {"session_id": SESSION_ID, "entities": {},
             "combat": {}, "ledger": {"current_sequence": 0, "events": []}}
    _patched_engine(monkeypatch, state=state)
    resp = client.get(
        "/api/v1/sessions/99999999-9999-9999-9999-999999999999/timeline",
        params={"token": _token("gm-1", "gm")},
    )
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "SESSION_NOT_FOUND"


@pytest.mark.asyncio
async def test_gm_can_view_verbatim_with_numbers(seeded_lobby, monkeypatch):
    state = {
        "session_id": SESSION_ID,
        "entities": {
            THORIN: _entity("Thorin", entity_id=THORIN, visible=True),
            GOBLIN: _entity("Goblin Shaman", entity_id=GOBLIN, visible=True),
        },
        "combat": {},
        "ledger": {
            "current_sequence": 1,
            "events": [
                _event(
                    1, "DAMAGE_APPLIED",
                    {"target_id": GOBLIN, "amount": 7, "hp_remaining": 13},
                    actor_id=THORIN,
                    timestamp_ms=_ts_ms(2026, 8, 26, 12, 0),
                ),
            ],
        },
    }
    _patched_engine(monkeypatch, state=state)
    resp = client.get(
        f"/api/v1/sessions/{SESSION_ID}/timeline",
        params={"token": _token("gm-1", "gm")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["entries"]) == 1
    summary = body["entries"][0]["summary"]
    assert "7" in summary and "13" in summary


# ---------------------------------------------------------------------------
# Per-event-type formatting spot checks (via the route)
# ---------------------------------------------------------------------------


def _events_only_state(events: list[dict]) -> dict:
    return {
        "session_id": SESSION_ID,
        "entities": {
            THORIN: _entity("Thorin", entity_id=THORIN, visible=True),
        },
        "combat": {},
        "ledger": {"current_sequence": len(events), "events": events},
    }


def _summaries_for(token: str, state: dict, monkeypatch) -> list[dict]:
    _patched_engine(monkeypatch, state=state)
    resp = client.get(
        f"/api/v1/sessions/{SESSION_ID}/timeline",
        params={"token": token},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["entries"]


@pytest.mark.asyncio
@pytest.mark.parametrize("event_type, payload, expected_substr", [
    ("SESSION_CREATED", {"name": "Curse of Strahd"}, "Session created"),
    ("COMBAT_BEGAN", {"round": 1, "order": []}, "Combat begins"),
    ("COMBAT_ENDED", {"rounds_fought": 4}, "Combat ends"),
    ("TURN_ADVANCED", {"round": 3}, "Round 3"),
    ("DELAY_TAKEN", {"entity_id": THORIN, "round": 4}, "Thorin delays"),
    ("DELAY_RESUMED", {"entity_id": THORIN, "round": 4}, "Thorin resumes"),
    ("HEALED", {"target_id": THORIN, "amount": 5, "hp_remaining": 25}, "Thorin heals"),
    ("DEATH_SAVE_RESOLVED",
     {"outcome": "success", "natural_roll": 14, "successes": 1, "failures": 0,
      "is_stabilized": False, "is_dead": False},
     "death-save success"),
    ("INSPIRATION_CHANGED", {"granted": True}, "inspiration"),
    ("HELP_ACTION", {"helper_id": THORIN, "target_entity_id": THORIN}, "helps"),
])
async def test_event_type_formatting_spot_checks(
    seeded_lobby, monkeypatch, event_type, payload, expected_substr
):
    state = _events_only_state([_event(
        1, event_type, payload,
        timestamp_ms=_ts_ms(2026, 8, 26, 12, 0),
    )])
    entries = _summaries_for(_token("alice", "player"), state, monkeypatch)
    assert len(entries) == 1
    assert expected_substr in entries[0]["summary"]


# ---------------------------------------------------------------------------
# Chat append route
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_append_chat_message_round_trips_into_timeline(
    seeded_lobby, monkeypatch
):
    state = {"session_id": SESSION_ID, "entities": {},
             "combat": {}, "ledger": {"current_sequence": 0, "events": []}}
    _patched_engine(monkeypatch, state=state)
    # Append a chat message.
    resp = client.post(
        f"/api/v1/sessions/{SESSION_ID}/chat",
        params={"token": _token("alice", "player")},
        json={"content": "Hello table", "channel": "public"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["content"] == "Hello table"
    assert body["sequence_id"] >= 1
    # Timeline picks it up.
    resp2 = client.get(
        f"/api/v1/sessions/{SESSION_ID}/timeline",
        params={"token": _token("alice", "player")},
    )
    assert resp2.status_code == 200
    entries = resp2.json()["entries"]
    assert any(e["kind"] == "narrative" and e["summary"] == "Hello table" for e in entries)


@pytest.mark.asyncio
async def test_player_cannot_post_on_gm_channel(seeded_lobby, monkeypatch):
    state = {"session_id": SESSION_ID, "entities": {},
             "combat": {}, "ledger": {"current_sequence": 0, "events": []}}
    _patched_engine(monkeypatch, state=state)
    resp = client.post(
        f"/api/v1/sessions/{SESSION_ID}/chat",
        params={"token": _token("alice", "player")},
        json={"content": "fake gm line", "channel": "gm"},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "CHAT_CHANNEL_FORBIDDEN"


@pytest.mark.asyncio
async def test_gm_can_post_on_gm_channel(seeded_lobby, monkeypatch):
    """A GM staff token may append on the gm channel — they bypass the
    participant gate via the privileged role."""
    state = {"session_id": SESSION_ID, "entities": {},
             "combat": {}, "ledger": {"current_sequence": 0, "events": []}}
    _patched_engine(monkeypatch, state=state)
    resp = client.post(
        f"/api/v1/sessions/{SESSION_ID}/chat",
        params={"token": _token("gm-1", "gm")},
        json={"content": "whisper to gm channel", "channel": "gm"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["channel"] == "gm"