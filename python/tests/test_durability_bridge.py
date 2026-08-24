"""Tests for the engine-session durability bridge and .vttbundle import."""

import base64

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.routing.engine_client import EngineUnavailableError
from vtt_orchestrator.server import app

client = TestClient(app)


@pytest.fixture()
def gm_token(request):
    email = f"gm_bridge_{abs(hash(request.node.name)) % 10**8}@example.com"
    signup = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": email.split("@")[0], "display_name": "Bridge GM", "password": "dice-dice", "role": "gm"},
    )
    assert signup.status_code == 200, signup.text
    return signup.json()["token"]


def _spawn_ok(token: str) -> str:
    # Direct engine call: raises EngineUnavailableError (wrapping
    # httpx.ConnectError) BEFORE any gateway status code exists to inspect,
    # so a downstream `if resp.status_code == 502` guard would be dead code.
    try:
        created = engine_client.engine_request_sync(
            "POST",
            "/api/v1/sessions",
            {"campaign_id": "00000000-0000-0000-0000-000000000003",
             "session_name": "Durability Test"},
        )
    except EngineUnavailableError:
        pytest.skip("engine not running")
    session_id = created["session_id"]
    resp = client.post(
        "/api/v1/engine-session/persist",
        params={"token": token},
        json={"session_id": session_id},
    )
    assert resp.status_code == 200, resp.text
    return session_id


def test_persist_then_hydrate_roundtrip(gm_token):
    session_id = _spawn_ok(gm_token)

    hydrate = client.post(
        "/api/v1/engine-session/hydrate",
        params={"token": gm_token},
        json={"session_id": session_id},
    )
    # The live engine still holds this session, so restore succeeds.
    if hydrate.status_code == 502:
        pytest.skip("engine not running")
    assert hydrate.status_code == 200
    body = hydrate.json()
    assert body["status"] == "HYDRATED"
    assert body["engine_response"]["status"] == "RESTORED"


def test_hydrate_unknown_session_404(gm_token):
    resp = client.post(
        "/api/v1/engine-session/hydrate",
        params={"token": gm_token},
        json={"session_id": "00000000-0000-0000-0000-00000000dead".replace("dead", "deed")},
    )
    assert resp.status_code == 404


def test_bundle_import_hydrates_engine_session(gm_token):
    from vtt_orchestrator.compendium.bundle_packager import CampaignBundlePackager

    packer = CampaignBundlePackager()
    zip_bytes = packer.export_bundle({
        "title": "The Sunken Crypt of Karas",
        "grid_dimensions": {"width": 20, "height": 20},
        "walls": [{"x": 10, "y": 0}, {"x": 10, "y": 1}, {"x": 10, "y": 2}],
        "tokens": [
            {"id": "tok-hero", "name": "Kara", "is_player": True,
             "x": 2.5, "y": 2.5, "hp": 22, "ac": 15},
            {"id": "tok-bones", "name": "Bone Crawler", "is_player": False,
             "x": 17.0, "y": 17.0, "hp": 30, "ac": 13},
        ],
    })

    resp = client.post(
        "/api/v1/campaign/import-bundle",
        params={"token": gm_token},
        json={"bundle_b64": base64.b64encode(zip_bytes).decode(),
              "session_name": "Karas Run"},
    )
    if resp.status_code == 502:
        pytest.skip("engine not running")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "IMPORTED"
    assert body["map_walls_applied"] == 3
    assert body["tokens_spawned"] == 2
    assert body["title"] == "The Sunken Crypt of Karas"


def test_bundle_import_requires_auth():
    resp = client.post(
        "/api/v1/campaign/import-bundle",
        json={"bundle_b64": "AAAA", "session_name": "x"},
    )
    assert resp.status_code == 422, "missing token must fail validation"


def test_corrupt_bundle_rejected(gm_token):
    resp = client.post(
        "/api/v1/campaign/import-bundle",
        params={"token": gm_token},
        json={"bundle_b64": base64.b64encode(b"not a zip").decode()},
    )
    assert resp.status_code in (400, 422)
