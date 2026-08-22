"""
Procedural Dynasty & Trait Inheritance Engine
Ported and synthesized from opendnd/opendnd algorithms.
Generates multi-generational noble houses, trait inheritance, and faction feud matrices.
"""

from typing import List, Dict, Any, Optional
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
        self.generate_initial_dynasties()

    def _inherit_traits(self, parent_traits: List[str]) -> List[str]:
        inherited: List[str] = []
        for trait in parent_traits:
            if self.rng.random() < 0.65:
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

    def inject_lore_into_graph(self, house_id: str, lore_graph: EpistemicLoreGraphManager) -> int:
        house = self.houses.get(house_id)
        if not house:
            return 0

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
        ]

        for target_id, rel in house.feuds.items():
            target_house = self.houses.get(target_id)
            target_name = target_house.name if target_house else target_id
            assertions.append(
                LoreAssertionPayload(
                    proposing_entity_id="Director_Agent",
                    subject_node_id=house.name,
                    predicate_relation="MAINTAINS_FEUD_STATUS",
                    object_node_id=f"{rel} with {target_name}",
                    epistemic_tier=EpistemicTier.PROPOSED_FACT,
                    context_sentence=f"{house.name} maintains {rel} against {target_name}.",
                )
            )

        for assertion in assertions:
            lore_graph.submit_assertion(assertion)

        return len(assertions)


global_dynasty_engine = DynastyEngine()
