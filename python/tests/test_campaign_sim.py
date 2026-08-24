"""Backlog item 5.1 (+5.2): agent-driven campaign simulation harness.

Contract under test:

- ``CampaignSimulation.run()`` drives N synthetic ``CampaignSimPlayer``s
  through the REAL orchestrator surface: auth signup/login, lobby
  create/join/launch, character create/deploy, then T rounds of turns whose
  actions execute through the SAME authenticated proxy endpoints a browser
  uses (``?token=`` forwarded identity).
- Every LLM decision goes through ``routing.llm_client.LLMStreamingGateway``
  (so JSONL logging captures it); malformed/absent LLM output falls back to
  the deterministic scripted policy FOR THAT TURN while still counting the
  attempt.
- With no LLM key configured the run is tagged ``mode: "scripted"`` and never
  touches the network.
- Rejections reported by the proxy/engine are accounted per-round with their
  reasons. The report invents nothing: every number is counted.

No unit test touches the network: outbound orchestrator HTTP rides an
in-process ASGI transport, the authoritative Rust engine behind
``routing.engine_client`` is replaced with an in-memory fake, and the LLM
upstream is a canned httpx fake (same pattern as test_llm_intent.py).
"""

import asyncio
import copy
import json
import re
import uuid as uuid_mod

import httpx
import pytest
from types import SimpleNamespace

from vtt_orchestrator.routing import engine_client, llm_client as llm_client_module
from vtt_orchestrator.routing.engine_client import EngineRejectedError
from vtt_orchestrator.routing.llm_client import LLMConfig, LLMStreamingGateway
from vtt_orchestrator.server import app
from vtt_orchestrator.simulation.campaign_sim import (
    CampaignSimulation,
    CampaignSimPlayer,
    scripted_decision,
)


# ---------------------------------------------------------------------------
# Fakes: the authoritative Rust engine (behind routing.engine_client)
# ---------------------------------------------------------------------------

DUMMY_ID = engine_client._coerce_uuid("sim-training-dummy")


class FakeEngine:
    """In-memory stand-in for vtt-server's HTTP surface.

    Records every call INCLUDING the forwarded actor identity so tests can
    assert that player tokens (not the gateway service principal) authorized
    each action.
    """

    def __init__(self):
        self.calls = []
        self.entities = {}          # session_id -> {entity_id: entity dict}
        self.reject_rules = []      # list of (path_substring, status, reason)
        self.attack_damage = 3

    # -- configuration ------------------------------------------------------

    def reject(self, path_substring: str, reason: str, status: int = 409):
        self.reject_rules.append((path_substring, status, reason))

    # -- fake transport -----------------------------------------------------

    async def engine_request(self, method, path, payload=None, *, actor=None):
        self.calls.append(
            {"method": method, "path": path, "payload": payload, "actor": actor}
        )
        for pattern, status, reason in self.reject_rules:
            if pattern in path:
                raise EngineRejectedError(status, json.dumps({"reason": reason}))

        if method == "POST" and path == "/api/v1/sessions":
            session_id = str(uuid_mod.uuid4())
            self.entities[session_id] = {}
            return {"session_id": session_id, "status": "CREATED"}

        m = re.fullmatch(r"/api/v1/sessions/([^/]+)/entities", path)
        if m:
            session_id = m.group(1)
            bucket = self.entities.setdefault(session_id, {})
            entity = dict(payload)
            bucket[entity["id"]] = entity
            return {"status": "SPAWNED", "entity_id": entity["id"]}

        m = re.fullmatch(r"/api/v1/sessions/([^/]+)", path)
        if method == "GET" and m:
            return {
                "session_id": m.group(1),
                "entities": copy.deepcopy(self.entities.get(m.group(1), {})),
            }

        m = re.fullmatch(r"/api/v1/sessions/([^/]+)/action/attack", path)
        if m:
            attacker_id = payload["attacker_id"]
            target_id = payload["target_id"]
            bucket = self.entities[m.group(1)]
            if attacker_id not in bucket:
                raise EngineRejectedError(404, json.dumps({"reason": "UNKNOWN_ATTACKER"}))
            target = bucket.get(target_id)
            if target is None or target.get("is_dead"):
                raise EngineRejectedError(409, json.dumps({"reason": "TARGET_ALREADY_DEAD"}))
            target["current_hp"] = int(target.get("current_hp", 0)) - self.attack_damage
            dead = target["current_hp"] <= 0
            target["current_hp"] = max(target["current_hp"], 0)
            target["is_dead"] = dead
            return {
                "status": "RESOLVED",
                "action_name": "Strike",
                "is_hit": True,
                "total_damage": self.attack_damage,
                "target_hp_remaining": target["current_hp"],
                "target_is_dead": dead,
                "event_sequence": len(self.calls),
            }

        m = re.fullmatch(r"/api/v1/sessions/([^/]+)/move", path)
        if m:
            bucket = self.entities[m.group(1)]
            entity = bucket.get(payload["entity_id"])
            if entity is None:
                raise EngineRejectedError(409, json.dumps({"reason": "MOVE_REJECTED"}))
            entity["position"] = [payload["x"], payload["y"], 0.0]
            return {"status": "MOVED", "outcome": {"to": {"x": payload["x"], "y": payload["y"]}}}

        if path == "/api/v1/actions/check":
            return {"total": 15, "d20": 13, "modifier": 2, "dc": payload.get("dc"), "success": True}

        raise AssertionError(f"FakeEngine has no route for {method} {path}")

    def calls_to(self, substring):
        return [c for c in self.calls if substring in c["path"]]


@pytest.fixture(autouse=True)
def _fresh_rate_limiter_windows():
    """The orchestrator's in-process rate limiter keeps 60s sliding windows in
    module state; a full test file issues far more than the auth bucket's
    30 requests/minute through the shared ASGI app. Reset the windows around
    every test so order and suite size can never starve later sims of setup."""
    from vtt_orchestrator import server as server_module

    server_module._rate_windows.clear()
    yield
    server_module._rate_windows.clear()


@pytest.fixture()
def fake_engine(monkeypatch):
    """Replaces the engine transport AND clears ambient LLM credentials so a
    developer's exported LLM_KEY can never turn a scripted test nondeterministic."""
    fake = FakeEngine()
    monkeypatch.setattr(engine_client, "engine_request", fake.engine_request)
    for var in ("LLM_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    return fake


def asgi_transport():
    return httpx.ASGITransport(app=app)


def make_simulation(players=2, rounds=3, **kwargs):
    kwargs.setdefault("transport", asgi_transport())
    return CampaignSimulation(players=players, rounds=rounds, **kwargs)


def run(players=2, rounds=3, **kwargs):
    return asyncio.run(make_simulation(players, rounds, **kwargs).run())


def run_with_sim(players=2, rounds=3, **kwargs):
    """Like ``run`` but also hands back the simulation instance so tests can
    inspect its disposition engine directly."""
    sim = make_simulation(players, rounds, **kwargs)
    return sim, asyncio.run(sim.run())


# ---------------------------------------------------------------------------
# Fakes: the LLM upstream (canned chat-completions bodies)
# ---------------------------------------------------------------------------

def _install_upstream(monkeypatch, contents):
    """Patch ONLY the LLM leg of httpx: chat-completions posts get canned
    bodies, every other URL passes through to the real client (which is how
    the sim's own ASGI transport keeps working)."""
    bodies = [
        c if isinstance(c, dict) else {
            "choices": [{"message": {"role": "assistant", "content": c}}]
        }
        for c in contents
    ]

    class _FakeAsyncClient(httpx.AsyncClient):
        remaining = list(bodies)
        calls = []

        async def post(self, url, headers=None, json=None, **kwargs):
            if "chat/completions" not in str(url):
                return await super().post(url, headers=headers, json=json, **kwargs)
            type(self).calls.append({"url": url, "payload": json})
            body = type(self).remaining.pop(0)
            return httpx.Response(200, json=body,
                                  request=httpx.Request("POST", str(url)))

    monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", _FakeAsyncClient)
    return _FakeAsyncClient


@pytest.fixture()
def llm_mode(monkeypatch, tmp_path):
    # Keep run artifacts out of the shared logs/ directory during tests.
    monkeypatch.setattr(llm_client_module, "LLM_LOG_PATH", str(tmp_path / "llm_calls.jsonl"))
    monkeypatch.setenv("LLM_API", "http://fake-llm.test/v1")
    monkeypatch.setenv("LLM_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "test-model")


# ---------------------------------------------------------------------------
# Scripted-mode happy path
# ---------------------------------------------------------------------------

class TestScriptedModeLifecycle:
    def test_full_lifecycle_end_to_end_against_mocks(self, fake_engine):
        report = run(players=2, rounds=3)

        assert report["mode"] == "scripted"
        assert report["players_configured"] == 2
        assert report["lobby_id"]
        assert report["engine_session_id"] in fake_engine.entities

        # Lobby lifecycle really happened through the orchestrator.
        assert len(fake_engine.calls_to("/entities")) >= 3  # dummy + 2 deploys
        assert any(c["path"] == "/api/v1/sessions" and c["method"] == "POST"
                   for c in fake_engine.calls)

        totals = report["totals"]
        assert totals["actions_attempted"] == 6          # 2 players x 3 rounds
        assert totals["accepted"] + totals["rejected"] == totals["actions_attempted"]
        assert totals["llm_calls_made"] == 0             # scripted mode never asks
        assert all(t["decision_source"] == "scripted" for r in report["rounds"]
                   for t in r["turns"])
        assert len(report["rounds"]) == 3

    def test_every_proxied_action_forwards_the_players_own_identity(self, fake_engine):
        report = run(players=2, rounds=3)

        user_ids = {p["user_id"] for p in report["per_player"]}
        assert len(user_ids) == 2
        action_calls = [c for c in fake_engine.calls
                        if any(s in c["path"] for s in ("/move", "/attack"))]
        assert action_calls, "expected at least one proxied action"
        for call in action_calls:
            assert call["actor"] is not None, "action proxy must forward caller identity"
            assert call["actor"]["user_id"] in user_ids

    def test_deploy_binds_entities_and_dummy_is_hostile_target(self, fake_engine):
        report = run(players=2, rounds=3)
        session_state = fake_engine.entities[report["engine_session_id"]]
        pc_ids = {p["entity_id"] for p in report["per_player"]}
        assert len(pc_ids) == 2
        for entity_id, entity in session_state.items():
            if entity_id in pc_ids:
                assert entity["owner_player_id"] in {
                    p["user_id"] for p in report["per_player"]}
            else:
                assert entity.get("is_player") is False  # the training dummy

        attacks = fake_engine.calls_to("/action/attack")
        assert attacks, "scripted policy must attack the hostile dummy"
        assert all(c["payload"]["target_id"] == DUMMY_ID for c in attacks)


# ---------------------------------------------------------------------------
# Rejection accounting
# ---------------------------------------------------------------------------

class TestRejectionAccounting:
    def test_engine_rejections_are_counted_with_reasons(self, fake_engine):
        fake_engine.reject("/move", "MOVE_REJECTED")

        report = run(players=2, rounds=2)

        totals = report["totals"]
        assert totals["rejected"] > 0
        assert totals["rejected"] == totals["actions_attempted"] - totals["accepted"]
        assert totals["rejection_reasons"].get("MOVE_REJECTED") == totals["rejected"]
        # Attempted still counts the refused turns — nothing disappears.
        assert totals["actions_attempted"] == 4
        rejected_turns = [t for r in report["rounds"] for t in r["turns"] if t["rejected"]]
        assert len(rejected_turns) == totals["rejected"]
        assert all(t["rejection_reason"] == "MOVE_REJECTED" for t in rejected_turns)

    def test_partial_rejection_mix_is_accounted_per_round(self, fake_engine):
        fake_engine.reject("/action/attack", "TARGET_OUT_OF_RANGE")

        report = run(players=2, rounds=3)
        assert report["totals"]["rejection_reasons"] == {"TARGET_OUT_OF_RANGE":
                                                         report["totals"]["rejected"]}
        per_round_attempts = sum(len(r["turns"]) for r in report["rounds"])
        assert per_round_attempts == report["totals"]["actions_attempted"] == 6


# ---------------------------------------------------------------------------
# LLM mode
# ---------------------------------------------------------------------------

class TestLLMMode:
    def test_valid_llm_decisions_are_parsed_and_executed(self, fake_engine, llm_mode, monkeypatch):
        upstream = _install_upstream(monkeypatch, [
            json.dumps({"action": "attack", "target_id": DUMMY_ID, "reason": "strike it"}),
            json.dumps({"action": "move", "x": 7.5, "y": 6.0}),
            json.dumps({"action": "check"}),
            json.dumps({"action": "attack", "target_id": DUMMY_ID}),
        ])

        report = run(players=2, rounds=2)

        assert report["mode"] == "llm"
        assert len(upstream.calls) == 4                       # one per turn
        assert all("chat/completions" in c["url"] for c in upstream.calls)
        totals = report["totals"]
        assert totals["llm_calls_made"] == 4
        assert totals["llm_decisions_accepted"] == 4
        assert totals["llm_fallbacks"] == 0
        sources = [t["decision_source"] for r in report["rounds"] for t in r["turns"]]
        assert sources.count("llm") == 4
        # The attack decisions really reached the engine against the named target.
        attacks = fake_engine.calls_to("/action/attack")
        assert len(attacks) == 2
        assert all(c["payload"]["target_id"] == DUMMY_ID for c in attacks)
        assert len(fake_engine.calls_to("/move")) == 1

    def test_malformed_llm_output_falls_back_but_counts_the_attempt(self, fake_engine, llm_mode, monkeypatch):
        _install_upstream(monkeypatch, ["this is not json {{{"])

        report = run(players=1, rounds=1)

        assert report["mode"] == "llm"
        totals = report["totals"]
        assert totals["llm_calls_made"] == 1                  # attempt counted
        assert totals["llm_fallbacks"] == 1
        assert totals["llm_decisions_accepted"] == 0
        turn = report["rounds"][0]["turns"][0]
        assert turn["decision_source"] == "llm_fallback"
        assert turn["fallback_reason"]
        # The turn STILL happened via the deterministic policy.
        assert totals["actions_attempted"] == 1

    def test_unknown_action_label_falls_back_to_scripted_choice(self, fake_engine, llm_mode, monkeypatch):
        _install_upstream(monkeypatch, ['{"action": "summon_dragon"}'])

        report = run(players=1, rounds=1)

        turn = report["rounds"][0]["turns"][0]
        assert turn["decision_source"] == "llm_fallback"
        assert "unknown_action" in turn["fallback_reason"]
        assert turn["action"] in ("attack", "move", "check")

    def test_llm_http_failure_falls_back_and_run_stays_honest(self, fake_engine, llm_mode, monkeypatch):
        class _FailingClient(httpx.AsyncClient):
            async def post(self, url, *args, **kwargs):
                if "chat/completions" in str(url):
                    raise RuntimeError("connection reset")
                return await super().post(url, *args, **kwargs)

        monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", _FailingClient)

        report = run(players=1, rounds=2)

        assert report["mode"] == "llm"           # a key WAS configured
        assert report["totals"]["llm_fallbacks"] == 2
        assert report["totals"]["actions_attempted"] == 2

    def test_no_key_configured_means_scripted_never_touches_network(self, fake_engine, monkeypatch):
        class _NeverClient(httpx.AsyncClient):
            async def post(self, url, *args, **kwargs):
                if "chat/completions" in str(url):
                    raise AssertionError("network LLM call attempted in scripted mode")
                return await super().post(url, *args, **kwargs)

        monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", _NeverClient)

        report = run(players=2, rounds=2)

        assert report["mode"] == "scripted"
        assert report["totals"]["llm_calls_made"] == 0


class _InstallNever:
    """Base for failing clients used by TestLLMMode.test_llm_http_failure."""


# ---------------------------------------------------------------------------
# Player-level auth behavior
# ---------------------------------------------------------------------------

class TestPlayerAuth:
    def test_signup_then_login_for_existing_email(self, fake_engine):
        async def scenario():
            transport = asgi_transport()
            first = CampaignSimPlayer("alpha", 0, transport=transport,
                                      email="fixed-alpha@campaign-sim.test")
            await first.authenticate()
            second = CampaignSimPlayer("alpha", 0, transport=transport,
                                       email="fixed-alpha@campaign-sim.test")
            await second.authenticate()   # same email -> login path, not signup
            assert first.user_id == second.user_id
            # Both tokens actually authorize authenticated calls.
            record = await second.authed("GET", "/api/v1/auth/session")
            assert record["status"] == 200 and record["body"]["valid"] is True

        asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Report honesty / shape
# ---------------------------------------------------------------------------

class TestReportShape:
    REQUIRED_KEYS = (
        "mode", "started_at", "elapsed_seconds", "players_configured",
        "rounds_requested", "lobby_id", "engine_session_id",
        "totals", "per_player", "rounds", "errors",
    )

    TOTALS_KEYS = (
        "turns", "actions_attempted", "accepted", "rejected",
        "rejection_reasons", "llm_calls_made", "llm_decisions_accepted",
        "llm_fallbacks", "degraded_flags_seen",
    )

    def test_report_contains_only_counted_metrics(self, fake_engine):
        report = run(players=2, rounds=2)

        for key in self.REQUIRED_KEYS:
            assert key in report, f"missing report key {key}"
        for key in self.TOTALS_KEYS:
            assert key in report["totals"], f"missing totals key {key}"

        totals = report["totals"]
        assert totals["turns"] == 4
        assert totals["accepted"] + totals["rejected"] == totals["actions_attempted"]
        assert sum(totals["rejection_reasons"].values()) == totals["rejected"]

        # No fabricated benchmark scores: MCR/HCI are the playtest harness's
        # job, not this report's.
        assert "mechanical_compliance_rate_pct" not in report
        assert "hallucination_continuity_index" not in report

        assert len(report["per_player"]) == 2
        for entry in report["per_player"]:
            assert entry["actions_attempted"] == 2
            assert entry["accepted"] + entry["rejected"] == 2
            assert entry["entity_id"] and entry["character_id"] and entry["user_id"]
        assert sum(p["actions_attempted"] for p in report["per_player"]) == \
            totals["actions_attempted"]

    def test_degraded_flags_seen_counts_truthy_degraded_fields(self, fake_engine, monkeypatch):
        original = fake_engine.engine_request

        async def tagging(method, path, payload=None, *, actor=None):
            result = await original(method, path, payload, actor=actor)
            if isinstance(result, dict) and "/move" in path:
                result["degraded"] = True
            return result

        monkeypatch.setattr(engine_client, "engine_request", tagging)
        report = run(players=1, rounds=2)
        assert report["totals"]["degraded_flags_seen"] > 0


# ---------------------------------------------------------------------------
# Social-state telemetry (campaign_sim x npc_disposition integration)
# ---------------------------------------------------------------------------

def _all_turns(report):
    return [t for r in report["rounds"] for t in r["turns"]]


class TestSocialStateTelemetry:
    def test_accepted_attacks_record_attacked_kind_on_target(self, fake_engine):
        sim, report = run_with_sim(players=2, rounds=3)

        history = sim.disposition.history()
        accepted_attacks = [t for t in _all_turns(report)
                            if t["action"] == "attack" and t["accepted"]]
        assert accepted_attacks, "scripted policy must attack in round 1"
        assert len(history) == len(accepted_attacks)
        # Exactly the expected directed kind onto the attacked target.
        assert all(rec.kind == "attacked" for rec in history)
        assert all(rec.npc_id == DUMMY_ID for rec in history)
        entity_ids = {p["entity_id"] for p in report["per_player"]}
        assert all(rec.player_id in entity_ids for rec in history)

    def test_checks_and_moves_record_no_disposition_entries(self, fake_engine):
        sim, report = run_with_sim(players=2, rounds=4)

        non_attack_turns = [t for t in _all_turns(report) if t["action"] != "attack"]
        assert any(t["accepted"] for t in non_attack_turns), \
            "scenario must contain accepted checks/moves"
        index_of = {p["name"]: i for i, p in enumerate(report["per_player"])}
        attack_ts = {t["round"] * 10.0 + index_of[t["player"]]
                     for t in _all_turns(report) if t["action"] == "attack"}
        recorded_ts = {rec.timestamp for rec in sim.disposition.history()}
        # Every recorded interaction sits on an attack turn's sim-clock slot —
        # checks/moves contributed nothing.
        assert recorded_ts <= attack_ts
        assert all(rec.kind == "attacked" for rec in sim.disposition.history())

    def test_rejected_attacks_record_nothing(self, fake_engine):
        fake_engine.reject("/action/attack", "TARGET_OUT_OF_RANGE")

        sim, report = run_with_sim(players=2, rounds=2)

        attacks = [t for t in _all_turns(report) if t["action"] == "attack"]
        assert attacks and all(t["rejected"] for t in attacks)
        assert sim.disposition.history() == []
        assert report["totals"]["disposition_interactions"] == 0

    def test_report_carries_per_player_stances_and_interaction_totals(self, fake_engine):
        sim, report = run_with_sim(players=2, rounds=2)

        totals = report["totals"]
        history = sim.disposition.history()
        assert totals["disposition_interactions"] == len(history) > 0
        assert totals["disposition_interactions_by_kind"] == {
            "attacked": len(history),
        }
        for entry in report["per_player"]:
            # One accepted attack each -> the dummy tracks a stance toward them,
            # keyed by display name (name preferred over raw id).
            assert entry["interactions_recorded"] == 1
            assert entry["stances"] == {
                "Training Dummy":
                    sim.disposition.stance(DUMMY_ID, entry["entity_id"]),
            }

    def test_hostile_stance_after_repeated_attacks(self, fake_engine, llm_mode, monkeypatch):
        _install_upstream(monkeypatch, [
            json.dumps({"action": "attack", "target_id": DUMMY_ID})
        ] * 3)

        sim, report = run_with_sim(players=1, rounds=3)

        kinds = [rec.kind for rec in sim.disposition.history()]
        assert kinds == ["attacked", "attacked", "attacked"]
        player = report["per_player"][0]
        assert player["interactions_recorded"] == 3
        assert player["stances"] == {"Training Dummy": "hostile"}

    def test_decision_prompt_includes_current_target_stances(self, fake_engine,
                                                             llm_mode, monkeypatch):
        upstream = _install_upstream(monkeypatch, [
            json.dumps({"action": "check"}),
        ])

        run_with_sim(players=1, rounds=1)

        prompt_text = json.dumps(upstream.calls[0]["payload"]["messages"])
        assert "stances_toward_you" in prompt_text
        # The training dummy has no relationship yet -> surfaced as neutral.
        assert "neutral" in prompt_text

    def test_scripted_policy_inputs_receive_stances_unknown_targets_neutral(
            self, fake_engine):
        sim = CampaignSimulation(mode="scripted")
        stub = SimpleNamespace(entity_id="pc-1")
        snapshot = {"entities": [
            {"id": "pc-1", "name": "Me", "hp": 28, "max_hp": 28, "ac": 16,
             "is_player": True, "is_dead": False},
            {"id": "npc-9", "name": "Goblin", "hp": 7, "max_hp": 7, "ac": 13,
             "is_player": False, "is_dead": False},
        ]}

        view = sim._stance_view(stub, snapshot)
        assert view == {"Goblin": "neutral"}          # unknown target -> neutral
        assert sim._stance_toward("totally-unknown", "pc-1") == "neutral"
        assert sim._stance_toward("x", None) == "neutral"

        decision = scripted_decision(stub, snapshot, 1, view)
        assert decision["action"] == "attack"
        assert decision["target_id"] == "npc-9"

    def test_timestamps_deterministic_across_identical_runs(self, fake_engine):
        sim_a, rep_a = run_with_sim(players=2, rounds=3)
        sim_b, rep_b = run_with_sim(players=2, rounds=3)

        # Each run signs up fresh users, so raw player UUIDs differ; project
        # them onto stable per-player slots before comparing.
        def normalized(report, sim):
            slot = {p["entity_id"]: i for i, p in enumerate(report["per_player"])}
            return [(slot.get(r.player_id, r.player_id), r.npc_id, r.kind,
                     r.magnitude, r.timestamp)
                    for r in sim.disposition.history()]

        hist_a = normalized(rep_a, sim_a)
        hist_b = normalized(rep_b, sim_b)
        assert hist_a and hist_a == hist_b
        assert [p["stances"] for p in rep_a["per_player"]] == \
            [p["stances"] for p in rep_b["per_player"]]
        assert [p["interactions_recorded"] for p in rep_a["per_player"]] == \
            [p["interactions_recorded"] for p in rep_b["per_player"]]

        # Timestamps are pure sim-clock values (round * 10 + turn index),
        # never wall-clock reads.
        index_of = {p["name"]: i for i, p in enumerate(rep_a["per_player"])}
        expected_ts = {t["round"] * 10.0 + index_of[t["player"]]
                       for t in _all_turns(rep_a)
                       if t["action"] == "attack" and t["accepted"]}
        assert {rec.timestamp for rec in sim_a.disposition.history()} == expected_ts
