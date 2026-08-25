"""Iteration 24: DirectorAgent as a deterministic campaign-pacing tracker.

Contract under test:

- ``DirectorAgent`` consumes ONLY observable signals (HP damage dealt, entity
  deaths, disposition stance transitions, quest-stage advances, rounds
  elapsed) and maintains a deterministic tension curve. Identical signal
  sequences always produce identical curves — no RNG, no wall clock, no LLM
  in the math.
- Recommendations (``raise_stakes``, ``introduce_complication``,
  ``spotlight_player:<id>``) are pure functions of the curve + counted player
  action totals.
- LLM involvement is limited to drafting hook TEXT via the existing gateway,
  and is honestly labeled: an unparseable/unavailable response yields ``None``
  rather than invented prose.
"""

import asyncio

import pytest

from vtt_orchestrator.agents.agent_hierarchy import (
    DirectorAgent,
    EncounterDMAgent,
)


# ---------------------------------------------------------------------------
# Deterministic tension tracking
# ---------------------------------------------------------------------------

class TestTensionCurve:
    def test_starts_empty_at_zero_tension(self):
        director = DirectorAgent()
        assert director.curve() == []
        assert director.tension() == 0.0

    def test_quiet_round_is_nearly_flat_and_matches_formula(self):
        """Round 1 with zero signals: only round pressure contributes.
        raw = 0.15 * min(1/10, 1) = 0.015; tension = 0.5 * 0 + 0.5 * 0.015."""
        director = DirectorAgent()
        sample = director.observe_round(1)
        assert sample["tension"] == pytest.approx(0.0075)
        assert director.tension() == pytest.approx(0.0075)

    def test_damage_raises_tension_more_than_a_quiet_round(self):
        quiet = DirectorAgent()
        bloody = DirectorAgent()
        quiet.observe_round(1)
        bloody.observe_round(1, hp_damage=40.0)
        assert bloody.tension() > quiet.tension()

    def test_deaths_raise_tension_more_than_damage_alone(self):
        dmg_only = DirectorAgent()
        lethal = DirectorAgent()
        dmg_only.observe_round(1, hp_damage=30.0)
        lethal.observe_round(1, hp_damage=30.0, deaths=2)
        assert lethal.tension() > dmg_only.tension()

    def test_extreme_signals_saturate_and_stay_bounded(self):
        """Every saturated component maps to exactly 1.0 (raw reaches 1.0 once
        round_pressure saturates at ROUND_PRESSURE_HORIZON); smoothing pulls
        the level halfway there in one step and repeated saturation converges
        to the ceiling without ever exceeding it."""
        director = DirectorAgent()
        sample = director.observe_round(10, hp_damage=10**6, deaths=10**6,
                                        disposition_shifts=10**6,
                                        quest_stage_advanced=True)
        assert sample["raw_signal"] == pytest.approx(1.0)
        for rnd in range(11, 21):
            sample = director.observe_round(
                rnd, hp_damage=10**6, deaths=10**6,
                disposition_shifts=10**6, quest_stage_advanced=True)
            assert 0.0 <= sample["tension"] <= 1.0
        # Geometric smoothing converges toward (never past) the ceiling.
        assert director.tension() == pytest.approx(1.0, abs=1e-3)

    def test_tension_never_exceeds_bounds_over_long_run(self):
        director = DirectorAgent()
        for rnd in range(1, 51):
            sample = director.observe_round(rnd, hp_damage=(5 if rnd % 2 else 60),
                                            deaths=rnd % 3)
            assert 0.0 <= sample["tension"] <= 1.0

    def test_identical_signal_sequences_produce_identical_curves(self):
        a, b = DirectorAgent(), DirectorAgent()
        for rnd in range(1, 8):
            kwargs = dict(hp_damage=rnd * 7.5, deaths=rnd % 2,
                          disposition_shifts=rnd % 3,
                          quest_stage_advanced=(rnd == 4))
            a.observe_round(rnd, **kwargs)
            b.observe_round(rnd, **kwargs)
        assert a.curve() == b.curve()

    def test_samples_carry_round_number_and_component_breakdown(self):
        director = DirectorAgent()
        sample = director.observe_round(3, hp_damage=12.0, deaths=1,
                                        disposition_shifts=1)
        assert sample["round"] == 3
        components = sample["components"]
        assert set(components) >= {"hp_swing", "deaths", "disposition_shifts",
                                   "round_pressure", "quest_stage"}
        assert components["deaths"] > 0.0
        assert components["hp_swing"] > 0.0

    def test_negative_signals_are_rejected(self):
        director = DirectorAgent()
        with pytest.raises(ValueError):
            director.observe_round(1, hp_damage=-1.0)
        with pytest.raises(ValueError):
            director.observe_round(1, deaths=-1)
        with pytest.raises(ValueError):
            director.observe_round(1, disposition_shifts=-1)

    def test_party_hp_pool_scales_the_hp_component(self):
        small_pool = DirectorAgent(party_hp_pool=50.0)
        big_pool = DirectorAgent(party_hp_pool=500.0)
        small_pool.observe_round(1, hp_damage=25.0)
        big_pool.observe_round(1, hp_damage=25.0)
        assert small_pool.tension() > big_pool.tension()

    def test_invalid_party_hp_pool_rejected(self):
        with pytest.raises(ValueError):
            DirectorAgent(party_hp_pool=0)
        with pytest.raises(ValueError):
            DirectorAgent(party_hp_pool=-10)

    def test_curve_is_a_copy_not_live_state(self):
        director = DirectorAgent()
        director.observe_round(1)
        snapshot = director.curve()
        director.observe_round(2, deaths=1)
        assert len(snapshot) == 1


# ---------------------------------------------------------------------------
# Deterministic recommendations
# ---------------------------------------------------------------------------

class TestRecommendations:
    def test_no_recommendations_before_enough_samples(self):
        director = DirectorAgent()
        director.observe_round(1, hp_damage=80)
        assert director.recommendations(min_samples=2) == []

    def test_sustained_low_tension_recommends_raise_stakes(self):
        director = DirectorAgent()
        director.observe_round(1)
        director.observe_round(2)
        recs = director.recommendations()
        assert "raise_stakes" in recs

    def test_spike_to_high_tension_recommends_introduce_complication(self):
        director = DirectorAgent()
        director.observe_round(1, hp_damage=200.0, deaths=3)
        director.observe_round(2, hp_damage=200.0, deaths=3)
        assert "introduce_complication" in director.recommendations()

    def test_plateau_recommends_introduce_complication(self):
        director = DirectorAgent()
        # Same signal every round -> the smoothed curve converges to a flat
        # plateau well inside PLATEAU_BAND.
        for rnd in range(1, 13):
            director.observe_round(rnd, hp_damage=20.0)
        tail = [s["tension"] for s in director.curve()[-3:]]
        assert max(tail) - min(tail) <= 0.02
        assert "introduce_complication" in director.recommendations()

    def test_spotlight_goes_to_least_active_player_when_under_share_floor(self):
        director = DirectorAgent(player_ids=["ada", "ben", "cy"])
        for _ in range(10):
            director.record_player_action("ada")
            director.record_player_action("ben")
        director.record_player_action("cy")
        recs = director.recommendations()
        spotlight = [r for r in recs if r.startswith("spotlight_player:")]
        assert spotlight == ["spotlight_player:cy"]

    def test_no_spotlight_when_agency_is_evenly_distributed(self):
        director = DirectorAgent(player_ids=["ada", "ben"])
        for _ in range(5):
            director.record_player_action("ada")
            director.record_player_action("ben")
        assert all(not r.startswith("spotlight_player:")
                   for r in director.recommendations())

    def test_spotlight_requires_two_tracked_players(self):
        director = DirectorAgent(player_ids=["solo"])
        assert not any(r.startswith("spotlight_player:")
                       for r in director.recommendations())

    def test_recommendations_are_stable_across_calls(self):
        director = DirectorAgent(player_ids=["a", "b"])
        director.observe_round(1, deaths=9)
        director.observe_round(2, deaths=9)
        assert director.recommendations() == director.recommendations()


# ---------------------------------------------------------------------------
# LLM hook TEXT (provenance-labeled, never fabricated)
# ---------------------------------------------------------------------------

class _FakeGateway:
    def __init__(self, parsed):
        self._parsed = parsed
        self.prompts = []

    async def complete_json(self, system_prompt, user_prompt, **kwargs):
        self.prompts.append((system_prompt, user_prompt))
        return self._parsed


class TestLLMHookText:
    def test_hook_text_labeled_llm_when_gateway_parses(self):
        director = DirectorAgent()
        director.observe_round(1, deaths=5)
        gateway = _FakeGateway({"hook": "The ceiling begins to groan overhead."})
        result = asyncio.run(director.draft_hook_text(
            gateway, recommendation="introduce_complication"))
        assert result == {"text": "The ceiling begins to groan overhead.",
                          "generator": "llm"}
        # The recommendation context reaches the prompt; the model never sets it.
        assert "introduce_complication" in gateway.prompts[0][1]

    def test_hook_text_is_none_when_gateway_returns_garbage(self):
        director = DirectorAgent()
        director.observe_round(1)
        assert asyncio.run(director.draft_hook_text(_FakeGateway("nope"))) is None
        assert asyncio.run(director.draft_hook_text(_FakeGateway(None))) is None

    def test_hook_text_is_none_when_hook_field_missing_or_empty(self):
        director = DirectorAgent()
        director.observe_round(1)
        assert asyncio.run(director.draft_hook_text(
            _FakeGateway({"wrong": "field"}))) is None
        assert asyncio.run(director.draft_hook_text(_FakeGateway({"hook": ""}))) is None

    def test_gateway_exception_surfaced_as_none_not_invented_prose(self):
        class _Boom:
            async def complete_json(self, *_a, **_k):
                raise RuntimeError("upstream down")

        director = DirectorAgent()
        director.observe_round(1)
        assert asyncio.run(director.draft_hook_text(_Boom())) is None

    def test_tension_math_does_not_call_the_gateway(self):
        gateway = _FakeGateway({"hook": "x"})
        director = DirectorAgent()
        director.observe_round(1, deaths=1)
        director.recommendations()
        assert gateway.prompts == []


# ---------------------------------------------------------------------------
# Backward compatibility of the hierarchy
# ---------------------------------------------------------------------------

class TestHierarchyCompatibility:
    def test_encounter_dm_agent_accepts_injected_director(self):
        director = DirectorAgent()
        agent = EncounterDMAgent(director=director)
        assert agent.director is director

    def test_encounter_dm_agent_draft_still_schema_bound(self):
        agent = EncounterDMAgent()
        draft = agent.generate_combat_draft(
            "attack", {"is_hit": True, "total_damage": 5, "target_hp_remaining": 3})
        assert isinstance(draft, str) and draft
