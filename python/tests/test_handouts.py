"""Handout persistence: real backend surface for GOALS.md Pillar 2.

Covers the CRUD lifecycle under /api/v1/handouts plus the role-visibility
contract (players/spectators never see ``gm_only`` rows) and auth scoping.

Identities are exercised via directly minted signed tokens rather than
/signup calls: handout authorization reads ``role`` from the token payload
alone, and the whole-suite auth rate-limit bucket (30 requests / 60 s) is
already near capacity from the other test modules.
"""

import time
import uuid

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.server import app

client = TestClient(app)


def _token_for(user_id: str, role: str) -> str:
    """Mints a signed session token directly instead of signing up an account.

    Every /api/v1/handouts route authorizes from the signed payload alone
    (_caller_actor), so no DB-backed account is required here. This also keeps
    the module off the shared auth rate-limit bucket (30 requests / 60 s),
    which the rest of the suite already runs close to.
    """
    from vtt_orchestrator.server import _sign_token

    return _sign_token({"user_id": user_id, "role": role,
                        "exp": time.time() + 600})


@pytest.fixture(scope="module")
def gm():
    return {"token": _token_for("usr_handout_gm", "gm"),
            "user": {"id": "usr_handout_gm"}}


@pytest.fixture(scope="module")
def player():
    return {"token": _token_for("usr_handout_player", "player"),
            "user": {"id": "usr_handout_player"}}


@pytest.fixture()
def spectator_token():
    return _token_for("usr_handout_spectator", "spectator")


def _create(token: str, **overrides) -> dict:
    payload = {
        "title": "The Sunken Crypt",
        "content_md": "# The Crypt\n\n*Salt crusted stairs.*",
        "revealed_to": "all",
    }
    payload.update(overrides)
    resp = client.post("/api/v1/handouts", params={"token": token}, json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_handout_crud_lifecycle(gm):
    created = _create(gm["token"], revealed_to="party")
    assert created["title"] == "The Sunken Crypt"
    assert created["revealed_to"] == "party"
    assert created["content_md"].startswith("# The Crypt")
    assert created["created_by"] == gm["user"]["id"]
    assert created["handout_id"]

    fetched = client.get(
        f"/api/v1/handouts/{created['handout_id']}", params={"token": gm["token"]}
    )
    assert fetched.status_code == 200
    assert fetched.json()["handout_id"] == created["handout_id"]

    updated = client.put(
        f"/api/v1/handouts/{created['handout_id']}",
        params={"token": gm["token"]},
        json={"title": "The Drowned Crypt", "revealed_to": "all"},
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["title"] == "The Drowned Crypt"
    assert body["revealed_to"] == "all"
    # Unspecified fields survive a partial update.
    assert body["content_md"].startswith("# The Crypt")

    listing = client.get("/api/v1/handouts", params={"token": gm["token"]})
    assert listing.status_code == 200
    assert any(h["handout_id"] == created["handout_id"] for h in listing.json()["handouts"])

    deleted = client.delete(
        f"/api/v1/handouts/{created['handout_id']}", params={"token": gm["token"]}
    )
    assert deleted.status_code == 200

    gone = client.get(
        f"/api/v1/handouts/{created['handout_id']}", params={"token": gm["token"]}
    )
    assert gone.status_code == 404


def test_handout_list_scopes_by_campaign(gm):
    campaign_a = str(uuid.uuid4())
    campaign_b = str(uuid.uuid4())
    in_a = _create(gm["token"], campaign_id=campaign_a)
    in_b = _create(gm["token"], campaign_id=campaign_b)
    unscoped = _create(gm["token"])

    listing_a = client.get(
        "/api/v1/handouts", params={"token": gm["token"], "campaign_id": campaign_a}
    )
    ids = {h["handout_id"] for h in listing_a.json()["handouts"]}
    assert in_a["handout_id"] in ids
    assert in_b["handout_id"] not in ids
    assert unscoped["handout_id"] not in ids


def test_player_listing_excludes_gm_only_rows_but_sees_all_and_party(gm, player):
    public = _create(gm["token"], revealed_to="all")
    party = _create(gm["token"], revealed_to="party")
    secret = _create(gm["token"], revealed_to="gm_only")

    seen = client.get("/api/v1/handouts", params={"token": player["token"]}).json()
    ids = {h["handout_id"] for h in seen["handouts"]}
    assert public["handout_id"] in ids
    assert party["handout_id"] in ids
    assert secret["handout_id"] not in ids

    # Direct GET on a gm_only row must not leak it either (no existence oracle).
    direct = client.get(
        f"/api/v1/handouts/{secret['handout_id']}", params={"token": player["token"]}
    )
    assert direct.status_code == 404


def test_spectator_listing_also_excludes_gm_only(gm, spectator_token):
    secret = _create(gm["token"], revealed_to="gm_only")
    public = _create(gm["token"], revealed_to="all")

    seen = client.get("/api/v1/handouts", params={"token": spectator_token}).json()
    ids = {h["handout_id"] for h in seen["handouts"]}
    assert public["handout_id"] in ids
    assert secret["handout_id"] not in ids


def test_invalid_revealed_to_rejected(gm):
    resp = client.post(
        "/api/v1/handouts",
        params={"token": gm["token"]},
        json={"title": "X", "content_md": "", "revealed_to": "everyone"},
    )
    assert resp.status_code == 422


def test_handout_update_delete_by_creator_not_role(gm, player):
    """Creator-scoped mutation: a player-authored note stays editable by its
    author even though they are not a GM."""
    authored = _create(player["token"], revealed_to="party")
    renamed = client.put(
        f"/api/v1/handouts/{authored['handout_id']}",
        params={"token": player["token"]},
        json={"title": "My Notes"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "My Notes"
    deleted = client.delete(
        f"/api/v1/handouts/{authored['handout_id']}", params={"token": player["token"]}
    )
    assert deleted.status_code == 200


def test_foreign_user_delete_and_update_404(gm, player):
    """A valid token belonging to neither the creator nor a GM gets the same
    404 as a nonexistent id — mutation routes cannot be probed as an
    existence oracle."""
    created = _create(gm["token"])

    stolen_delete = client.delete(
        f"/api/v1/handouts/{created['handout_id']}", params={"token": player["token"]}
    )
    assert stolen_delete.status_code == 404

    stolen_update = client.put(
        f"/api/v1/handouts/{created['handout_id']}",
        params={"token": player["token"]},
        json={"title": "Hijacked"},
    )
    assert stolen_update.status_code == 404

    garbage = client.delete(
        f"/api/v1/handouts/{uuid.uuid4()}", params={"token": player["token"]}
    )
    assert garbage.status_code == 404


def test_handout_routes_require_auth(gm):
    created = _create(gm["token"])
    assert client.post("/api/v1/handouts", json={"title": "x"}).status_code == 401
    assert client.get("/api/v1/handouts").status_code == 401
    assert client.get(f"/api/v1/handouts/{created['handout_id']}").status_code == 401
    assert client.put(
        f"/api/v1/handouts/{created['handout_id']}", json={"title": "x"}
    ).status_code == 401
    assert client.delete(f"/api/v1/handouts/{created['handout_id']}").status_code == 401
