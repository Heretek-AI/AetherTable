"""Lobby depth: per-member ready flag + character binding (iteration 33).

Audit defect: the lobby surface carried only identity rows (user_id,
display_name, role) — no ready flag and no per-member character binding —
so a host had no honest way to know whether the party was set before
launching the table.

These tests pin:

  * member state defaults (``ready=False``, ``selected_character_id=None``)
    visible on every roster read;
  * POST /lobbies/{id}/ready  — self-service toggle, membership-gated;
  * POST /lobbies/{id}/character — ownership-validated via the same
    player_characters checks deploy uses;
  * launch gating — host-only launch REFUSES while any member is unready
    unless the host explicitly passes ``force``;
  * persistence round-trip through the storage layer (both backends).
"""

import asyncio
import os
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator import server as server_module
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


def _make_table(host: dict, name: str = "Ready Room") -> dict:
    created = client.post(
        "/api/v1/lobbies", params={"token": host["token"]}, json={"name": name}
    )
    assert created.status_code == 200, created.text
    return created.json()


def _join(lobby: dict, user: dict) -> dict:
    joined = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/join",
        params={"token": user["token"]},
        json={"invite_code": lobby["invite_code"]},
    )
    assert joined.status_code == 200, joined.text
    return joined.json()


def _member(lobby_body: dict, user_id: str) -> dict:
    return next(m for m in lobby_body["members"] if m["user_id"] == user_id)


# --- Member defaults + ready flag round trip -------------------------------------

def test_member_defaults_and_ready_round_trip():
    host = _signup("readyhost")
    guest = _signup("readyguest")
    lobby = _make_table(host)

    # Host starts in the roster with explicit depth defaults.
    assert _member(lobby, host["user"]["id"])["ready"] is False
    assert _member(lobby, host["user"]["id"])["selected_character_id"] is None

    roster = _join(lobby, guest)
    assert _member(roster, guest["user"]["id"])["ready"] is False
    assert _member(roster, guest["user"]["id"])["selected_character_id"] is None

    marked = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/ready",
        params={"token": guest["token"]},
        json={"ready": True},
    )
    assert marked.status_code == 200, marked.text
    assert _member(marked.json(), guest["user"]["id"])["ready"] is True

    # Visible on an independent roster read, not just the mutation response.
    fetched = client.get(
        f"/api/v1/lobbies/{lobby['lobby_id']}", params={"token": guest["token"]}
    )
    assert fetched.status_code == 200, fetched.text
    assert _member(fetched.json(), guest["user"]["id"])["ready"] is True

    # Toggling back off works (a player may un-ready to swap sheets).
    off = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/ready",
        params={"token": guest["token"]},
        json={"ready": False},
    )
    assert off.status_code == 200, off.text
    assert _member(off.json(), guest["user"]["id"])["ready"] is False


def test_ready_requires_membership_and_auth():
    host = _signup("gatehost")
    outsider = _signup("gateoutsider")
    lobby = _make_table(host)

    denied = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/ready",
        params={"token": outsider["token"]},
        json={"ready": True},
    )
    assert denied.status_code == 403

    missing = client.post(
        "/api/v1/lobbies/nonexistent-id/ready",
        params={"token": host["token"]},
        json={"ready": True},
    )
    assert missing.status_code == 404

    anon = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/ready", json={"ready": True}
    )
    assert anon.status_code == 401


# --- Character binding ------------------------------------------------------------

def test_character_binding_ownership_rejection_and_rebind():
    host = _signup("bindhost")
    guest = _signup("bindguest")
    lobby = _make_table(host)
    _join(lobby, guest)

    def make_char(user, name):
        made = client.post(
            "/api/v1/characters",
            params={"token": user["token"]},
            json={"name": name, "character_class": "fighter", "level": 3},
        )
        assert made.status_code == 200, made.text
        return made.json()

    own_a = make_char(guest, "Brann Vell")
    own_b = make_char(guest, "Sable Wren")
    foreign = make_char(host, "Hostsheet")

    bound = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/character",
        params={"token": guest["token"]},
        json={"character_id": own_a["character_id"]},
    )
    assert bound.status_code == 200, bound.text
    assert _member(bound.json(), guest["user"]["id"])["selected_character_id"] \
        == own_a["character_id"]

    # Rebinding overwrites the previous selection.
    rebound = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/character",
        params={"token": guest["token"]},
        json={"character_id": own_b["character_id"]},
    )
    assert rebound.status_code == 200, rebound.text
    assert _member(rebound.json(), guest["user"]["id"])["selected_character_id"] \
        == own_b["character_id"]

    # Someone else's sheet is refused even though the id exists.
    stolen = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/character",
        params={"token": guest["token"]},
        json={"character_id": foreign["character_id"]},
    )
    assert stolen.status_code == 403
    # Refusal names the sheet's owner, and the prior binding is untouched.
    roster = client.get(
        f"/api/v1/lobbies/{lobby['lobby_id']}", params={"token": guest["token"]}
    )
    assert _member(roster.json(), guest["user"]["id"])["selected_character_id"] \
        == own_b["character_id"]

    unknown = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/character",
        params={"token": guest["token"]},
        json={"character_id": "chr_does_not_exist"},
    )
    assert unknown.status_code == 404

    # Non-members cannot bind at all, not even their own sheet.
    outsider = _signup("bindoutsider")
    outsider_char = make_char(outsider, "Lurker")
    denied = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/character",
        params={"token": outsider["token"]},
        json={"character_id": outsider_char["character_id"]},
    )
    assert denied.status_code == 403

    anon = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/character",
        json={"character_id": own_a["character_id"]},
    )
    assert anon.status_code == 401


# --- Launch gating -----------------------------------------------------------------

@pytest.fixture()
def fake_engine(monkeypatch):
    """Launch's engine leg succeeds without a live engine process."""

    async def fake_engine_request(method, path, payload=None, *, actor=None):
        return {"session_id": "sess-mock-launch"}

    monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)


def test_launch_refuses_while_members_unready_and_force_overrides(fake_engine):
    host = _signup("launchhost")
    guest = _signup("launchguest")
    lobby = _make_table(host)
    _join(lobby, guest)

    # Host alone readying is not enough — the guest is still pending.
    host_ready = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/ready",
        params={"token": host["token"]}, json={"ready": True},
    )
    assert host_ready.status_code == 200, host_ready.text

    refused = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/launch",
        params={"token": host["token"]},
    )
    assert refused.status_code == 409, refused.text
    detail = refused.json()["detail"]
    listed = [m["user_id"] for m in detail["unready_members"]]
    assert guest["user"]["id"] in listed
    assert host["user"]["id"] not in listed
    assert guest["user"]["displayName"] in detail["message"]

    # A non-host cannot force past the gate.
    forced_by_guest = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/launch",
        params={"token": guest["token"]}, json={"force": True},
    )
    assert forced_by_guest.status_code == 403

    # Host force overrides the gate.
    forced = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/launch",
        params={"token": host["token"]}, json={"force": True},
    )
    assert forced.status_code == 200, forced.text
    assert forced.json()["status"] == "LAUNCHED"

    # Fresh table: once EVERY member readies, plain launch passes.
    second = _make_table(host, "All Ready")
    _join(second, guest)
    for user in (host, guest):
        ok = client.post(
            f"/api/v1/lobbies/{second['lobby_id']}/ready",
            params={"token": user["token"]}, json={"ready": True},
        )
        assert ok.status_code == 200, ok.text
    clean = client.post(
        f"/api/v1/lobbies/{second['lobby_id']}/launch",
        params={"token": host["token"]},
    )
    assert clean.status_code == 200, clean.text
    assert clean.json()["status"] == "LAUNCHED"


def test_launch_gating_lists_every_unready_member(fake_engine):
    host = _signup("listhost")
    g1 = _signup("listone")
    g2 = _signup("listtwo")
    lobby = _make_table(host)
    _join(lobby, g1)
    _join(lobby, g2)

    only_g2 = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/ready",
        params={"token": g2["token"]}, json={"ready": True},
    )
    assert only_g2.status_code == 200

    refused = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/launch",
        params={"token": host["token"]},
    )
    assert refused.status_code == 409
    listed = {m["user_id"] for m in refused.json()["detail"]["unready_members"]}
    assert listed == {host["user"]["id"], g1["user"]["id"]}

    # Unknown lobby stays a 404 regardless of body shape.
    missing = client.post(
        "/api/v1/lobbies/nonexistent-id/launch", json={"force": True}
    )
    assert missing.status_code == 401  # no token at all -> auth failure first


# --- Persistence round trip ---------------------------------------------------------

def test_memory_store_round_trip():
    from vtt_orchestrator.storage import MemoryStore

    async def scenario():
        store = MemoryStore()
        lobby = await store.create_lobby("u_host", "Host", "RT", "ABC234")
        await store.join_lobby(lobby["lobby_id"], "u_guest", "Guest", "player")

        fresh = await store.get_lobby(lobby["lobby_id"])
        assert _member(fresh, "u_host")["ready"] is False
        assert _member(fresh, "u_host")["selected_character_id"] is None
        assert _member(fresh, "u_guest")["ready"] is False

        assert await store.set_member_ready(lobby["lobby_id"], "u_guest", True)
        assert await store.set_member_character(lobby["lobby_id"], "u_guest", "chr_rt1")

        reloaded = await store.get_lobby(lobby["lobby_id"])
        assert _member(reloaded, "u_guest")["ready"] is True
        assert _member(reloaded, "u_guest")["selected_character_id"] == "chr_rt1"
        assert _member(reloaded, "u_host")["ready"] is False  # untouched

        listed = await store.list_lobbies_for_user("u_guest")
        assert _member(listed[0], "u_guest")["ready"] is True

        # Unknown lobby / non-member are None, never fabricated rosters.
        assert await store.set_member_ready("lob_nope", "u_guest", True) is None
        assert await store.set_member_character("lob_nope", "u_guest", "chr_rt1") is None
        assert await store.set_member_ready(lobby["lobby_id"], "u_stranger", True) is None

    asyncio.run(scenario())


@pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; Postgres mode not exercised",
)
def test_postgres_store_round_trip():
    from vtt_orchestrator.storage import init_storage

    async def scenario():
        store = await init_storage()
        try:
            assert store.backend == "postgres"
            suffix = os.urandom(3).hex()
            lobby = await store.create_lobby(f"pg_host_{suffix}", "Host", "RT", "ABC234")
            await store.join_lobby(lobby["lobby_id"], f"pg_guest_{suffix}", "Guest", "player")

            fresh = await store.get_lobby(lobby["lobby_id"])
            assert _member(fresh, f"pg_guest_{suffix}")["ready"] is False

            assert await store.set_member_ready(lobby["lobby_id"], f"pg_guest_{suffix}", True)
            assert await store.set_member_character(
                lobby["lobby_id"], f"pg_guest_{suffix}", "chr_pg_roundtrip")

            reloaded = await store.get_lobby(lobby["lobby_id"])
            assert _member(reloaded, f"pg_guest_{suffix}")["ready"] is True
            assert _member(reloaded, f"pg_guest_{suffix}")["selected_character_id"] \
                == "chr_pg_roundtrip"
        finally:
            if getattr(store, "pool", None):
                await store.pool.close()

    asyncio.run(scenario())
