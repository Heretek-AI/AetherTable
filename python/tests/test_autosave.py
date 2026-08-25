"""Tests for GM-only campaign autosave.

POST /api/v1/campaign/autosave fetches LIVE engine state for a session and
wraps it as a campaign save snapshot through the existing create-save storage
path, so an autosave row is retrievable via the ordinary GET
/api/v1/campaign/save/{save_id} load path. Engine calls are faked here: the
durability bridge tests cover the live-engine round trip.
"""

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.routing.engine_client import EngineUnavailableError
from vtt_orchestrator.server import app

client = TestClient(app)

SESSION_ID = "00000000-0000-0000-0000-00000000a11s"


def _live_state() -> dict:
    return {
        "session_id": SESSION_ID,
        "entities": {
            "ent-hero": {"name": "Kara", "current_hp": 22, "is_conscious": True},
            "ent-bones": {"name": "Bone Crawler", "current_hp": 30, "is_conscious": True},
        },
        "ledger": {"events": [{"seq": 1}, {"seq": 2}, {"seq": 3}]},
        "combat": {"in_combat": True, "round": 4},
    }


@pytest.fixture()
def gm_token(request):
    # Minted directly rather than via /signup: staff roles are no longer
    # self-service-grantable (audit F6a), and this module asserts the GM role
    # verbatim as it travels to the engine. Other modules exercise the
    # VTT_ADMIN_EMAILS bootstrap path instead.
    from vtt_orchestrator.server import _sign_token

    import time as _time

    user_id = f"gm_auto_{abs(hash(request.node.name)) % 10**8}"
    return _sign_token({"user_id": user_id, "role": "gm",
                        "exp": _time.time() + 600})


@pytest.fixture()
def player_token(request):
    email = f"pl_auto_{abs(hash(request.node.name)) % 10**8}@example.com"
    signup = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": email.split("@")[0], "display_name": "Player One",
              "password": "dice-dice", "role": "player"},
    )
    assert signup.status_code == 200, signup.text
    return signup.json()["token"]


class TestCampaignAutosave:
    def test_gm_autosave_persists_retrievable_snapshot(self, gm_token, monkeypatch):
        seen = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            seen["method"], seen["path"], seen["actor"] = method, path, actor
            return _live_state()

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        resp = client.post(
            "/api/v1/campaign/autosave",
            params={"token": gm_token},
            json={"session_id": SESSION_ID, "name": "Crypt Run Checkpoint"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert set(body) == {"save_id", "round", "captured_at"}
        assert body["round"] == 4

        # The gateway fetched the authoritative state from the engine with the
        # caller's identity forwarded, not from any client-supplied payload.
        # (_coerce_uuid deterministically maps non-UUID session labels.)
        assert seen["method"] == "GET"
        assert seen["path"] == f"/api/v1/sessions/{engine_client._coerce_uuid(SESSION_ID)}"
        assert seen["actor"]["role"] == "gm"

        # Retrievable through the EXISTING save/load path owned by the caller.
        listing = client.get("/api/v1/campaign/saves", params={"token": gm_token}).json()
        assert listing["total"] == 1
        loaded = client.get(
            f"/api/v1/campaign/save/{body['save_id']}", params={"token": gm_token}
        )
        assert loaded.status_code == 200, loaded.text
        record = loaded.json()
        assert record["snapshot"]["round"] == 4
        assert record["snapshot"]["entities_count"] == 2
        assert record["snapshot"]["events_count"] == 3
        assert record["snapshot"]["snapshot"]["entities"]["ent-hero"]["current_hp"] == 22

    def test_player_role_forbidden_403(self, player_token, monkeypatch):
        called = []

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            called.append(path)
            return _live_state()

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        resp = client.post(
            "/api/v1/campaign/autosave",
            params={"token": player_token},
            json={"session_id": SESSION_ID},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "AUTOSAVE_GM_ONLY"
        # Fail closed BEFORE touching the engine or the store.
        assert called == []
        listing = client.get("/api/v1/campaign/saves", params={"token": player_token}).json()
        assert listing["total"] == 0

    def test_unreachable_engine_returns_502(self, gm_token, monkeypatch):
        async def dead_engine(method, path, payload=None, *, actor=None):
            raise EngineUnavailableError("connection refused")

        monkeypatch.setattr(engine_client, "engine_request", dead_engine)
        resp = client.post(
            "/api/v1/campaign/autosave",
            params={"token": gm_token},
            json={"session_id": SESSION_ID},
        )
        assert resp.status_code == 502
        # Honest failure: nothing half-saved under the autosave slot.
        listing = client.get("/api/v1/campaign/saves", params={"token": gm_token}).json()
        assert listing["total"] == 0

    def test_empty_session_still_saves(self, gm_token, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            return {
                "session_id": SESSION_ID,
                "entities": {},
                "ledger": {"events": []},
                "combat": {"in_combat": False, "round": 1},
            }

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = client.post(
            "/api/v1/campaign/autosave",
            params={"token": gm_token},
            json={"session_id": SESSION_ID},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["round"] == 1
        loaded = client.get(
            f"/api/v1/campaign/save/{body['save_id']}", params={"token": gm_token}
        ).json()
        assert loaded["snapshot"]["entities_count"] == 0
        assert loaded["snapshot"]["events_count"] == 0
