"""Auth hardening for the durability bridge and legacy Query-token routes.

Iteration 8 follow-ups to the gateway auth migration:

* ``POST /api/v1/engine-session/persist`` and ``POST /api/v1/engine-session/hydrate``
  used to be publicly routable, state-mutating endpoints that spoke to the
  engine as the service principal. They now require an authenticated caller,
  and further restrict session-affecting work to gm/admin tokens or members of
  a lobby bound to that engine session — mirroring the x-card rewind model
  (unbound sessions fail CLOSED to staff only, because there is no roster
  proving a player's standing).
* The legacy routes that still declared ``token: str = Query(...)`` —
  DELETE character, campaign bundle import, auth/session, lore/assert —
  rejected header-only callers at validation (Query-required ignores
  Authorization headers) and leaked tokens into URLs/logs. They now resolve
  the token via ``_require_auth`` (Bearer header first, ?token= back-compat).
"""

import base64
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.server import app

client = TestClient(app)


def _signup(name: str, role: str = "player") -> dict:
    email = f"{name}_{abs(hash(name + str(time.time()))) % 10**8}@example.com"
    resp = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": name, "display_name": name.title(),
              "password": "dice-dice", "role": role},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture()
def gm():
    return _signup("durabot_gm", "gm")


@pytest.fixture()
def player():
    return _signup("durabot_player", "player")


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _tamper(token: str) -> str:
    return token[:-4] + ("0000" if not token.endswith("0000") else "1111")


# --- Durability bridge: authentication -----------------------------------------


def test_anonymous_persist_rejected():
    resp = client.post(
        "/api/v1/engine-session/persist",
        json={"session_id": "00000000-0000-0000-0000-000000000001"},
    )
    assert resp.status_code == 401


def test_anonymous_hydrate_rejected():
    resp = client.post(
        "/api/v1/engine-session/hydrate",
        json={"session_id": "00000000-0000-0000-0000-000000000001"},
    )
    assert resp.status_code == 401


def test_tampered_token_on_bridge_rejected(gm):
    for path in ("/api/v1/engine-session/persist", "/api/v1/engine-session/hydrate"):
        resp = client.post(path, headers=_auth(_tamper(gm["token"])),
                           json={"session_id": "00000000-0000-0000-0000-000000000001"})
        assert resp.status_code == 401, f"{path} -> {resp.status_code}"


# --- Durability bridge: authorization ------------------------------------------


def test_unbound_player_forbidden_on_bridge(player):
    """A valid player token naming a session they have no lobby roster for must
    get 403 — the bridge binds/restores whole sessions, which is not a
    bystander operation."""
    for path in ("/api/v1/engine-session/persist", "/api/v1/engine-session/hydrate"):
        resp = client.post(path, headers=_auth(player["token"]),
                           json={"session_id": "00000000-0000-0000-0000-00000000beef"})
        assert resp.status_code == 403, f"{path} -> {resp.status_code}"


def test_gm_header_auth_passes_bridge_authz_to_handler(gm):
    """A gm Bearer-header caller clears the auth/authz gate and reaches the
    handler: hydrating a session with no snapshot yields the honest 404 (this
    path never touches the engine, so it proves the gate without one)."""
    resp = client.post(
        "/api/v1/engine-session/hydrate",
        headers=_auth(gm["token"]),
        json={"session_id": "00000000-0000-0000-0000-00000000dead".replace("dead", "deed")},
    )
    assert resp.status_code == 404, resp.text

    # Back-compat: the legacy ?token= channel still works on the same route.
    legacy = client.post(
        "/api/v1/engine-session/hydrate",
        params={"token": gm["token"]},
        json={"session_id": "00000000-0000-0000-0000-00000000dead".replace("dead", "deed")},
    )
    assert legacy.status_code == 404, legacy.text


# --- Legacy Query-token routes migrated to _require_auth -----------------------


def test_delete_character_accepts_header_only_caller():
    user = _signup("deletebot")
    payload = {
        "name": "Moro Dann", "character_class": "fighter", "level": 1,
        "abilities": {"STR": 16, "DEX": 12, "CON": 14, "INT": 10, "WIS": 10, "CHA": 10},
        "hp": 12, "ac": 16, "speed": 30,
    }
    created = client.post("/api/v1/characters", headers=_auth(user["token"]), json=payload)
    assert created.status_code == 200, created.text
    character_id = created.json()["character_id"]

    # No query string anywhere: Authorization header only.
    deleted = client.delete(f"/api/v1/characters/{character_id}", headers=_auth(user["token"]))
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["status"] == "DELETED"

    again = client.delete(f"/api/v1/characters/{character_id}", headers=_auth(user["token"]))
    assert again.status_code == 404


def test_delete_character_rejects_bad_tokens():
    user = _signup("deletebot2")
    payload = {
        "name": "Sif", "character_class": "rogue", "level": 1,
        "abilities": {"STR": 10, "DEX": 16, "CON": 12, "INT": 10, "WIS": 10, "CHA": 10},
        "hp": 8, "ac": 14, "speed": 30,
    }
    created = client.post("/api/v1/characters", headers=_auth(user["token"]), json=payload)
    character_id = created.json()["character_id"]

    anon = client.delete(f"/api/v1/characters/{character_id}")
    assert anon.status_code == 401
    bad = client.delete(f"/api/v1/characters/{character_id}", headers=_auth(_tamper(user["token"])))
    assert bad.status_code == 401


def test_import_campaign_bundle_header_only_reaches_validation():
    """Header-only callers must clear auth and reach the bundle parser (a
    corrupt bundle gives the parser's 4xx, proving auth no longer gates on the
    query string)."""
    user = _signup("importbot_hdr")
    resp = client.post(
        "/api/v1/campaign/import-bundle",
        headers=_auth(user["token"]),
        json={"bundle_b64": base64.b64encode(b"not a zip").decode()},
    )
    assert resp.status_code in (400, 422), resp.text
    # A 422 from FastAPI *validation* would name the missing `token` query
    # param; the parser's rejection talks about the bundle itself.
    assert "token" not in str(resp.json().get("detail", "")), (
        "header-only caller still gated by Query-required token validation"
    )


def test_import_campaign_bundle_rejects_anonymous_and_tampered():
    anon = client.post("/api/v1/campaign/import-bundle",
                       json={"bundle_b64": base64.b64encode(b"x").decode()})
    assert anon.status_code == 401
    user = _signup("importbot_bad")
    bad = client.post("/api/v1/campaign/import-bundle",
                      headers=_auth(_tamper(user["token"])), json={"bundle_b64": "AAAA"})
    assert bad.status_code == 401


def test_auth_session_accepts_bearer_header():
    user = _signup("sessbot")
    resp = client.get("/api/v1/auth/session", headers=_auth(user["token"]))
    assert resp.status_code == 200
    assert resp.json()["valid"] is True
    assert resp.json()["user"]["id"] == user["user"]["id"]

    bad = client.get("/api/v1/auth/session", headers=_auth(_tamper(user["token"])))
    assert bad.status_code == 401
    anon = client.get("/api/v1/auth/session")
    assert anon.status_code == 401


def test_lore_assert_accepts_bearer_header(player):
    tag = f"hdr_{abs(hash(time.time())) % 10**6}"
    payload = {
        "proposing_entity_id": "npc_test_1",
        "subject_node_id": f"Subject_{tag}",
        "predicate_relation": "ALLIES_WITH",
        "object_node_id": f"Object_{tag}",
        "context_sentence": f"{tag} allies with its object.",
        "epistemic_tier": "SUBJECTIVE_RUMOR",
    }
    resp = client.post("/api/v1/lore/assert", headers=_auth(player["token"]), json=payload)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] in ("COMMITTED", "STAGED")

    bad = client.post("/api/v1/lore/assert", headers=_auth(_tamper(player["token"])), json=payload)
    assert bad.status_code == 401
