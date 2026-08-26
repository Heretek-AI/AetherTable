"""LIVE cross-stack exercise: SRD Surprise + Delay + spotlight + timeline.

Loop3 iteration 35: no cross-stack test had exercised Surprise or Delay
end-to-end over HTTP button-click semantics — the Rust unit gates covered
the engine, the vitest suites covered the client against a MOCKED gateway,
and the pytest gate exercised the gateway against a FAKE engine. This module
drives the real gateway (in-process ASGI via TestClient) against the REAL
vtt-server engine (crates/vtt-server) over ENGINE_API_URL.

Liveness gating follows the repo's engine-live convention (test_engine_proxy):
tests SKIP (never fail) when no engine answers on ENGINE_API_URL — CI without
the Rust binary stays green, and a plain pytest run leaves the engine-live
benchmark to the benchmark launcher (scripts/run_all_benchmarks.sh boots the
engine before its pytest phase, so THIS live module runs inside every full
milestone benchmark). This module never boots an engine of its own.

Scenario (GM + one simulated player, all over real HTTP routes the browser
also hits):
  create session -> spawn a player-owned PC, a hidden surprised NPC and a
  visible NPC -> begin combat -> GM grants Surprise to the PC and the hidden
  NPC through the gateway proxy POST /api/v1/engine/combat/surprise (the
  iteration-35 wire gap the client's toggle targets) -> the PLAYER snapshot
  must show the PC surprised WITHOUT leaking the hidden NPC's flag -> advance
  a turn -> the surprise window closes (released after the first turn) ->
  delay the PC -> advance again -> the delayed skip works -> POST
  spotlight/report -> GET timeline.

Honesty: this is a live run only when the engine responds; every assertion
is against observable HTTP responses from the same routes the browser uses.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server as server_module
from vtt_orchestrator.server import _sign_token, app

client = TestClient(app)

ENGINE_URL = os.environ.get("ENGINE_API_URL", "http://localhost:8088")


def _engine_up() -> bool:
    try:
        httpx.get(f"{ENGINE_URL}/health", timeout=1.0)
        return True
    except httpx.HTTPError:
        return False


@pytest.fixture(scope="module")
def live_engine():
    """Skip-when-down gate, identical to test_engine_proxy: the module runs
    ONLY when an engine answers on ENGINE_API_URL. The benchmark launcher
    (scripts/run_all_benchmarks.sh, step [2/4]) boots that engine before
    pytest runs, so the milestone benchmark exercises this live; a plain
    pytest run with no engine skips it — CI without the Rust binary stays
    green. This module never boots an engine of its own."""
    if not _engine_up():
        pytest.skip("vtt-server engine not running on ENGINE_API_URL")
    yield


@pytest.fixture(autouse=True)
def _clean_spotlight_scores():
    """The spotlight score table is module singleton state; start and end
    empty (same isolation the spotlight suite gives its tables)."""
    server_module.spotlight_scores.clear_all()
    yield
    server_module.spotlight_scores.clear_all()


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _auth(user_id: str, role: str) -> dict:
    return {"Authorization": f"Bearer {_token(user_id, role)}"}


def _eid(tag: str) -> str:
    """Stable entity id for a tag (reproducible across runs)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"iter35-live-{tag}"))


KAEL = _eid("kael-pc")
LYRA = _eid("lyra-pc")
SHADOW = _eid("shadow-stalker")
SENTRY = _eid("goblin-sentry")


def _spawn_payload(
    entity_id: str,
    name: str,
    *,
    is_player: bool,
    owner: str | None,
    is_visible: bool,
) -> dict:
    """Full server-side stat block — the same shape the engine proxies accept
    and the lobby/character deploy flows send (see test_engine_proxy)."""
    return {
        "id": entity_id,
        "compendium_id": f"iter35_{name.replace(' ', '_').lower()}",
        "name": name,
        "is_player": is_player,
        "owner_player_id": owner,
        "current_hp": 12,
        "max_hp": 12,
        "temp_hp": 0,
        "ac": 14,
        "speed_feet": 30.0,
        "position": [2.5, 2.5, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {
            "strength": 16,
            "dexterity": 14,
            "constitution": 14,
            "intelligence": 10,
            "wisdom": 12,
            "charisma": 10,
        },
        "conditions": [],
        "action_budget": {
            "action": True,
            "bonus_action": True,
            "reaction": True,
            "movement_remaining_feet": 30.0,
            "free_object_interaction": True,
        },
        "spell_slots_remaining": {},
        "attacks": [],
        "resistances": [],
        "vulnerabilities": [],
        "immunities": [],
        "inventory": {"items": {}},
        "is_conscious": True,
        "is_dead": False,
        "is_visible": is_visible,
    }


def _bind_lobby_to_engine_session(host_id: str, guest_id: str, session_id: str) -> None:
    """Create a lobby (session's seats) and bind it to the engine session,
    exactly like lobby launch does — required by the spotlight and timeline
    routes. Mirrors the binding helper in test_session_spotlight."""
    created = client.post(
        "/api/v1/lobbies",
        params={"token": _token(host_id, "player")},
        json={"name": "Iteration 35 Live Table"},
    )
    assert created.status_code == 200, created.text
    lobby_id = created.json()["lobby_id"]
    joined = client.post(
        f"/api/v1/lobbies/{lobby_id}/join",
        params={"token": _token(guest_id, "player")},
        json={"invite_code": created.json()["invite_code"]},
    )
    assert joined.status_code == 200, joined.text
    asyncio.run(server_module.storage_backend.set_lobby_session(lobby_id, session_id))


def _session_state(session_id: str, who: dict) -> dict:
    resp = client.post(
        "/api/v1/engine/session-state",
        headers=who,
        json={"session_id": session_id},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _gateway_error_code(resp) -> str:
    """FastAPI wraps the gateway/engine rejection detail in {detail}; the
    machine-readable code (FORBIDDEN_ROLE / ALREADY_DELAYED / ...) lives at
    detail.error — the same key the client's rejectionFrom() unwraps."""
    body = resp.json()
    return (body.get("detail") or {}).get("error", body.get("error", ""))


def test_live_surprise_delay_spotlight_timeline_stack(live_engine):
    """The full live scenario, one focused run (see module docstring)."""
    gm = _auth("gm-live", "gm")
    player = _auth("player-live", "player")

    # -- 1. create a session through the gateway proxy ---------------------
    created = client.post(
        "/api/v1/engine/session",
        headers=gm,
        json={"session_name": "Iteration 35 Surprise & Delay Table",
              "campaign_id": "aethertable-default"},
    )
    assert created.status_code == 200, created.text
    session_id: str = created.json()["session_id"]

    # -- 2. spawn the combatants (GM seat; hidden NPCs need a GM) -----------
    for payload in (
        _spawn_payload(KAEL, "Kael Halvar", is_player=True, owner="player-live", is_visible=True),
        _spawn_payload(LYRA, "Lyra Nightwind", is_player=True, owner="lyra-live", is_visible=True),
        _spawn_payload(SHADOW, "Shadow Stalker", is_player=False, owner=None, is_visible=False),
        _spawn_payload(SENTRY, "Goblin Sentry", is_player=False, owner=None, is_visible=True),
    ):
        spawned = client.post(
            "/api/v1/engine/spawn",
            headers=gm,
            json={"session_id": session_id, "entity": payload},
        )
        assert spawned.status_code == 200, spawned.text

    # -- 3. begin combat (GM button; the proxy forwards only the session) ---
    begun = client.post(
        "/api/v1/engine/combat/begin",
        headers=gm,
        json={"session_id": session_id},
    )
    assert begun.status_code == 200, begun.text
    combat = begun.json()
    assert combat["status"] == "COMBAT_BEGAN"
    assert combat["in_combat"] is True
    assert combat.get("round") == 1
    order = combat["order"]
    assert {e["entity_id"] for e in order} == {KAEL, LYRA, SHADOW, SENTRY}

    # -- 4. GM adjudicates Surprise through the gateway proxy (the fixed
    #       /api/v1/engine/combat/surprise route — the client's toggle) -----
    granted = client.post(
        "/api/v1/engine/combat/surprise",
        headers=gm,
        json={"session_id": session_id, "entity_id": KAEL, "surprised": True},
    )
    assert granted.status_code == 200, granted.text
    assert granted.json()["status"] == "SURPRISE_GRANTED"

    granted_hidden = client.post(
        "/api/v1/engine/combat/surprise",
        headers=gm,
        json={"session_id": session_id, "entity_id": SHADOW, "surprised": True},
    )
    assert granted_hidden.status_code == 200, granted_hidden.text
    assert granted_hidden.json()["status"] == "SURPRISE_GRANTED"

    # Non-GM adjudication is refused by the engine's RBAC (403 verbatim).
    refused = client.post(
        "/api/v1/engine/combat/surprise",
        headers=player,
        json={"session_id": session_id, "entity_id": SENTRY, "surprised": True},
    )
    assert refused.status_code == 403
    assert _gateway_error_code(refused) == "FORBIDDEN_ROLE"

    # -- 5. PLAYER snapshot: own surprise visible, hidden NPC's surprise must
    #       NOT leak (the Iteration-32 projection, now verified cross-stack) --
    player_view = _session_state(session_id, player)
    p_surprised = [str(s) for s in player_view["combat"]["surprised"]]
    assert KAEL in p_surprised, "the player sees their own surprised PC"
    assert SHADOW not in p_surprised, "a hidden surprised NPC must not leak to the player"
    p_order = [str(o) for o in player_view["combat"]["order"]]
    assert SHADOW not in p_order, "the hidden NPC must not appear in the player's order"
    p_entities = player_view.get("entities", {})
    assert SHADOW not in p_entities, "the hidden NPC's stat block must not be served to the player"
    assert p_entities[KAEL]["name"] == "Kael Halvar", "an owned PC ships its full stat block"

    # GM snapshot is the ledger of truth: both ids verbatim.
    gm_view = _session_state(session_id, gm)
    g_surprised = [str(s) for s in gm_view["combat"]["surprised"]]
    assert KAEL in g_surprised and SHADOW in g_surprised, "GM sees the full surprise set"

    # -- 6. a STILL-surprised combatant cannot Delay (Iteration-32 disjoint):
    #       the engine refuses before the first turn concludes --------------
    still_surprised_delay = client.post(
        "/api/v1/engine/delay",
        headers=player,
        json={"session_id": session_id, "entity_id": KAEL},
    )
    assert still_surprised_delay.status_code == 409
    assert _gateway_error_code(still_surprised_delay) == "ENTITY_SURPRISED"

    # Advance turns: a surprised combatant releases the moment its FIRST TURN
    # concludes — the cursor passes over the surprised slot and the penalty
    # drops. One /turn/next releases the surprised slots it passes before the
    # next clean actor, so the set drains monotonically over at most a full
    # initiative lap (never re-grows). Verify the drain live on both views.
    prev_count: int | None = None
    drained = False
    for _ in range(len(order) + 2):
        for who, who_name in ((gm, "GM"), (player, "player")):
            view = _session_state(session_id, who)
            cur = [str(s) for s in view["combat"]["surprised"]]
            if prev_count is not None:
                assert len(cur) <= prev_count, (
                    f"surprise set must shrink monotonically ({who_name} view)"
                )
            prev_count = len(cur)
            if len(cur) == 0:
                drained = True
        if drained:
            break
        advanced = client.post(
            "/api/v1/engine/turn-next",
            headers=gm,
            json={"session_id": session_id},
        )
        assert advanced.status_code == 200, advanced.text
        assert advanced.json()["status"] == "TURN_ADVANCED"
    assert drained, "surprise must drain to empty once every first turn has concluded"

    # Round counter has marched; snap current round from the GM truth view.
    gm_view = _session_state(session_id, gm)
    round_after_drain = gm_view["combat"]["round"]
    assert round_after_drain >= 2

    # -- 7. once released, Kael delays as its owner --------------------------
    parked_delay = client.post(
        "/api/v1/engine/delay",
        headers=player,
        json={"session_id": session_id, "entity_id": KAEL},
    )
    assert parked_delay.status_code == 200, parked_delay.text
    assert parked_delay.json()["status"] == "DELAY_TAKEN"

    double_delay = client.post(
        "/api/v1/engine/delay",
        headers=player,
        json={"session_id": session_id, "entity_id": KAEL},
    )
    assert double_delay.status_code == 409
    assert _gateway_error_code(double_delay) == "ALREADY_DELAYED"

    # Ownership RBAC: an UNOWNED entity is controllable by any non-spectator
    # (documented residual allowance), but another player's PC is not.
    unowned_delay = client.post(
        "/api/v1/engine/delay",
        headers=player,
        json={"session_id": session_id, "entity_id": SENTRY},
    )
    assert unowned_delay.status_code == 200, unowned_delay.text
    assert unowned_delay.json()["status"] == "DELAY_TAKEN"
    # Undo the unowned park so the later delayed-skip assertions stay focused
    # on Kael alone being parked.
    client.post(
        "/api/v1/engine/delay/resume",
        headers=player,
        json={"session_id": session_id, "entity_id": SENTRY},
    )

    foreign_delay = client.post(
        "/api/v1/engine/delay",
        headers=player,
        json={"session_id": session_id, "entity_id": LYRA},
    )
    assert foreign_delay.status_code == 403
    assert _gateway_error_code(foreign_delay) == "ENTITY_NOT_OWNED"

    parked = _session_state(session_id, gm)
    assert KAEL in [str(d) for d in parked["combat"]["delayed"]], "Kael is parked out of order"

    # -- 8. advance again: the delayed slot is skipped, cursor lands elsewhere
    advanced2 = client.post(
        "/api/v1/engine/turn-next",
        headers=gm,
        json={"session_id": session_id},
    )
    assert advanced2.status_code == 200, advanced2.text
    assert advanced2.json()["round"] == round_after_drain + 1

    after_skip = _session_state(session_id, gm)
    comb = after_skip["combat"]
    assert comb["round"] == round_after_drain + 1
    assert KAEL in [str(d) for d in comb["delayed"]], "Kael stays parked (skip is not a resume)"
    current_actor = comb["order"][comb["turn_index"]]
    assert str(current_actor) != KAEL, "the delayed combatant's slot must be passed over"

    # -- 9. spotlight self-report (bound seat over real HTTP) ----------------
    _bind_lobby_to_engine_session("player-live", "gm-live", session_id)
    reported = client.post(
        f"/api/v1/sessions/{session_id}/spotlight/report",
        headers=_auth("player-live", "player"),
        json={
            "seat_user_id": "player-live",
            "duration_ms": 2500,
            "occurred_at": int(time.time() * 1000),
        },
    )
    assert reported.status_code == 200, reported.text
    assert reported.json()["status"] == "recorded"
    assert reported.json()["seat_user_id"] == "player-live"

    # A participant crediting ANOTHER seat is refused (SPOTLIGHT_SPOOFED_SEAT).
    spoofed = client.post(
        f"/api/v1/sessions/{session_id}/spotlight/report",
        headers=_auth("player-live", "player"),
        json={
            "seat_user_id": "gm-live",
            "duration_ms": 1000,
            "occurred_at": int(time.time() * 1000),
        },
    )
    assert spoofed.status_code == 403
    assert _gateway_error_code(spoofed) == "SPOTLIGHT_SPOOFED_SEAT"

    # -- 10. timeline: engine ledger events merged over real HTTP ------------
    timeline = client.get(
        f"/api/v1/sessions/{session_id}/timeline",
        headers=gm,
    )
    assert timeline.status_code == 200, timeline.text
    entries = timeline.json()["entries"]
    engine_types = [e.get("event_type") for e in entries if e.get("kind") == "engine"]
    assert "SESSION_CREATED" in engine_types
    assert "SURPRISE_GRANTED" in engine_types
    assert "SURPRISE_RELEASED" in engine_types
    assert "DELAY_TAKEN" in engine_types
    assert "TURN_ADVANCED" in engine_types

    # Player's timeline must not carry the hidden NPC's identity anywhere.
    p_timeline = client.get(
        f"/api/v1/sessions/{session_id}/timeline",
        headers=player,
    )
    assert p_timeline.status_code == 200, p_timeline.text
    body = p_timeline.text
    assert "Shadow Stalker" not in body, (
        "a hidden NPC's name must not surface in the player's timeline feed"
    )
    gm_timeline_body = timeline.text
    assert "Shadow Stalker" in gm_timeline_body, "GM sees the hidden NPC's identity"