import pytest
from vtt_orchestrator.simulation.quest_engine import (
    QuestGraphGenerator,
    ConcordiaPactEngine,
    QuestNodeType,
    QuestGraph,
)


def test_quest_graph_generator_branching():
    generator = QuestGraphGenerator(seed=42)
    quest = generator.generate_campaign_quest(
        campaign_theme="The Iron Succession",
        primary_house="house_vane",
        rival_house="house_silverpeak",
    )

    assert isinstance(quest, QuestGraph)
    assert quest.quest_id == "quest_iron_succession"
    assert quest.initial_node_id in quest.nodes

    hook_node = quest.nodes[quest.initial_node_id]
    assert hook_node.node_type == QuestNodeType.HOOK
    assert len(hook_node.choices) >= 2

    # Verify branching connectivity
    target_ids = [c.target_node_id for c in hook_node.choices]
    for tid in target_ids:
        assert tid in quest.nodes


def test_concordia_pact_negotiations():
    engine = ConcordiaPactEngine()

    # Successful diplomacy roll (DC 15)
    res_success = engine.negotiate_treaty(
        house_a_name="House Vane",
        house_b_name="House Silverpeak",
        player_diplomacy_roll=18,
        concessions_offered="Cede silver mining rights in the eastern ridge",
    )
    assert res_success.pact_agreed is True
    assert res_success.house_a_approval > 0.6
    assert res_success.reputation_deltas["House Vane"] > 0

    # Failed diplomacy roll
    res_fail = engine.negotiate_treaty(
        house_a_name="House Vane",
        house_b_name="House Silverpeak",
        player_diplomacy_roll=8,
        concessions_offered="Unconditional surrender",
    )
    assert res_fail.pact_agreed is False
    assert "collapsed" in res_fail.final_terms.lower()
