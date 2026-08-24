"""
Procedural Dynasty & Trait Inheritance Engine
Ported and synthesized from opendnd/opendnd algorithms.
Generates multi-generational noble houses, trait inheritance, and faction feud matrices.

Depth mechanics (pillar iteration 8):
- Multi-generation lineages: ``extend_lineage`` compounds traits across 3+
  generations. Each trait's inheritance probability grows with the number of
  ancestor generations that carried it, bounded below certainty (deep
  bloodlines become likely, never guaranteed).
- Marriage/alliance: ``form_alliance`` marries the heads of two houses; their
  children draw from the union of both parents' trait pools, filtered through
  per-trait dominance/recessiveness weights (dominant traits express,
  recessive ones are usually suppressed but can surface under lenient rolls).
- House prestige: derived from living-member trait quality, alliances,
  generational depth, minus feuds. Fed back into ``inject_lore_into_graph``
  with generation-appropriate canon (young houses claim a young bloodline as
  PROPOSED_FACT; 5+ generation houses claim an unbroken bloodline as
  VALIDATED_CANON).

All stochasticity flows through the seeded ``random.Random`` instance; there
is no wall-clock dependence anywhere in this module.
"""

from typing import List, Dict, Any, Optional, Tuple
import random
from dataclasses import dataclass, field, asdict
from vtt_orchestrator.schemas.models import EpistemicTier, LoreAssertionPayload
from vtt_orchestrator.lore.epistemic_graph import EpistemicLoreGraphManager


@dataclass
class DynastyMember:
    id: str
    name: str
    title: str
    generation: int  # 1 = Founder, 2 = Current Ruler, 3 = Heir
    is_alive: bool
    traits: List[str]
    personality: str
    parent_ids: List[str] = field(default_factory=list)
    spouse_id: Optional[str] = None
    historical_event: Optional[str] = None


@dataclass
class MarriagePact:
    """A marriage/alliance between two houses, joining their trait pools."""
    house_a: str
    house_b: str
    partner_a_id: str
    partner_b_id: str
    children_ids: List[str] = field(default_factory=list)
    generation: int = 0


@dataclass
class NobleHouse:
    id: str
    name: str
    motto: str
    crest_icon: str
    theme_color: str
    seat_of_power: str
    primary_virtue: str
    members: List[DynastyMember] = field(default_factory=list)
    feuds: Dict[str, str] = field(default_factory=dict)  # house_id -> relationship (Allied, Blood Feud, Cold War, Neutral)
    marriages: List[MarriagePact] = field(default_factory=list)

    @property
    def max_generation(self) -> int:
        return max((m.generation for m in self.members), default=0)


class DynastyEngine:
    AVAILABLE_TRAITS = [
        "Iron Will (+2 Wisdom Saves)",
        "Arcane Spark (Innate Cantrip)",
        "Silver Tongue (+3 Persuasion)",
        "Shadow Affinity (Darkvision 60ft)",
        "Ruthless Ambition (+1 Crit Range)",
        "Dwarven Blood (Poison Resistance)",
        "Griffin Rider (Aerial Mastery)",
        "Cursed Bloodline (Disadvantage vs Necromancy)",
    ]

    NOBLE_HOUSE_TEMPLATES = [
        {
            "id": "house_vane",
            "name": "House Vane of Black Iron",
            "motto": "Strength Carved in Iron",
            "crest_icon": "crown",
            "theme_color": "#dc2626",
            "seat_of_power": "The Obsidian Citadel",
            "primary_virtue": "Ruthless Dominion",
            "founder_name": "Valerius Vane the Conqueror",
            "ruler_name": "Baron Malakor Vane",
            "spouse_name": "Lady Vespera of the Mist",
            "heir_name": "Lord Corvus Vane",
            "cadet_name": "Seraphina Vane (Exiled Heir)",
        },
        {
            "id": "house_silverthorn",
            "name": "House Silverthorn",
            "motto": "The Griffin Does Not Yield",
            "crest_icon": "shield",
            "theme_color": "#38bdf8",
            "seat_of_power": "Sunspire Keep",
            "primary_virtue": "Unyielding Honor",
            "founder_name": "High Justiciar Theron Silverthorn",
            "ruler_name": "Duchess Katherine Silverthorn",
            "spouse_name": "Lord Eric of Highfall",
            "heir_name": "Sir Jeremy Silverthorn",
            "cadet_name": "Aria Silverthorn (Court Mage)",
        },
        {
            "id": "house_duskwalker",
            "name": "House Duskwalker",
            "motto": "In Shadows We Rule",
            "crest_icon": "eye",
            "theme_color": "#a855f7",
            "seat_of_power": "The Veiled Spires",
            "primary_virtue": "Esoteric Secrets & Spying",
            "founder_name": "Lord Morpheus the Unseen",
            "ruler_name": "Countess Evelyn Duskwalker",
            "spouse_name": "Ambassador Kenneth Gray",
            "heir_name": "Silas Duskwalker (Shadow-Blade)",
            "cadet_name": "Lyra Duskwalker (Scholar)",
        },
    ]

    def __init__(self, seed: Optional[int] = 42):
        self.rng = random.Random(seed)
        self.houses: Dict[str, NobleHouse] = {}
        self.marriage_pacts: List[MarriagePact] = []
        self.generate_initial_dynasties()

    # ------------------------------------------------------------------
    # Trait genetics: dominance weights and generational compounding
    # ------------------------------------------------------------------

    # Dominance/recessiveness weight per trait in [0, 1]. High weight =
    # dominant allele-like behaviour: likely to express in cross-house
    # children even when only one parent carries it.
    TRAIT_DOMINANCE: Dict[str, float] = {
        "Iron Will (+2 Wisdom Saves)": 0.70,
        "Ruthless Ambition (+1 Crit Range)": 0.65,
        "Dwarven Blood (Poison Resistance)": 0.60,
        "Arcane Spark (Innate Cantrip)": 0.55,
        "Griffin Rider (Aerial Mastery)": 0.55,
        "Silver Tongue (+3 Persuasion)": 0.45,
        "Shadow Affinity (Darkvision 60ft)": 0.35,
        "Cursed Bloodline (Disadvantage vs Necromancy)": 0.15,
    }

    BASE_INHERITANCE_PROBABILITY = 0.65
    COMPOUND_BONUS_PER_CARRIER_GENERATION = 0.08
    MAX_INHERITANCE_PROBABILITY = 0.95
    ATAVISM_FACTOR = 0.35  # discount for ancestral traits resurfacing
    DOMINANT_EXPRESSION_BASE = 0.30
    DOMINANT_EXPRESSION_SPAN = 0.50

    @classmethod
    def dominance_of(cls, trait: str) -> float:
        return cls.TRAIT_DOMINANCE.get(trait, 0.5)

    def inheritance_probability(self, trait: str, prior_generation_count: int) -> float:
        """
        Probability a trait passes to the next generation. Compounds with
        the number of ancestor generations that carried it (a trait held
        unbroken for many generations becomes entrenched), but never
        reaches certainty.
        """
        effective_carriers = max(1, prior_generation_count)
        raw = (
            self.BASE_INHERITANCE_PROBABILITY
            + self.COMPOUND_BONUS_PER_CARRIER_GENERATION * (effective_carriers - 1)
        )
        return min(self.MAX_INHERITANCE_PROBABILITY, raw)

    def expression_probability(self, trait: str) -> float:
        """Probability a trait expresses in a child of a cross-house marriage."""
        return self.DOMINANT_EXPRESSION_BASE + self.DOMINANT_EXPRESSION_SPAN * self.dominance_of(trait)

    def _inherit_traits(
        self,
        parent_traits: List[str],
        prior_generation_counts: Optional[Dict[str, int]] = None,
    ) -> List[str]:
        counts = prior_generation_counts or {}
        inherited: List[str] = []
        for trait in parent_traits:
            probability = self.inheritance_probability(trait, counts.get(trait, 1))
            if self.rng.random() < probability:
                inherited.append(trait)
        if self.rng.random() < 0.25 or len(inherited) == 0:
            random_trait = self.rng.choice(self.AVAILABLE_TRAITS)
            if random_trait not in inherited:
                inherited.append(random_trait)
        return inherited

    def generate_initial_dynasties(self) -> Dict[str, NobleHouse]:
        self.houses = {}

        for tpl in self.NOBLE_HOUSE_TEMPLATES:
            # Gen 1: Founder
            founder_traits = self.rng.sample(self.AVAILABLE_TRAITS, 2)
            founder = DynastyMember(
                id=f"{tpl['id']}_gen1_founder",
                name=tpl["founder_name"],
                title="Grand Founder & Patriarch",
                generation=1,
                is_alive=False,
                traits=founder_traits,
                personality="Visionary, uncompromising warlord who forged the house during the Great Fracturing.",
                historical_event="Constructed the seat of power following the defeat of the Shadow Dragon.",
            )

            # Gen 2: Current Ruler & Spouse
            ruler_traits = self._inherit_traits(founder_traits)
            ruler = DynastyMember(
                id=f"{tpl['id']}_gen2_ruler",
                name=tpl["ruler_name"],
                title="Reigning Sovereign & Lord Warden",
                generation=2,
                is_alive=True,
                traits=ruler_traits,
                personality="Calculating politician maintaining military supremacy across the provinces.",
                parent_ids=[founder.id],
                historical_event="Negotiated the Iron Accords following the Siege of 1032.",
            )

            spouse = DynastyMember(
                id=f"{tpl['id']}_gen2_spouse",
                name=tpl["spouse_name"],
                title="Consort & Grand Chancellor",
                generation=2,
                is_alive=True,
                traits=self.rng.sample(self.AVAILABLE_TRAITS, 2),
                personality="Shrewd diplomat with deep connections to the continental trade cartels.",
            )
            ruler.spouse_id = spouse.id
            spouse.spouse_id = ruler.id

            # Gen 3: Heirs
            combined_parents_traits = list(set(ruler.traits + spouse.traits))
            heir_traits = self._inherit_traits(combined_parents_traits)
            heir = DynastyMember(
                id=f"{tpl['id']}_gen3_heir",
                name=tpl["heir_name"],
                title="Crown Heir & Commander of the Guard",
                generation=3,
                is_alive=True,
                traits=heir_traits,
                personality="Fierce champion eager to prove their martial worth in upcoming campaigns.",
                parent_ids=[ruler.id, spouse.id],
                historical_event="Led the vanguard in the Border Skirmishes of 1040.",
            )

            cadet_traits = self._inherit_traits(combined_parents_traits)
            cadet = DynastyMember(
                id=f"{tpl['id']}_gen3_cadet",
                name=tpl["cadet_name"],
                title="Scion & Archival Scholar",
                generation=3,
                is_alive=True,
                traits=cadet_traits,
                personality="Rebellious intellectual questioning the ancient edicts of the founding treaty.",
                parent_ids=[ruler.id, spouse.id],
            )

            house = NobleHouse(
                id=tpl["id"],
                name=tpl["name"],
                motto=tpl["motto"],
                crest_icon=tpl["crest_icon"],
                theme_color=tpl["theme_color"],
                seat_of_power=tpl["seat_of_power"],
                primary_virtue=tpl["primary_virtue"],
                members=[founder, ruler, spouse, heir, cadet],
            )
            self.houses[house.id] = house

        # Configure Feud & Tension Matrix
        self.houses["house_vane"].feuds = {
            "house_silverthorn": "Blood Feud (Borderlands War)",
            "house_duskwalker": "Cold War (Espionage & Intrigue)",
        }
        self.houses["house_silverthorn"].feuds = {
            "house_vane": "Blood Feud (Vengeance for Fallen Knights)",
            "house_duskwalker": "Allied (Mutual Defense Treaty)",
        }
        self.houses["house_duskwalker"].feuds = {
            "house_vane": "Cold War (Economic Sabotage)",
            "house_silverthorn": "Allied (Intelligence Sharing)",
        }

        return self.houses

    # ------------------------------------------------------------------
    # Lineage bookkeeping
    # ------------------------------------------------------------------

    @staticmethod
    def _is_blood_descendant(member: DynastyMember, house: NobleHouse) -> bool:
        """
        True when every recorded parent belongs to ``house`` — i.e. pure
        in-house descent. Married-in consorts (no parents here) and
        alliance-born children of cross-house marriages do not extend the
        house's own unbroken bloodline.
        """
        if not member.parent_ids:
            return False
        house_member_ids = {m.id for m in house.members}
        return all(pid in house_member_ids for pid in member.parent_ids)

    @classmethod
    def bloodline_depth(cls, house: NobleHouse) -> int:
        """
        Deepest generation reachable through pure in-house descent. Cross-
        house marriage children carry blended blood and are excluded.
        """
        depth = 0
        for member in house.members:
            if cls._is_blood_descendant(member, house):
                depth = max(depth, member.generation)
        return depth

    @classmethod
    def _carrier_generations(cls, house: NobleHouse, trait: str) -> int:
        """Number of distinct generations of ``house`` that carried ``trait``."""
        generations = {m.generation for m in house.members if trait in m.traits}
        return len(generations)

    @classmethod
    def head_of_house(cls, house: NobleHouse) -> Optional[DynastyMember]:
        """Deepest blood descendant (last-listed on ties); falls back to deepest member."""
        blood = [
            m for m in house.members
            if cls._is_blood_descendant(m, house)
        ]
        candidates = blood or house.members
        if not candidates:
            return None
        deepest = max(m.generation for m in candidates)
        return next(m for m in reversed(candidates) if m.generation == deepest)

    def _ordered_trait_pool(self, *trait_lists: List[str]) -> List[str]:
        """Union of trait pools in canonical AVAILABLE_TRAITS order (stable RNG draws)."""
        seen = {t for lst in trait_lists for t in lst}
        known = [t for t in self.AVAILABLE_TRAITS if t in seen]
        unknown = sorted(seen - set(known))
        return known + unknown

    # ------------------------------------------------------------------
    # Multi-generation lineages
    # ------------------------------------------------------------------

    def extend_lineage(
        self,
        house_id: str,
        additional_generations: int = 1,
        mutation_rate: float = 0.25,
    ) -> List[DynastyMember]:
        """
        Extends ``house_id`` by ``additional_generations`` further generations.
        Traits compound: the longer a trait has been carried by the bloodline,
        the more likely it is transmitted (see ``inheritance_probability``),
        and ancestral traits held by grandparents/great-grandparents can
        resurface (atavism) at a discounted probability. Each new generation
        also marries in a consort whose traits join the parental pool.
        Returns the newly created members in creation order.
        """
        house = self.houses.get(house_id)
        if not house or additional_generations <= 0:
            return []

        created: List[DynastyMember] = []
        for _ in range(additional_generations):
            depth = self.bloodline_depth(house)
            parent = self.head_of_house(house)
            if parent is None:
                break

            next_generation = max(m.generation for m in house.members) + 1

            consort = DynastyMember(
                id=f"{house_id}_gen{next_generation}_consort",
                name=f"Consort of {house.name.split(' ', 1)[-1]} (Generation {next_generation})",
                title="Married-In Consort",
                generation=next_generation,
                is_alive=True,
                traits=self.rng.sample(self.AVAILABLE_TRAITS, 2),
                personality="Bound to the house by treaty rather than blood.",
            )

            parental_pool = self._ordered_trait_pool(parent.traits, consort.traits)
            ancestral_pool = [
                t for t in self._ordered_trait_pool(*(m.traits for m in house.members))
                if t not in parental_pool
            ]

            inherited: List[str] = []
            for trait in parental_pool:
                probability = self.inheritance_probability(
                    trait, self._carrier_generations(house, trait)
                )
                if self.rng.random() < probability and trait not in inherited:
                    inherited.append(trait)

            # Atavism: distant ancestors' traits can resurface, weakly.
            for trait in ancestral_pool:
                probability = min(
                    self.MAX_INHERITANCE_PROBABILITY,
                    self.inheritance_probability(
                        trait, self._carrier_generations(house, trait)
                    ) * self.ATAVISM_FACTOR,
                )
                if self.rng.random() < probability and trait not in inherited:
                    inherited.append(trait)

            if mutation_rate > 0 and self.rng.random() < mutation_rate:
                fresh = self.rng.choice(self.AVAILABLE_TRAITS)
                if fresh not in inherited:
                    inherited.append(fresh)

            if not inherited:
                inherited.append(self.rng.choice(self.AVAILABLE_TRAITS))

            heir = DynastyMember(
                id=f"{house_id}_gen{next_generation}_heir",
                name=f"Heir of {house.name.split(' ', 1)[-1]} (Generation {next_generation})",
                title="Blooded Heir of the Extended Line",
                generation=next_generation,
                is_alive=True,
                traits=inherited,
                personality="Raised on the accumulated legend of the bloodline.",
                parent_ids=[parent.id],
                historical_event=f"Born at the turning of Generation {next_generation}.",
            )

            consort.spouse_id = heir.id
            heir.spouse_id = consort.id
            house.members.extend([consort, heir])
            created.extend([consort, heir])

        return created

    # ------------------------------------------------------------------
    # Marriage / alliance between houses
    # ------------------------------------------------------------------

    def form_alliance(
        self,
        house_a_id: str,
        house_b_id: str,
        mutation_rate: float = 0.15,
    ) -> Optional[Dict[str, Any]]:
        """
        Marries the heads of two houses. Children born to the union are
        recorded in BOTH houses and draw from the combined parental pools,
        filtered by each trait's dominance weight: dominant traits express
        readily, recessive ones usually stay latent but can surface.
        """
        house_a = self.houses.get(house_a_id)
        house_b = self.houses.get(house_b_id)
        if not house_a or not house_b or house_a_id == house_b_id:
            return None

        head_a = self.head_of_house(house_a)
        head_b = self.head_of_house(house_b)
        if not head_a or not head_b:
            return None

        combined_pool = self._ordered_trait_pool(head_a.traits, head_b.traits)

        pact = MarriagePact(
            house_a=house_a_id,
            house_b=house_b_id,
            partner_a_id=head_a.id,
            partner_b_id=head_b.id,
            generation=max(head_a.generation, head_b.generation) + 1,
        )
        children: List[DynastyMember] = []

        for house, prefix in ((house_a, "a"), (house_b, "b")):
            child_generation = max(m.generation for m in house.members) + 1
            expressed = [
                trait for trait in combined_pool
                if self.rng.random() < self.expression_probability(trait)
            ]
            if mutation_rate > 0 and self.rng.random() < mutation_rate:
                fresh = self.rng.choice(self.AVAILABLE_TRAITS)
                if fresh not in expressed:
                    expressed.append(fresh)
            if not expressed:
                expressed.append(self.rng.choice(combined_pool))

            child = DynastyMember(
                id=f"{house.id}_gen{child_generation}_alliance_child",
                name=f"Alliance-Born Scion of {house.name.split(' ', 1)[-1]}",
                title="Seal of the Inter-House Pact",
                generation=child_generation,
                is_alive=True,
                traits=expressed,
                personality="Carries the blended blood of two great houses.",
                parent_ids=[head_a.id, head_b.id],
                historical_event=f"Born to seal the pact between {house_a.name} and {house_b.name}.",
            )
            house.members.append(child)
            children.append(child)
            pact.children_ids.append(child.id)

        house_a.feuds[house_b_id] = "Allied (Marriage Pact)"
        house_b.feuds[house_a_id] = "Allied (Marriage Pact)"
        house_a.marriages.append(pact)
        house_b.marriages.append(pact)
        self.marriage_pacts.append(pact)

        return {
            "marriage": {
                "partners": [head_a.id, head_b.id],
                "houses": [house_a_id, house_b_id],
                "generation": pact.generation,
            },
            "children": list(pact.children_ids),
            "trait_pool": list(combined_pool),
        }

    # ------------------------------------------------------------------
    # House prestige
    # ------------------------------------------------------------------

    ALLIANCE_PRESTIGE_BONUS = 8.0
    BLOOD_FEUD_PENALTY = -6.0
    COLD_WAR_PENALTY = -2.0
    DEPTH_PRESTIGE_BONUS_PER_EXTRA_GENERATION = 2.0
    BASELINE_GENERATIONS_FOR_DEPTH = 3

    def house_prestige(self, house_id: str) -> float:
        """
        Prestige derived from the dominance-weighted traits of living
        members, plus standing alliances and generational depth, minus the
        drag of feuds. Fully deterministic for a given engine state.
        """
        house = self.houses.get(house_id)
        if not house:
            return 0.0

        trait_score = sum(
            self.dominance_of(trait)
            for member in house.members
            if member.is_alive
            for trait in member.traits
        )

        alliance_bonus = sum(
            self.ALLIANCE_PRESTIGE_BONUS
            for status in house.feuds.values()
            if status.startswith("Allied")
        )
        feud_penalty = sum(
            self.BLOOD_FEUD_PENALTY if status.startswith("Blood Feud")
            else self.COLD_WAR_PENALTY if status.startswith("Cold War")
            else 0.0
            for status in house.feuds.values()
        )

        extra_generations = max(
            0, self.bloodline_depth(house) - self.BASELINE_GENERATIONS_FOR_DEPTH
        )
        depth_bonus = extra_generations * self.DEPTH_PRESTIGE_BONUS_PER_EXTRA_GENERATION

        return round(trait_score + alliance_bonus + feud_penalty + depth_bonus, 3)

    def rank_houses(self) -> List[Tuple[str, float]]:
        """House ids ranked by prestige, strongest first."""
        ranked = [(hid, self.house_prestige(hid)) for hid in self.houses]
        ranked.sort(key=lambda item: (-item[1], item[0]))
        return ranked

    def get_dynasty_payload(self) -> Dict[str, Any]:
        return {
            "houses": [
                {
                    "id": h.id,
                    "name": h.name,
                    "motto": h.motto,
                    "crest_icon": h.crest_icon,
                    "theme_color": h.theme_color,
                    "seat_of_power": h.seat_of_power,
                    "primary_virtue": h.primary_virtue,
                    "members": [asdict(m) for m in h.members],
                    "feuds": h.feuds,
                }
                for h in self.houses.values()
            ]
        }

    # Bloodline claims graduate from PROPOSED_FACT to VALIDATED_CANON once a
    # house's in-house descent reaches this many generations.
    CANONICAL_BLOODLINE_DEPTH = 5

    def inject_lore_into_graph(self, house_id: str, lore_graph: EpistemicLoreGraphManager) -> int:
        house = self.houses.get(house_id)
        if not house:
            return 0

        depth = self.bloodline_depth(house)

        # Generation-appropriate canon: young houses may only *claim* an
        # emerging bloodline (proposed fact); long unbroken lines are
        # validated canon.
        if depth >= self.CANONICAL_BLOODLINE_DEPTH:
            bloodline_relation = "HOLDS_UNBROKEN_BLOODLINE"
            bloodline_object = f"{depth} Generations of Unbroken Descent"
            bloodline_tier = EpistemicTier.VALIDATED_CANON
            bloodline_sentence = (
                f"{house.name}'s bloodline has passed unbroken through "
                f"{depth} recorded generations."
            )
        else:
            bloodline_relation = "HOLDS_YOUNG_BLOODLINE"
            bloodline_object = f"{depth} Recorded Generations"
            bloodline_tier = EpistemicTier.PROPOSED_FACT
            bloodline_sentence = (
                f"Only {depth} generations of {house.name} are recorded; the line is "
                f"still proving itself."
            )

        assertions: List[LoreAssertionPayload] = [
            LoreAssertionPayload(
                proposing_entity_id="Director_Agent",
                subject_node_id=house.name,
                predicate_relation="RULES_FROM",
                object_node_id=house.seat_of_power,
                epistemic_tier=EpistemicTier.VALIDATED_CANON,
                context_sentence=f"{house.name} sovereign authority is recognized from {house.seat_of_power}.",
            ),
            LoreAssertionPayload(
                proposing_entity_id="Director_Agent",
                subject_node_id=house.name,
                predicate_relation="EMBODIES_VIRTUE",
                object_node_id=house.primary_virtue,
                epistemic_tier=EpistemicTier.PROPOSED_FACT,
                context_sentence=f"{house.name} strictly embodies the martial virtue of {house.primary_virtue}.",
            ),
            LoreAssertionPayload(
                proposing_entity_id="Director_Agent",
                subject_node_id=house.name,
                predicate_relation=bloodline_relation,
                object_node_id=bloodline_object,
                epistemic_tier=bloodline_tier,
                context_sentence=bloodline_sentence,
            ),
            LoreAssertionPayload(
                proposing_entity_id="Director_Agent",
                subject_node_id=house.name,
                predicate_relation="COMMANDS_PRESTIGE",
                object_node_id=str(self.house_prestige(house_id)),
                epistemic_tier=EpistemicTier.PROPOSED_FACT,
                context_sentence=(
                    f"{house.name} holds a dynastic prestige score of "
                    f"{self.house_prestige(house_id):.1f}, weighted by its traits, alliances and lineage depth."
                ),
            ),
        ]

        for target_id, rel in house.feuds.items():
            target_house = self.houses.get(target_id)
            target_name = target_house.name if target_house else target_id
            if rel.startswith("Allied"):
                relation = "HOLDS_ALLIANCE_WITH"
                sentence = f"{house.name} is bound by alliance ({rel}) to {target_name}."
            else:
                relation = "MAINTAINS_FEUD_STATUS"
                sentence = f"{house.name} maintains {rel} against {target_name}."
            assertions.append(
                LoreAssertionPayload(
                    proposing_entity_id="Director_Agent",
                    subject_node_id=house.name,
                    predicate_relation=relation,
                    object_node_id=target_name,
                    epistemic_tier=EpistemicTier.PROPOSED_FACT,
                    context_sentence=sentence,
                )
            )

        for assertion in assertions:
            lore_graph.submit_assertion(assertion)

        return len(assertions)


global_dynasty_engine = DynastyEngine()
