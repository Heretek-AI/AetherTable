"""Iteration 47: campaign-scoped gateway state survives a process restart.

The audit found that several pieces of SHARED campaign state lived only in
gateway process memory (module-level singletons): the active quest graph,
the faction simulation world state. This module pins down the durability
contract:

* POST /api/v1/campaign/autosave captures the durable-worthy pieces
  (active quest graph + faction sim state) alongside the verbatim engine
  snapshot, through the EXISTING campaign_saves storage path.
* After a simulated restart (module singletons reset to their import-time
  values), an authenticated GM reload restores what was saved instead of
  silently regenerating different canon.
* A non-GM or unauthenticated caller is refused BEFORE anything is applied.
* A corrupt save produces an honest 422 error, never a crash or silent
  regeneration.

Engine calls are faked here exactly as in test_autosave.py; the durability
bridge tests own the live-engine round trip.
"""

import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.server import app

client = TestClient(app)

SESSION_ID = "00000000-0000-0000-0000-00000000d47"


def _live_state() -> dict:
    return {
        "session_id": SESSION_ID,
        "entities": {"ent-hero": {"name": "Kara", "current_hp": 20}},
        "ledger": {"events": [{"seq": 1}]},
        "combat": {"in_combat": False},
    }


def _sign(user_id: str, role: str) -> str:
    from vtt_orchestrator.server import _sign_token

    return _sign_token(
        {"user_id": user_id, "role": role, "exp": time.time() + 600}
    )


@pytest.fixture()
def gm_token(request):
    return _sign(f"gm_dur_{abs(hash(request.node.name)) % 10**8}", "gm")


@pytest.fixture()
def player_token(request):
    email = f"pl_dur_{abs(hash(request.node.name)) % 10**8}@example.com"
    signup = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": email.split("@")[0],
              "display_name": "Player One", "password": "dice-dice",
              "role": "player"},
    )
    assert signup.status_code == 200, signup.text
    return signup.json()["token"]


def _reset_module_singletons() -> None:
    """Simulates a gateway restart: the process-memory singletons are back to
    their import-time values. (Re-importing the module would break every other
    holder of the app object, so the suite resets the singletons themselves.)"""
    import vtt_orchestrator.server as srv

    srv.active_campaign_quest = None
    srv.faction_sim.resources = 100


class TestAutosaveCapturesGatewayState:
    def test_autosave_snapshot_includes_quest_and_faction(self, gm_token, monkeypatch):
        import vtt_orchestrator.server as srv

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            return _live_state()

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        generated = client.post(
            "/api/v1/quest/generate",
            params={"token": gm_token},
            json={"campaign_theme": "The Iron Succession"},
        )
        assert generated.status_code == 200, generated.text
        quest_title = generated.json()["title"]

        saved = client.post(
            "/api/v1/campaign/autosave",
            params={"token": gm_token},
            json={"session_id": SESSION_ID, "name": "Durability Probe"},
        )
        assert saved.status_code == 200, saved.text
        save_id = saved.json()["save_id"]

        record = client.get(
            f"/api/v1/campaign/save/{save_id}", params={"token": gm_token}
        ).json()
        snap = record["snapshot"]
        # The verbatim engine payload keeps its original shape...
        assert snap["snapshot"]["session_id"] == SESSION_ID
        # ...and the gateway-owned campaign state rides along.
        assert isinstance(snap.get("quest"), dict), snap.keys()
        assert snap["quest"]["format"] == "quest_graph_v1"
        assert snap["quest"]["graph"]["title"] == quest_title
        assert snap["quest"]["graph"]["nodes"], "generated graph nodes serialized"
        faction = snap.get("faction_simulation")
        assert isinstance(faction, dict)
        assert set(faction) >= {"faction_name", "resources", "world_state"}
        assert faction["faction_name"] == srv.faction_sim.faction_name

    def test_no_active_quest_records_null_quest_slot(self, gm_token, monkeypatch):
        import vtt_orchestrator.server as srv

        srv.active_campaign_quest = None

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            return _live_state()

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        saved = client.post(
            "/api/v1/campaign/autosave",
            params={"token": gm_token},
            json={"session_id": SESSION_ID, "name": "No Quest Yet"},
        )
        assert saved.status_code == 200, saved.text
        record = client.get(
            f"/api/v1/campaign/save/{saved.json()['save_id']}",
            params={"token": gm_token},
        ).json()
        assert record["snapshot"]["quest"] is None


class TestRestartRestore:
    def test_active_quest_survives_restart_via_read(self, gm_token, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            return _live_state()

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        generated = client.post(
            "/api/v1/quest/generate",
            params={"token": gm_token},
            json={"campaign_theme": "The Iron Succession"},
        )
        assert generated.status_code == 200, generated.text
        expected = generated.json()
        saved = client.post(
            "/api/v1/campaign/autosave",
            params={"token": gm_token},
            json={"session_id": SESSION_ID, "name": "Quest Checkpoint"},
        )
        assert saved.status_code == 200, saved.text

        _reset_module_singletons()

        # Authenticated reload of the campaign: the journal read must serve the
        # PERSISTED graph, not quietly roll new canon.
        active = client.get("/api/v1/quest/active", params={"token": gm_token})
        assert active.status_code == 200, active.text
        body = active.json()
        assert body["quest_id"] == expected["quest_id"]
        assert body["title"] == expected["title"]
        assert body["nodes"] == expected["nodes"]

    def test_explicit_restore_returns_what_was_applied(self, gm_token, monkeypatch):
        import vtt_orchestrator.server as srv

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            return _live_state()

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        client.post(
            "/api/v1/quest/generate", params={"token": gm_token}, json={}
        )
        tick = client.post("/api/v1/simulation/tick", params={"token": gm_token})
        assert tick.status_code == 200, tick.text
        world_before = tick.json()["world_state"]

        saved = client.post(
            "/api/v1/campaign/autosave",
            params={"token": gm_token},
            json={"session_id": SESSION_ID, "name": "Restore Probe"},
        )
        assert saved.status_code == 200, saved.text
        save_id = saved.json()["save_id"]

        _reset_module_singletons()

        restored = client.post(
            "/api/v1/campaign/restore",
            params={"token": gm_token},
            json={"save_id": save_id},
        )
        assert restored.status_code == 200, restored.text
        body = restored.json()
        assert body["status"] == "restored"
        assert body["save_id"] == save_id
        assert body["quest"]["nodes"], "restored quest carries its graph"
        assert body["faction"]["world_state"] == world_before

        # Module state actually moved.
        assert srv.active_campaign_quest is not None
        assert srv.faction_sim.world_state == world_before

    def test_missing_save_is_404_not_crash(self, gm_token):
        resp = client.post(
            "/api/v1/campaign/restore",
            params={"token": gm_token},
            json={"save_id": "save_does_not_exist"},
        )
        assert resp.status_code == 404

    def test_other_users_save_is_invisible_to_restore(self, gm_token, player_token, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            return _live_state()

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        saved = client.post(
            "/api/v1/campaign/autosave",
            params={"token": gm_token},
            json={"session_id": SESSION_ID, "name": "Private Checkpoint"},
        )
        assert saved.status_code == 200
        save_id = saved.json()["save_id"]

        # A different owner cannot restore (or even probe) someone else's save.
        foreign = client.post(
            "/api/v1/campaign/restore",
            params={"token": _sign("some_other_user", "gm")},
            json={"save_id": save_id},
        )
        assert foreign.status_code == 404


class TestRestoreAuthRefusal:
    def test_unauthenticated_restore_refused(self, gm_token, player_token, monkeypatch):
        import vtt_orchestrator.server as srv

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            return _live_state()

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        saved = client.post(
            "/api/v1/campaign/autosave",
            params={"token": gm_token},
            json={"session_id": SESSION_ID, "name": "Auth Probe"},
        )
        assert saved.status_code == 200
        save_id = saved.json()["save_id"]

        no_token = client.post(
            "/api/v1/campaign/restore", json={"save_id": save_id}
        )
        assert no_token.status_code == 401

        _reset_module_singletons()
        player = client.post(
            "/api/v1/campaign/restore",
            params={"token": player_token},
            json={"save_id": save_id},
        )
        assert player.status_code == 403
        assert player.json()["detail"] != ""
        # Refused before mutating shared state.
        assert srv.active_campaign_quest is None


def _write_save_direct(owner: str, name: str, snapshot: dict) -> dict:
    """Writes a snapshot straight through the storage layer, bypassing the
    autosave route — how legacy rows and hand-corrupted rows arrive."""
    import asyncio

    import vtt_orchestrator.server as srv

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(
            srv.storage_backend.upsert_campaign_save(owner, name, snapshot, 1)
        )
    finally:
        loop.close()


class TestCorruptSaveHonesty:
    def test_corrupt_quest_payload_is_honest_422(self, gm_token):
        import vtt_orchestrator.server as srv

        owner = f"gm_dur_{abs(hash('TestCorruptSaveHonesty.test_corrupt_quest_payload_is_honest_422')) % 10**8}"
        # Structurally broken quest payload + non-numeric faction resources,
        # exactly what a truncated/edited row would look like.
        meta = _write_save_direct(
            owner, "Corrupt Save",
            {"round": 1, "quest": {"format": "quest_graph_v1",
                                   "graph": {"quest_id": "q1"}},
             "faction_simulation": {"faction_name": "Shadow Cabal",
                                    "resources": "not-a-number",
                                    "world_state": {}}},
        )
        save_id = meta["save_id"]

        _reset_module_singletons()

        # Explicit restore: honest 422 naming the corruption, never a 500.
        resp = client.post(
            "/api/v1/campaign/restore",
            params={"token": _sign(owner, "gm")},
            json={"save_id": save_id},
        )
        assert resp.status_code == 422, resp.text
        assert "CORRUPT" in resp.json()["detail"]

        # Read-path restore refuses the same way instead of silently
        # regenerating a different quest behind the GM's back.
        active = client.get("/api/v1/quest/active", params={"token": _sign(owner, "gm")})
        assert active.status_code == 422
        assert "CORRUPT" in active.json()["detail"]

        # The server is still healthy afterwards.
        assert client.get(
            "/api/v1/campaign/saves", params={"token": _sign(owner, "gm")}
        ).status_code == 200

    def test_save_without_gateway_state_still_loads(self, gm_token, monkeypatch):
        """A legacy save written before iteration 47 has no quest/faction slots;
        restoring it must succeed with an honest 'nothing to apply' rather than
        inventing state."""
        import vtt_orchestrator.server as srv

        owner = f"gm_dur_{abs(hash('TestCorruptSaveHonesty.test_save_without_gateway_state_still_loads')) % 10**8}"
        meta = _write_save_direct(owner, "Legacy Save", {"round": 3})

        _reset_module_singletons()
        resp = client.post(
            "/api/v1/campaign/restore",
            params={"token": _sign(owner, "gm")},
            json={"save_id": meta["save_id"]},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["quest"] is None
