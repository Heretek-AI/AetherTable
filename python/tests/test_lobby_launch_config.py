"""Lobby launch configuration: rule_version, starting_level, party_size.

Iteration 71. GOALS.md P2's creation wizard needs the table's edition choice,
starting level and intended party size persisted SERVER-SIDE — today POST
/api/v1/lobbies accepts only ``{name}``, so the wizard's choices evaporate
before launch and every session inherits whatever the engine's environment
default is.

The rule-version machinery already exists on SESSIONS (iteration 34:
RuleVersion enum + VTT_DEFAULT_RULE_VERSION + persistence); these tests pin
that lobbies carry that same choice through to engine session creation:

  * POST /api/v1/lobbies accepts optional ``rule_version`` ("srd_5_1" |
    "srd_5_2", 422-validated like the engine), ``starting_level`` (int
    1..=20, default 1) and ``party_size`` (int 2..=8, default 4);
  * legacy callers posting exactly ``{"name": ...}`` keep working and see
    the defaults unchanged;
  * roster reads (create response, GET /lobbies/{id}, GET /lobbies/mine)
    expose all three fields;
  * host launch passes the lobby's ``rule_version`` into the engine session
    creation payload (asserted via a stubbed engine call);
  * storage round-trip in MemoryStore, and PostgresStore when DATABASE_URL
    is set.
"""

import asyncio
import os
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
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


def _make_table(host: dict, body: dict) -> dict:
    created = client.post(
        "/api/v1/lobbies", params={"token": host["token"]}, json=body
    )
    return created


# --- Create round trip ---------------------------------------------------------------

def test_create_with_all_fields_round_trips():
    host = _signup("cfg_host")
    resp = _make_table(host, {
        "name": "Greyhold 2024",
        "rule_version": "srd_5_2",
        "starting_level": 5,
        "party_size": 6,
    })
    assert resp.status_code == 200, resp.text
    lobby = resp.json()
    assert lobby["rule_version"] == "srd_5_2"
    assert lobby["starting_level"] == 5
    assert lobby["party_size"] == 6

    # Visible on an independent roster read, not just the create response.
    fetched = client.get(
        f"/api/v1/lobbies/{lobby['lobby_id']}", params={"token": host["token"]}
    )
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["rule_version"] == "srd_5_2"
    assert fetched.json()["starting_level"] == 5
    assert fetched.json()["party_size"] == 6

    mine = client.get("/api/v1/lobbies/mine", params={"token": host["token"]})
    assert mine.status_code == 200, mine.text
    row = next(l for l in mine.json()["lobbies"]
               if l["lobby_id"] == lobby["lobby_id"])
    assert row["rule_version"] == "srd_5_2"
    assert row["starting_level"] == 5
    assert row["party_size"] == 6


def test_legacy_payload_shape_keeps_defaults():
    """A caller posting the exact legacy body gets a lobby with the same
    defaults it always got — no new required fields, no behavior change."""
    host = _signup("legacy_host")
    resp = _make_table(host, {"name": "Old School"})
    assert resp.status_code == 200, resp.text
    lobby = resp.json()
    # The three legacy-era keys are still there and untouched.
    assert lobby["name"] == "Old School"
    assert lobby["invite_code"]
    assert lobby["host_user_id"] == host["user"]["id"]
    assert lobby["engine_session_id"] is None
    assert lobby["members"]
    # New fields surface with their defaults.
    assert lobby["rule_version"] is None
    assert lobby["starting_level"] == 1
    assert lobby["party_size"] == 4


# --- Validation (422 like the engine's RuleVersion parse) -----------------------------

@pytest.mark.parametrize("bad_body", [
    {"name": "Bad Edition", "rule_version": "srd_6_0"},
    {"name": "Bad Edition", "rule_version": ""},
    {"name": "Low Level", "starting_level": 0},
    {"name": "High Level", "starting_level": 21},
    {"name": "Tiny Party", "party_size": 1},
    {"name": "Big Party", "party_size": 9},
])
def test_invalid_values_are_422(bad_body):
    host = _signup("vld_host")
    resp = _make_table(host, bad_body)
    assert resp.status_code == 422, resp.text

    # Boundary values ARE accepted (inclusive ranges).
    ok = client.post(
        "/api/v1/lobbies", params={"token": host["token"]},
        json={"name": "Edges", "starting_level": 20, "party_size": 2},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["starting_level"] == 20
    assert ok.json()["party_size"] == 2


# --- Launch propagates rule_version ----------------------------------------------------

@pytest.fixture()
def capturing_engine(monkeypatch):
    """Stubbed engine leg that records the session-creation payload."""
    captured = {}

    async def fake_engine_request(method, path, payload=None, *, actor=None):
        captured["method"] = method
        captured["path"] = path
        captured["payload"] = dict(payload or {})
        return {"session_id": "sess-mock-cfg"}

    monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
    return captured


def _ready_everyone(lobby: dict, *users: dict):
    for user in users:
        marked = client.post(
            f"/api/v1/lobbies/{lobby['lobby_id']}/ready",
            params={"token": user["token"]}, json={"ready": True},
        )
        assert marked.status_code == 200, marked.text


def test_launch_propagates_rule_version(capturing_engine):
    host = _signup("launch_cfg_host")
    guest = _signup("launch_cfg_guest")
    made = _make_table(host, {
        "name": "Edition Locked",
        "rule_version": "srd_5_1",
        "starting_level": 3,
        "party_size": 5,
    })
    assert made.status_code == 200, made.text
    lobby = made.json()
    joined = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/join",
        params={"token": guest["token"]},
        json={"invite_code": lobby["invite_code"]},
    )
    assert joined.status_code == 200, joined.text
    _ready_everyone(lobby, host, guest)

    launched = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/launch",
        params={"token": host["token"]},
    )
    assert launched.status_code == 200, launched.text
    assert launched.json()["status"] == "LAUNCHED"

    assert capturing_engine["path"] == "/api/v1/sessions"
    payload = capturing_engine["payload"]
    # The edition choice rides along with the existing launch fields.
    assert payload.get("campaign_id")
    assert payload.get("session_name") == "Lobby Edition Locked"
    assert payload.get("rule_version") == "srd_5_1"

    # The launched session id is bound back onto the lobby either way.
    assert launched.json()["lobby"]["engine_session_id"] == "sess-mock-cfg"


def test_legacy_launch_payload_unchanged_when_no_rule_version(capturing_engine):
    host = _signup("launch_plain_host")
    made = _make_table(host, {"name": "Plain Table"})
    assert made.status_code == 200, made.text
    lobby = made.json()
    _ready_everyone(lobby, host)

    launched = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/launch",
        params={"token": host["token"]},
    )
    assert launched.status_code == 200, launched.text
    payload = capturing_engine["payload"]
    assert payload.get("campaign_id")
    # No edition preference was recorded, so none is asserted onto the engine;
    # the engine keeps applying its own VTT_DEFAULT_RULE_VERSION.
    assert "rule_version" not in payload


# --- Storage round trips -----------------------------------------------------------------

def test_memory_store_launch_config_round_trip():
    from vtt_orchestrator.storage import MemoryStore

    async def scenario():
        store = MemoryStore()
        configured = await store.create_lobby(
            "u_host", "Host", "RT Configured", "ABC234",
            rule_version="srd_5_2", starting_level=7, party_size=8,
        )
        assert configured["rule_version"] == "srd_5_2"
        assert configured["starting_level"] == 7
        assert configured["party_size"] == 8

        legacy = await store.create_lobby("u_host2", "Host", "RT Legacy", "DEF345")
        assert legacy["rule_version"] is None
        assert legacy["starting_level"] == 1
        assert legacy["party_size"] == 4

        fresh = await store.get_lobby(configured["lobby_id"])
        assert fresh["rule_version"] == "srd_5_2"
        assert fresh["starting_level"] == 7
        assert fresh["party_size"] == 8

        listed = await store.list_lobbies_for_user("u_host")
        row = next(l for l in listed if l["lobby_id"] == configured["lobby_id"])
        assert row["rule_version"] == "srd_5_2"
        assert row["starting_level"] == 7
        assert row["party_size"] == 8

    asyncio.run(scenario())


@pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; Postgres mode not exercised",
)
def test_postgres_store_launch_config_round_trip():
    from vtt_orchestrator.storage import init_storage

    async def scenario():
        store = await init_storage()
        try:
            assert store.backend == "postgres"
            suffix = os.urandom(3).hex()
            configured = await store.create_lobby(
                f"pg_host_{suffix}", "Host", "RT PG Configured", "GHI456",
                rule_version="srd_5_1", starting_level=11, party_size=3,
            )
            assert configured["rule_version"] == "srd_5_1"
            assert configured["starting_level"] == 11
            assert configured["party_size"] == 3

            legacy = await store.create_lobby(
                f"pg_host_{suffix}_b", "Host", "RT PG Legacy", "JKL567")
            assert legacy["rule_version"] is None
            assert legacy["starting_level"] == 1
            assert legacy["party_size"] == 4

            fresh = await store.get_lobby(configured["lobby_id"])
            assert fresh["rule_version"] == "srd_5_1"
            assert fresh["starting_level"] == 11
            assert fresh["party_size"] == 3
        finally:
            if getattr(store, "pool", None):
                await store.pool.close()

    asyncio.run(scenario())
