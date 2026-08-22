import pytest
from vtt_orchestrator.simulation.dynasty_engine import DynastyEngine
from vtt_orchestrator.lore.epistemic_graph import EpistemicLoreGraphManager
from vtt_orchestrator.simulation.empirical_playtester import EmpiricalPlaytester


def test_dynasty_engine_generation_and_inheritance():
    engine = DynastyEngine(seed=123)
    payload = engine.get_dynasty_payload()
    houses = payload["houses"]

    assert len(houses) == 3
    house_ids = [h["id"] for h in houses]
    assert "house_vane" in house_ids
    assert "house_silverthorn" in house_ids
    assert "house_duskwalker" in house_ids

    vane = next(h for h in houses if h["id"] == "house_vane")
    assert len(vane["members"]) == 5

    # Check 3 generations
    generations = {m["generation"] for m in vane["members"]}
    assert generations == {1, 2, 3}

    # Check inherited traits exist
    for m in vane["members"]:
        assert len(m["traits"]) > 0


def test_dynasty_lore_graph_injection():
    engine = DynastyEngine(seed=456)
    lore_graph = EpistemicLoreGraphManager()

    injected_count = engine.inject_lore_into_graph("house_vane", lore_graph)
    assert injected_count >= 3

    # Verify edge created in graph
    vane_edges = [e for e in lore_graph.edges if e["from"] == "House Vane of Black Iron"]
    assert len(vane_edges) >= 2


def test_empirical_playtester_metrics():
    playtester = EmpiricalPlaytester(seed=789)
    res = playtester.run_benchmark(num_simulations=100)

    assert res["total_simulations"] == 100
    assert res["win_rate"] >= 80.0
    assert 2.0 <= res["average_turns"] <= 8.0
