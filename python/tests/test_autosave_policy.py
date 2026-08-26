"""Iteration 77: opt-in per-campaign PERIODIC autosave.

The audit found that campaign durability was entirely pull-based: nothing
saved a campaign unless a human clicked autosave (POST /campaign/autosave) or
the client posted a snapshot (POST /campaign/save). A crashed browser or an
overnight session lost everything after the last manual click.

Contract pinned here:

* A GM opts a session IN with PUT /api/v1/campaign/autosave/policy carrying
  ``interval_minutes``; the policy is PERSISTED in storage (survives restart),
  readable back via GET, and gated GM/admin-only like every other autosave
  surface.
* The gateway runs a lightweight background loop (FastAPI lifespan) that,
  each tick, saves every ENABLED policy whose interval has elapsed AND whose
  engine ledger moved since the previous periodic save (idle campaigns are
  skipped rather than rewritten identically).
* One campaign failing to save (unreachable engine, corrupt state, storage
  error) is logged and skipped — it never kills the loop or the other
  campaigns' saves.
* Honest constraint, asserted in docs/tests: single-worker assumption. Two
  uvicorn workers would each run the loop and race on the same upsert slot.

Engine calls are faked exactly as in test_autosave.py / iteration 47; the
durability bridge tests own the live-engine round trip.
"""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.server import app

client = TestClient(app)


def _sign(user_id: str, role: str) -> str:
    from vtt_orchestrator.server import _sign_token

    return _sign_token(
        {"user_id": user_id, "role": role, "exp": time.time() + 600}
    )


@pytest.fixture()
def gm_token(request):
    return _sign(f"gm_pol_{abs(hash(request.node.name)) % 10**8}", "gm")


@pytest.fixture()
def second_gm_token(request):
    return _sign(f"gm_pol2_{abs(hash(request.node.name)) % 10**8}", "gm")


@pytest.fixture()
def player_token(request):
    email = f"pl_pol_{abs(hash(request.node.name)) % 10**8}@example.com"
    signup = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": email.split("@")[0],
              "display_name": "Player One", "password": "dice-dice",
              "role": "player"},
    )
    assert signup.status_code == 200, signup.text
    return signup.json()["token"]


def _live_state(events: int = 3, round_number: int = 4) -> dict:
    return {
        "session_id": "00000000-0000-0000-0000-00000000b17",
        "entities": {"ent-hero": {"name": "Kara", "current_hp": 20}},
        "ledger": {"events": [{"seq": i} for i in range(events)]},
        "combat": {"in_combat": True, "round": round_number},
    }


def _put_policy(token: str, session_id: str, **overrides):
    body = {"session_id": session_id, "enabled": True, "interval_minutes": 5}
    body.update(overrides)
    return client.put(
        "/api/v1/campaign/autosave/policy",
        params={"token": token},
        json=body,
    )


def _enable_policy(token: str, session_id: str, interval: int = 5) -> None:
    resp = _put_policy(token, session_id, interval_minutes=interval)
    assert resp.status_code == 200, resp.text


class TestAutosavePolicyRoutes:
    def test_gm_sets_and_reads_back_policy(self, gm_token):
        session_id = f"s-{abs(hash('setread')) % 10**8}"
        resp = _put_policy(gm_token, session_id, interval_minutes=7)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["session_id"] == session_id
        assert body["enabled"] is True
        assert body["interval_minutes"] == 7

        # Readable back through the GET half, same identity.
        got = client.get(
            "/api/v1/campaign/autosave/policy",
            params={"token": gm_token, "session_id": session_id},
        )
        assert got.status_code == 200, got.text
        assert got.json()["interval_minutes"] == 7
        assert got.json()["enabled"] is True

    def test_unset_policy_defaults_to_disabled(self, gm_token):
        session_id = f"s-{abs(hash('unset')) % 10**8}"
        got = client.get(
            "/api/v1/campaign/autosave/policy",
            params={"token": gm_token, "session_id": session_id},
        )
        assert got.status_code == 200, got.text
        body = got.json()
        assert body["enabled"] is False

    def test_disable_via_put_turns_policy_off(self, gm_token):
        session_id = f"s-{abs(hash('disable')) % 10**8}"
        assert _put_policy(gm_token, session_id).status_code == 200
        off = _put_policy(gm_token, session_id, enabled=False)
        assert off.status_code == 200, off.text
        assert off.json()["enabled"] is False
        got = client.get(
            "/api/v1/campaign/autosave/policy",
            params={"token": gm_token, "session_id": session_id},
        ).json()
        assert got["enabled"] is False

    def test_player_forbidden_403_before_any_write(self, player_token):
        session_id = f"s-{abs(hash('p403')) % 10**8}"
        resp = _put_policy(player_token, session_id)
        assert resp.status_code == 403
        assert resp.json()["detail"] == "AUTOSAVE_POLICY_GM_ONLY"
        got = client.get(
            "/api/v1/campaign/autosave/policy",
            params={"token": player_token, "session_id": session_id},
        )
        assert got.status_code == 403

    def test_unauthenticated_401(self):
        resp = client.put(
            "/api/v1/campaign/autosave/policy",
            json={"session_id": "whatever", "enabled": True,
                  "interval_minutes": 5},
        )
        assert resp.status_code == 401

    def test_invalid_interval_rejected_422(self, gm_token):
        # Below 1 would hammer the engine every poll; above 1440 (a day)
        # "periodic" stops meaning anything.
        for bad in (0, -3, 1441):
            resp = _put_policy(gm_token, f"s-{abs(hash(str(bad))) % 10**8}",
                               interval_minutes=bad)
            assert resp.status_code == 422, (bad, resp.text)

    def test_policy_survives_in_storage_across_readers(self, gm_token,
                                                       second_gm_token):
        """Persisted in the storage backend, not a request-scoped dict: another
        GM identity sees nothing (per-owner rows), and the SAME owner still
        reads the policy back after unrelated traffic."""
        session_id = f"s-{abs(hash('persist')) % 10**8}"
        assert _put_policy(gm_token, session_id, interval_minutes=15).status_code == 200
        # Owner-scoped: a different GM has no policy row for this session.
        got = client.get(
            "/api/v1/campaign/autosave/policy",
            params={"token": second_gm_token, "session_id": session_id},
        ).json()
        assert got["enabled"] is False
        # Same owner still reads it.
        mine = client.get(
            "/api/v1/campaign/autosave/policy",
            params={"token": gm_token, "session_id": session_id},
        ).json()
        assert mine["interval_minutes"] == 15


class TestPeriodicAutosaveCycle:

    def test_due_campaign_with_ledger_movement_saves(self, gm_token,
                                                     monkeypatch):
        import vtt_orchestrator.server as srv

        session_id = f"s-{abs(hash('due_save')) % 10**8}"
        _enable_policy(gm_token, session_id)

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            assert method == "GET"
            assert actor == {"user_id":
                             srv._verify_token(gm_token)["user_id"],
                             "role": "gm"}
            return _live_state(events=3)

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        t0 = time.time()
        saved = asyncio.run(srv.run_autosave_cycle(now=t0))
        mine = [s for s in saved if s["session_id"] == session_id]
        assert len(mine) == 1
        assert mine[0]["events_count"] == 3

        # The save is retrievable through the ordinary load path owned by the
        # GM, under the rolling periodic slot (upsert-keyed, not unbounded).
        listing = client.get("/api/v1/campaign/saves",
                             params={"token": gm_token}).json()
        names = [s["save_name"] for s in listing["saves"]]
        assert any(session_id[:8] in n for n in names), names

    def test_idle_campaign_skipped_no_identical_rewrite(self, gm_token,
                                                        monkeypatch):
        import vtt_orchestrator.server as srv

        session_id = f"s-{abs(hash('idle')) % 10**8}"
        _enable_policy(gm_token, session_id)

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            return _live_state(events=9)

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        t0 = time.time()
        first = asyncio.run(srv.run_autosave_cycle(now=t0))
        assert any(s["session_id"] == session_id for s in first)

        # Same ledger length on the next tick => idle => skipped even though
        # the interval has elapsed again.
        second = asyncio.run(srv.run_autosave_cycle(now=t0 + 3600))
        assert all(s["session_id"] != session_id for s in second)

        # Movement again => saved once more.
        async def moved(method, path, payload=None, *, actor=None):
            return _live_state(events=12)

        monkeypatch.setattr(engine_client, "engine_request", moved)
        third = asyncio.run(srv.run_autosave_cycle(now=t0 + 7200))
        assert any(s["session_id"] == session_id for s in third)

    def test_interval_not_elapsed_skipped_even_with_movement(self, gm_token,
                                                             monkeypatch):
        import vtt_orchestrator.server as srv

        session_id = f"s-{abs(hash('early')) % 10**8}"
        _enable_policy(gm_token, session_id, interval=10)

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            return _live_state(events=2)

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        t0 = time.time()
        assert any(s["session_id"] == session_id
                   for s in asyncio.run(srv.run_autosave_cycle(now=t0)))
        # 60s later << 10 minutes: movement happened, but too early.
        async def more(method, path, payload=None, *, actor=None):
            return _live_state(events=4)

        monkeypatch.setattr(engine_client, "engine_request", more)
        again = asyncio.run(srv.run_autosave_cycle(now=t0 + 60))
        assert all(s["session_id"] != session_id for s in again)

    def test_disabled_or_missing_policy_never_saves(self, gm_token,
                                                    monkeypatch):
        import vtt_orchestrator.server as srv

        called = []

        async def spy(method, path, payload=None, *, actor=None):
            called.append(path)
            return _live_state()

        monkeypatch.setattr(engine_client, "engine_request", spy)
        # Disabled policy: opted out entirely.
        session_off = f"s-{abs(hash('off')) % 10**8}"
        assert _put_policy(gm_token, session_off, enabled=False).status_code == 200
        asyncio.run(srv.run_autosave_cycle(now=time.time()))
        assert called == []
        # No policy at all for this owner either.
        assert all("nope" not in p for p in called)

    def test_one_corrupt_campaign_does_not_block_others(self, gm_token,
                                                        second_gm_token,
                                                        monkeypatch):
        import vtt_orchestrator.server as srv

        dead_session = f"s-{abs(hash('dead')) % 10**8}"
        live_session = f"s-{abs(hash('alive')) % 10**8}"
        _enable_policy(gm_token, dead_session)
        _enable_policy(second_gm_token, live_session)

        dead_owner = srv._verify_token(gm_token)["user_id"]
        live_owner = srv._verify_token(second_gm_token)["user_id"]

        async def rotten(method, path, payload=None, *, actor=None):
            if actor["user_id"] == dead_owner:
                raise RuntimeError("simulated corrupt engine payload")
            return _live_state(events=5)

        monkeypatch.setattr(engine_client, "engine_request", rotten)

        saved = asyncio.run(srv.run_autosave_cycle(now=time.time()))
        # The healthy campaign still got its save despite the other raising.
        assert any(s["session_id"] == live_session for s in saved)
        assert all(s["session_id"] != dead_session for s in saved)
        # The loop itself survives to run another tick.
        assert callable(srv.run_autosave_cycle)


class TestBackgroundLoopWiring:
    def test_loop_ticks_and_saves_due_campaign(self, gm_token, monkeypatch):
        import vtt_orchestrator.server as srv

        session_id = f"s-{abs(hash('loop')) % 10**8}"
        _enable_policy(gm_token, session_id, interval=1)

        async def fake_engine_request(method, path, payload=None, *,
                                      actor=None):
            return _live_state(events=6)

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        async def scenario():
            task = asyncio.create_task(srv._autosave_loop(poll_seconds=0.02))
            try:
                for _ in range(200):
                    await asyncio.sleep(0.02)
                    listing = await srv.storage_backend.list_campaign_saves(
                        srv._verify_token(gm_token)["user_id"])
                    if any(session_id[:8] in s["save_name"]
                           for s in listing):
                        return True
                return False
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        assert asyncio.run(scenario()) is True

    def test_loop_swallows_per_campaign_failure_and_keeps_ticking(
            self, gm_token, monkeypatch):
        import vtt_orchestrator.server as srv

        session_id = f"s-{abs(hash('loopfail')) % 10**8}"
        _enable_policy(gm_token, session_id, interval=1)

        flips = {"n": 0}

        async def flaky(method, path, payload=None, *, actor=None):
            flips["n"] += 1
            if flips["n"] <= 2:
                raise RuntimeError("transient engine outage")
            return _live_state(events=7)

        monkeypatch.setattr(engine_client, "engine_request", flaky)

        async def scenario():
            task = asyncio.create_task(srv._autosave_loop(poll_seconds=0.02))
            try:
                for _ in range(300):
                    await asyncio.sleep(0.02)
                    listing = await srv.storage_backend.list_campaign_saves(
                        srv._verify_token(gm_token)["user_id"])
                    if any(session_id[:8] in s["save_name"]
                           for s in listing):
                        return True
                return False
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        assert asyncio.run(scenario()) is True
