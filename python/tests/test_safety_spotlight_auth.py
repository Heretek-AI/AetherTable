"""Authorization for the safety and spotlight endpoints.

Defect being closed: POST /api/v1/safety/x-card took no token at all, so any
anonymous caller could rewind ANY named engine session; the spotlight
endpoints accepted spoofed speaker_ids from anyone.

Trust decisions encoded here (documented in server.py next to the handlers):

* X-card requires an authenticated token. Pillar-11 player-veto is
  deliberate: any PARTICIPANT of the named session may trigger — legitimacy
  is derived from lobby membership bound to that engine session_id, because
  that is the membership data the gateway actually owns.
* A caller who is gm/admin globally may trigger against any session.
* Sessions with no lobby binding (created out-of-band via the engine proxy)
  can only be rewound by gm/admin tokens — the gateway has no membership
  record proving a player's standing, so it fails closed.
* A non-GM may only file the intervention under their OWN user id.
* Spotlight recording requires a token; speaker_id must BE the authenticated
  user (id / username / displayName) unless the caller is gm/admin.
"""

import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server as server_module
from vtt_orchestrator.server import _sign_token, app

client = TestClient(app)


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _xcard(player_id: str, session_id: str | None = None) -> dict:
    body = {
        "player_id": player_id,
        "topic": "spiders",
        "current_sequence_id": 7,
    }
    if session_id:
        body["engine_session_id"] = session_id
    return body


# ---------------------------------------------------------------------------
# X-card authentication & authorization
# ---------------------------------------------------------------------------


class TestXCardAuth:
    def test_anonymous_x_card_rejected(self):
        resp = client.post("/api/v1/safety/x-card", json=_xcard("usr_any"))
        assert resp.status_code == 401

    def test_invalid_token_rejected(self):
        resp = client.post(
            "/api/v1/safety/x-card",
            params={"token": "not-a-real-token"},
            json=_xcard("usr_any"),
        )
        assert resp.status_code == 401

    def test_player_can_trigger_for_own_unnamed_session(self):
        """No engine_session_id: nothing is rewound, so an authenticated
        player filing under their own id stays allowed (Pillar-11)."""
        resp = client.post(
            "/api/v1/safety/x-card",
            params={"token": _token("usr_p10", "player")},
            json=_xcard("usr_p10"),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "SAFETY_INTERVENTION_ACTIVATED"
        assert "engine_rewind" not in resp.json()

    def test_non_gm_cannot_file_under_someone_elses_id(self):
        resp = client.post(
            "/api/v1/safety/x-card",
            params={"token": _token("usr_p11", "player")},
            json=_xcard("usr_someone_else"),
        )
        assert resp.status_code == 403

    def test_gm_may_trigger_on_arbitrary_named_session(self):
        resp = client.post(
            "/api/v1/safety/x-card",
            params={"token": _token("usr_gm20", "gm")},
            json=_xcard("usr_gm20", session_id="11111111-1111-1111-1111-111111111111"),
        )
        assert resp.status_code == 200, resp.text
        # Either applied on a live ledger or honestly unavailable offline.
        assert resp.json()["engine_rewind"]["status"] in (
            "SAFETY_REWIND_SUCCESS",
            "ENGINE_UNAVAILABLE",
        )

    def test_outsider_cannot_rewind_a_session_they_are_not_in(self):
        """The core defect: an authenticated but unrelated user must NOT be
        able to rewind someone else's named session."""
        resp = client.post(
            "/api/v1/safety/x-card",
            params={"token": _token("usr_outsider", "player")},
            json=_xcard("usr_outsider", session_id="22222222-2222-2222-2222-222222222222"),
        )
        assert resp.status_code == 403, resp.text


class TestXCardParticipantLegitimacy:
    def test_bound_lobby_participant_may_trigger(self):
        host_token = _token("usr_host30", "player")
        created = client.post(
            "/api/v1/lobbies", params={"token": host_token}, json={"name": "Safety Lobby"}
        )
        assert created.status_code == 200, created.text
        lobby_id = created.json()["lobby_id"]

        guest_token = _token("usr_guest31", "player")
        joined = client.post(
            f"/api/v1/lobbies/{lobby_id}/join",
            params={"token": guest_token},
            json={"invite_code": created.json()["invite_code"]},
        )
        assert joined.status_code == 200

        session_id = "33333333-3333-3333-3333-333333333333"
        # Bind the lobby to the engine session exactly as lobby launch does,
        # without requiring the live Rust engine in this unit test.
        import asyncio

        asyncio.run(server_module.storage_backend.set_lobby_session(lobby_id, session_id))

        participant = client.post(
            "/api/v1/safety/x-card",
            params={"token": guest_token},
            json=_xcard("usr_guest31", session_id=session_id),
        )
        assert participant.status_code == 200, participant.text

        outsider = client.post(
            "/api/v1/safety/x-card",
            params={"token": _token("usr_stranger32", "player")},
            json=_xcard("usr_stranger32", session_id=session_id),
        )
        assert outsider.status_code == 403


# ---------------------------------------------------------------------------
# Spotlight endpoints
# ---------------------------------------------------------------------------


class TestSpotlightAuth:
    def test_record_without_token_rejected(self):
        resp = client.post(
            "/api/v1/spotlight/record",
            json={"speaker_id": "Thorin", "duration_sec": 4.2},
        )
        assert resp.status_code == 401

    def test_agency_without_token_rejected(self):
        assert client.get("/api/v1/spotlight/agency").status_code == 401

    @staticmethod
    def _signup(name: str, role: str) -> dict:
        import uuid

        email = f"{name}_{uuid.uuid4().hex[:8]}@example.com"
        resp = client.post(
            "/api/v1/auth/signup",
            json={
                "email": email,
                "username": name,
                "display_name": name.title(),
                "password": "dice-dice",
                "role": role,
            },
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    def test_player_records_their_own_voice(self):
        account = self._signup("spotlighter", "player")
        resp = client.post(
            "/api/v1/spotlight/record",
            params={"token": account["token"]},
            json={"speaker_id": account["user"]["id"], "duration_sec": 4.2},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "recorded"

    def test_display_name_and_username_count_as_self(self):
        account = self._signup("mira_vale", "player")
        for speaker in (account["user"]["displayName"], account["user"]["username"]):
            resp = client.post(
                "/api/v1/spotlight/record",
                params={"token": account["token"]},
                json={"speaker_id": speaker, "duration_sec": 2.0},
            )
            assert resp.status_code == 200, f"{speaker!r} must count as self"

    def test_spoofed_speaker_id_forbidden(self):
        resp = client.post(
            "/api/v1/spotlight/record",
            params={"token": _token("usr_spk42", "player")},
            json={"speaker_id": "Thorin", "duration_sec": 9.9},
        )
        assert resp.status_code == 403, resp.text

    def test_gm_may_record_any_speaker(self):
        resp = client.post(
            "/api/v1/spotlight/record",
            params={"token": _token("usr_gm43", "gm")},
            json={"speaker_id": "Thorin", "duration_sec": 1.5},
        )
        assert resp.status_code == 200

    def test_agency_readable_with_valid_token(self):
        resp = client.get("/api/v1/spotlight/agency", params={"token": _token("usr_spk44", "player")})
        assert resp.status_code == 200
        assert "agency_weights" in resp.json()
