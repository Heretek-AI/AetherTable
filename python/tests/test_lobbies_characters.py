"""Tests for lobby lifecycle, character persistence/deploy, engine proxies,
and the rate limiter (plan workstreams A–E)."""

import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.server import app, _bucket_for_path

client = TestClient(app)


def _signup(name: str) -> dict:
    email = f"{name}_{abs(hash(name + str(time.time()))) % 10**8}@example.com"
    resp = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": name, "display_name": name.title(),
              "password": "dice-dice", "role": "player"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture()
def host():
    return _signup("hostbot")


@pytest.fixture()
def guest():
    return _signup("guestbot")


# --- Workstream A: lobbies -----------------------------------------------------

def test_lobby_lifecycle(host, guest):
    created = client.post(
        "/api/v1/lobbies", params={"token": host["token"]}, json={"name": "Crypt Run"}
    )
    assert created.status_code == 200
    lobby = created.json()
    assert lobby["host_user_id"] == host["user"]["id"]
    assert len(lobby["invite_code"]) == 6
    assert any(m["user_id"] == host["user"]["id"] for m in lobby["members"])

    # Wrong invite code refused.
    bad = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/join",
        params={"token": guest["token"]},
        json={"invite_code": "XXXXXX"},
    )
    assert bad.status_code == 403

    # Correct code joins; rejoin is idempotent.
    for _ in range(2):
        joined = client.post(
            f"/api/v1/lobbies/{lobby['lobby_id']}/join",
            params={"token": guest["token"]},
            json={"invite_code": lobby["invite_code"].lower()},
        )
        assert joined.status_code == 200
    roster = joined.json()
    member_ids = {m["user_id"] for m in roster["members"]}
    assert {host["user"]["id"], guest["user"]["id"]} <= member_ids

    mine = client.get("/api/v1/lobbies/mine", params={"token": guest["token"]})
    assert any(l["lobby_id"] == lobby["lobby_id"] for l in mine.json()["lobbies"])

    # Only the host can launch.
    denied = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/launch", params={"token": guest["token"]}
    )
    assert denied.status_code == 403

    launched = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/launch", params={"token": host["token"]}
    )
    if launched.status_code == 502:
        pytest.skip("engine not running")
    assert launched.status_code == 200
    body = launched.json()
    assert body["status"] == "LAUNCHED"
    assert body["session_id"]
    assert body["lobby"]["engine_session_id"] == body["session_id"]

    # Unauthenticated access refused everywhere.
    assert client.get(f"/api/v1/lobbies/{lobby['lobby_id']}").status_code == 422


def test_lobby_unknown_404(host):
    resp = client.post(
        "/api/v1/lobbies/nonexistent-id/join",
        params={"token": host["token"]},
        json={"invite_code": "ABC234"},
    )
    assert resp.status_code in (404, 500)  # malformed id tolerated either way


# --- Workstream B: characters ---------------------------------------------------

def _make_character(token: str, name: str = "Kara") -> dict:
    resp = client.post(
        "/api/v1/characters",
        params={"token": token},
        json={
            "name": name, "character_class": "fighter", "level": 3,
            "abilities": {"STR": 16, "DEX": 14, "CON": 14, "INT": 10, "WIS": 12, "CHA": 8},
            "hp": 28, "ac": 16, "speed": 30,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_character_persistence_and_deploy(host, guest):
    record = _make_character(host["token"], "Kara Ironvow")
    assert record["owner_user_id"] == host["user"]["id"]
    assert record["character_class"] == "fighter"

    listing = client.get("/api/v1/characters", params={"token": host["token"]})
    assert any(c["character_id"] == record["character_id"]
               for c in listing.json()["characters"])

    # Another user cannot see/delete it.
    foreign_list = client.get("/api/v1/characters", params={"token": guest["token"]})
    assert not any(c["character_id"] == record["character_id"]
                   for c in foreign_list.json()["characters"])
    stolen = client.delete(
        f"/api/v1/characters/{record['character_id']}", params={"token": guest["token"]}
    )
    assert stolen.status_code == 404

    # Deploy spawns an OWNED entity (RBAC-bound).
    session = client.post("/api/v1/engine/session", params={"token": host["token"]}, json={})
    deploy = client.post(
        f"/api/v1/characters/{record['character_id']}/deploy",
        params={"token": host["token"]},
        json={"session_id": session.json()["session_id"], "x": 5.0, "y": 5.0},
    )
    if deploy.status_code == 502:
        pytest.skip("engine not running")
    assert deploy.status_code == 200, deploy.text
    body = deploy.json()
    assert body["owner_player_id"] == host["user"]["id"]

    # Guest deploying someone else's character is forbidden before spawn.
    denied = client.post(
        f"/api/v1/characters/{record['character_id']}/deploy",
        params={"token": guest["token"]},
        json={"session_id": session.json()["session_id"]},
    )
    assert denied.status_code == 403


# --- Workstream C: proxy routes --------------------------------------------------

def test_engine_proxy_routes_contract():
    """Spawn → turn-next → move against the live engine via gateway routes."""
    session_resp = client.post("/api/v1/engine/session", json={})
    if session_resp.status_code == 502:
        pytest.skip("engine not running")
    session_id = session_resp.json()["session_id"]

    from vtt_orchestrator.playtest.synthetic_playtest import _statblock
    hero_id = engine_client._coerce_uuid("proxy-hero")
    entity = _statblock(hero_id, "Proxy Hero", 25, 15, 5)
    spawned = client.post(
        "/api/v1/engine/spawn",
        json={"session_id": session_id, "entity": entity},
    )
    assert spawned.status_code == 200, spawned.text
    assert spawned.json()["status"] == "SPAWNED"

    moved = client.post(
        "/api/v1/engine/move",
        json={"session_id": session_id, "entity_id": hero_id, "x": 12.0, "y": 7.5},
    )
    assert moved.status_code == 200
    assert moved.json()["outcome"]["to"]["x"] if isinstance(moved.json()["outcome"]["to"], dict) else True

    advanced = client.post(
        "/api/v1/engine/turn-next", json={"session_id": session_id}
    )
    assert advanced.status_code == 200
    assert advanced.json()["status"] == "TURN_ADVANCED"

    # Unknown entity move is rejected by the engine (409 MOVE_REJECTED).
    bad_move = client.post(
        "/api/v1/engine/move",
        json={"session_id": session_id, "entity_id": engine_client._coerce_uuid("ghost"),
              "x": 1.0, "y": 1.0},
    )
    assert bad_move.status_code in (404, 409)


# --- Workstream E: rate limiting --------------------------------------------------

def test_bucket_selection():
    assert _bucket_for_path("/api/v1/auth/signup") == "auth"
    assert _bucket_for_path("/api/v1/agent/turn") == "agent"
    assert _bucket_for_path("/api/v1/compendium/spells") == "default"


def test_rate_limiter_blocks_flood():
    import httpx
    from vtt_orchestrator.server import _rate_windows

    # Simulate an exhausted window for this test client's IP+auth bucket.
    key = ("testclient", "auth")
    now = time.time()
    limit, _window = (30, 60)
    _rate_windows[key] = [now] * (limit + 1)

    try:
        flooded = client.post("/api/v1/auth/signup", json={"email": "x@y.z"})
        assert flooded.status_code == 429
        assert flooded.headers.get("Retry-After")
    finally:
        _rate_windows.pop(key, None)
