"""Tests for gateway-side role projection on the read proxies.

Iteration-32 follow-up to the audit finding that POST
/api/v1/engine/session-state returned FULL engine state to anyone, making
spectator filtering render-only. The gateway now PROJECTS the ``entities``
map by the caller's role before returning it:

=================  ==========================================================
Caller role        Entities received
=================  ==========================================================
gm / admin         Full authoritative state, verbatim.
player             Own entities (``owner_player_id`` == caller user_id) in
                   full; every OTHER visible entity reduced to
                   {id, name, is_visible, position, is_player, is_dead}; hidden entities dropped.
spectator          Every visible entity reduced to
                   {id, name, is_visible, position, is_player, is_dead}; hidden entities dropped;
                   no HP/AC/abilities/stat blocks anywhere.
(no token)         401 Unauthorized — the route is browser-facing and must
                   never serve the full engine state anonymously.
=================  ==========================================================

GET /api/v1/engine/session-replay AND POST /api/v1/engine/session-state
apply the same redaction policy to LEDGER EVENTS: spectator exports keep the
event narrative but strip numeric HP/damage amounts ("took damage", never
"took 7 damage"); players/GM keep exact numbers.

The engine is monkeypatched throughout: these tests pin the GATEWAY
projection contract, not the Rust engine itself.
"""

import json
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.server import app, _sign_token

client = TestClient(app)

SESSION_ID = "12345678-90ab-cdef-1234-567890abcdef"


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _entity(
    name: str,
    *,
    owner: str | None = None,
    visible: bool = True,
    hp: int = 28,
) -> dict:
    return {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, name)),
        "name": name,
        "current_hp": hp,
        "max_hp": hp,
        "temp_hp": 0,
        "ac": 16,
        "position": [1.0, 2.0, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {"strength": 18},
        "attacks": [{"name": "Longsword", "attack_bonus": 8}],
        "conditions": [],
        "is_conscious": True,
        "is_dead": False,
        "is_player": True,
        "is_visible": visible,
        **({"owner_player_id": owner} if owner is not None else {}),
    }


def _state(entities: dict) -> dict:
    return {
        "session_id": SESSION_ID,
        "entities": entities,
        "combat": {"in_combat": True, "round": 3},
        "ledger": {"current_sequence": 9},
    }


def _patched_state(monkeypatch, state: dict) -> dict:
    captured: dict = {}

    async def fake_engine_request(method, path, payload=None, *, actor=None):
        captured.update({"method": method, "path": path})
        captured["actor"] = actor
        return state

    monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
    return captured


def _fetch(token: str | None) -> dict:
    params = {"token": token} if token else {}
    resp = client.post(
        "/api/v1/engine/session-state",
        params=params,
        json={"session_id": SESSION_ID},
    )
    assert resp.status_code == 200
    return resp.json()


class TestSpectatorProjection:
    """Spectators receive only the public board: who is where, nothing more."""

    def test_spectator_sees_no_hidden_entities(self, monkeypatch):
        state = _state({
            "e-hero": _entity("Hero"),
            "e-hidden-trap": _entity("Ambush Trap", visible=False),
        })
        _patched_state(monkeypatch, state)

        body = _fetch(_token("watcher-1", "spectator"))
        assert "e-hidden-trap" not in body["entities"]
        assert set(body["entities"]) == {"e-hero"}

    def test_spectator_entity_projection_is_public_fields_only(self, monkeypatch):
        state = _state({"e-hero": _entity("Hero")})
        _patched_state(monkeypatch, state)

        body = _fetch(_token("watcher-1", "spectator"))
        hero = body["entities"]["e-hero"]
        assert hero == {
            "id": hero["id"],
            "name": "Hero",
            "is_visible": True,
            "position": [1.0, 2.0, 0.0],
            "is_player": True,
            "is_dead": False,
        }
        # No stat detail leaks through extra keys either.
        for forbidden in ("current_hp", "max_hp", "ac", "abilities", "attacks",
                          "conditions", "owner_player_id"):
            assert forbidden not in hero

    def test_spectator_non_entity_state_is_preserved(self, monkeypatch):
        """Only ``entities`` is projected; combat/ledger metadata still travels."""
        state = _state({"e-hero": _entity("Hero")})
        _patched_state(monkeypatch, state)

        body = _fetch(_token("watcher-1", "spectator"))
        assert body["session_id"] == SESSION_ID
        assert body["combat"] == {"in_combat": True, "round": 3}
        assert body["ledger"] == {"current_sequence": 9}

    def test_spectator_identity_is_forwarded_to_the_engine(self, monkeypatch):
        captured = _patched_state(monkeypatch, _state({}))
        _fetch(_token("watcher-1", "spectator"))
        assert captured["actor"] == {"user_id": "watcher-1", "role": "spectator"}
        assert captured["method"] == "GET"
        assert captured["path"] == f"/api/v1/sessions/{SESSION_ID}"


class TestPlayerProjection:
    """Players see their own sheet in full; everyone else is a public token."""

    def test_player_sees_own_entity_in_full(self, monkeypatch):
        state = _state({
            "e-mine": _entity("Thorin", owner="player-7"),
        })
        _patched_state(monkeypatch, state)

        body = _fetch(_token("player-7", "player"))
        mine = body["entities"]["e-mine"]
        assert mine["name"] == "Thorin"
        assert mine["current_hp"] == 28
        assert mine["ac"] == 16
        assert mine["abilities"] == {"strength": 18}

    def test_player_sees_others_as_visible_projection(self, monkeypatch):
        state = _state({
            "e-other": _entity("Orc Warlord", owner="someone-else"),
        })
        _patched_state(monkeypatch, state)

        body = _fetch(_token("player-7", "player"))
        other = body["entities"]["e-other"]
        assert set(other) == {"id", "name", "is_visible", "position",
                              "is_player", "is_dead"}
        assert other["name"] == "Orc Warlord"
        assert "current_hp" not in other and "ac" not in other

    def test_player_does_not_see_hidden_entities_at_all(self, monkeypatch):
        state = _state({
            "e-hidden": _entity("Hidden Assassin", owner=None, visible=False),
            "e-my-hidden-pet": _entity("Familiar", owner="player-7", visible=False),
        })
        _patched_state(monkeypatch, state)

        body = _fetch(_token("player-7", "player"))
        assert "e-hidden" not in body["entities"]
        # Even the player's own entity stays hidden while the GM keeps it so.
        assert "e-my-hidden-pet" not in body["entities"]

    def test_unowned_entity_without_owner_field_is_filtered(self, monkeypatch):
        """An entity with no ownership marker is never treated as the
        caller's own sheet."""
        state = _state({"e-npc": _entity("Innkeeper")})
        _patched_state(monkeypatch, state)

        body = _fetch(_token("player-7", "player"))
        assert set(body["entities"]["e-npc"]) == {
            "id", "name", "is_visible", "position", "is_player", "is_dead",
        }


class TestGmAndAdminProjection:
    """GM (and admin) callers keep the verbatim authoritative state."""

    @pytest.mark.parametrize("role", ["gm", "admin"])
    def test_privileged_roles_get_full_state(self, monkeypatch, role):
        state = _state({
            "e-hero": _entity("Hero", owner="player-7"),
            "e-hidden": _entity("Ambush Trap", visible=False),
        })
        _patched_state(monkeypatch, state)

        body = _fetch(_token("gm-1", role))
        assert body["entities"]["e-hidden"]["current_hp"] == 28
        assert body["entities"]["e-hero"]["ac"] == 16

    def test_no_token_is_unauthorized_never_verbatim(self, monkeypatch):
        """The tokenless 'legacy service-principal verbatim read' must not exist
        on a browser-facing route: no token is an auth failure, and the engine
        is never even contacted."""
        captured = _patched_state(monkeypatch, _state({"e-hero": _entity("Hero")}))
        resp = client.post(
            "/api/v1/engine/session-state",
            json={"session_id": SESSION_ID},
        )
        assert resp.status_code == 401
        assert captured == {}  # engine never saw the request

    def test_unknown_role_is_treated_as_spectator(self, monkeypatch):
        """Fail closed: any unrecognized role gets the most restrictive view."""
        state = _state({"e-hero": _entity("Hero")})
        _patched_state(monkeypatch, state)

        body = _fetch(_token("mystery-1", "bard"))
        assert set(body["entities"]["e-hero"]) == {
            "id", "name", "is_visible", "position", "is_player", "is_dead",
        }


class TestAuthUnchanged:
    def test_invalid_token_is_unauthorized(self):
        resp = client.post(
            "/api/v1/engine/session-state",
            params={"token": "not.a.valid.token"},
            json={"session_id": SESSION_ID},
        )
        assert resp.status_code == 401


# --- Replay export redaction ----------------------------------------------------------

ATTACKER = "aaaaaaaa-0000-0000-0000-000000000001"
TARGET = "bbbbbbbb-0000-0000-0000-000000000002"


def _event(seq: int, event_type: str, payload: dict) -> dict:
    return {
        "sequence_id": seq,
        "actor_id": ATTACKER,
        "event_type": event_type,
        "payload": payload,
        "is_reverted": False,
    }


def _replay_state(events: list[dict]) -> dict:
    return {
        "session_id": SESSION_ID,
        "entities": {},
        "combat": {"in_combat": True, "round": 4},
        "ledger": {"current_sequence": len(events), "events": events},
    }


def _export_replay(token: str, state: dict, monkeypatch) -> dict:
    _patched_state(monkeypatch, state)
    resp = client.get(
        "/api/v1/engine/session-replay",
        params={"session_id": SESSION_ID, "token": token},
    )
    assert resp.status_code == 200
    return json.loads(resp.content)


class TestSpectatorReplayRedaction:
    """Spectator exports narrate outcomes without exact numbers."""

    def test_attack_damage_and_hp_amounts_are_stripped(self, monkeypatch):
        state = _replay_state([
            _event(1, "ATTACK_RESOLVED", {
                "attacker_id": ATTACKER, "target_id": TARGET,
                "is_hit": True, "total_damage": 7, "target_hp_remaining": 13,
            }),
        ])
        body = _export_replay(_token("watcher-1", "spectator"), state, monkeypatch)

        summary = body["events"][0]["summary"]
        assert "7" not in summary and "13" not in summary
        assert "hit" in summary and "damage dealt" in summary

    def test_damage_applied_amount_is_stripped(self, monkeypatch):
        state = _replay_state([
            _event(1, "DAMAGE_APPLIED", {
                "target_id": TARGET, "amount": 11, "hp_remaining": 4,
            }),
        ])
        body = _export_replay(_token("watcher-1", "spectator"), state, monkeypatch)

        summary = body["events"][0]["summary"]
        assert "11" not in summary and "4)" not in summary
        assert TARGET in summary and "took damage" in summary

    def test_heal_amounts_are_stripped_but_target_kept(self, monkeypatch):
        state = _replay_state([
            _event(1, "HEALED", {"target_id": TARGET, "amount": 5, "hp_remaining": 18}),
        ])
        body = _export_replay(_token("watcher-1", "spectator"), state, monkeypatch)

        summary = body["events"][0]["summary"]
        assert "5" not in summary and "18" not in summary
        assert TARGET in summary and "healed" in summary

    def test_spell_cast_damage_amount_is_stripped(self, monkeypatch):
        state = _replay_state([
            _event(1, "SPELL_CAST", {
                "caster_id": ATTACKER, "spell_id": "magic-missile",
                "damage_total": 9, "target_hp_remaining": 6,
            }),
        ])
        body = _export_replay(_token("watcher-1", "spectator"), state, monkeypatch)

        summary = body["events"][0]["summary"]
        assert "9" not in summary and "6" not in summary
        assert "magic-missile" in summary

    def test_unknown_event_payload_is_not_dumped_raw_for_spectators(self, monkeypatch):
        """An unprojectable payload must not leak its numbers verbatim."""
        state = _replay_state([
            _event(1, "MYSTERY_EVENT", {"secret_hp": 42, "note": "hi"}),
        ])
        body = _export_replay(_token("watcher-1", "spectator"), state, monkeypatch)

        summary = body["events"][0]["summary"]
        assert "42" not in summary
        assert '"note"' not in summary

    def test_round_metadata_survives_redaction(self, monkeypatch):
        state = _replay_state([_event(1, "TURN_ADVANCED", {"round": 4})])
        body = _export_replay(_token("watcher-1", "spectator"), state, monkeypatch)
        assert body["round"] == 4
        assert "round advanced to 4" in body["events"][0]["summary"]

    def test_player_export_retains_exact_numbers(self, monkeypatch):
        state = _replay_state([
            _event(1, "ATTACK_RESOLVED", {
                "attacker_id": ATTACKER, "target_id": TARGET,
                "is_hit": True, "total_damage": 7, "target_hp_remaining": 13,
            }),
        ])
        body = _export_replay(_token("player-7", "player"), state, monkeypatch)
        summary = body["events"][0]["summary"]
        assert "for 7" in summary and "(HP→13)" in summary


# --- Ledger redaction on /api/v1/engine/session-state --------------------------
# The live snapshot carries the SAME ledger the replay export projects; it must
# not become a side channel that hands players/spectators raw HP/damage numbers
# (and hidden-entity event payloads) that replay deliberately strips.

def _fetch_state_events(token: str, events: list[dict], monkeypatch) -> dict:
    """POSTs session-state with a patched engine returning ``events``."""
    state = _state({"e-hero": _entity("Hero")})
    state["ledger"] = {"current_sequence": len(events), "events": events}
    _patched_state(monkeypatch, state)
    return _fetch(token)


class TestSessionStateLedgerRedaction:
    def test_spectator_ledger_numbers_are_stripped(self, monkeypatch):
        events = [
            _event(1, "ATTACK_RESOLVED", {
                "attacker_id": ATTACKER, "target_id": TARGET,
                "is_hit": True, "total_damage": 7, "target_hp_remaining": 13,
            }),
            _event(2, "DAMAGE_APPLIED", {"target_id": TARGET, "amount": 11, "hp_remaining": 4}),
        ]
        body = _fetch_state_events(_token("watcher-1", "spectator"), events, monkeypatch)

        ledger_events = body["ledger"]["events"]
        first, second = ledger_events[0], ledger_events[1]
        assert "damage dealt" in first["summary"] and "hit" in first["summary"]
        assert "7" not in first["summary"] and "13" not in first["summary"]
        assert "took damage" in second["summary"]
        assert "11" not in second["summary"] and "4)" not in second["summary"]

    def test_spectator_ledger_payload_is_never_dumped_raw(self, monkeypatch):
        """The projected event must be a summary — no verbatim payload dict."""
        events = [_event(1, "MYSTERY_EVENT", {"secret_hp": 42})]
        body = _fetch_state_events(_token("watcher-1", "spectator"), events, monkeypatch)

        event = body["ledger"]["events"][0]
        assert event.get("payload") is None or event.get("payload") == {}
        assert json.dumps(event).find("42") == -1

    def test_player_ledger_keeps_exact_numbers_like_replay(self, monkeypatch):
        events = [
            _event(1, "ATTACK_RESOLVED", {
                "attacker_id": ATTACKER, "target_id": TARGET,
                "is_hit": True, "total_damage": 7, "target_hp_remaining": 13,
            }),
        ]
        body = _fetch_state_events(_token("player-7", "player"), events, monkeypatch)
        summary = body["ledger"]["events"][0]["summary"]
        assert "for 7" in summary and "(HP→13)" in summary

    def test_gm_ledger_keeps_exact_numbers(self, monkeypatch):
        events = [
            _event(1, "HEALED", {"target_id": TARGET, "amount": 5, "hp_remaining": 18}),
        ]
        body = _fetch_state_events(_token("gm-1", "gm"), events, monkeypatch)
        summary = body["ledger"]["events"][0]["summary"]
        assert "healed for 5" in summary and "(HP→18)" in summary

# --- Iteration 88 (audit F2): payload-heavy event types leak to players ----------
#
# The player tier sits inside _PLAYER_VISIBLE_ROLES, so redact_numbers is False
# for players — and every event type WITHOUT an explicit summary handler falls
# through to the raw-payload fallback (`json.dumps(payload)`). Iterations 72-78
# added exactly such events, and their payloads carry hidden-campaign secrets:
#
#   OPPORTUNITY_ATTACK_RESOLVED -> target_hp_remaining (enemy HP leak)
#   MOVE_ENTITY                 -> opportunity_attacks[{attacker_id}] (names
#                                  entities the player cannot see)
#   READY_ACTION_SET/RELEASED   -> readied trigger text verbatim
#   INSPIRATION_CHANGED         -> grant reason verbatim
#   ITEM_TRANSFERRED            -> container/item ids
#
# Fix: modeled summaries in the PLAYER tier; GM stays verbatim; spectator keeps
# its existing withheld line. Nothing is fabricated: segments derive only from
# fields genuinely present in the payload.

OA_ATTACKER = "cccccccc-0000-0000-0000-000000000003"
OA_MOVER = "dddddddd-0000-0000-0000-000000000004"


def _oa_resolved_event(seq: int = 1) -> dict:
    """The ledger row the Rust engine actually writes on a resolved OA swing."""
    return _event(seq, "OPPORTUNITY_ATTACK_RESOLVED", {
        "attacker_id": OA_ATTACKER,
        "mover_id": OA_MOVER,
        "resolution": {
            "attacker_id": OA_ATTACKER,
            "target_id": OA_MOVER,
            "attack_roll": 14,
            "natural_roll": 11,
            "target_ac": 13,
            "is_hit": True,
            "is_critical_hit": False,
            "is_critical_miss": False,
            "total_damage": 7,
            "target_hp_remaining": 6,
            "target_is_conscious": True,
            "target_is_dead": False,
        },
        "weapon": "Longsword",
    })


def _move_entity_event(seq: int = 1, attackers: list[str] | None = None) -> dict:
    triggers = [{"attacker_id": a, "mover_id": OA_MOVER} for a in (attackers or [])]
    event = _event(seq, "MOVE_ENTITY", {
        "from": [5.0, 5.0, 0.0],
        "to": [20.0, 5.0, 0.0],
        "distance_feet": 15.0,
        "opportunity_attacks": triggers,
    })
    # The Rust engine journals MOVE_ENTITY under the MOVER's own actor id.
    event["actor_id"] = OA_MOVER
    return event


class TestPlayerLedgerPayloadHeavyEventsModeled:
    """Players get MODELED summaries for the iteration-72+ event types — never
    the raw payload dump the unmodeled fallback produces."""

    def test_oa_resolved_names_pairing_but_never_target_hp(self, monkeypatch):
        events = [_oa_resolved_event(1)]
        body = _fetch_state_events(_token("player-7", "player"), events, monkeypatch)
        summary = body["ledger"]["events"][0]["summary"]
        assert OA_ATTACKER in summary and OA_MOVER in summary, (
            "the pairing must stay auditable for players"
        )
        assert "hit" in summary or "missed" in summary
        # THE FIX: no enemy HP number rides along.
        assert "6" not in summary.replace("#6", ""), summary
        assert "hp" not in summary.lower(), summary

    def test_oa_resolved_miss_reports_miss_not_hp(self, monkeypatch):
        event = _oa_resolved_event(1)
        event["payload"]["resolution"]["is_hit"] = False
        event["payload"]["resolution"]["total_damage"] = 0
        body = _fetch_state_events(
            _token("player-7", "player"), [event], monkeypatch
        )
        summary = body["ledger"]["events"][0]["summary"]
        assert "missed" in summary
        assert "hp" not in summary.lower()

    def test_move_entity_summary_drops_opportunity_attack_array_for_players(
        self, monkeypatch
    ):
        hidden_enemy = "eeeeeeee-0000-0000-0000-000000000005"
        events = [_move_entity_event(1, attackers=[hidden_enemy])]
        body = _fetch_state_events(_token("player-7", "player"), events, monkeypatch)
        event = body["ledger"]["events"][0]
        summary = event["summary"]
        assert hidden_enemy not in json.dumps(event), (
            "a hidden provoking attacker must not be named to a player"
        )
        assert "opportunity_attacks" not in summary

    def test_move_entity_without_oas_still_summarizes_the_mover(self, monkeypatch):
        events = [_move_entity_event(1, attackers=[])]
        body = _fetch_state_events(_token("player-7", "player"), events, monkeypatch)
        summary = body["ledger"]["events"][0]["summary"]
        assert OA_MOVER in summary
        assert "moved" in summary

    def test_ready_action_set_is_modeled_not_raw(self, monkeypatch):
        events = [_event(1, "READY_ACTION_SET", {
            "description": "swing at the first goblin that passes",
            "set_on_round": 4,
            "trigger": "enemy enters reach",
        })]
        body = _fetch_state_events(_token("player-7", "player"), events, monkeypatch)
        summary = body["ledger"]["events"][0]["summary"]
        assert summary.startswith("{") is False, "raw payload dump leaked"
        assert "readie" in summary.lower() and "action" in summary.lower()
        assert json.dumps(events[0]["payload"], sort_keys=True) != summary
        assert ATTACKER not in summary or "readied an action" in summary

    def test_ready_action_released_is_modeled_not_raw(self, monkeypatch):
        events = [_event(1, "READY_ACTION_RELEASED", {
            "description": "swing at the first goblin",
            "released_on_round": 5,
            "trigger": "enemy entered reach",
        })]
        body = _fetch_state_events(_token("player-7", "player"), events, monkeypatch)
        summary = body["ledger"]["events"][0]["summary"]
        assert summary.startswith("{") is False
        assert "ready" in summary.lower() or "release" in summary.lower()

    def test_inspiration_changed_grant_is_a_fact_line(self, monkeypatch):
        events = [_event(1, "INSPIRATION_CHANGED", {
            "granted": True, "reason": "heroic roleplay",
        })]
        body = _fetch_state_events(_token("player-7", "player"), events, monkeypatch)
        summary = body["ledger"]["events"][0]["summary"]
        assert summary.startswith("{") is False
        assert "inspiration" in summary.lower()

    def test_item_transferred_is_a_fact_line_without_container_ids(self, monkeypatch):
        events = [_event(1, "ITEM_TRANSFERRED", {
            "item_id": "item-99",
            "container_id": "container-7",
            "from_container_id": None,
        })]
        body = _fetch_state_events(_token("player-7", "player"), events, monkeypatch)
        summary = body["ledger"]["events"][0]["summary"]
        assert summary.startswith("{") is False
        assert "container-7" not in summary

    def test_gm_still_sees_verbatim_payload_facts(self, monkeypatch):
        """GM tier stays verbatim: exact numbers survive on these events too."""
        events = [
            _oa_resolved_event(1),
            _move_entity_event(2, attackers=[OA_ATTACKER]),
        ]
        body = _fetch_state_events(_token("gm-1", "gm"), events, monkeypatch)
        oa_summary = body["ledger"]["events"][0]["summary"]
        move_summary = body["ledger"]["events"][1]["summary"]
        # GM tier stays VERBATIM: the full resolution (with target HP) and the
        # full opportunity_attacks array survive untouched.
        assert "target_hp_remaining" in oa_summary and '"is_hit": true' in oa_summary, oa_summary
        assert OA_ATTACKER in move_summary and OA_MOVER in move_summary, move_summary

    def test_spectator_tier_still_withholds_entirely(self, monkeypatch):
        events = [_oa_resolved_event(1)]
        body = _fetch_state_events(_token("watcher-1", "spectator"), events, monkeypatch)
        summary = body["ledger"]["events"][0]["summary"]
        assert "withheld" in summary, summary
        assert OA_MOVER not in summary
