"""
Parametrization contract tests for QuestGraphGenerator.

These pin down the fix for the audit finding "Quest generator ignoring its
parameters (fixed narrative)": theme, party level, desired length, and the
seed must all materially change the generated DAG, deterministically.

Honesty contract under test: theme content comes only from curated theme
tables. When a table cannot fill a requested structure the generator emits
fewer nodes and discloses it via `QuestGraph.coverage_note` -- it never pads
with invented filler.
"""

from collections import Counter

import pytest

from vtt_orchestrator.simulation.quest_engine import (
    ConcordiaPactEngine,
    QuestGraph,
    QuestGraphGenerator,
    QuestNodeType,
)

THEMES = ("crypt", "court", "wilderness")


def _make(theme, seed=7, level=5, length="medium", **kwargs):
    return QuestGraphGenerator(seed=seed).generate_campaign_quest(
        theme=theme, party_level=level, length=length, **kwargs
    )


def _edges(quest):
    """Flatten (node_id, choice_id, edge) triples over the whole DAG."""
    out = []
    for node_id, node in quest.nodes.items():
        for edge in node.choices:
            out.append((node_id, edge.choice_id, edge))
    return out


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_same_seed_yields_identical_dag():
    a = QuestGraphGenerator(seed=1234).generate_campaign_quest(
        theme="crypt", party_level=4, length="long"
    )
    b = QuestGraphGenerator(seed=1234).generate_campaign_quest(
        theme="crypt", party_level=4, length="long"
    )
    assert a.model_dump() == b.model_dump()


def test_different_seeds_vary_content_within_a_theme():
    graphs = [
        QuestGraphGenerator(seed=s).generate_campaign_quest(theme="wilderness")
        for s in (1, 2, 3)
    ]
    contents = {
        tuple(n.title for n in g.nodes.values()) for g in graphs
    }
    assert len(contents) > 1, "different seeds produced byte-identical quests"


# ---------------------------------------------------------------------------
# Theme changes structure and content (specific, not vibes)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("theme", THEMES)
def test_each_theme_produces_its_own_quest_identity(theme):
    quest = _make(theme)
    assert isinstance(quest, QuestGraph)
    assert f"{theme}" in quest.quest_id
    assert quest.quest_id != "quest_iron_succession"


def test_node_type_profiles_differ_pairwise_between_themes():
    profiles = {}
    for theme in THEMES:
        quest = _make(theme)
        profiles[theme] = Counter(n.node_type for n in quest.nodes.values())
    assert profiles["court"] != profiles["crypt"]
    assert profiles["crypt"] != profiles["wilderness"]
    assert profiles["court"] != profiles["wilderness"]


def test_crypt_is_tactical_and_court_is_intrigue():
    crypt = _make("crypt")
    court = _make("court")
    crypt_types = {n.node_type for n in crypt.nodes.values()}
    court_types = {n.node_type for n in court.nodes.values()}
    assert QuestNodeType.TACTICAL_ENCOUNTER in crypt_types
    assert QuestNodeType.SOCIAL_NEGOTIATION not in crypt_types
    assert QuestNodeType.SOCIAL_NEGOTIATION in court_types
    assert QuestNodeType.TACTICAL_ENCOUNTER not in court_types


def test_wilderness_introduces_travel_hazards_absent_elsewhere():
    wild = _make("wilderness")
    court = _make("court")
    assert any(
        n.node_type == QuestNodeType.TRAVEL_HAZARD for n in wild.nodes.values()
    )
    assert all(
        n.node_type != QuestNodeType.TRAVEL_HAZARD for n in court.nodes.values()
    )


def test_theme_title_sets_are_pairwise_disjoint():
    title_sets = {}
    summaries = {}
    for theme in THEMES:
        quest = _make(theme)
        title_sets[theme] = {n.title for n in quest.nodes.values()}
        summaries[theme] = quest.summary
    for i, a in enumerate(THEMES):
        for b in THEMES[i + 1 :]:
            assert title_sets[a].isdisjoint(title_sets[b]), f"{a} vs {b}"
            assert summaries[a] != summaries[b], f"{a} vs {b}"


def test_skill_checks_use_theme_appropriate_skills():
    court_social_skills = {"Persuasion", "Deception", "Intimidation"}
    for theme in ("crypt", "wilderness"):
        quest = _make(theme)
        used = {
            e.skill_check_required[0]
            for _, _, e in _edges(quest)
            if e.skill_check_required
        }
        assert used, f"{theme} quest has no skill checks at all"
        assert not (used & court_social_skills), (
            f"{theme} quest leaked court social skills: {used & court_social_skills}"
        )


def test_objectives_differ_across_themes_via_prompts():
    prompts = {}
    for theme in THEMES:
        quest = _make(theme)
        prompts[theme] = " ".join(n.narrative_prompt for n in quest.nodes.values())
    assert prompts["crypt"] != prompts["court"] != prompts["wilderness"]
    # Theme-specific vocabulary must actually appear.
    assert "crypt" in prompts["crypt"].lower() or "catacomb" in prompts["crypt"].lower()
    assert (
        "ridge" in prompts["wilderness"].lower()
        or "trail" in prompts["wilderness"].lower()
    )


# ---------------------------------------------------------------------------
# Party level scales difficulty numbers, not structure
# ---------------------------------------------------------------------------


def test_party_level_scales_difficulty_and_rewards_with_fixed_structure():
    low = _make("crypt", seed=11, level=1)
    high = _make("crypt", seed=11, level=16)

    # Structure identical: same node ids, same choice ids per node.
    assert set(low.nodes) == set(high.nodes)
    for nid in low.nodes:
        assert [c.choice_id for c in low.nodes[nid].choices] == [
            c.choice_id for c in high.nodes[nid].choices
        ]

    low_edges = {(n, c): e for n, c, e in _edges(low)}
    high_edges = {(n, c): e for n, c, e in _edges(high)}

    checked = [
        k
        for k in low_edges
        if low_edges[k].skill_check_required and high_edges[k].skill_check_required
    ]
    assert checked, "expected at least one skill-checked edge to compare"
    for k in checked:
        assert (
            high_edges[k].skill_check_required[1]
            > low_edges[k].skill_check_required[1]
        ), f"DC did not scale up at {k}"

    total_gold_low = sum(e.rewards_gold for e in low_edges.values())
    total_gold_high = sum(e.rewards_gold for e in high_edges.values())
    total_xp_low = sum(e.rewards_xp for e in low_edges.values())
    total_xp_high = sum(e.rewards_xp for e in high_edges.values())
    assert total_gold_high > total_gold_low
    assert total_xp_high > total_xp_low


# ---------------------------------------------------------------------------
# Desired length changes DAG size; thin tables truncate honestly
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("theme", ("court", "crypt"))
def test_length_grows_the_dag(theme):
    sizes = {
        length: len(_make(theme, length=length).nodes)
        for length in ("short", "medium", "long")
    }
    assert sizes["short"] < sizes["medium"] < sizes["long"]


def test_thin_table_truncates_instead_of_padding():
    # The wilderness investigation table has fewer entries than a full long
    # quest needs; the generator must emit fewer nodes and disclose it.
    medium = _make("wilderness", length="medium")
    long_wild = _make("wilderness", length="long")
    long_court = _make("court", length="long")

    assert long_court.coverage_note is None
    assert long_wild.coverage_note is not None
    assert "truncat" in long_wild.coverage_note.lower()
    # Still a valid, connected DAG despite the truncation.
    assert long_wild.initial_node_id in long_wild.nodes
    for node in long_wild.nodes.values():
        for edge in node.choices:
            assert edge.target_node_id in long_wild.nodes


def test_every_generated_graph_is_a_wellformed_reachable_dag():
    for theme in THEMES:
        quest = _make(theme, length="long")
        seen = {quest.initial_node_id}
        frontier = [quest.initial_node_id]
        while frontier:
            current = frontier.pop()
            for edge in quest.nodes[current].choices:
                assert edge.target_node_id in quest.nodes
                if edge.target_node_id not in seen:
                    seen.add(edge.target_node_id)
                    frontier.append(edge.target_node_id)
        assert seen == set(quest.nodes), f"{theme}: unreachable nodes present"
        # Resolutions terminate.
        for node in quest.nodes.values():
            if node.node_type == QuestNodeType.RESOLUTION:
                assert node.choices == []


# ---------------------------------------------------------------------------
# Backward compatibility with existing callers (server.py + old test)
# ---------------------------------------------------------------------------


def test_legacy_call_signature_still_works():
    gen = QuestGraphGenerator(seed=42)
    quest = gen.generate_campaign_quest(
        campaign_theme="The Iron Succession",
        primary_house="house_vane",
        rival_house="house_silverpeak",
    )
    assert isinstance(quest, QuestGraph)
    assert quest.quest_id == "quest_iron_succession"
    assert quest.initial_node_id in quest.nodes
    hook = quest.nodes[quest.initial_node_id]
    assert hook.node_type == QuestNodeType.HOOK
    assert len(hook.choices) >= 2
    for edge in hook.choices:
        assert edge.target_node_id in quest.nodes


def test_no_argument_call_matches_server_default_path():
    quest = QuestGraphGenerator().generate_campaign_quest()
    assert quest.initial_node_id in quest.nodes
    assert quest.quest_id == "quest_iron_succession"


def test_explicit_unknown_theme_is_rejected_not_silently_substituted():
    with pytest.raises(ValueError):
        QuestGraphGenerator(seed=1).generate_campaign_quest(theme="space_opera")


def test_concordia_engine_untouched_by_parametrization():
    res = ConcordiaPactEngine().negotiate_treaty(
        house_a_name="House Vane",
        house_b_name="House Silverpeak",
        player_diplomacy_roll=18,
        concessions_offered="mining rights",
    )
    assert res.pact_agreed is True
