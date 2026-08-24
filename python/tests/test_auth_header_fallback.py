"""Header-based auth for protected REST routes (backlog 3.10).

Tokens used to ride the ?token= query string on every gateway route, which
leaks them into proxy/access logs. The client now sends
`Authorization: Bearer <token>` and the gateway's `_require_auth` dependency
resolves the token from the header FIRST, falling back to ?token= so older
clients (and WebSocket handshakes, where headers are impossible) keep working.

Covers the routes whose browser clients were migrated: lobbies, characters,
and campaign persistence.
"""

import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.server import app

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
def user():
    return _signup("headerbot")


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_create_lobby_accepts_authorization_header(user):
    created = client.post("/api/v1/lobbies", headers=_auth(user["token"]), json={"name": "Vault Run"})
    assert created.status_code == 200, created.text
    lobby = created.json()
    assert lobby["host_user_id"] == user["user"]["id"]

    # Header auth works on GET too.
    mine = client.get("/api/v1/lobbies/mine", headers=_auth(user["token"]))
    assert mine.status_code == 200
    assert any(l["lobby_id"] == lobby["lobby_id"] for l in mine.json()["lobbies"])

    detail = client.get(f"/api/v1/lobbies/{lobby['lobby_id']}", headers=_auth(user["token"]))
    assert detail.status_code == 200


def test_lobby_query_param_still_accepted_for_backcompat(user):
    created = client.post(
        "/api/v1/lobbies", params={"token": user["token"]}, json={"name": "Legacy Run"}
    )
    assert created.status_code == 200, created.text
    mine = client.get("/api/v1/lobbies/mine", params={"token": user["token"]})
    assert mine.status_code == 200


def test_character_routes_accept_header_and_query(user):
    payload = {
        "name": "Sera Vail", "character_class": "rogue", "level": 2,
        "abilities": {"STR": 10, "DEX": 16, "CON": 14, "INT": 12, "WIS": 10, "CHA": 14},
        "hp": 18, "ac": 14, "speed": 30,
    }
    created = client.post("/api/v1/characters", headers=_auth(user["token"]), json=payload)
    assert created.status_code == 200, created.text
    character_id = created.json()["character_id"]

    listing = client.get("/api/v1/characters", headers=_auth(user["token"]))
    assert listing.status_code == 200
    assert any(c["character_id"] == character_id for c in listing.json()["characters"])

    detail = client.get(f"/api/v1/characters/{character_id}", headers=_auth(user["token"]))
    assert detail.status_code == 200
    assert detail.json()["name"] == "Sera Vail"

    # Back-compat: the same routes still honor ?token=.
    legacy_list = client.get("/api/v1/characters", params={"token": user["token"]})
    assert legacy_list.status_code == 200
    assert any(c["character_id"] == character_id for c in legacy_list.json()["characters"])


def test_campaign_save_roundtrip_with_header_auth(user):
    snapshot = {"tokens": [{"id": "t1", "x": 1, "y": 2}], "messages": []}
    saved = client.post(
        "/api/v1/campaign/save",
        headers=_auth(user["token"]),
        json={"name": "Header Save", "snapshot": snapshot, "round_number": 4},
    )
    assert saved.status_code == 200, saved.text
    save_id = saved.json()["save_id"]

    listing = client.get("/api/v1/campaign/saves", headers=_auth(user["token"]))
    assert listing.status_code == 200
    assert any(s["save_id"] == save_id for s in listing.json()["saves"])

    loaded = client.get(f"/api/v1/campaign/save/{save_id}", headers=_auth(user["token"]))
    assert loaded.status_code == 200
    assert loaded.json()["snapshot"]["tokens"][0]["id"] == "t1"

    deleted = client.delete(f"/api/v1/campaign/save/{save_id}", headers=_auth(user["token"]))
    assert deleted.status_code == 200

    # Legacy body-token save path still works for old clients.
    legacy = client.post(
        "/api/v1/campaign/save",
        json={"token": user["token"], "name": "Legacy Save", "snapshot": {}, "round_number": 1},
    )
    assert legacy.status_code == 200


def test_header_wins_over_stale_query_token(user):
    """A valid header must not be poisoned by a garbage query param."""
    resp = client.get(
        "/api/v1/characters",
        params={"token": "not-a-token"},
        headers=_auth(user["token"]),
    )
    assert resp.status_code == 200


def test_missing_token_is_401_on_migrated_routes():
    for method, path in (
        ("get", "/api/v1/lobbies/mine"),
        ("post", "/api/v1/lobbies"),
        ("get", "/api/v1/characters"),
        ("get", "/api/v1/campaign/saves"),
    ):
        resp = getattr(client, method)(path, **({"json": {}} if method == "post" else {}))
        assert resp.status_code == 401, f"{method.upper()} {path} -> {resp.status_code}"


def test_tampered_bearer_token_rejected(user):
    token = user["token"]
    tampered = token[:-4] + ("0000" if not token.endswith("0000") else "1111")
    resp = client.get("/api/v1/characters", headers={"Authorization": f"Bearer {tampered}"})
    assert resp.status_code == 401
