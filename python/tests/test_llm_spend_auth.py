"""Auth + rate-limit hardening for the LLM-spend and shared-state routes.

Iteration 10 closes the sweep documented at the end of iteration 8: seven
routes that mutate shared state or spend LLM budget still accepted anonymous
callers:

* ``POST /api/v1/agent/turn`` — drives tool-agent actions against an engine
  session (the most serious: unauthenticated engine mutation through the
  agent loop).
* ``POST /api/v1/dynasty/inject-lore`` — mutates the SHARED global lore graph.
* ``POST /api/v1/simulation/tick`` — advances the SHARED faction simulation.
* ``POST /api/v1/simulation/empirical-benchmark`` — 10-1000 encounter
  simulations per call: an unauthenticated CPU/DoS vector.
* ``POST /api/v1/intent/classify``, ``POST /api/v1/orchestrator/turn``,
  ``POST /api/v1/orchestrator/narrative/stream`` (plus the legacy
  ``/api/v1/narrative/*`` aliases) — every hit can spend model tokens.

Trust decisions encoded here (documented next to the handlers in server.py):

* agent/turn: gm/admin for ANY session; other seats only as members of a
  lobby bound to the named engine session (the x-card participation model);
  everyone else fails closed with 403.
* inject-lore / simulation tick / empirical-benchmark: gm/admin ONLY.
* classify / orchestrator turns / narrative streams: ANY authenticated seat
  (players narrate too), but the traffic lands in a dedicated ``llm``
  rate-limit bucket capped below the agent bucket, and the benchmark route
  gets its own tighter ``benchmark`` bucket.
"""

import time

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

client = TestClient(app)


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _auth(user_id: str = "usr_test", role: str = "player") -> dict:
    return {"Authorization": f"Bearer {_token(user_id, role)}"}


def _tamper(token: str) -> str:
    return token[:-4] + ("0000" if not token.endswith("0000") else "1111")


def _turn_payload(**overrides) -> dict:
    base = {
        "user_intent": "I strike the goblin",
        "turn_index": 1,
        "entity_id": "pc_thorin",
        "engine_execution_payload": {
            "action_name": "Greataxe Strike",
            "is_hit": True,
            "total_damage": 11,
            "target_hp_remaining": 15,
            "target_is_conscious": True,
            "target_is_dead": False,
        },
        "active_entity_count": 4,
        "previous_entity_count": 4,
    }
    base.update(overrides)
    return base


ALL_PROTECTED_ROUTES = [
    ("/api/v1/agent/turn", {
        "user_intent": "I strike the goblin",
        "session_id": "00000000-0000-0000-0000-00000000beef",
    }),
    ("/api/v1/dynasty/inject-lore", {"house_id": "house_vane"}),
    ("/api/v1/simulation/tick", None),
    ("/api/v1/simulation/empirical-benchmark", None),
    ("/api/v1/intent/classify", {"utterance": "I attack with greatsword",
                                 "speaker_id": "Thorin"}),
    ("/api/v1/orchestrator/turn", _turn_payload()),
    ("/api/v1/orchestrator/narrative/stream", _turn_payload()),
]


# ---------------------------------------------------------------------------
# Authentication: nobody rides free
# ---------------------------------------------------------------------------


class TestAnonymousRejected:
    @pytest.mark.parametrize("path,body", ALL_PROTECTED_ROUTES)
    def test_anonymous_caller_gets_401(self, path, body):
        kwargs = {"json": body} if body is not None else {}
        resp = client.post(path, **kwargs)
        assert resp.status_code == 401, f"{path} -> {resp.status_code}"

    @pytest.mark.parametrize("path,body", ALL_PROTECTED_ROUTES)
    def test_tampered_token_gets_401(self, path, body):
        kwargs = {"json": body} if body is not None else {}
        resp = client.post(
            path, headers=_auth(role="gm"), **kwargs
        )
        assert resp.status_code in (200, 403), "sanity: untampered gm clears auth"
        resp = client.post(
            path,
            headers={"Authorization": f"Bearer {_tamper(_token('usr_gm', 'gm'))}"},
            **kwargs,
        )
        assert resp.status_code == 401, f"{path} -> {resp.status_code}"

    def test_legacy_query_param_channel_still_accepted(self):
        """/intent/classify keeps the documented ?token= back-compat channel."""
        resp = client.post(
            "/api/v1/intent/classify",
            params={"token": _token("usr_test", "player")},
            json={"utterance": "I attack with greatsword", "speaker_id": "Thorin"},
        )
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Authorization: who may touch shared state
# ---------------------------------------------------------------------------


class TestStaffOnlyRoutes:
    @pytest.mark.parametrize("path,body", [
        ("/api/v1/dynasty/inject-lore", {"house_id": "house_vane"}),
        ("/api/v1/simulation/tick", None),
        ("/api/v1/simulation/empirical-benchmark", None),
    ])
    def test_player_and_spectator_forbidden(self, path, body):
        for role in ("player", "spectator"):
            kwargs = {"json": body} if body is not None else {}
            resp = client.post(path, headers=_auth(f"usr_{role}", role), **kwargs)
            assert resp.status_code == 403, f"{path}/{role} -> {resp.status_code}"
            assert "GM" in resp.json()["detail"] or "gm" in resp.json()["detail"]

    def test_gm_may_tick_shared_simulation(self):
        resp = client.post("/api/v1/simulation/tick", headers=_auth("usr_gm", "gm"))
        assert resp.status_code == 200, resp.text
        assert "actions_executed" in resp.json()

    def test_gm_may_run_benchmark(self):
        resp = client.post(
            "/api/v1/simulation/empirical-benchmark",
            params={"simulations": 10},
            headers=_auth("usr_gm", "gm"),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["total_simulations"] == 10


class TestAgentTurnAuthorization:
    PATH = "/api/v1/agent/turn"

    def _body(self, session_id="00000000-0000-0000-0000-00000000beef"):
        return {"user_intent": "I strike the goblin", "session_id": session_id}

    def test_outside_player_forbidden(self):
        """A valid player token naming a session with no bound lobby roster
        must NOT be able to drive the tool agent against it."""
        resp = client.post(
            self.PATH, headers=_auth("usr_outsider", "player"),
            json=self._body(),
        )
        assert resp.status_code == 403, resp.text
        assert "AGENT_TURN_FORBIDDEN" in resp.json()["detail"]

    def test_spectator_forbidden_even_without_session_roster(self):
        resp = client.post(
            self.PATH, headers=_auth("usr_spec", "spectator"),
            json=self._body(),
        )
        assert resp.status_code == 403

    def test_gm_may_drive_any_session(self):
        """GM clears the gate; the handler then honestly reports the tool
        agent cannot run without a configured LLM key (mock mode) instead of
        pretending to act."""
        resp = client.post(
            self.PATH, headers=_auth("usr_gm1", "gm"), json=self._body()
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] in ("UNAVAILABLE", "LLM_UPSTREAM_EMPTY")

    def test_bound_lobby_participant_may_drive_their_session(self):
        host_auth = _auth("usr_host41", "player")
        created = client.post(
            "/api/v1/lobbies", headers=host_auth, json={"name": "Agent Lobby"}
        )
        assert created.status_code == 200, created.text
        lobby = created.json()

        guest_auth = _auth("usr_guest42", "player")
        joined = client.post(
            f"/api/v1/lobbies/{lobby['lobby_id']}/join",
            headers=guest_auth,
            json={"invite_code": lobby["invite_code"]},
        )
        assert joined.status_code == 200

        session_id = "44444444-4444-4444-4444-444444444444"
        # Bind exactly as lobby launch does, without needing the live engine.
        import asyncio

        asyncio.run(
            server_module.storage_backend.set_lobby_session(lobby["lobby_id"], session_id)
        )

        ok = client.post(
            self.PATH, headers=guest_auth, json=self._body(session_id)
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["status"] in ("UNAVAILABLE", "LLM_UPSTREAM_EMPTY")

        stranger = client.post(
            self.PATH, headers=_auth("usr_stranger43", "player"),
            json=self._body(session_id),
        )
        assert stranger.status_code == 403


class TestNarrateRoutesAnyAuthenticatedSeat:
    """Players narrate too: classify/turn/stream accept any valid token."""

    @pytest.mark.parametrize("role", ["player", "spectator"])
    def test_classify_accepts_any_authenticated_role(self, role):
        resp = client.post(
            "/api/v1/intent/classify",
            headers=_auth(f"usr_{role}", role),
            json={"utterance": "I attack with greatsword", "speaker_id": "Thorin"},
        )
        assert resp.status_code == 200
        assert resp.json()["intent_type"] == "MECHANICAL_INVOCATION"

    def test_orchestrator_turn_accepts_player(self):
        resp = client.post(
            "/api/v1/orchestrator/turn", headers=_auth("usr_p50", "player"),
            json=_turn_payload(),
        )
        assert resp.status_code == 200, resp.text
        assert "status" in resp.json()


# ---------------------------------------------------------------------------
# Rate limiting: spend-appropriate buckets
# ---------------------------------------------------------------------------


class TestSpendBuckets:
    def test_llm_routes_land_in_llm_bucket(self):
        for path in (
            "/api/v1/intent/classify",
            "/api/v1/orchestrator/turn",
            "/api/v1/orchestrator/narrative/stream",
            "/api/v1/narrative/generate",
            "/api/v1/narrative/stream",
        ):
            assert _bucket_for_path(path) == "llm", path

    def test_benchmark_gets_own_bucket(self):
        assert _bucket_for_path("/api/v1/simulation/empirical-benchmark") == "benchmark"

    def test_existing_buckets_unchanged(self):
        assert _bucket_for_path("/api/v1/auth/signup") == "auth"
        assert _bucket_for_path("/api/v1/agent/turn") == "agent"
        assert _bucket_for_path("/api/v1/compendium/spells") == "default"

    def test_benchmark_cap_is_tightest(self):
        assert _RATE_LIMITS["benchmark"][0] < _RATE_LIMITS["llm"][0]
        assert _RATE_LIMITS["llm"][0] <= _RATE_LIMITS["agent"][0]

    def test_benchmark_bucket_actually_blocks(self):
        limit, _window = _RATE_LIMITS["benchmark"]
        key = ("testclient", "benchmark")
        try:
            _rate_windows[key] = [time.time()] * limit
            resp = client.post(
                "/api/v1/simulation/empirical-benchmark",
                params={"simulations": 10},
                headers=_auth("usr_gm", "gm"),
            )
            assert resp.status_code == 429
            assert resp.json()["error"] == "RATE_LIMITED"
        finally:
            _rate_windows.pop(key, None)

    def test_llm_bucket_actually_blocks(self):
        limit, _window = _RATE_LIMITS["llm"]
        key = ("testclient", "llm")
        try:
            _rate_windows[key] = [time.time()] * limit
            resp = client.post(
                "/api/v1/intent/classify",
                headers=_auth("usr_test", "player"),
                json={"utterance": "I attack", "speaker_id": "Thorin"},
            )
            assert resp.status_code == 429
        finally:
            _rate_windows.pop(key, None)
