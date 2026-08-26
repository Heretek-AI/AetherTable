"""Per-session Lines & Veils safety boundaries (Pillar 11).

Defect being closed: the gateway had an X-Card but no way for a table to
declare content boundaries BEFORE play — "lines" (hard limits: never
introduce this content) and "veils" (fade-to-black topics: may appear, never
depicted). GOALS.md Pillar 11 requires both.

Trust decisions encoded here (documented in server.py next to the handlers):

* Every boundary route requires an authenticated HMAC token (401 otherwise).
* Session existence comes from the gateway's own membership data: at least
  one lobby bound to that engine_session_id. An id no lobby binds is an
  unknown session -> 404 SESSION_NOT_FOUND.
* Access is participant-or-staff: gm/admin globally, or any member of a lobby
  bound to the session (the ``_caller_is_session_participant`` derivation).
  Spectators ARE lobby members by convention (join_lobby records them with
  role 'spectator' and the derivation is role-blind), so they count.
  Authenticated outsiders on a REAL session get 403 SAFETY_NOT_A_PARTICIPANT.
* Adding: any participant may add entries tagged with their OWN actor id;
  gm/admin may also manage (delete) anyone's entries. A player may only ever
  delete their own entry -> 403 BOUNDARY_DELETE_FORBIDDEN.
* Normalization: topics are trimmed; empty -> 422 BOUNDARY_TOPIC_REQUIRED,
  longer than 120 chars after trimming -> 422 BOUNDARY_TOPIC_TOO_LONG, and a
  case-insensitive duplicate within the same list -> 422 BOUNDARY_DUPLICATE.
* REDACTION RULE (the load-bearing design point): veils are shared openly at
  most tables, so every participant sees veil topics verbatim. LINES can be
  sensitive, so a non-staff viewer sees OTHER participants' line topics as
  "[redacted]" while their own lines stay verbatim; gm/admin see everything
  verbatim because they must adjudicate against the full list.
"""

import asyncio
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server as server_module
from vtt_orchestrator.safety import (
    BOUNDARY_TOPIC_MAX_LEN,
    REDACTED_TOPIC,
    BoundaryError,
    SafetyBoundaryRegistry,
)
from vtt_orchestrator.server import _sign_token, app

client = TestClient(app)


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _session_id() -> str:
    return str(uuid.uuid4())


@pytest.fixture(autouse=True)
def _clean_registry():
    """Boundaries live in module state; each test starts from an empty table."""
    server_module.safety_boundaries.clear()
    yield
    server_module.safety_boundaries.clear()


def _bound_table(host_id: str, *guest_ids: str) -> str:
    """Creates a lobby via the API, joins the guests, and binds it to a fresh
    engine session exactly as lobby launch does (minus the live engine)."""
    host_token = _token(host_id, "player")
    created = client.post(
        "/api/v1/lobbies", params={"token": host_token}, json={"name": "Safety Table"}
    )
    assert created.status_code == 200, created.text
    lobby_id = created.json()["lobby_id"]
    invite = created.json()["invite_code"]
    for guest in guest_ids:
        joined = client.post(
            f"/api/v1/lobbies/{lobby_id}/join",
            params={"token": _token(guest, "player")},
            json={"invite_code": invite},
        )
        assert joined.status_code == 200, joined.text
    session_id = _session_id()
    asyncio.run(server_module.storage_backend.set_lobby_session(lobby_id, session_id))
    return session_id


# ---------------------------------------------------------------------------
# Unit: normalization / caps / dedupe / redaction at the registry layer
# ---------------------------------------------------------------------------


class TestRegistryNormalization:
    def setup_method(self):
        self.registry = SafetyBoundaryRegistry()

    def test_topic_is_trimmed(self):
        entry = self.registry.add("s1", "line", "  spiders  ", added_by="u1")
        assert entry["topic"] == "spiders"

    def test_empty_topic_rejected(self):
        with pytest.raises(BoundaryError) as err:
            self.registry.add("s1", "line", "   ", added_by="u1")
        assert err.value.code == "BOUNDARY_TOPIC_REQUIRED"

    def test_overlong_topic_rejected(self):
        with pytest.raises(BoundaryError) as err:
            self.registry.add("s1", "veil", "x" * (BOUNDARY_TOPIC_MAX_LEN + 1), added_by="u1")
        assert err.value.code == "BOUNDARY_TOPIC_TOO_LONG"

    def test_topic_at_cap_is_accepted(self):
        entry = self.registry.add("s1", "veil", "y" * BOUNDARY_TOPIC_MAX_LEN, added_by="u1")
        assert len(entry["topic"]) == BOUNDARY_TOPIC_MAX_LEN

    def test_duplicates_are_case_insensitive_per_list(self):
        self.registry.add("s1", "line", "Sexual Violence", added_by="u1")
        with pytest.raises(BoundaryError) as err:
            self.registry.add("s1", "line", "sexual violence ", added_by="u2")
        assert err.value.code == "BOUNDARY_DUPLICATE"

    def test_same_topic_may_be_line_and_veil(self):
        # Different lists are different declarations; one table can fade-to-
        # black AND hard-limit adjacent phrasings independently.
        self.registry.add("s1", "line", "torture", added_by="u1")
        entry = self.registry.add("s1", "veil", "torture", added_by="u1")
        assert entry["kind"] == "veil"

    def test_remove_and_unknown_entry(self):
        entry = self.registry.add("s1", "line", "gore", added_by="u1")
        assert self.registry.remove("s1", "line", entry["entry_id"]) is True
        assert self.registry.remove("s1", "line", entry["entry_id"]) is False
        assert self.registry.remove("s1", "line", "bnd_missing") is False


class TestRegistryRedaction:
    def setup_method(self):
        self.registry = SafetyBoundaryRegistry()
        self.registry.add("s1", "line", "self-harm", added_by="player_a")
        self.registry.add("s1", "line", "animal cruelty", added_by="player_b")
        self.registry.add("s1", "veil", "romance", added_by="player_a")

    def test_staff_see_everything_verbatim(self):
        view = self.registry.view("s1", viewer_id="gm1", privileged=True)
        assert [l["topic"] for l in view["lines"]] == ["self-harm", "animal cruelty"]
        assert [v["topic"] for v in view["veils"]] == ["romance"]

    def test_player_sees_own_lines_verbatim(self):
        view = self.registry.view("s1", viewer_id="player_a", privileged=False)
        topics = {l["added_by"]: l["topic"] for l in view["lines"]}
        assert topics["player_a"] == "self-harm"
        assert topics["player_b"] == REDACTED_TOPIC

    def test_veils_are_never_redacted(self):
        view = self.registry.view("s1", viewer_id="player_b", privileged=False)
        assert [v["topic"] for v in view["veils"]] == ["romance"]

    def test_redacted_entries_keep_their_metadata(self):
        view = self.registry.view("s1", viewer_id="player_c", privileged=False)
        redacted = [l for l in view["lines"] if l["topic"] == REDACTED_TOPIC]
        assert {l["added_by"] for l in redacted} == {"player_a", "player_b"}
        assert all(l["entry_id"] for l in redacted)


# ---------------------------------------------------------------------------
# Routes: authentication & authorization matrix
# ---------------------------------------------------------------------------


class TestBoundaryAuth:
    def test_anonymous_get_rejected(self):
        resp = client.get(f"/api/v1/sessions/{_session_id()}/safety/boundaries")
        assert resp.status_code == 401

    def test_anonymous_add_rejected(self):
        resp = client.post(
            f"/api/v1/sessions/{_session_id()}/safety/lines", json={"topic": "spiders"}
        )
        assert resp.status_code == 401

    def test_invalid_token_rejected(self):
        resp = client.get(
            f"/api/v1/sessions/{_session_id()}/safety/boundaries",
            params={"token": "forged"},
        )
        assert resp.status_code == 401

    def test_unknown_session_404_even_for_gm(self):
        """No lobby is bound to this id, so from the gateway's membership data
        the session does not exist."""
        resp = client.get(
            f"/api/v1/sessions/{_session_id()}/safety/boundaries",
            params={"token": _token("usr_gm40", "gm")},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"] == "SESSION_NOT_FOUND"

    def test_outsider_on_real_session_403(self):
        session_id = _bound_table("usr_host50", "usr_p51")
        outsider_token = _token("usr_stranger52", "player")
        resp = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries",
            params={"token": outsider_token},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"] == "SAFETY_NOT_A_PARTICIPANT"

    def test_participant_player_can_read_boundaries(self):
        session_id = _bound_table("usr_host60", "usr_p61")
        resp = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries",
            params={"token": _token("usr_p61", "player")},
        )
        assert resp.status_code == 200
        assert resp.json()["lines"] == []
        assert resp.json()["veils"] == []

    def test_gm_can_read_without_membership(self):
        session_id = _bound_table("usr_host62", "usr_p63")
        resp = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries",
            params={"token": _token("usr_gm64", "gm")},
        )
        assert resp.status_code == 200

    def test_spectator_member_is_a_participant(self):
        """Survey result: spectators join lobbies as full roster members and
        _caller_is_session_participant is role-blind, so a spectator seat can
        read (and declare) the table's boundaries."""
        host_token = _token("usr_host70", "player")
        created = client.post(
            "/api/v1/lobbies", params={"token": host_token}, json={"name": "Spectator Table"}
        )
        lobby_id = created.json()["lobby_id"]
        spec_token = _token("usr_spec71", "spectator")
        client.post(
            f"/api/v1/lobbies/{lobby_id}/join",
            params={"token": spec_token},
            json={"invite_code": created.json()["invite_code"]},
        )
        session_id = _session_id()
        asyncio.run(server_module.storage_backend.set_lobby_session(lobby_id, session_id))
        resp = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries",
            params={"token": spec_token},
        )
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Routes: add / delete semantics
# ---------------------------------------------------------------------------


class TestAddAndDelete:
    def test_player_adds_own_tagged_line(self):
        session_id = _bound_table("usr_host80", "usr_p81")
        resp = client.post(
            f"/api/v1/sessions/{session_id}/safety/lines",
            params={"token": _token("usr_p81", "player")},
            json={"topic": "  sexual violence  "},
        )
        assert resp.status_code == 200, resp.text
        entry = resp.json()["entry"]
        assert entry["topic"] == "sexual violence"
        assert entry["kind"] == "line"
        assert entry["added_by"] == "usr_p81"

    def test_duplicate_returns_422_with_code(self):
        session_id = _bound_table("usr_host82", "usr_p83")
        url = f"/api/v1/sessions/{session_id}/safety/lines"
        first = client.post(
            url, params={"token": _token("usr_p83", "player")}, json={"topic": "Spiders"}
        )
        assert first.status_code == 200
        dup = client.post(
            url, params={"token": _token("usr_p83", "player")}, json={"topic": "SPIDERS"}
        )
        assert dup.status_code == 422
        assert dup.json()["detail"]["error"] == "BOUNDARY_DUPLICATE"

    def test_too_long_returns_422_with_code(self):
        session_id = _bound_table("usr_host84", "usr_p85")
        resp = client.post(
            f"/api/v1/sessions/{session_id}/safety/veils",
            params={"token": _token("usr_p85", "player")},
            json={"topic": "z" * (BOUNDARY_TOPIC_MAX_LEN + 1)},
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["error"] == "BOUNDARY_TOPIC_TOO_LONG"

    def test_blank_topic_returns_422_with_code(self):
        session_id = _bound_table("usr_host86", "usr_p87")
        resp = client.post(
            f"/api/v1/sessions/{session_id}/safety/veils",
            params={"token": _token("usr_p87", "player")},
            json={"topic": "   "},
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["error"] == "BOUNDARY_TOPIC_REQUIRED"

    def test_author_deletes_own_entry(self):
        session_id = _bound_table("usr_host88", "usr_p89")
        url = f"/api/v1/sessions/{session_id}/safety/lines"
        entry = client.post(
            url, params={"token": _token("usr_p89", "player")}, json={"topic": "gore"}
        ).json()["entry"]
        deleted = client.delete(
            f"{url}/{entry['entry_id']}", params={"token": _token("usr_p89", "player")}
        )
        assert deleted.status_code == 200
        listing = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries",
            params={"token": _token("usr_p89", "player")},
        ).json()
        assert listing["lines"] == []

    def test_other_player_cannot_delete_someone_elses_entry(self):
        session_id = _bound_table("usr_host90", "usr_p91", "usr_p92")
        url = f"/api/v1/sessions/{session_id}/safety/lines"
        entry = client.post(
            url, params={"token": _token("usr_p91", "player")}, json={"topic": "needles"}
        ).json()["entry"]
        denied = client.delete(
            f"{url}/{entry['entry_id']}", params={"token": _token("usr_p92", "player")}
        )
        assert denied.status_code == 403
        assert denied.json()["detail"]["error"] == "BOUNDARY_DELETE_FORBIDDEN"

    def test_gm_deletes_anyones_entry(self):
        session_id = _bound_table("usr_host93", "usr_p94")
        url = f"/api/v1/sessions/{session_id}/safety/lines"
        entry = client.post(
            url, params={"token": _token("usr_p94", "player")}, json={"topic": "gore"}
        ).json()["entry"]
        deleted = client.delete(
            f"{url}/{entry['entry_id']}", params={"token": _token("usr_gm95", "gm")}
        )
        assert deleted.status_code == 200

    def test_unknown_entry_delete_is_404(self):
        session_id = _bound_table("usr_host96", "usr_p97")
        resp = client.delete(
            f"/api/v1/sessions/{session_id}/safety/veils/bnd_nope",
            params={"token": _token("usr_gm98", "gm")},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"] == "BOUNDARY_ENTRY_NOT_FOUND"


# ---------------------------------------------------------------------------
# Routes: the redaction rule end to end
# ---------------------------------------------------------------------------


class TestRedactionRuleOverHttp:
    def test_players_see_others_lines_redacted_gm_sees_all(self):
        session_id = _bound_table("usr_host100", "usr_p101", "usr_p102")
        lines_url = f"/api/v1/sessions/{session_id}/safety/lines"
        veils_url = f"/api/v1/sessions/{session_id}/safety/veils"

        own = client.post(
            lines_url,
            params={"token": _token("usr_p101", "player")},
            json={"topic": "self-harm"},
        ).json()["entry"]
        other = client.post(
            lines_url,
            params={"token": _token("usr_p102", "player")},
            json={"topic": "animal cruelty"},
        ).json()["entry"]
        client.post(
            veils_url,
            params={"token": _token("usr_p102", "player")},
            json={"topic": "romance"},
        )

        # Viewer p101: their OWN line stays verbatim, p102's is redacted...
        mine_view = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries",
            params={"token": _token("usr_p101", "player")},
        ).json()
        by_id = {l["entry_id"]: l["topic"] for l in mine_view["lines"]}
        assert by_id[own["entry_id"]] == "self-harm"
        assert by_id[other["entry_id"]] == "[redacted]"
        # ...but veils are open to everyone at the table.
        assert [v["topic"] for v in mine_view["veils"]] == ["romance"]

        # GM adjudicates against the FULL list.
        gm_view = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries",
            params={"token": _token("usr_gm103", "gm")},
        ).json()
        gm_topics = sorted(l["topic"] for l in gm_view["lines"])
        assert gm_topics == ["animal cruelty", "self-harm"]

    def test_admin_sees_all_verbatim_too(self):
        session_id = _bound_table("usr_host104", "usr_p105")
        client.post(
            f"/api/v1/sessions/{session_id}/safety/lines",
            params={"token": _token("usr_p105", "player")},
            json={"topic": "torture"},
        )
        admin_view = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries",
            params={"token": _token("usr_admin106", "admin")},
        ).json()
        assert [l["topic"] for l in admin_view["lines"]] == ["torture"]


# ---------------------------------------------------------------------------
# Routes: counts-only summary projection
#
# The summary endpoint is the privacy-cheap counterpart to the full listing:
# it lets the client render badges ("you've declared 3 lines") without ever
# pulling the topic text. The contract documented here:
#
# * auth gate is the same _boundary_gate (HMAC 401, unknown session 404,
#   outsider 403 SAFETY_NOT_A_PARTICIPANT — uniform for staff).
# * response carries ONLY counts: {you.{lines, veils}, others.{lines, veils},
#   redacted.lines}; no topic strings, no actor ids, no timestamps.
# * "you" is what the caller themselves filed; "others" is everyone else's,
#   collapsed into a single integer per kind (no per-actor breakdown).
# * "redacted.lines" == others.lines for non-staff (every other line is
#   redacted to a player); == 0 for staff (lines are never redacted to gm/admin).
# * Empty registry -> all zeros, never 404 (the gate already proved the
#   session exists).
# ---------------------------------------------------------------------------


class TestSummaryAuth:
    def test_anonymous_get_rejected(self):
        resp = client.get(f"/api/v1/sessions/{_session_id()}/safety/boundaries/summary")
        assert resp.status_code == 401

    def test_invalid_token_rejected(self):
        resp = client.get(
            f"/api/v1/sessions/{_session_id()}/safety/boundaries/summary",
            params={"token": "forged"},
        )
        assert resp.status_code == 401

    def test_unknown_session_404_even_for_gm(self):
        """The gate must answer 404 SESSION_NOT_FOUND for an id no lobby
        binds — staff get the same uniform 404 so the route is not an
        existence oracle for other deployments' tables."""
        resp = client.get(
            f"/api/v1/sessions/{_session_id()}/safety/boundaries/summary",
            params={"token": _token("usr_gm_summary0", "gm")},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"] == "SESSION_NOT_FOUND"

    def test_outsider_on_real_session_403(self):
        session_id = _bound_table("usr_h_sum1", "usr_p_sum1")
        outsider = _token("usr_stranger_sum1", "player")
        resp = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": outsider},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"] == "SAFETY_NOT_A_PARTICIPANT"

    def test_spectator_member_is_a_participant(self):
        """Survey result: spectators join lobbies as full roster members and
        _caller_is_session_participant is role-blind, so a spectator seat can
        read the table's boundaries summary."""
        host_token = _token("usr_h_sum_spec", "player")
        created = client.post(
            "/api/v1/lobbies",
            params={"token": host_token},
            json={"name": "Spec Summary Table"},
        )
        lobby_id = created.json()["lobby_id"]
        spec_token = _token("usr_spec_sum", "spectator")
        client.post(
            f"/api/v1/lobbies/{lobby_id}/join",
            params={"token": spec_token},
            json={"invite_code": created.json()["invite_code"]},
        )
        session_id = _session_id()
        asyncio.run(server_module.storage_backend.set_lobby_session(lobby_id, session_id))
        resp = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": spec_token},
        )
        assert resp.status_code == 200


class TestSummaryCounts:
    def test_empty_registry_returns_all_zeros(self):
        """The route must never 404 on an empty table — the gate already
        proved the session exists; an unused table is the legitimate
        pre-declaration state."""
        session_id = _bound_table("usr_h_sum_empty", "usr_p_sum_empty")
        resp = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": _token("usr_p_sum_empty", "player")},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "you": {"lines": 0, "veils": 0},
            "others": {"lines": 0, "veils": 0},
            "redacted": {"lines": 0},
        }

    def test_mixed_entries_split_between_you_and_others(self):
        session_id = _bound_table(
            "usr_h_sum_mix", "usr_p_sum_mix_a", "usr_p_sum_mix_b"
        )
        lines_url = f"/api/v1/sessions/{session_id}/safety/lines"
        veils_url = f"/api/v1/sessions/{session_id}/safety/veils"
        # p_a declares 2 lines + 1 veil; p_b declares 1 line + 2 veils.
        for topic in ("self-harm", "spiders"):
            client.post(
                lines_url,
                params={"token": _token("usr_p_sum_mix_a", "player")},
                json={"topic": topic},
            )
        client.post(
            veils_url,
            params={"token": _token("usr_p_sum_mix_a", "player")},
            json={"topic": "romance"},
        )
        client.post(
            lines_url,
            params={"token": _token("usr_p_sum_mix_b", "player")},
            json={"topic": "animal cruelty"},
        )
        for topic in ("gore", "torture"):
            client.post(
                veils_url,
                params={"token": _token("usr_p_sum_mix_b", "player")},
                json={"topic": topic},
            )

        a_view = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": _token("usr_p_sum_mix_a", "player")},
        ).json()
        assert a_view == {
            "you": {"lines": 2, "veils": 1},
            "others": {"lines": 1, "veils": 2},
            "redacted": {"lines": 1},
        }
        b_view = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": _token("usr_p_sum_mix_b", "player")},
        ).json()
        assert b_view == {
            "you": {"lines": 1, "veils": 2},
            "others": {"lines": 2, "veils": 1},
            "redacted": {"lines": 2},
        }

    def test_gm_sees_full_breakdown_with_redacted_zero(self):
        """gm/admin must see everyone's lines, so 'others' carries the total
        and 'redacted' collapses to 0 — nothing is redacted to staff."""
        session_id = _bound_table("usr_h_sum_gm", "usr_p_sum_gm_a", "usr_p_sum_gm_b")
        lines_url = f"/api/v1/sessions/{session_id}/safety/lines"
        client.post(
            lines_url,
            params={"token": _token("usr_p_sum_gm_a", "player")},
            json={"topic": "needleplay"},
        )
        client.post(
            lines_url,
            params={"token": _token("usr_p_sum_gm_b", "player")},
            json={"topic": "claustrophobia"},
        )
        gm_view = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": _token("usr_gm_sum_staff", "gm")},
        ).json()
        assert gm_view == {
            "you": {"lines": 0, "veils": 0},
            "others": {"lines": 2, "veils": 0},
            "redacted": {"lines": 0},
        }

    def test_admin_sees_full_breakdown_with_redacted_zero(self):
        """Same contract for admin role (mirrors the verbatim view)."""
        session_id = _bound_table("usr_h_sum_admin", "usr_p_sum_admin")
        client.post(
            f"/api/v1/sessions/{session_id}/safety/veils",
            params={"token": _token("usr_p_sum_admin", "player")},
            json={"topic": "romance"},
        )
        admin_view = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": _token("usr_admin_sum_staff", "admin")},
        ).json()
        assert admin_view == {
            "you": {"lines": 0, "veils": 0},
            "others": {"lines": 0, "veils": 1},
            "redacted": {"lines": 0},
        }

    def test_add_increments_you(self):
        session_id = _bound_table("usr_h_sum_inc", "usr_p_sum_inc")
        url = f"/api/v1/sessions/{session_id}/safety/boundaries/summary"
        token = _token("usr_p_sum_inc", "player")
        before = client.get(f"/api/v1/sessions/{session_id}/safety/boundaries/summary", params={"token": token}).json()
        client.post(
            f"/api/v1/sessions/{session_id}/safety/lines",
            params={"token": token},
            json={"topic": "spiders"},
        )
        after = client.get(url, params={"token": token}).json()
        assert after["you"]["lines"] == before["you"]["lines"] + 1
        assert after["you"]["veils"] == before["you"]["veils"]
        assert after["others"] == before["others"]

    def test_delete_decrements_you(self):
        session_id = _bound_table("usr_h_sum_dec", "usr_p_sum_dec")
        token = _token("usr_p_sum_dec", "player")
        entry = client.post(
            f"/api/v1/sessions/{session_id}/safety/veils",
            params={"token": token},
            json={"topic": "romance"},
        ).json()["entry"]
        before = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": token},
        ).json()
        client.delete(
            f"/api/v1/sessions/{session_id}/safety/veils/{entry['entry_id']}",
            params={"token": token},
        )
        after = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": token},
        ).json()
        assert after["you"]["veils"] == before["you"]["veils"] - 1
        assert after["you"]["lines"] == before["you"]["lines"]


class TestSummaryNoLeakage:
    def test_response_body_carries_no_topic_strings(self):
        """The endpoint's whole point is to AVOID topic leakage. After adding
        sensitive topics, the response body must literally not contain any of
        them — and likewise must not echo entry_id / added_by / created_at
        from the registry."""
        session_id = _bound_table("usr_h_sum_leak", "usr_p_sum_leak_a", "usr_p_sum_leak_b")
        sensitive = [
            ("line", "TOPIC_LEAK_NEEDLEPLAY", "usr_p_sum_leak_a"),
            ("line", "TOPIC_LEAK_CLAUSTROPHOBIA", "usr_p_sum_leak_b"),
            ("veil", "TOPIC_LEAK_ROMANCE", "usr_p_sum_leak_b"),
            ("veil", "TOPIC_LEAK_GORE", "usr_p_sum_leak_a"),
        ]
        for kind, topic, actor in sensitive:
            url = (
                f"/api/v1/sessions/{session_id}/safety/lines"
                if kind == "line"
                else f"/api/v1/sessions/{session_id}/safety/veils"
            )
            client.post(
                url,
                params={"token": _token(actor, "player")},
                json={"topic": topic},
            )
        # Also fetch the full listing so we can use its entry_ids / actor ids
        # as canary strings — none of them must leak into the summary either.
        full = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries",
            params={"token": _token("usr_p_sum_leak_a", "player")},
        ).json()
        canary_strings = {topic for _, topic, _ in sensitive}
        for entry in full["lines"] + full["veils"]:
            canary_strings.add(entry["entry_id"])
            canary_strings.add(entry["added_by"])

        for viewer in ("usr_p_sum_leak_a", "usr_p_sum_leak_b", "usr_gm_sum_leak"):
            role = "gm" if viewer.startswith("usr_gm_") else "player"
            body = client.get(
                f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
                params={"token": _token(viewer, role)},
            ).text
            for canary in canary_strings:
                assert canary not in body, (
                    f"Summary leaked {canary!r} to viewer {viewer}: {body!r}"
                )

    def test_response_shape_is_exactly_documented(self):
        """Lock the contract: keys MUST be exactly {you, others, redacted};
        nested keys MUST be exactly the documented ones. Clients will code
        against this structure."""
        session_id = _bound_table("usr_h_sum_shape", "usr_p_sum_shape")
        resp = client.get(
            f"/api/v1/sessions/{session_id}/safety/boundaries/summary",
            params={"token": _token("usr_p_sum_shape", "player")},
        )
        body = resp.json()
        assert set(body.keys()) == {"you", "others", "redacted"}
        assert set(body["you"].keys()) == {"lines", "veils"}
        assert set(body["others"].keys()) == {"lines", "veils"}
        assert set(body["redacted"].keys()) == {"lines"}
        for nested in (body["you"], body["others"], body["redacted"]):
            for value in nested.values():
                assert isinstance(value, int)


class TestRegistrySummary:
    """Direct unit coverage of the registry's summary projection so the
    route layer is provably a thin wrapper."""

    def test_staff_redacted_lines_is_zero(self):
        registry = SafetyBoundaryRegistry()
        registry.add("s1", "line", "self-harm", added_by="u_a")
        registry.add("s1", "line", "spiders", added_by="u_b")
        out = registry.summary("s1", viewer_id="gm1", privileged=True)
        assert out == {
            "you": {"lines": 0, "veils": 0},
            "others": {"lines": 2, "veils": 0},
            "redacted": {"lines": 0},
        }

    def test_player_redacted_lines_equals_others_lines(self):
        registry = SafetyBoundaryRegistry()
        registry.add("s1", "line", "self-harm", added_by="u_a")
        registry.add("s1", "line", "spiders", added_by="u_b")
        registry.add("s1", "line", "gore", added_by="u_a")
        out = registry.summary("s1", viewer_id="u_a", privileged=False)
        assert out["you"]["lines"] == 2
        assert out["others"]["lines"] == 1
        assert out["redacted"]["lines"] == 1

    def test_unknown_session_returns_all_zeros(self):
        registry = SafetyBoundaryRegistry()
        out = registry.summary("missing", viewer_id="u_a", privileged=False)
        assert out == {
            "you": {"lines": 0, "veils": 0},
            "others": {"lines": 0, "veils": 0},
            "redacted": {"lines": 0},
        }
