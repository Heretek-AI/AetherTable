"""Tests for orchestrator-backed identity & sessions (/api/v1/auth/*)."""

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.server import app

client = TestClient(app)


@pytest.fixture()
def fresh_account(request):
    email = f"player_{abs(hash(request.node.name)) % 10**8}@aethertable.io"
    password = "secret-dice"
    resp = client.post(
        "/api/v1/auth/signup",
        json={
            "email": email,
            "display_name": "Test Hero",
            "password": password,
            "role": "player",
        },
    )
    assert resp.status_code == 200, resp.text
    return {"email": email, "password": password}


def test_signup_login_and_session_roundtrip(fresh_account):
    login = client.post(
        "/api/v1/auth/login",
        json={"email": fresh_account["email"], "password": fresh_account["password"]},
    )
    assert login.status_code == 200
    body = login.json()
    assert body["user"]["role"] == "player"
    assert body["expires_in"] > 0

    session = client.get("/api/v1/auth/session", params={"token": body["token"]})
    assert session.status_code == 200
    assert session.json()["valid"] is True
    assert session.json()["user"]["email"] == fresh_account["email"]


def test_wrong_password_rejected():
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "gm@aethertable.io", "password": "wrong-password"},
    )
    assert resp.status_code == 401


def test_gm_seed_account_is_env_gated(monkeypatch):
    """The hardcoded dev backdoor is gone: seed credentials must come from
    AETHERTABLE_SEED_GM_* env vars and nothing seeds without them."""
    from vtt_orchestrator import server as server_mod

    monkeypatch.setattr(server_mod, "SEED_GM_EMAIL", "")
    monkeypatch.setattr(server_mod, "SEED_GM_PASSWORD", "")
    denied = client.post(
        "/api/v1/auth/login", json={"email": "seeded-gm@example.com", "password": "provisioned"}
    )
    assert denied.status_code == 401

    email = f"seeded_gm_{abs(hash('env')) % 10**8}@example.com"
    monkeypatch.setattr(server_mod, "SEED_GM_EMAIL", email)
    monkeypatch.setattr(server_mod, "SEED_GM_PASSWORD", "provisioned-secret")
    seeded = client.post(
        "/api/v1/auth/login", json={"email": email, "password": "provisioned-secret"}
    )
    assert seeded.status_code == 200
    assert seeded.json()["user"]["role"] == "gm"


def test_lore_assertion_requires_auth(fresh_account):
    """Unauthenticated writes to shared lore canon are refused."""
    payload = {
        "proposing_entity_id": "npc_test_1",
        "subject_node_id": "Tavern_Room",
        "predicate_relation": "RULES",
        "object_node_id": "Keeper_Garrick",
        "context_sentence": "The keeper rules the tavern.",
        "epistemic_tier": "SUBJECTIVE_RUMOR",
    }
    anon = client.post("/api/v1/lore/assert", json=payload)
    assert anon.status_code == 422, "missing token query param must fail validation"

    login = client.post(
        "/api/v1/auth/login",
        json={"email": fresh_account["email"], "password": fresh_account["password"]},
    )
    token = login.json()["token"]
    ok = client.post("/api/v1/lore/assert", params={"token": token}, json=payload)
    assert ok.status_code == 200


def test_tampered_token_rejected(fresh_account):
    login = client.post(
        "/api/v1/auth/login",
        json={"email": fresh_account["email"], "password": fresh_account["password"]},
    )
    token = login.json()["token"]
    tampered = token[:-4] + ("0000" if not token.endswith("0000") else "1111")
    resp = client.get("/api/v1/auth/session", params={"token": tampered})
    assert resp.status_code == 401


def test_duplicate_signup_conflict(fresh_account):
    resp = client.post(
        "/api/v1/auth/signup",
        json={"email": fresh_account["email"], "password": fresh_account["password"]},
    )
    assert resp.status_code == 409
