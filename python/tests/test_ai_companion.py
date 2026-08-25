"""Pillar 1 backlog item: drop-in AI companions with tactical roles.

Contract under test (``simulation.ai_companion.AiCompanion``):

- An ``AiCompanion`` wraps an ALREADY-AUTHENTICATED ``CampaignSimPlayer`` seat
  and takes turns against a snapshot through the SAME ``?token=``-forwarded
  proxy endpoints campaign_sim uses — no second HTTP stack.
- Three tactical roles with deterministic scripted policies:
  * tank       — engage the nearest living hostile: move into reach, then attack.
  * skirmisher — hit-and-run: alternate engage turns (attack when in reach,
                 otherwise close the gap) with disengage turns (move away).
  * healer     — heal the most-wounded ALLY whose HP is actually observable
                 below half (the proxy only exposes HP for entities you own or
                 for GM/admin seats); otherwise fall back to tank behavior.
- LLM refinement is OPTIONAL: role doctrine + snapshot go to
  ``routing.llm_client.LLMStreamingGateway.complete_json``; output is validated
  like campaign_sim validates its decisions (vocabulary + known-target cross
  check). Anything malformed/unknown falls back to the scripted policy FOR THAT
  TURN while still counting the attempt. With no key configured the companion
  is tagged ``mode: "scripted"`` and never touches the network.
- Every turn reports honest provenance: {role, decision_source, action,
  accepted, ...}. Nothing is extrapolated.

No unit test touches the network: outbound orchestrator HTTP rides an
in-process ASGI transport, the authoritative Rust engine is an in-memory fake
(reused from test_campaign_sim, extended with a /heal route), and the LLM
upstream is a canned httpx fake.
"""

import asyncio
import json
import math
import re

import httpx
import pytest

from vtt_orchestrator.routing import engine_client, llm_client as llm_client_module
from vtt_orchestrator.routing.llm_client import LLMConfig, LLMStreamingGateway
from vtt_orchestrator.simulation.campaign_sim import CampaignSimPlayer
from vtt_orchestrator.simulation.ai_companion import (
    REALIZABILITY,
    ROLES,
    AiCompanion,
)

# Reuse the exact mocking apparatus from the campaign sim tests so both suites
# exercise the same fakes (ASGITransport app + in-memory engine).
from test_campaign_sim import (
    DUMMY_ID,
    FakeEngine,
    _install_upstream,
    asgi_transport,
)


# ---------------------------------------------------------------------------
# Fakes: engine extended with the heal proxy route
# ---------------------------------------------------------------------------

class HealCapableEngine(FakeEngine):
    """FakeEngine plus POST /api/v1/sessions/{id}/heal (engine-owned clamping)."""

    def __init__(self):
        super().__init__()
        self.heals = []

    async def engine_request(self, method, path, payload=None, *, actor=None):
        m = re.fullmatch(r"/api/v1/sessions/([^/]+)/heal", path)
        if method == "POST" and m:
            self.calls.append({"method": method, "path": path,
                               "payload": payload, "actor": actor})
            bucket = self.entities[m.group(1)]
            entity = bucket.get(payload["entity_id"])
            if entity is None:
                from vtt_orchestrator.routing.engine_client import EngineRejectedError
                raise EngineRejectedError(404, json.dumps({"reason": "UNKNOWN_ENTITY"}))
            before = int(entity.get("current_hp", 0))
            healed = min(before + int(payload["amount"]),
                         int(entity.get("max_hp", before)))
            entity["current_hp"] = healed
            self.heals.append({"entity_id": payload["entity_id"],
                               "amount": payload["amount"],
                               "hp_before": before, "hp_after": healed})
            return {"status": "HEALED", "entity_id": payload["entity_id"],
                    "hp_before": before, "hp_after": healed}
        return await super().engine_request(method, path, payload, actor=actor)


# NOTE: the per-test ``_rate_windows`` reset used to live here as a local
# autouse fixture; it now lives once in tests/conftest.py
# (``_isolate_rate_limiter_windows``) so every module gets it for free.


@pytest.fixture()
def fake_engine(monkeypatch):
    """Same discipline as test_campaign_sim: real ASGI app in-process, fake
    engine transport, ambient LLM credentials scrubbed."""
    fake = HealCapableEngine()
    monkeypatch.setattr(engine_client, "engine_request", fake.engine_request)
    for var in ("LLM_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    return fake


def scripted_companion(player, role):
    """A companion guaranteed deterministic: gateway has no key -> mock."""
    return AiCompanion(player, role=role,
                       llm_gateway=LLMStreamingGateway(LLMConfig()))


async def setup_table(n_players=1):
    """Host a table through the real orchestrator surface and deploy seats."""
    transport = asgi_transport()
    players = []
    for i in range(n_players):
        p = CampaignSimPlayer(f"ai-seat-{i}", i, transport=transport,
                              role="gm" if i == 0 else "player")
        await p.authenticate()
        players.append(p)
    host = players[0]
    await host.host_table("AI Companion Table")
    for guest in players[1:]:
        await guest.join_table(host.lobby_id, host.invite_code)
    for p in players:
        await p.mark_ready()
    session_id = await host.launch_table()
    for p in players:
        p.bind_session(session_id)
        await p.deploy_character(session_id)
    dummy_id = await host.spawn_encounter_target(session_id)
    return players, session_id, dummy_id


async def run_turns(role, n_players=1, n_turns=1, llm_gateway=None):
    players, session_id, dummy_id = await setup_table(n_players)
    comp = AiCompanion(players[0], role=role, llm_gateway=llm_gateway) \
        if llm_gateway else scripted_companion(players[0], role)
    reports = []
    for _ in range(n_turns):
        snapshot = await players[0].observe_session()
        reports.append(await comp.take_turn(snapshot))
    return comp, players, session_id, dummy_id, reports


def distance(a_pos, b_pos):
    return math.dist([float(a_pos[0]), float(a_pos[1])],
                     [float(b_pos[0]), float(b_pos[1])])


# ---------------------------------------------------------------------------
# Role registry + report provenance
# ---------------------------------------------------------------------------

class TestCompanionContract:
    def test_unknown_role_is_rejected_upfront(self, fake_engine):
        async def scenario():
            players, _, _ = await setup_table(1)
            with pytest.raises(ValueError):
                AiCompanion(players[0], role="bard")

        asyncio.run(scenario())

    def test_role_registry_covers_the_three_tactical_roles(self):
        assert set(ROLES) == {"tank", "skirmisher", "healer"}
        # The realizability matrix is part of the public contract: every role
        # documents what is real today vs aspirational.
        assert set(REALIZABILITY) == set(ROLES)
        for entry in REALIZABILITY.values():
            assert {"realizable", "aspirational"} <= set(entry)

    def test_turn_report_carries_honest_provenance(self, fake_engine):
        async def scenario():
            _, _, _, _, reports = await run_turns("tank", n_turns=1)
            turn = reports[0]
            for key in ("role", "decision_source", "action", "accepted",
                        "attempted", "rejected", "rejection_reason",
                        "response_status", "llm_called", "fallback_reason"):
                assert key in turn, f"missing provenance key {key}"
            assert turn["role"] == "tank"
            assert turn["decision_source"] == "scripted"
            assert turn["llm_called"] is False
            assert turn["fallback_reason"] is None
            assert isinstance(turn["accepted"], bool)

        asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Tank: engage nearest hostile
# ---------------------------------------------------------------------------

class TestTankRole:
    def test_far_tank_moves_toward_nearest_hostile(self, fake_engine):
        async def scenario():
            _, players, session_id, _, reports = await run_turns("tank")
            turn = reports[0]
            assert turn["action"] == "move"
            assert turn["accepted"] is True
            moved = fake_engine.entities[session_id][players[0].entity_id]["position"]
            # Closed the gap to the dummy at [8, 8] from the deploy point [4, 4].
            assert distance(moved, [8.0, 8.0]) < distance([4.0, 4.0], [8.0, 8.0])
            move_calls = fake_engine.calls_to("/move")
            assert move_calls and move_calls[-1]["actor"] is not None

        asyncio.run(scenario())

    def test_adjacent_tank_attacks_the_hostile(self, fake_engine):
        async def scenario():
            _, players, session_id, _, _ = await run_turns("tank")
            # Drop the PC next to the dummy before the turn.
            fake_engine.entities[session_id][players[0].entity_id]["position"] = [8.0, 3.0]
            snapshot = await players[0].observe_session()
            turn = await scripted_companion(players[0], "tank").take_turn(snapshot)
            assert turn["action"] == "attack"
            assert turn["accepted"] is True
            attacks = fake_engine.calls_to("/action/attack")
            assert attacks and attacks[-1]["payload"]["target_id"] == DUMMY_ID

        asyncio.run(scenario())

    def test_no_hostile_left_means_a_check_not_an_attack(self, fake_engine):
        async def scenario():
            _, players, session_id, _, _ = await run_turns("tank")
            fake_engine.entities[session_id][DUMMY_ID]["is_dead"] = True
            snapshot = await players[0].observe_session()
            turn = await scripted_companion(players[0], "tank").take_turn(snapshot)
            assert turn["action"] == "check"

        asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Skirmisher: hit-and-run alternation
# ---------------------------------------------------------------------------

class TestSkirmisherRole:
    def test_engage_then_disengage_alternation(self, fake_engine):
        async def scenario():
            players, session_id, dummy_id = await setup_table(1)
            comp = scripted_companion(players[0], "skirmisher")
            pc = fake_engine.entities[session_id][players[0].entity_id]
            dummy = fake_engine.entities[session_id][DUMMY_ID]

            pc["position"] = [8.0, 3.0]           # in reach of [8, 8]
            turn_1 = await comp.take_turn(await players[0].observe_session())
            assert turn_1["action"] == "attack"   # hit...
            assert turn_1["accepted"] is True

            turn_2 = await comp.take_turn(await players[0].observe_session())
            assert turn_2["action"] == "move"     # ...then run
            assert distance(pc["position"], dummy["position"]) > \
                distance([8.0, 3.0], [8.0, 8.0])

            turn_3 = await comp.take_turn(await players[0].observe_session())
            assert turn_3["action"] == "move"     # re-engage from far away

        asyncio.run(scenario())

    def test_disengage_without_position_data_falls_back_to_check(self, fake_engine):
        async def scenario():
            players, session_id, _ = await setup_table(1)
            comp = scripted_companion(players[0], "skirmisher")
            comp.turns_taken = 1                  # next decision is a disengage
            snapshot = await players[0].observe_session()
            for e in snapshot["entities"]:
                if e["id"] != players[0].entity_id:
                    e["position"] = None          # board token without placement
            turn = await comp.take_turn(snapshot)
            assert turn["action"] == "check"

        asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Healer: observable-deficit healing, honest about what it cannot see
# ---------------------------------------------------------------------------

class TestHealerRole:
    def test_wounded_healer_heals_itself(self, fake_engine):
        async def scenario():
            _, players, session_id, _, _ = await run_turns("healer")
            pc = fake_engine.entities[session_id][players[0].entity_id]
            pc["current_hp"] = 10                  # 10/28 -> below half
            turn = await scripted_companion(players[0], "healer") \
                .take_turn(await players[0].observe_session())
            assert turn["action"] == "heal"
            assert turn["accepted"] is True
            heal = fake_engine.heals[-1]
            assert heal["entity_id"] == players[0].entity_id
            assert heal["amount"] > 0
            assert heal["hp_after"] == min(heal["hp_before"] + heal["amount"], 28)

        asyncio.run(scenario())

    def test_healer_attacks_when_nobody_is_hurt(self, fake_engine):
        async def scenario():
            players, session_id, _ = await setup_table(1)
            comp = scripted_companion(players[0], "healer")
            fake_engine.entities[session_id][players[0].entity_id]["position"] = [8.0, 3.0]
            turn = await comp.take_turn(await players[0].observe_session())
            assert turn["action"] == "attack"

        asyncio.run(scenario())

    def test_gm_seat_healer_heals_a_wounded_ally(self, fake_engine):
        """GM/admin seats see full ally stat blocks, so cross-ally healing is
        realizable FROM THAT SEAT — the matrix's 'GM seat' caveat."""
        async def scenario():
            players, session_id, _ = await setup_table(2)
            healer = scripted_companion(players[0], "healer")
            ally = fake_engine.entities[session_id][players[1].entity_id]
            ally["current_hp"] = 6                  # 6/28, observable to GM seat
            turn = await healer.take_turn(await players[0].observe_session())
            assert turn["action"] == "heal"
            assert fake_engine.heals[-1]["entity_id"] == players[1].entity_id

        asyncio.run(scenario())

    def test_player_seat_cannot_see_ally_hp_so_does_not_pretend_to_triage(
            self, fake_engine):
        """A player-role seat receives only board tokens for other entities (no
        HP), so an ally-deficit heal is NOT realizable there — the companion
        falls back instead of fabricating triage data."""
        async def scenario():
            players, session_id, _ = await setup_table(2)
            guest = scripted_companion(players[1], "healer")
            fake_engine.entities[session_id][players[0].entity_id]["current_hp"] = 4
            turn = await guest.take_turn(await players[1].observe_session())
            assert turn["action"] != "heal"

        asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Execution goes through the authenticated proxy path
# ---------------------------------------------------------------------------

class TestExecutionPath:
    def test_actions_forward_the_companions_own_token_identity(self, fake_engine):
        async def scenario():
            _, players, session_id, _, _ = await run_turns("tank", n_turns=3)
            action_calls = [c for c in fake_engine.calls
                            if any(s in c["path"] for s in ("/move", "/attack", "/heal"))]
            assert action_calls
            for call in action_calls:
                assert call["actor"] is not None
                assert call["actor"]["user_id"] == players[0].user_id

        asyncio.run(scenario())

    def test_proxy_rejection_is_reported_not_swallowed(self, fake_engine):
        async def scenario():
            fake_engine.reject("/action/attack", "TARGET_OUT_OF_RANGE")
            players, session_id, _ = await setup_table(1)
            comp = scripted_companion(players[0], "tank")
            fake_engine.entities[session_id][players[0].entity_id]["position"] = [8.0, 3.0]
            turn = await comp.take_turn(await players[0].observe_session())
            assert turn["action"] == "attack"
            assert turn["attempted"] is True
            assert turn["accepted"] is False
            assert turn["rejected"] is True
            assert turn["rejection_reason"] == "TARGET_OUT_OF_RANGE"

        asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Optional LLM refinement
# ---------------------------------------------------------------------------

class TestLLMRefinement:
    @pytest.fixture()
    def llm_mode(self, monkeypatch, tmp_path):
        monkeypatch.setattr(llm_client_module, "LLM_LOG_PATH",
                            str(tmp_path / "llm_calls.jsonl"))
        monkeypatch.setenv("LLM_API", "http://fake-llm.test/v1")
        monkeypatch.setenv("LLM_KEY", "test-key")
        monkeypatch.setenv("LLM_MODEL", "test-model")

    def test_valid_llm_decision_refines_targeting(self, fake_engine, llm_mode,
                                                  monkeypatch):
        upstream = _install_upstream(monkeypatch, [
            json.dumps({"action": "attack", "target_id": DUMMY_ID,
                        "reason": "focus fire"}),
        ])

        async def scenario():
            players, session_id, _ = await setup_table(1)
            comp = AiCompanion(players[0], role="tank",
                               llm_gateway=LLMStreamingGateway(LLMConfig()))
            fake_engine.entities[session_id][players[0].entity_id]["position"] = [8.0, 3.0]
            turn = await comp.take_turn(await players[0].observe_session())
            assert len(upstream.calls) == 1
            assert turn["decision_source"] == "llm"
            assert turn["llm_called"] is True
            assert turn["fallback_reason"] is None
            assert turn["action"] == "attack" and turn["accepted"] is True
            prompt_text = json.dumps(upstream.calls[0]["payload"]["messages"])
            assert "tank" in prompt_text.lower()      # doctrine travels with it

        asyncio.run(scenario())

    def test_malformed_llm_output_falls_back_to_scripted_and_still_counts(
            self, fake_engine, llm_mode, monkeypatch):
        _install_upstream(monkeypatch, ["not json {{{"])

        async def scenario():
            players, session_id, _ = await setup_table(1)
            comp = AiCompanion(players[0], role="skirmisher",
                               llm_gateway=LLMStreamingGateway(LLMConfig()))
            turn = await comp.take_turn(await players[0].observe_session())
            assert turn["decision_source"] == "llm_fallback"
            assert turn["llm_called"] is True
            assert turn["fallback_reason"]
            assert turn["attempted"] is True          # the turn still happened

        asyncio.run(scenario())

    def test_llm_targeting_an_unknown_entity_is_cross_checked_and_rejected(
            self, fake_engine, llm_mode, monkeypatch):
        upstream = _install_upstream(monkeypatch, [
            json.dumps({"action": "attack", "target_id": "made-up-entity"}),
        ])

        async def scenario():
            players, session_id, _ = await setup_table(1)
            comp = AiCompanion(players[0], role="tank",
                               llm_gateway=LLMStreamingGateway(LLMConfig()))
            fake_engine.entities[session_id][players[0].entity_id]["position"] = [8.0, 3.0]
            turn = await comp.take_turn(await players[0].observe_session())
            assert turn["decision_source"] == "llm_fallback"
            assert "unknown_target" in turn["fallback_reason"]

        asyncio.run(scenario())

    def test_llm_outage_falls_back_per_turn(self, fake_engine, llm_mode,
                                            monkeypatch):
        class _FailingClient(httpx.AsyncClient):
            async def post(self, url, *args, **kwargs):
                if "chat/completions" in str(url):
                    raise RuntimeError("connection reset")
                return await super().post(url, *args, **kwargs)

        monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", _FailingClient)

        async def scenario():
            players, session_id, _ = await setup_table(1)
            comp = AiCompanion(players[0], role="tank",
                               llm_gateway=LLMStreamingGateway(LLMConfig()))
            turn = await comp.take_turn(await players[0].observe_session())
            assert turn["decision_source"] == "llm_fallback"
            assert turn["attempted"] is True

        asyncio.run(scenario())

    def test_no_key_configured_never_touches_the_llm_network(self, fake_engine,
                                                             monkeypatch):
        class _NeverClient(httpx.AsyncClient):
            async def post(self, url, *args, **kwargs):
                if "chat/completions" in str(url):
                    raise AssertionError("network LLM call without configuration")
                return await super().post(url, *args, **kwargs)

        monkeypatch.setattr(llm_client_module.httpx, "AsyncClient", _NeverClient)

        async def scenario():
            players, session_id, _ = await setup_table(1)
            comp = scripted_companion(players[0], "healer")
            turn = await comp.take_turn(await players[0].observe_session())
            assert comp.mode == "scripted"
            assert turn["decision_source"] == "scripted"
            assert turn["llm_called"] is False

        asyncio.run(scenario())
