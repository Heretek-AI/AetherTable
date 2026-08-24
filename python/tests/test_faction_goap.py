"""Tests for genuine GOAP planning in FactionSimulationGOAP (backlog 4.12).

Covers: STRIPS-style actions, forward-search planner, optimality vs greedy,
determinism, unreachable goals, and backward-compatible legacy fallback.
"""

from vtt_orchestrator.simulation.faction_simulation import (
    delta,
    FactionAction,
    FactionGoal,
    FactionSimulationGOAP,
)


def make_sim(resources: int = 100, **kwargs) -> FactionSimulationGOAP:
    return FactionSimulationGOAP("Test Faction", resources=resources, **kwargs)


# ---------------------------------------------------------------------------
# Reachable goals produce executable plans
# ---------------------------------------------------------------------------


def test_plan_found_for_reachable_goal():
    sim = make_sim(resources=100)
    goal = FactionGoal("fortify", 1.0, {"defense": 4})
    plan = sim.plan(goal)
    assert plan is not None
    assert len(plan) > 0
    # Executing the plan must actually reach the goal.
    assert sim.execute_plan(plan, goal)


def test_plan_satisfies_multi_fact_goal():
    sim = make_sim(resources=200)
    goal = FactionGoal("project_power", 1.0, {"influence": 23, "defense": 4})
    plan = sim.plan(goal)
    assert plan is not None


def test_plan_respects_precondition_chaining():
    """FortifyHoldings requires military>=2, which itself requires recruiting."""
    sim = make_sim(resources=100)
    plan = sim.plan(FactionGoal("fortify", 1.0, {"defense": 4}))
    assert plan is not None
    names = [a.name for a in plan]
    assert names.index("RecruitForces") < names.index("FortifyHoldings")


def test_espionage_raid_requires_intel_and_military():
    sim = make_sim(resources=60)
    raid = next(a for a in sim.available_actions if a.name == "EspionageRaid")
    state = dict(sim.world_state)
    state["resources"] = 60
    assert not raid.preconditions_met(state)  # no intel, no military
    state.update({"intel": True, "military": 3})
    assert raid.preconditions_met(state)


def test_plan_gathers_intel_before_espionage_raid():
    """A war-chest goal beyond TradeCaravan's one-shot boost forces the
    intel-gated raid; the planner must order GatherIntel first."""
    sim = make_sim(resources=60)
    # From 60g the non-raid ceiling is 54g (RecruitForces -> TradeCaravan), so
    # reaching 75g requires repeated intel-gated EspionageRaids.
    goal = FactionGoal("war_chest", 1.0, {"resources": 75})
    plan = sim.plan(goal)
    assert plan is not None
    names = [a.name for a in plan]
    assert "EspionageRaid" in names
    assert names.index("GatherIntel") < names.index("EspionageRaid")
    assert sim.execute_plan(plan, goal)
    assert sim.resources >= 55


def test_alliance_chain_to_influence_goal():
    """ForgeAlliance needs reputation>=5; HostFestival raises reputation."""
    sim = make_sim(resources=100, initial_world_state={"reputation": 2, "influence": 20})
    goal = FactionGoal("prestige", 1.0, {"influence": 26})
    plan = sim.plan(goal)
    assert plan is not None
    names = [a.name for a in plan]
    assert "HostFestival" in names and "ForgeAlliance" in names
    assert names.index("HostFestival") < names.index("ForgeAlliance")


# ---------------------------------------------------------------------------
# Unreachable goals return None
# ---------------------------------------------------------------------------


def test_plan_returns_none_for_unreachable_goal():
    sim = make_sim(resources=30)
    # Defense cap achievable within budget is far below 500.
    assert sim.plan(FactionGoal("impossible", 1.0, {"defense": 500})) is None


def test_plan_returns_none_when_budget_blocks_prerequisites():
    sim = make_sim(resources=5)
    # Cannot even afford GatherIntel/RecruitForces chains.
    assert sim.plan(FactionGoal("fortify", 1.0, {"defense": 4})) is None


def test_empty_plan_for_already_satisfied_goal():
    sim = make_sim(resources=100, initial_world_state={"defense": 10})
    plan = sim.plan(FactionGoal("already_safe", 1.0, {"defense": 4}))
    assert plan == []


# ---------------------------------------------------------------------------
# Optimality: planner beats greedy first-fit
# ---------------------------------------------------------------------------

QUICKFIX = FactionAction(
    name="PanicWall",
    cost=50,
    preconditions={},
    effects={"defense": delta(2)},
)


def test_optimal_ordering_beats_greedy_first_fit():
    """A greedy first-fit walk could reach the goal by stacking the expensive
    PanicWall (+2 for 50g, twice = 100g); the planner must find the cheaper
    22g chain instead."""
    sim = make_sim(resources=100)
    sim.available_actions.append(QUICKFIX)  # greedy-first candidate
    goal = FactionGoal("fortify", 1.0, {"defense": 4})
    plan = sim.plan(goal)
    assert plan is not None
    total_cost = sum(a.cost for a in plan)
    assert total_cost < QUICKFIX.cost * 2, (
        f"planner chose greedy-equivalent plan costing {total_cost}"
    )
    assert all(a.name != "PanicWall" for a in plan)


def test_planner_prefers_lowest_total_cost_among_ties():
    sim = make_sim(resources=100)
    cheap = FactionAction(name="CheapFix", cost=10, preconditions={}, effects={"defense": 4})
    sim.available_actions.append(cheap)
    plan = sim.plan(FactionGoal("cheap", 1.0, {"defense": 4}))
    assert plan is not None
    assert sum(a.cost for a in plan) <= 10


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_planning_is_deterministic_across_runs():
    plans = []
    for _ in range(5):
        sim = make_sim(resources=150)
        plans.append([a.name for a in sim.plan(FactionGoal("p", 1.0, {"defense": 8}))])
    assert all(p == plans[0] for p in plans)


def test_execution_is_deterministic_across_runs():
    finals = []
    for _ in range(3):
        sim = make_sim(resources=150)
        sim.set_goal(FactionGoal("p", 1.0, {"defense": 8}))
        while sim.goal_progress_pending() and sim.resources > 0:
            msgs = sim.advance_simulation_tick()
            if not msgs:
                break
        finals.append((sim.world_state.get("defense"), sim.resources))
    assert all(f == finals[0] for f in finals)


# ---------------------------------------------------------------------------
# Backward compatibility: legacy heuristic fallback
# ---------------------------------------------------------------------------


def test_legacy_fallback_still_works_without_goal():
    sim = make_sim(resources=100)
    executed = sim.advance_simulation_tick()
    assert executed == ["Test Faction executed: Scout Keep"]
    assert sim.world_state["scouted_keep"] is True
    assert sim.resources == 85


def test_legacy_fallback_full_sequence_matches_old_behavior():
    # The original heuristic oscillates when flush (Scout Keep sets
    # influence_level=25, Infiltrate Sanctum resets it to 50, so each action
    # keeps finding the other's effect "unsatisfied"); it must still only ever
    # run legacy actions, in the same order, with the same accounting.
    sim = make_sim(resources=110)
    log = []
    for _ in range(6):
        log.extend(sim.advance_simulation_tick())
    legacy_names = {"Scout Keep", "Infiltrate Sanctum", "Mobilize Faction Guard"}
    executed_names = [msg.split("executed: ")[1] for msg in log]
    assert all(name in legacy_names for name in executed_names)
    assert executed_names[0] == "Scout Keep"
    assert executed_names[1] == "Infiltrate Sanctum"
    assert sim.world_state["has_relic"] is True
    expected_resources = 110
    costs = {"Scout Keep": 15, "Infiltrate Sanctum": 40, "Mobilize Faction Guard": 50}
    for name in executed_names:
        expected_resources -= costs[name]
    assert sim.resources == expected_resources


def test_goal_mode_ticks_advance_toward_goal():
    sim = make_sim(resources=100)
    sim.set_goal(FactionGoal("fortify", 1.0, {"defense": 4}))
    ticks = 0
    while sim.world_state.get("defense", 0) < 4 and ticks < 10:
        msgs = sim.advance_simulation_tick()
        ticks += 1
        assert msgs, "goal mode should always emit progress until goal reached"
    assert sim.world_state["defense"] >= 4
    assert "RecruitForces" in msgs[0] or "FortifyHoldings" in msgs[0]


def test_clear_goal_restores_legacy_behavior():
    sim = make_sim(resources=100)
    sim.set_goal(FactionGoal("x", 1.0, {"defense": 4}))
    sim.clear_goal()
    assert sim.advance_simulation_tick() == ["Test Faction executed: Scout Keep"]


def test_public_surface_preserved():
    sim = make_sim(resources=42)
    assert sim.faction_name == "Test Faction"
    assert sim.resources == 42
    assert isinstance(sim.world_state, dict)
    assert isinstance(sim.available_actions, list)
    assert all(isinstance(a, FactionAction) for a in sim.available_actions)
    assert callable(sim.advance_simulation_tick)
    # Legacy action set still present.
    names = [a.name for a in sim.available_actions]
    assert {"Scout Keep", "Infiltrate Sanctum", "Mobilize Faction Guard"} <= set(names)


def test_world_state_is_plain_numeric_dict_of_facts():
    sim = make_sim(resources=100)
    for key, value in sim.world_state.items():
        assert isinstance(value, (int, float, bool)), f"{key}={value!r} not numeric"
