"""
Pillar 8 iteration: dynasty depth tests.

Covers multi-generation lineage compounding + mutation, cross-house
alliance inheritance weighted by trait dominance/recessiveness, house
prestige scoring/ordering, generation-appropriate lore-graph injection,
and backwards compatibility of the legacy single-generation API.
"""

import random
import json

import pytest

from vtt_orchestrator.simulation.dynasty_engine import DynastyEngine, DynastyMember, NobleHouse
from vtt_orchestrator.lore.epistemic_graph import EpistemicLoreGraphManager
from vtt_orchestrator.schemas.models import EpistemicTier


IRON_WILL = "Iron Will (+2 Wisdom Saves)"
ARCANE_SPARK = "Arcane Spark (Innate Cantrip)"
SILVER_TONGUE = "Silver Tongue (+3 Persuasion)"
CURSED_BLOOD = "Cursed Bloodline (Disadvantage vs Necromancy)"
GRIFFIN_RIDER = "Griffin Rider (Aerial Mastery)"


class ScriptedRandom:
    """
    Deterministic RNG stand-in. ``random()`` always returns the scripted
    value, so every probabilistic gate with p > value passes and every
    gate with p <= value fails. choice/sample/choices resolve
    deterministically (argmax weight / head of sequence).
    """

    def __init__(self, value: float):
        self.value = value

    def random(self) -> float:
        return self.value

    def choice(self, seq):
        return seq[0]

    def sample(self, seq, k):
        return list(seq)[:k]

    def choices(self, population, weights=None, k=1):
        if weights:
            idx = max(range(len(population)), key=lambda i: weights[i])
        else:
            idx = 0
        return [population[idx]] * k


LEGACY_MEMBER_KEYS = {
    "id", "name", "title", "generation", "is_alive", "traits",
    "personality", "parent_ids", "spouse_id", "historical_event",
}


def _craft_house(engine: DynastyEngine, house_id: str, gen3_traits, gen2_traits=None, gen1_traits=None) -> NobleHouse:
    """Insert a minimal three-generation house with controlled trait pools."""
    house = NobleHouse(
        id=house_id,
        name=f"House {house_id.split('_', 1)[1].title()}",
        motto="Tested in Fire",
        crest_icon="tower",
        theme_color="#ffffff",
        seat_of_power="Test Bastion",
        primary_virtue="Verification",
    )
    founder = DynastyMember(
        id=f"{house_id}_gen1_founder", name="Founder Test", title="Founder",
        generation=1, is_alive=False,
        traits=list(gen1_traits if gen1_traits is not None else gen3_traits[:1]),
        personality="stub",
    )
    ruler = DynastyMember(
        id=f"{house_id}_gen2_ruler", name="Ruler Test", title="Ruler",
        generation=2, is_alive=True,
        traits=list(gen2_traits if gen2_traits is not None else gen3_traits[:1]),
        personality="stub", parent_ids=[founder.id],
    )
    spouse = DynastyMember(
        id=f"{house_id}_gen2_spouse", name="Spouse Test", title="Consort",
        generation=2, is_alive=True, traits=["Shadow Affinity (Darkvision 60ft)"],
        personality="stub",
    )
    ruler.spouse_id = spouse.id
    spouse.spouse_id = ruler.id
    heir = DynastyMember(
        id=f"{house_id}_gen3_heir", name="Heir Test", title="Heir",
        generation=3, is_alive=True, traits=list(gen3_traits),
        personality="stub", parent_ids=[ruler.id, spouse.id],
    )
    house.members = [founder, ruler, spouse, heir]
    engine.houses[house_id] = house
    return house


# ---------------------------------------------------------------------------
# 1. Multi-generation lineages: compounding + mutation, deterministic
# ---------------------------------------------------------------------------

def test_three_generation_lineage_compounds_across_extended_generations():
    engine = DynastyEngine(seed=101)
    engine.rng = ScriptedRandom(0.0)  # every inheritance gate succeeds
    house = _craft_house(
        engine, "house_compound",
        gen3_traits=[IRON_WILL],
        gen2_traits=[IRON_WILL, SILVER_TONGUE],
        gen1_traits=[IRON_WILL],
    )

    created = engine.extend_lineage("house_compound", additional_generations=2, mutation_rate=0.0)

    assert len(created) == 4  # heir + spouse per generation
    generations = {m.generation for m in created}
    assert generations == {4, 5}

    by_gen = {m.generation: m for m in house.members}
    gen4_heir = by_gen[4]
    gen5_heir = by_gen[5]

    # Compounding: the trait carried by gens 1-3 survives into gens 4 AND 5.
    assert IRON_WILL in gen4_heir.traits
    assert IRON_WILL in gen5_heir.traits
    # Parent-pool traits flow down (spouse traits included in the pool).
    assert SILVER_TONGUE in gen4_heir.traits

    # Lineage linkage: every extended generation descends from exactly ONE
    # parent — the previous generation's blooded heir, never a married-in
    # consort — and each heir is wed to its own generation's consort. (This
    # replaced an earlier `... or True` tautology that asserted nothing.)
    assert len(created) == 4
    assert gen4_heir.parent_ids == ["house_compound_gen3_heir"]
    assert gen5_heir.parent_ids == [gen4_heir.id]
    assert gen4_heir.spouse_id == "house_compound_gen4_consort"
    assert gen5_heir.spouse_id == "house_compound_gen5_consort"


def test_mutation_introduces_new_trait_at_configured_rate():
    engine = DynastyEngine(seed=202)
    engine.rng = ScriptedRandom(0.0)
    _craft_house(engine, "house_mutant", gen3_traits=[IRON_WILL])

    created = engine.extend_lineage("house_mutant", additional_generations=1, mutation_rate=1.0)

    heir = next(m for m in created if m.parent_ids)
    assert IRON_WILL in heir.traits  # inherited
    assert len(heir.traits) > 1      # mutation added something new
    mutated = [t for t in heir.traits if t != IRON_WILL and "Darkvision" not in t]
    assert mutated, "expected a mutated-in trait beyond the parental pool"


def test_lineage_extension_is_fully_deterministic_for_a_seed():
    def run():
        engine = DynastyEngine(seed=303)
        _craft_house(engine, "house_det", gen3_traits=[ARCANE_SPARK, IRON_WILL])
        engine.extend_lineage("house_det", additional_generations=3)
        return json.dumps(
            [[m.id, m.generation, sorted(m.traits)] for m in engine.houses["house_det"].members],
            sort_keys=True,
        )

    assert run() == run()


def test_compounding_raises_inheritance_probability_monotonically():
    engine = DynastyEngine(seed=404)
    p_one_gen = engine.inheritance_probability(IRON_WILL, prior_generation_count=1)
    p_three_gens = engine.inheritance_probability(IRON_WILL, prior_generation_count=3)
    assert p_three_gens > p_one_gen
    assert p_three_gens <= 0.95  # never guaranteed, even for deep bloodlines


# ---------------------------------------------------------------------------
# 2. Marriage / alliance between houses
# ---------------------------------------------------------------------------

def test_alliance_children_inherit_from_both_pools_per_dominance_weights():
    engine = DynastyEngine(seed=505)
    engine.rng = ScriptedRandom(0.6)  # expresses only traits with high dominance
    _craft_house(engine, "house_sun", gen3_traits=[IRON_WILL])          # dominance 0.70 -> p=0.65 > 0.6
    _craft_house(engine, "house_shade", gen3_traits=[CURSED_BLOOD])     # dominance 0.15 -> p=0.375 < 0.6

    pact = engine.form_alliance("house_sun", "house_shade", mutation_rate=0.0)

    assert pact is not None
    sun_child = engine.houses["house_sun"].members[-1]
    shade_child = engine.houses["house_shade"].members[-1]

    # Dominant trait from EITHER parent pool expresses in BOTH children...
    assert IRON_WILL in sun_child.traits
    assert IRON_WILL in shade_child.traits
    # ...while the recessive curse is suppressed in both.
    assert CURSED_BLOOD not in sun_child.traits
    assert CURSED_BLOOD not in shade_child.traits

    # Children are recorded as children of the cross-house marriage.
    for child in (sun_child, shade_child):
        assert set(child.parent_ids) == {pact["marriage"]["partners"][0], pact["marriage"]["partners"][1]}
    assert sun_child.id in [c for c in pact["children"]]

    # Marriage partners are cross-linked and both houses record the alliance.
    assert pact["marriage"]["partners"][0] != pact["marriage"]["partners"][1]
    assert engine.houses["house_sun"].feuds["house_shade"].startswith("Allied")
    assert engine.houses["house_shade"].feuds["house_sun"].startswith("Allied")


def test_alliance_recessive_expression_when_rng_is_lenient():
    engine = DynastyEngine(seed=606)
    engine.rng = ScriptedRandom(0.1)  # nearly everything expresses
    _craft_house(engine, "house_a", gen3_traits=[CURSED_BLOOD])
    _craft_house(engine, "house_b", gen3_traits=[GRIFFIN_RIDER])

    engine.form_alliance("house_a", "house_b", mutation_rate=0.0)
    child = engine.houses["house_a"].members[-1]
    # Lenient gate: both pools contribute, including the recessive curse.
    assert CURSED_BLOOD in child.traits
    assert GRIFFIN_RIDER in child.traits


# ---------------------------------------------------------------------------
# 3. House prestige scoring and ordering
# ---------------------------------------------------------------------------

def test_prestige_ordering_matches_crafted_inputs():
    engine = DynastyEngine(seed=707)
    golden = _craft_house(engine, "house_golden", gen3_traits=[GRIFFIN_RIDER, ARCANE_SPARK])
    cursed = _craft_house(engine, "house_cursed", gen3_traits=[CURSED_BLOOD])

    golden.feuds["house_x"] = "Allied (Mutual Defense Treaty)"
    cursed.feuds["house_y"] = "Blood Feud (Borderlands War)"

    p_golden = engine.house_prestige("house_golden")
    p_cursed = engine.house_prestige("house_cursed")

    assert p_golden > p_cursed
    ranked = engine.rank_houses()
    # The crafted pair must appear in the global ranking in score order,
    # regardless of where the seeded template houses land.
    positions = {hid: i for i, (hid, _) in enumerate(ranked)}
    assert positions["house_golden"] < positions["house_cursed"]
    scores = [score for _, score in ranked]
    assert scores == sorted(scores, reverse=True)


def test_alliance_and_depth_raise_prestige():
    engine = DynastyEngine(seed=808)
    _craft_house(engine, "house_rise", gen3_traits=[SILVER_TONGUE])
    _craft_house(engine, "house_other", gen3_traits=[ARCANE_SPARK])

    before = engine.house_prestige("house_rise")
    engine.form_alliance("house_rise", "house_other", mutation_rate=0.0)
    after_alliance = engine.house_prestige("house_rise")
    assert after_alliance > before

    before_depth = engine.house_prestige("house_rise")
    engine.extend_lineage("house_rise", additional_generations=2, mutation_rate=0.0)
    after_depth = engine.house_prestige("house_rise")
    assert after_depth > before_depth


# ---------------------------------------------------------------------------
# 4. Lore-graph injection reflects the final dynastic state
# ---------------------------------------------------------------------------

def test_lore_injection_reflects_deep_lineage_and_alliances():
    engine = DynastyEngine(seed=909)
    _craft_house(engine, "house_lore", gen3_traits=[GRIFFIN_RIDER])
    _craft_house(engine, "house_ally", gen3_traits=[SILVER_TONGUE])
    engine.extend_lineage("house_lore", additional_generations=2, mutation_rate=0.0)
    engine.form_alliance("house_lore", "house_ally", mutation_rate=0.0)

    graph = EpistemicLoreGraphManager()
    injected = engine.inject_lore_into_graph("house_lore", graph)
    assert injected >= 5

    rels = {(e["rel"], e["to"]) for e in graph.edges if e["from"] == "House Lore"}
    deep = [edge for edge in rels if edge[0] == "HOLDS_UNBROKEN_BLOODLINE"]
    assert deep and "5" in deep[0][1]
    assert any(rel == "COMMANDS_PRESTIGE" for rel, _ in rels)
    assert any(rel == "HOLDS_ALLIANCE_WITH" for rel, _ in rels)

    # Deep-lineage canon is committed as validated canon, not rumor.
    canon_edge = next(e for e in graph.edges if e["rel"] == "HOLDS_UNBROKEN_BLOODLINE")
    assert canon_edge["tier"] == EpistemicTier.VALIDATED_CANON


def test_lore_injection_is_generation_appropriate_for_young_houses():
    engine = DynastyEngine(seed=111)
    graph = EpistemicLoreGraphManager()

    engine.inject_lore_into_graph("house_vane", graph)

    rels = {e["rel"] for e in graph.edges if e["from"] == "House Vane of Black Iron"}
    assert "HOLDS_YOUNG_BLOODLINE" in rels          # 3 recorded generations only
    assert "HOLDS_UNBROKEN_BLOODLINE" not in rels   # no deep-lineage claim
    # Founding canon is validated; young-bloodline status stays proposed.
    young_edge = next(e for e in graph.edges if e["rel"] == "HOLDS_YOUNG_BLOODLINE")
    assert young_edge["tier"] == EpistemicTier.PROPOSED_FACT


# ---------------------------------------------------------------------------
# 5. Legacy single-generation API unchanged for existing callers
# ---------------------------------------------------------------------------

def test_legacy_single_generation_api_unchanged():
    engine = DynastyEngine(seed=123)
    payload = engine.get_dynasty_payload()

    assert set(payload.keys()) == {"houses"}
    assert len(payload["houses"]) == 3
    vane = next(h for h in payload["houses"] if h["id"] == "house_vane")
    assert len(vane["members"]) == 5
    assert {m["generation"] for m in vane["members"]} == {1, 2, 3}
    for m in vane["members"]:
        assert set(m.keys()) == LEGACY_MEMBER_KEYS
        assert len(m["traits"]) > 0
    assert set(vane.keys()) == {
        "id", "name", "motto", "crest_icon", "theme_color",
        "seat_of_power", "primary_virtue", "members", "feuds",
    }

    # Unknown house id still yields zero injections.
    assert engine.inject_lore_into_graph("house_missing", EpistemicLoreGraphManager()) == 0


def test_legacy_seed_output_stable_against_new_features():
    """Extending one house must not disturb the untouched template houses."""
    engine_a = DynastyEngine(seed=77)
    engine_b = DynastyEngine(seed=77)
    _craft_house(engine_b, "house_extra", gen3_traits=[ARCANE_SPARK])

    engine_b.extend_lineage("house_vane", additional_generations=1)

    a_vane = engine_a.get_dynasty_payload()["houses"]
    b_all = engine_b.get_dynasty_payload()["houses"]
    assert len(a_vane) == 3
    assert len(b_all) == 4
    b_vane = next(h for h in b_all if h["id"] == "house_vane")
    b_silverthorn = next(h for h in b_all if h["id"] == "house_silverthorn")
    a_silverthorn = next(h for h in a_vane if h["id"] == "house_silverthorn")
    assert b_silverthorn == a_silverthorn
    assert len(next(m for m in b_vane["members"] if m["generation"] == 4)["traits"]) > 0
