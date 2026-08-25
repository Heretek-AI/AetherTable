"""Auth enforcement on the quest routes.

POST /api/v1/quest/generate, GET /api/v1/quest/active, and
POST /api/v1/quest/concordia-negotiate mutate gateway-side state (the
module-level ``active_campaign_quest`` graph) yet shipped without any token
dependency while the client gated them as GM-only advisory UI. These tests pin
the server-side contract: every quest route requires a session token (401),
generation is GM/admin-only (403), and reading the active graph is open to any
authenticated role.
"""

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.server import app

client = TestClient(app)


@pytest.fixture()
def gm_token(request, monkeypatch):
    # Staff roles are not self-service-grantable (audit F6a); this exercises
    # the operator bootstrap path instead: a VTT_ADMIN_EMAILS address is
    # created as admin at signup and the quest gate accepts gm OR admin.
    email = f"gm_quest_{abs(hash(request.node.name)) % 10**8}@example.com"
    monkeypatch.setenv("VTT_ADMIN_EMAILS", email)
    signup = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": email.split("@")[0], "display_name": "Quest GM",
              "password": "dice-dice"},
    )
    assert signup.status_code == 200, signup.text
    assert signup.json()["user"]["role"] == "admin", signup.text
    return signup.json()["token"]


@pytest.fixture()
def player_token(request):
    email = f"pl_quest_{abs(hash(request.node.name)) % 10**8}@example.com"
    signup = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": email.split("@")[0], "display_name": "Player One",
              "password": "dice-dice", "role": "player"},
    )
    assert signup.status_code == 200, signup.text
    return signup.json()["token"]


class TestQuestGenerateAuth:
    def test_unauthenticated_generate_is_401(self):
        resp = client.post(
            "/api/v1/quest/generate",
            json={"campaign_theme": "The Iron Succession"},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Missing session token"

    def test_player_generate_is_403(self, player_token):
        resp = client.post(
            "/api/v1/quest/generate",
            params={"token": player_token},
            json={"campaign_theme": "The Iron Succession"},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "QUEST_GENERATION_GM_ONLY"

    def test_gm_generate_succeeds_and_activates_graph(self, gm_token):
        resp = client.post(
            "/api/v1/quest/generate",
            params={"token": gm_token},
            json={"campaign_theme": "The Iron Succession"},
        )
        assert resp.status_code == 200, resp.text

        # Generation has the side effect of activating the graph; the GM's
        # authenticated read of /quest/active returns THAT graph.
        active = client.get("/api/v1/quest/active", params={"token": gm_token})
        assert active.status_code == 200, active.text


class TestActiveQuestRead:
    def test_unauthenticated_read_is_401(self):
        resp = client.get("/api/v1/quest/active")
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Missing session token"

    def test_any_authenticated_role_may_read(self, player_token, gm_token):
        # Seed an activated graph as GM first so the read path does not have to
        # lazily generate one for a player.
        seed = client.post(
            "/api/v1/quest/generate", params={"token": gm_token}, json={}
        )
        assert seed.status_code == 200, seed.text

        for token in (gm_token, player_token):
            resp = client.get("/api/v1/quest/active", params={"token": token})
            assert resp.status_code == 200, resp.text


class TestConcordiaNegotiateAuth:
    def test_unauthenticated_negotiate_is_401(self):
        resp = client.post("/api/v1/quest/concordia-negotiate", json={})
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Missing session token"

    def test_player_negotiate_succeeds(self, player_token):
        # Negotiation is a read-style pact computation over supplied inputs; it
        # requires a token but not a GM role.
        resp = client.post(
            "/api/v1/quest/concordia-negotiate",
            params={"token": player_token},
            json={},
        )
        assert resp.status_code == 200, resp.text
