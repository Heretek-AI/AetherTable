"""Per-session spotlight aggregation: report / GET / reset (Pillar 11).

Iteration 33: the survey found the CLIENT CRDT speech ledger
(``client/src/sync/speech_ledger.ts`` + ``yjs_doc_client.ts``) genuinely
converges per-peer VAD segments room-wide, but the python orchestrator holds
NO read path into that Y.Doc (the relay is a Node process). So the server
cannot aggregate from the ledger directly; the honest layer is the self-report
channel + rolling decayed aggregation implemented here and documented in
``vtt_orchestrator/simulation/spotlight_aggregator.py``.

Tests split into two halves:

* UNIT (aggregator math): injected clocks verify decay factoring, future /
  stale timestamps, the ``is_quiet`` mean-minus-one-sigma threshold and its
  documented degenerate regimes, in-process sweeping, and reset semantics.
* API (routes in server.py): the report auth matrix, body validation
  (negative/overlong duration, malformed timestamp, blank or non-member seat,
  unknown session), the tight per-IP ``spotlight_report`` bucket, GET zero-
  until-reported semantics, and GM/admin-only DELETE.
"""

import asyncio
import math
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server as server_module
from vtt_orchestrator.server import (
    _RATE_LIMITS,
    _bucket_for_path,
    _rate_windows,
    _sign_token,
    app,
)
from vtt_orchestrator.simulation.spotlight_aggregator import SpotlightAggregator

client = TestClient(app)


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _auth(user_id: str, role: str = "player") -> dict:
    return {"Authorization": f"Bearer {_token(user_id, role)}"}


def _session_id() -> str:
    return str(uuid.uuid4())


def _bound_table(host_id: str, *guest_ids: str) -> str:
    """Creates a lobby, joins the guests, and binds it to a fresh engine
    session exactly as lobby launch does (minus the live engine). The public
    lobby roster therefore carries host + guests — the session's seats."""
    created = client.post(
        "/api/v1/lobbies",
        params={"token": _token(host_id, "player")},
        json={"name": "Spotlight Table"},
    )
    assert created.status_code == 200, created.text
    lobby_id = created.json()["lobby_id"]
    for guest in guest_ids:
        joined = client.post(
            f"/api/v1/lobbies/{lobby_id}/join",
            params={"token": _token(guest, "player")},
            json={"invite_code": created.json()["invite_code"]},
        )
        assert joined.status_code == 200, joined.text
    session_id = _session_id()
    asyncio.run(server_module.storage_backend.set_lobby_session(lobby_id, session_id))
    return session_id


_DROP = object()


def _report(session_id: str, seat: str, duration_ms: int,
            occurred_at: int | None = None) -> dict:
    """Self-report: the token identity and the seat are the same user."""
    body = {
        "seat_user_id": seat,
        "duration_ms": duration_ms,
        "occurred_at": occurred_at if occurred_at is not None else int(time.time() * 1000),
    }
    return client.post(
        f"/api/v1/sessions/{session_id}/spotlight/report",
        headers=_auth(seat),
        json=body,
    )


@pytest.fixture(autouse=True)
def _clean_spotlight_scores():
    """The score table is module singleton state; every test starts and ends
    on an empty table (same isolation the safety-boundaries suite gives its
    registry)."""
    server_module.spotlight_scores.clear_all()
    yield
    server_module.spotlight_scores.clear_all()


def _by_user(rows):
    return {r["user_id"]: r["score"] for r in rows}


# ---------------------------------------------------------------------------
# Unit: decay math, future/stale timestamps, accumulation, sweeping
# ---------------------------------------------------------------------------


class TestDecayMath:
    def test_two_seats_full_then_half_life_decay(self):
        agg = SpotlightAggregator(half_life_ms=100_000.0)
        t0 = 1_000_000.0
        agg.record("s1", "alice", 30_000, occurred_at=t0, received_at=t0)
        agg.record("s1", "bob", 30_000, occurred_at=t0, received_at=t0)

        at_t0 = _by_user(agg.snapshot("s1", now_ms=t0, roster=["alice", "bob"]))
        assert {k: pytest.approx(v) for k, v in at_t0.items()} == {
            "alice": 30.0,
            "bob": 30.0,
        }
        at_hl = _by_user(agg.snapshot("s1", now_ms=t0 + 100_000, roster=["alice", "bob"]))
        assert at_hl["alice"] == pytest.approx(15.0, abs=1e-3)
        assert at_hl["bob"] == pytest.approx(15.0, abs=1e-3)
        at_2hl = _by_user(agg.snapshot("s1", now_ms=t0 + 200_000, roster=["alice", "bob"]))
        assert at_2hl["alice"] == pytest.approx(7.5, abs=1e-3)

    def test_rolling_window_decays_partway_at_half_a_half_life(self):
        agg = SpotlightAggregator(half_life_ms=100_000.0)
        t0 = 5_000_000.0
        agg.record("s1", "alice", 40_000, occurred_at=t0, received_at=t0)
        scores = _by_user(agg.snapshot("s1", now_ms=t0 + 50_000, roster=["alice"]))
        assert scores["alice"] == pytest.approx(40.0 * 0.5 ** 0.5, abs=1e-3)

    def test_future_dated_report_counts_full_then_decays_normally(self):
        # A clock-skewed/spoofed future occurred_at must never beat the raw
        # duration it claims: effective age is clamped at zero, then wall clock
        # passes it and the score decays like any other.
        agg = SpotlightAggregator(half_life_ms=100_000.0)
        t0 = 3_000_000.0
        agg.record("s1", "alice", 40_000, occurred_at=t0 + 5_000, received_at=t0)
        at_receipt = _by_user(agg.snapshot("s1", now_ms=t0, roster=["alice"]))
        assert at_receipt["alice"] == pytest.approx(40.0, abs=1e-3)
        at_hl = _by_user(agg.snapshot("s1", now_ms=t0 + 100_000, roster=["alice"]))
        assert at_hl["alice"] == pytest.approx(20.0, abs=1e-3)

    def test_stale_report_contributes_tiny_decayed_fraction(self):
        agg = SpotlightAggregator(half_life_ms=100_000.0)
        t0 = 8_000_000.0
        # Six half-lives old: 40 s of claimed speech decays to 40/64 = 0.625 s.
        agg.record("s1", "alice", 40_000, occurred_at=t0 - 6 * 100_000, received_at=t0)
        scores = _by_user(agg.snapshot("s1", now_ms=t0, roster=["alice"]))
        assert scores["alice"] == pytest.approx(0.625, abs=1e-3)

    def test_accumulation_with_prior_decay(self):
        agg = SpotlightAggregator(half_life_ms=100_000.0)
        t0 = 2_000_000.0
        agg.record("s1", "alice", 20_000, occurred_at=t0, received_at=t0)
        # Second burst lands a full half-life later: the first has decayed 20->10.
        agg.record("s1", "alice", 20_000, occurred_at=t0 + 100_000, received_at=t0 + 100_000)
        mid = _by_user(agg.snapshot("s1", now_ms=t0 + 100_000, roster=["alice"]))
        assert mid["alice"] == pytest.approx(30.0, abs=1e-3)
        later = _by_user(agg.snapshot("s1", now_ms=t0 + 200_000, roster=["alice"]))
        assert later["alice"] == pytest.approx(15.0, abs=1e-3)

    def test_no_reports_yields_zero_rows_not_quiet(self):
        agg = SpotlightAggregator()
        rows = agg.snapshot("s1", now_ms=0.0, roster=["alice", "bob"])
        assert [r["score"] for r in rows] == [0.0, 0.0]
        assert all(r["is_quiet"] is False for r in rows)
        assert agg.latest_occurred_at("s1") is None

    def test_clear_drops_scores_and_latest_stamp(self):
        agg = SpotlightAggregator()
        agg.record("s1", "alice", 10_000, occurred_at=1_000_000, received_at=1_000_000)
        assert agg.latest_occurred_at("s1") == 1_000_000
        agg.clear("s1")
        rows = agg.snapshot("s1", now_ms=1_000_000, roster=["alice"])
        assert rows[0]["score"] == 0.0
        assert agg.latest_occurred_at("s1") is None

    def test_stale_session_is_swept(self):
        agg = SpotlightAggregator(half_life_ms=1_000.0, prune_half_lives=2)
        t0 = 1_000_000.0
        agg.record("s1", "alice", 5_000, occurred_at=t0, received_at=t0)
        assert agg.latest_occurred_at("s1") is not None
        agg.sweep_stale(t0 + 3_000)  # 3 half-lives > 2 half-life horizon
        assert agg.latest_occurred_at("s1") is None
        assert _by_user(agg.snapshot("s1", now_ms=t0 + 3_000, roster=["alice"])) == {
            "alice": 0.0
        }


class TestIsQuietThreshold:
    def test_mean_minus_one_sigma_flags_low_seats(self):
        agg = SpotlightAggregator()
        t0 = 1_000_000.0
        # Five seats, all reported at the same instant: one moderate-high band
        # and two stragglers. The low-water line (mean - 1 sigma over the
        # NONZERO scores) lands between the mid band and the stragglers.
        for seat, ms in [("alice", 60_000), ("bob", 55_000), ("carol", 50_000),
                         ("dave", 10_000), ("erin", 2_000)]:
            agg.record("s1", seat, ms, occurred_at=t0, received_at=t0)
        rows = agg.snapshot("s1", now_ms=t0, roster=["alice", "bob", "carol", "dave", "erin"])
        scores = {r["user_id"]: r["score"] for r in rows}
        nonzero = [s for s in scores.values() if s > 0]
        mean = sum(nonzero) / len(nonzero)
        sigma = math.sqrt(sum((x - mean) ** 2 for x in nonzero) / len(nonzero))
        low_water = mean - sigma

        assert sorted(scores) == ["alice", "bob", "carol", "dave", "erin"]
        # Sanity: the discriminating property of the line is that it lands
        # strictly between the mid band (carol, 50 s) and the stragglers
        # (dave, 10 s) — the whole point of a mean-minus-one-sigma cutoff.
        assert 10.0 < low_water < 50.0
        for row in rows:
            assert row["is_quiet"] == (row["score"] < low_water)
        by_user = {r["user_id"]: r["is_quiet"] for r in rows}
        assert by_user["dave"] is True   # 10 s vs line ~11.06
        assert by_user["erin"] is True   # 2 s
        assert by_user["alice"] is False
        assert by_user["bob"] is False
        assert by_user["carol"] is False

    def test_silent_seat_is_flagged_when_one_seat_spoke(self):
        # One nonzero seat: sigma is 0, the line equals that seat's score, and
        # the silent roster member scores 0 < line -> quiet (the useful DM cue).
        agg = SpotlightAggregator()
        agg.record("s1", "alice", 30_000, occurred_at=1_000_000, received_at=1_000_000)
        rows = agg.snapshot("s1", now_ms=1_000_000, roster=["alice", "bob"])
        by_user = {r["user_id"]: (r["score"], r["is_quiet"]) for r in rows}
        assert by_user["alice"] == (pytest.approx(30.0), False)
        assert by_user["bob"] == (0.0, True)

    def test_exactly_two_nonzero_seats_flag_nobody(self):
        # Strict '<' against mean - sigma: for exactly two nonzero scores the
        # lower one lands exactly ON the line, so neither is quiet (documented
        # degenerate regime).
        agg = SpotlightAggregator()
        t0 = 1_000_000.0
        agg.record("s1", "alice", 60_000, occurred_at=t0, received_at=t0)
        agg.record("s1", "bob", 30_000, occurred_at=t0, received_at=t0)
        rows = agg.snapshot("s1", now_ms=t0, roster=["alice", "bob"])
        assert all(r["is_quiet"] is False for r in rows)
        assert {r["user_id"]: r["score"] for r in rows} == {
            "alice": pytest.approx(60.0),
            "bob": pytest.approx(30.0),
        }

    def test_all_equal_scores_flag_nobody(self):
        agg = SpotlightAggregator()
        t0 = 1_000_000.0
        for seat in ("alice", "bob"):
            agg.record("s1", seat, 20_000, occurred_at=t0, received_at=t0)
        rows = agg.snapshot("s1", now_ms=t0, roster=["alice", "bob"])
        assert all(not r["is_quiet"] for r in rows)


# ---------------------------------------------------------------------------
# API: report authentication matrix
# ---------------------------------------------------------------------------


class TestReportAuth:
    def test_anonymous_report_401(self):
        session = _bound_table("usr_host0")
        resp = client.post(
            f"/api/v1/sessions/{session}/spotlight/report",
            json={"seat_user_id": "usr_host0", "duration_ms": 3000, "occurred_at": 1},
        )
        assert resp.status_code == 401

    def test_invalid_token_report_401(self):
        session = _bound_table("usr_host0")
        resp = client.post(
            f"/api/v1/sessions/{session}/spotlight/report",
            params={"token": "not-a-real-token"},
            json={"seat_user_id": "usr_host0", "duration_ms": 3000, "occurred_at": 1},
        )
        assert resp.status_code == 401

    def test_authenticated_outsider_on_real_session_403(self):
        session = _bound_table("usr_host0")
        resp = _report(session, "usr_outsider", 3000)
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_NOT_A_PARTICIPANT"

    def test_participant_reports_own_seat_200(self):
        session = _bound_table("usr_host0")
        resp = _report(session, "usr_host0", 3000)
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "recorded"

    def test_participant_cannot_report_another_members_seat_403(self):
        session = _bound_table("usr_host0", "usr_guest1")
        # usr_host0 is a participant but reporting guest1's seat — must refuse.
        resp = client.post(
            f"/api/v1/sessions/{session}/spotlight/report",
            headers=_auth("usr_host0"),
            json={
                "seat_user_id": "usr_guest1",
                "duration_ms": 3000,
                "occurred_at": int(time.time() * 1000),
            },
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_SPOOFED_SEAT"

    def test_participant_cannot_report_random_non_member_403(self):
        # The spoof refusal (403) fires before the membership 422 for a
        # non-staff caller, because the seat does not match the caller.
        session = _bound_table("usr_host0")
        resp = client.post(
            f"/api/v1/sessions/{session}/spotlight/report",
            headers=_auth("usr_host0"),
            json={
                "seat_user_id": "usr_nobody",
                "duration_ms": 3000,
                "occurred_at": int(time.time() * 1000),
            },
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_SPOOFED_SEAT"

    def test_gm_may_report_member_seat_200(self):
        session = _bound_table("usr_host0", "usr_guest1")
        resp = client.post(
            f"/api/v1/sessions/{session}/spotlight/report",
            headers=_auth("usr_gm", role="gm"),
            json={
                "seat_user_id": "usr_guest1",
                "duration_ms": 5000,
                "occurred_at": int(time.time() * 1000),
            },
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["seat_user_id"] == "usr_guest1"

    def test_admin_may_report_member_seat_200(self):
        session = _bound_table("usr_host0", "usr_guest1")
        resp = client.post(
            f"/api/v1/sessions/{session}/spotlight/report",
            headers=_auth("usr_admin", role="admin"),
            json={
                "seat_user_id": "usr_guest1",
                "duration_ms": 5000,
                "occurred_at": int(time.time() * 1000),
            },
        )
        assert resp.status_code == 200, resp.text

    def test_unknown_session_is_404_for_everyone(self):
        session = _session_id()  # no lobby binds this id
        for role in ("player", "gm", "admin"):
            resp = client.post(
                f"/api/v1/sessions/{session}/spotlight/report",
                headers=_auth(f"usr_{role}", role=role),
                json={
                    "seat_user_id": "usr_x",
                    "duration_ms": 1000,
                    "occurred_at": 1,
                },
            )
            assert resp.status_code == 404
            assert resp.json()["detail"]["error"] == "SESSION_NOT_FOUND"


# ---------------------------------------------------------------------------
# API: report body validation (422, machine-readable codes)
# ---------------------------------------------------------------------------


class TestReportValidation:
    def _post(self, session_id: str, *,
              caller: str = "usr_host0", caller_role: str = "player",
              **overrides) -> TestClient:
        body = {
            "seat_user_id": "usr_host0",
            "duration_ms": 3000,
            "occurred_at": int(time.time() * 1000),
        }
        # ``_DROP`` values DELETE the key so a missing-field 422 can be
        # exercised; everything else overrides in place.
        for key, value in overrides.items():
            if value is _DROP:
                body.pop(key, None)
            else:
                body[key] = value
        return client.post(
            f"/api/v1/sessions/{session_id}/spotlight/report",
            headers=_auth(caller, role=caller_role),
            json=body,
        )

    def test_negative_duration_422(self):
        resp = self._post(_bound_table("usr_host0"), duration_ms=-1)
        assert resp.status_code == 422
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_DURATION_OUT_OF_RANGE"

    def test_overlong_duration_422(self):
        resp = self._post(_bound_table("usr_host0"), duration_ms=600_001)
        assert resp.status_code == 422
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_DURATION_OUT_OF_RANGE"

    def test_duration_at_both_bounds_accepted(self):
        session = _bound_table("usr_host0")
        for ms in (0, 600_000):
            resp = self._post(session, duration_ms=ms)
            assert resp.status_code == 200, resp.text

    def test_non_integer_duration_422(self):
        # A fractional payload is refused by FastAPI's own schema layer.
        resp = self._post(_bound_table("usr_host0"), duration_ms=3.5)
        assert resp.status_code == 422

    def test_negative_occurred_at_422(self):
        resp = self._post(_bound_table("usr_host0"), occurred_at=-1)
        assert resp.status_code == 422
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_TIMESTAMP_INVALID"

    def test_missing_occurred_at_422(self):
        resp = self._post(_bound_table("usr_host0"), occurred_at=_DROP)
        assert resp.status_code == 422

    def test_blank_seat_422(self):
        resp = self._post(_bound_table("usr_host0"), seat_user_id="   ")
        assert resp.status_code == 422
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_SEAT_REQUIRED"

    def test_non_member_seat_422_for_gm(self):
        # Staff skip the spoof check, so a non-member seat reaches the
        # membership validation and gets its dedicated 422.
        session = _bound_table("usr_host0")
        resp = self._post(
            session, caller="usr_gm", caller_role="gm", seat_user_id="usr_nobody"
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_SEAT_NOT_A_MEMBER"


# ---------------------------------------------------------------------------
# API: the tight per-IP spotlight_report bucket
# ---------------------------------------------------------------------------


class TestSpotlightReportBucket:
    def test_report_path_lands_in_spotlight_report_bucket(self):
        assert (
            _bucket_for_path("/api/v1/sessions/abc123/spotlight/report")
            == "spotlight_report"
        )

    def test_get_and_delete_spotlight_stay_on_default_bucket(self):
        # Only the /report WRITE is metered; rolling reads and the GM reset
        # are cheap and stay on the loose default bucket.
        assert _bucket_for_path("/api/v1/sessions/abc123/spotlight") == "default"

    def test_bucket_is_tight(self):
        limit, window = _RATE_LIMITS["spotlight_report"]
        assert limit == 10
        assert window == 60

    def test_bucket_is_tighter_than_default_and_tighter_than_llm(self):
        assert _RATE_LIMITS["spotlight_report"][0] < _RATE_LIMITS["default"][0]
        assert _RATE_LIMITS["spotlight_report"][0] < _RATE_LIMITS["llm"][0]

    def test_bucket_actually_blocks(self):
        session = _bound_table("usr_host0")
        limit, _window = _RATE_LIMITS["spotlight_report"]
        key = ("testclient", "spotlight_report")
        try:
            _rate_windows[key] = [time.time()] * limit
            resp = client.post(
                f"/api/v1/sessions/{session}/spotlight/report",
                headers=_auth("usr_host0"),
                json={
                    "seat_user_id": "usr_host0",
                    "duration_ms": 1000,
                    "occurred_at": int(time.time() * 1000),
                },
            )
            assert resp.status_code == 429
            assert resp.json()["error"] == "RATE_LIMITED"
        finally:
            _rate_windows.pop(key, None)


# ---------------------------------------------------------------------------
# API: GET aggregation
# ---------------------------------------------------------------------------


class TestSpotlightGet:
    def test_anonymous_get_401(self):
        session = _bound_table("usr_host0")
        resp = client.get(f"/api/v1/sessions/{session}/spotlight")
        assert resp.status_code == 401

    def test_outsider_get_403(self):
        session = _bound_table("usr_host0")
        resp = client.get(
            f"/api/v1/sessions/{session}/spotlight", headers=_auth("usr_outsider")
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_NOT_A_PARTICIPANT"

    def test_absent_session_returns_zero_scores_for_every_seat(self):
        session = _bound_table("usr_host0", "usr_guest1")
        resp = client.get(
            f"/api/v1/sessions/{session}/spotlight", headers=_auth("usr_host0")
        )
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["data_source"] == "client_self_reports"
        assert payload["observed_at"] is None
        assert {r["user_id"]: r["score"] for r in payload["scores"]} == {
            "usr_host0": 0.0,
            "usr_guest1": 0.0,
        }
        assert all(r["is_quiet"] is False for r in payload["scores"])

    def test_get_reflects_reports_with_decay_and_latest_stamp(self):
        session = _bound_table("usr_host0", "usr_guest1")
        now = int(time.time() * 1000)
        # gm credits guest1 with 30 s; guest1 self-reports 3 s.
        assert client.post(
            f"/api/v1/sessions/{session}/spotlight/report",
            headers=_auth("usr_gm", role="gm"),
            json={"seat_user_id": "usr_guest1", "duration_ms": 30_000, "occurred_at": now},
        ).status_code == 200
        assert _report(session, "usr_guest1", 3_000, occurred_at=now).status_code == 200

        resp = client.get(
            f"/api/v1/sessions/{session}/spotlight", headers=_auth("usr_host0")
        )
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        scores = {r["user_id"]: r["score"] for r in payload["scores"]}
        # No meaningful decay has elapsed in-milliseconds of wall clock, so the
        # guest's two bursts stack near 33 window-seconds.
        assert scores["usr_guest1"] == pytest.approx(33.0, abs=1.0)
        assert scores["usr_host0"] == pytest.approx(0.0, abs=1e-3)
        assert payload["observed_at"] == now
        assert payload["data_source"] == "client_self_reports"

    def test_gm_get_any_bound_session_200(self):
        session = _bound_table("usr_host0")
        resp = client.get(
            f"/api/v1/sessions/{session}/spotlight", headers=_auth("usr_gm", role="gm")
        )
        assert resp.status_code == 200

    def test_unknown_session_get_404(self):
        resp = client.get(
            f"/api/v1/sessions/{_session_id()}/spotlight",
            headers=_auth("usr_gm", role="gm"),
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"] == "SESSION_NOT_FOUND"


# ---------------------------------------------------------------------------
# API: DELETE reset semantics (GM/admin only)
# ---------------------------------------------------------------------------


class TestSpotlightDelete:
    def test_anonymous_delete_401(self):
        session = _bound_table("usr_host0")
        resp = client.delete(f"/api/v1/sessions/{session}/spotlight")
        assert resp.status_code == 401

    def test_participant_delete_403(self):
        session = _bound_table("usr_host0")
        assert _report(session, "usr_host0", 3000).status_code == 200
        resp = client.delete(
            f"/api/v1/sessions/{session}/spotlight", headers=_auth("usr_host0")
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"] == "SPOTLIGHT_DELETE_FORBIDDEN"

    def test_gm_delete_clears_scores(self):
        session = _bound_table("usr_host0")
        assert _report(session, "usr_host0", 3000).status_code == 200
        resp = client.delete(
            f"/api/v1/sessions/{session}/spotlight", headers=_auth("usr_gm", role="gm")
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "cleared"
        get_resp = client.get(
            f"/api/v1/sessions/{session}/spotlight", headers=_auth("usr_gm", role="gm")
        )
        assert get_resp.status_code == 200
        assert get_resp.json()["observed_at"] is None
        assert get_resp.json()["scores"][0]["score"] == 0.0

    def test_admin_delete_ok_and_idempotent(self):
        session = _bound_table("usr_host0")
        for _ in range(2):
            resp = client.delete(
                f"/api/v1/sessions/{session}/spotlight",
                headers=_auth("usr_admin", role="admin"),
            )
            assert resp.status_code == 200, resp.text

    def test_delete_unknown_session_404(self):
        resp = client.delete(
            f"/api/v1/sessions/{_session_id()}/spotlight",
            headers=_auth("usr_gm", role="gm"),
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"] == "SESSION_NOT_FOUND"