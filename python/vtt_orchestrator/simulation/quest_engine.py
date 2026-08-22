"""
Procedural Quest & Dialogue Branching Tree Engine
Implements Directed Acyclic Graph (DAG) quest structures, morality branch points,
and Concordia-inspired multi-NPC treaty negotiation simulations.
"""

from enum import Enum
from typing import List, Dict, Any, Optional, Tuple
import random
from pydantic import BaseModel, Field


class QuestNodeType(str, Enum):
    HOOK = "HOOK"
    INVESTIGATION = "INVESTIGATION"
    SOCIAL_NEGOTIATION = "SOCIAL_NEGOTIATION"
    TACTICAL_ENCOUNTER = "TACTICAL_ENCOUNTER"
    MORAL_DILEMMA = "MORAL_DILEMMA"
    CLIMAX = "CLIMAX"
    RESOLUTION = "RESOLUTION"


class QuestChoiceEdge(BaseModel):
    choice_id: str
    target_node_id: str
    prompt_text: str
    skill_check_required: Optional[Tuple[str, int]] = None  # e.g. ("Persuasion", 14)
    faction_reputation_deltas: Dict[str, int] = Field(default_factory=dict)
    rewards_gold: int = 0
    rewards_xp: int = 0


class QuestNode(BaseModel):
    node_id: str
    node_type: QuestNodeType
    title: str
    narrative_prompt: str
    associated_faction_id: Optional[str] = None
    choices: List[QuestChoiceEdge] = Field(default_factory=list)


class QuestGraph(BaseModel):
    quest_id: str
    title: str
    summary: str
    initial_node_id: str
    nodes: Dict[str, QuestNode] = Field(default_factory=dict)


class ConcordiaNegotiationResult(BaseModel):
    pact_agreed: bool
    final_terms: str
    house_a_approval: float  # 0.0 to 1.0
    house_b_approval: float
    reputation_deltas: Dict[str, int]
    consequence_narrative: str


class QuestGraphGenerator:
    """
    Synthesizes rich, branching non-linear quest trees connected to noble houses.
    """

    def __init__(self, seed: Optional[int] = 42):
        self.rng = random.Random(seed)

    def generate_campaign_quest(
        self,
        campaign_theme: str = "The Iron Succession",
        primary_house: str = "house_vane",
        rival_house: str = "house_silverpeak",
    ) -> QuestGraph:
        nodes: Dict[str, QuestNode] = {}

        # 1. Hook
        nodes["node_hook"] = QuestNode(
            node_id="node_hook",
            node_type=QuestNodeType.HOOK,
            title="The Stolen Iron Seal",
            narrative_prompt=(
                f"A courier bearing the sigil of {primary_house.replace('_', ' ').title()} stumbles into the tavern, "
                f"poisoned by an assassin's blade. He clutches a parchment revealing that the ancient Iron Seal was stolen by agents of {rival_house.replace('_', ' ').title()}."
            ),
            associated_faction_id=primary_house,
            choices=[
                QuestChoiceEdge(
                    choice_id="c_investigate_catacombs",
                    target_node_id="node_investigate",
                    prompt_text="Track the assassin's bloody footprints down into the Sunken Catacombs.",
                    skill_check_required=("Survival", 12),
                    faction_reputation_deltas={primary_house: 5},
                    rewards_gold=50,
                    rewards_xp=100,
                ),
                QuestChoiceEdge(
                    choice_id="c_infiltrate_manor",
                    target_node_id="node_social_manor",
                    prompt_text=f"Attend {rival_house.replace('_', ' ').title()}'s masked masquerade to search the Lord's private study.",
                    skill_check_required=("Deception", 14),
                    faction_reputation_deltas={rival_house: 5},
                    rewards_gold=100,
                    rewards_xp=150,
                ),
            ],
        )

        # 2. Investigation Branch (Catacombs)
        nodes["node_investigate"] = QuestNode(
            node_id="node_investigate",
            node_type=QuestNodeType.INVESTIGATION,
            title="Shadows Beneath the Iron Crypt",
            narrative_prompt=(
                "Deep in the crypts, you corner the assassin who reveals he was hired by a shadow faction within both houses to provoke a civil war."
            ),
            associated_faction_id=primary_house,
            choices=[
                QuestChoiceEdge(
                    choice_id="c_spare_assassin",
                    target_node_id="node_moral_dilemma",
                    prompt_text="Spare the assassin in exchange for the forged conspiracy ledgers.",
                    skill_check_required=("Insight", 13),
                    faction_reputation_deltas={primary_house: 10, rival_house: 10},
                    rewards_gold=200,
                    rewards_xp=250,
                ),
                QuestChoiceEdge(
                    choice_id="c_slay_assassin",
                    target_node_id="node_climax_battle",
                    prompt_text="Execute the assassin and recover the Seal by force.",
                    faction_reputation_deltas={primary_house: 15, rival_house: -15},
                    rewards_gold=300,
                    rewards_xp=300,
                ),
            ],
        )

        # 3. Social Branch (Manor Masquerade)
        nodes["node_social_manor"] = QuestNode(
            node_id="node_social_manor",
            node_type=QuestNodeType.SOCIAL_NEGOTIATION,
            title="The Obsidian Masquerade",
            narrative_prompt=(
                f"Inside the grand ballroom of {rival_house.replace('_', ' ').title()}, Lady Aurelia approaches you, "
                "whispering that she knows you seek the Seal, and offers an alliance to depose her warmongering uncle."
            ),
            associated_faction_id=rival_house,
            choices=[
                QuestChoiceEdge(
                    choice_id="c_accept_lady_alliance",
                    target_node_id="node_moral_dilemma",
                    prompt_text="Form a secret pact with Lady Aurelia to expose the conspiracy peacefully.",
                    skill_check_required=("Persuasion", 15),
                    faction_reputation_deltas={rival_house: 20, primary_house: 5},
                    rewards_gold=250,
                    rewards_xp=300,
                ),
                QuestChoiceEdge(
                    choice_id="c_steal_seal_vault",
                    target_node_id="node_climax_battle",
                    prompt_text="Refuse her offer, create a distraction, and break into the Obsidian Vault.",
                    skill_check_required=("Stealth", 16),
                    faction_reputation_deltas={rival_house: -25, primary_house: 20},
                    rewards_gold=500,
                    rewards_xp=400,
                ),
            ],
        )

        # 4. Moral Dilemma Branch
        nodes["node_moral_dilemma"] = QuestNode(
            node_id="node_moral_dilemma",
            node_type=QuestNodeType.MORAL_DILEMMA,
            title="The Concordia Council",
            narrative_prompt=(
                "Both house patriarchs stand before the high court. You hold the evidence that could either trigger all-out war or forge an unbreakable blood pact."
            ),
            choices=[
                QuestChoiceEdge(
                    choice_id="c_forge_peace_treaty",
                    target_node_id="node_resolution_peace",
                    prompt_text="Present the conspiracy evidence and demand an eternal peace treaty sealed in blood.",
                    skill_check_required=("Persuasion", 16),
                    faction_reputation_deltas={primary_house: 25, rival_house: 25},
                    rewards_gold=1000,
                    rewards_xp=750,
                ),
                QuestChoiceEdge(
                    choice_id="c_betray_and_usurp",
                    target_node_id="node_resolution_chaos",
                    prompt_text="Falsify the evidence to destroy both leaders and claim lordship of the province.",
                    skill_check_required=("Intimidation", 18),
                    faction_reputation_deltas={primary_house: -50, rival_house: -50},
                    rewards_gold=2500,
                    rewards_xp=1200,
                ),
            ],
        )

        # 5. Climax Battle Branch
        nodes["node_climax_battle"] = QuestNode(
            node_id="node_climax_battle",
            node_type=QuestNodeType.CLIMAX,
            title="Clash of Black Iron",
            narrative_prompt=(
                "Swords are drawn in the courtyard as both noble retinues clash in a storm of steel and arcane fury."
            ),
            choices=[
                QuestChoiceEdge(
                    choice_id="c_defeat_warlord",
                    target_node_id="node_resolution_conquest",
                    prompt_text="Defeat the rogue warlord and secure the Iron Throne.",
                    faction_reputation_deltas={primary_house: 40, rival_house: -30},
                    rewards_gold=1500,
                    rewards_xp=1000,
                ),
            ],
        )

        # 6. Resolutions
        nodes["node_resolution_peace"] = QuestNode(
            node_id="node_resolution_peace",
            node_type=QuestNodeType.RESOLUTION,
            title="The Concordia Concordat",
            narrative_prompt="Peace reigns across the realm. Both noble houses unite under a joint banner, hailing you as Champion of the Realm.",
            choices=[],
        )

        nodes["node_resolution_chaos"] = QuestNode(
            node_id="node_resolution_chaos",
            node_type=QuestNodeType.RESOLUTION,
            title="Reign of the Shadow Lord",
            narrative_prompt="Both houses lie shattered. You reign from the obsidian throne amidst a lawless, terrifying new era.",
            choices=[],
        )

        nodes["node_resolution_conquest"] = QuestNode(
            node_id="node_resolution_conquest",
            node_type=QuestNodeType.RESOLUTION,
            title="Triumph of Black Iron",
            narrative_prompt=f"{primary_house.replace('_', ' ').title()} assumes absolute dominion over the province, rewarding your heroism with nobility.",
            choices=[],
        )

        return QuestGraph(
            quest_id="quest_iron_succession",
            title=campaign_theme,
            summary="A high-stakes political intrigue and assassination mystery determining the fate of the realm.",
            initial_node_id="node_hook",
            nodes=nodes,
        )


class ConcordiaPactEngine:
    """
    Simulates multi-party NPC negotiations using reputation and trait matrices.
    """

    def negotiate_treaty(
        self,
        house_a_name: str,
        house_b_name: str,
        player_diplomacy_roll: int,
        concessions_offered: str,
    ) -> ConcordiaNegotiationResult:
        # Base probability derived from player roll
        success_threshold = 15
        pact_agreed = player_diplomacy_roll >= success_threshold

        approval_a = min(1.0, max(0.1, player_diplomacy_roll / 25.0))
        approval_b = min(1.0, max(0.1, (player_diplomacy_roll - 2) / 25.0))

        if pact_agreed:
            terms = f"Mutual non-aggression pact, shared trade routes, and extradition of rogue assassins. Concession: {concessions_offered}."
            narrative = f"{house_a_name} and {house_b_name} sign the parchment with solemn oaths. The threat of war dissolves."
            deltas = {house_a_name: 20, house_b_name: 20}
        else:
            terms = "Negotiations collapsed. Diplomatic emissaries expelled."
            narrative = f"Tensions flare as {house_b_name} rejects the terms as insulting. Swords remain half-drawn."
            deltas = {house_a_name: -10, house_b_name: -10}

        return ConcordiaNegotiationResult(
            pact_agreed=pact_agreed,
            final_terms=terms,
            house_a_approval=approval_a,
            house_b_approval=approval_b,
            reputation_deltas=deltas,
            consequence_narrative=narrative,
        )
