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


def test_default_gm_account_seeds_on_first_login():
    resp = client.post(
        "/api/v1/auth/login", json={"email": "gm@aethertable.io", "password": "dragonlance"}
    )
    assert resp.status_code == 200
    assert resp.json()["user"]["role"] == "gm"


def test_tampered_token_rejected():
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "gm@aethertable.io", "password": "dragonlance"},
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
