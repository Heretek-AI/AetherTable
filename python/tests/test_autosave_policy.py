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

from vtt_orchestrator import server as server_module
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


def _ensure_standing(token: str, session_id: str) -> None:
    """Iteration 87 (audit A5/F1): policies require lobby-derived standing,
    so every legitimate-policy scenario binds a lobby owned by the caller to
    the engine session first (exactly what launch does via set_lobby_session).
    """
    created = client.post(
        "/api/v1/lobbies",
        params={"token": token},
        json={"name": f"Standing · {session_id[:8]}"},
    )
    assert created.status_code == 200, created.text
    asyncio.run(server_module.storage_backend.set_lobby_session(
        created.json()["lobby_id"], session_id))


def _enable_policy(token: str, session_id: str, interval: int = 5) -> None:
    _ensure_standing(token, session_id)
    resp = _put_policy(token, session_id, interval_minutes=interval)
    assert resp.status_code == 200, resp.text


class TestAutosavePolicyRoutes:
    def test_gm_sets_and_reads_back_policy(self, gm_token):
        session_id = f"s-{abs(hash('setread')) % 10**8}"
        _ensure_standing(gm_token, session_id)
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
        _ensure_standing(gm_token, session_id)
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
        _ensure_standing(gm_token, session_id)
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
        _ensure_standing(gm_token, session_off)
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


# --- Iteration 87 (audit A5/F1): the policy loop must not fabricate authority -
#
# Two defects pinned red here:
#
#   (a) PUT /campaign/autosave/policy gated ONLY on the caller's role. Any GM
#       could point a policy at an ARBITRARY session UUID (no lobby binding,
#       no relationship to req.session_id) and receive that table's complete
#       hidden-entity state one poll interval later.
#   (b) run_autosave_cycle called the engine as {"user_id": owner,
#       "role": "gm"} — a claim the gateway signs itself and the engine
#       trusts — so once enabled, the loop kept pulling FULL state forever on
#       behalf of an owner whose GM standing had since been revoked or who had
#       left the table.
#
# The fix derives standing from gateway-owned data (the lobby roster bound to
# the session via set_lobby_session — the same derivation as
# _caller_is_session_participant), re-checked FRESH each cycle, and fails
# closed even for admin tokens on unbound sessions.


def _lobby(token: str, name: str) -> dict:
    created = client.post(
        "/api/v1/lobbies", params={"token": token}, json={"name": name}
    )
    assert created.status_code == 200, created.text
    return created.json()


def _join(lobby: dict, token: str) -> None:
    joined = client.post(
        f"/api/v1/lobbies/{lobby['lobby_id']}/join",
        params={"token": token},
        json={"invite_code": lobby["invite_code"]},
    )
    assert joined.status_code == 200, joined.text


def _bind(lobby_id: str, session_id: str) -> None:
    asyncio.run(
        server_module.storage_backend.set_lobby_session(lobby_id, session_id)
    )


class TestPolicyStandingGate:
    def test_policy_on_arbitrary_unbound_session_rejected_403(self, gm_token):
        """The core defect: role alone is not standing. A GM naming a session
        UUID they have no lobby relationship with gets 403 and NO row."""
        arbitrary = "99999999-9999-9999-9999-999999999991"
        resp = _put_policy(gm_token, arbitrary)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "AUTOSAVE_POLICY_NO_STANDING"
        got = client.get(
            "/api/v1/campaign/autosave/policy",
            params={"token": gm_token, "session_id": arbitrary},
        ).json()
        assert got["enabled"] is False

    def test_admin_also_requires_lobby_binding(self):
        """Fail closed even for admins: global staff standing is not table
        standing over an unbound session UUID."""
        admin_token = _sign("usr_admin87", "admin")
        arbitrary = "99999999-9999-9999-9999-999999999992"
        resp = _put_policy(admin_token, arbitrary)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "AUTOSAVE_POLICY_NO_STANDING"

    def test_host_of_bound_lobby_has_standing(self, gm_token):
        lobby = _lobby(gm_token, "Autosave Host Lobby")
        session_id = "88888888-8888-8888-8888-888888888881"
        _bind(lobby["lobby_id"], session_id)
        resp = _put_policy(gm_token, session_id)
        assert resp.status_code == 200, resp.text
        assert resp.json()["enabled"] is True

    def test_member_of_bound_lobby_has_standing(self):
        """A GM who is an ordinary MEMBER (not host) of a lobby bound to the
        session has standing — membership itself is the evidence, host or not."""
        member_token = _sign("usr_member87", "gm")
        host_lobby = _lobby(_sign("usr_host87", "player"), "Member Standing Lobby")
        _join(host_lobby, member_token)
        session_id = "88888888-8888-8888-8888-888888888882"
        _bind(host_lobby["lobby_id"], session_id)
        resp = _put_policy(member_token, session_id)
        assert resp.status_code == 200, resp.text

    def test_gm_with_no_lobby_relationship_to_bound_session_rejected(
            self, gm_token):
        """A lobby exists and is bound to the session — but THIS caller is not
        in it. Role 'gm' alone still confers nothing."""
        outsider_lobby = _lobby(_sign("usr_host88", "player"), "Not Theirs")
        session_id = "88888888-8888-8888-8888-888888888883"
        _bind(outsider_lobby["lobby_id"], session_id)
        resp = _put_policy(gm_token, session_id)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "AUTOSAVE_POLICY_NO_STANDING"


class TestCycleReverifiesStanding:
    def test_removed_owner_policy_disabled_and_fetch_skipped(self, gm_token,
                                                             monkeypatch):
        """The loop-side half of the defect: standing is re-derived FRESH each
        cycle. When the owner's membership ends (removed / left), the next
        tick disables the policy and never touches the engine for it."""
        import vtt_orchestrator.server as srv

        lobby = _lobby(gm_token, "Revocation Lobby")
        session_id = "88888888-8888-8888-8888-888888888884"
        _bind(lobby["lobby_id"], session_id)
        owner = srv._verify_token(gm_token)["user_id"]
        assert _put_policy(gm_token, session_id).status_code == 200

        calls = []

        async def spy(method, path, payload=None, *, actor=None):
            calls.append(path)
            return _live_state(events=4)

        monkeypatch.setattr(engine_client, "engine_request", spy)

        # Standing intact: first tick saves and does reach the engine.
        # (Call count is scoped to THIS session's path: other tests' policies
        # legitimately share the shared storage backend and may also save.)
        mine = f"/api/v1/sessions/{session_id}"

        def my_calls() -> int:
            return sum(1 for c in calls if c == mine)

        first = asyncio.run(srv.run_autosave_cycle(now=time.time()))
        assert any(s["session_id"] == session_id for s in first)
        assert my_calls() == 1

        # Standing lost: drop every lobby membership for this user (the
        # storage-level equivalent of being removed or leaving; the gateway
        # exposes no leave route, so membership ends exactly here).
        async def strip():
            owned = [
                lb["lobby_id"]
                for lb in await srv.storage_backend.list_lobbies_for_user(owner)
            ]
            for lobby_id in owned:
                record = srv.storage_backend.lobbies.get(lobby_id)
                if record is not None:
                    record["members"] = [
                        m for m in record["members"] if m["user_id"] != owner
                    ]

        asyncio.run(strip())

        second = asyncio.run(srv.run_autosave_cycle(now=time.time() + 3600))
        # No further fetch happened on the owner's behalf...
        assert my_calls() == 1
        assert all(s["session_id"] != session_id for s in second)
        # ...the policy was persisted DISABLED so later ticks stop asking...
        got = client.get(
            "/api/v1/campaign/autosave/policy",
            params={"token": gm_token, "session_id": session_id},
        ).json()
        assert got["enabled"] is False
        # ...and the disabled row is invisible to future cycles.
        remaining = [
            p for p in asyncio.run(
                server_module.storage_backend.list_enabled_autosave_policies())
            if p["owner_user_id"] == owner
            and p["engine_session_id"] == session_id
        ]
        assert remaining == []

    def test_standing_intact_cycle_continues_saving(self, gm_token, monkeypatch):
        import vtt_orchestrator.server as srv

        lobby = _lobby(gm_token, "Durable Standing Lobby")
        session_id = "88888888-8888-8888-8888-888888888885"
        _bind(lobby["lobby_id"], session_id)
        assert _put_policy(gm_token, session_id).status_code == 200

        ticks = {"n": 0}

        async def live(method, path, payload=None, *, actor=None):
            ticks["n"] += 1
            return _live_state(events=3 + ticks["n"])

        monkeypatch.setattr(engine_client, "engine_request", live)

        t0 = time.time()
        assert any(s["session_id"] == session_id
                   for s in asyncio.run(srv.run_autosave_cycle(now=t0)))
        assert any(s["session_id"] == session_id
                   for s in asyncio.run(srv.run_autosave_cycle(now=t0 + 3600)))
        # Both cycles actually reached the engine: the standing re-check
        # passed both times rather than silently dropping the campaign.
        assert ticks["n"] >= 2
