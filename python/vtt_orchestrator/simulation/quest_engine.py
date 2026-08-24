"""
Procedural Quest & Dialogue Branching Tree Engine
Implements Directed Acyclic Graph (DAG) quest structures, morality branch points,
and Concordia-inspired multi-NPC treaty negotiation simulations.
"""

from dataclasses import dataclass
from enum import Enum
from typing import List, Dict, Any, Optional, Tuple
import random
import re
from pydantic import BaseModel, Field


class QuestNodeType(str, Enum):
    HOOK = "HOOK"
    INVESTIGATION = "INVESTIGATION"
    SOCIAL_NEGOTIATION = "SOCIAL_NEGOTIATION"
    TACTICAL_ENCOUNTER = "TACTICAL_ENCOUNTER"
    MORAL_DILEMMA = "MORAL_DILEMMA"
    TRAVEL_HAZARD = "TRAVEL_HAZARD"
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
    # Set only when the requested length exceeded what the curated theme
    # tables could fill; discloses the truncation instead of padding.
    coverage_note: Optional[str] = None


class ConcordiaNegotiationResult(BaseModel):
    pact_agreed: bool
    final_terms: str
    house_a_approval: float  # 0.0 to 1.0
    house_b_approval: float
    reputation_deltas: Dict[str, int]
    consequence_narrative: str


DEFAULT_CAMPAIGN_THEME = "The Iron Succession"


@dataclass(frozen=True)
class NodeTemplate:
    """One authored piece of quest content. Nothing outside these tables is
    ever invented at generation time."""

    title: str
    prompt: str


@dataclass(frozen=True)
class ThemeTable:
    """Curated content pool for one quest theme.

    Coverage contract: the generator only draws from these pools. If a pool is
    too thin to fill the requested structure it emits fewer nodes and records
    a `coverage_note` on the graph rather than padding with filler.

    Pool sizes (entries available):
        court      hooks=3 probes=3 pressures=3 clashes=2 dilemmas=2 climaxes=2 resolutions=3
        crypt      hooks=3 probes=3 pressures=3 clashes=2 dilemmas=2 climaxes=2 resolutions=3
        wilderness hooks=3 probes=2 pressures=3 clashes=2 dilemmas=2 climaxes=2 resolutions=3

    A "long" quest asks probes for 2+1 entries, so wilderness (probes=2)
    truncates honestly; court and crypt fill every slot.
    """

    key: str
    summary: str
    skills: Tuple[str, ...]
    factions: Tuple[str, str]
    pressure_type: QuestNodeType
    clash_type: QuestNodeType
    keywords: Tuple[str, ...]
    hooks: Tuple[NodeTemplate, ...]
    probes: Tuple[NodeTemplate, ...]  # INVESTIGATION nodes
    pressures: Tuple[NodeTemplate, ...]  # theme-defining middle nodes
    clashes: Tuple[NodeTemplate, ...]  # late-act middle nodes
    dilemmas: Tuple[NodeTemplate, ...]
    climaxes: Tuple[NodeTemplate, ...]
    resolutions: Tuple[NodeTemplate, ...]


COURT_TABLE = ThemeTable(
    key="court",
    summary=(
        "A high-stakes political intrigue and assassination mystery "
        "determining the fate of the realm."
    ),
    skills=("Persuasion", "Deception", "Insight", "Intimidation", "History"),
    factions=("court_loyists", "court_conspirators"),
    pressure_type=QuestNodeType.SOCIAL_NEGOTIATION,
    clash_type=QuestNodeType.SOCIAL_NEGOTIATION,
    keywords=("court", "intrigue", "succession", "noble", "throne", "masquerade"),
    hooks=(
        NodeTemplate(
            title="The Stolen Iron Seal",
            prompt=(
                "A courier bearing the sigil of {primary} stumbles into the tavern, "
                "poisoned by an assassin's blade. He clutches a parchment revealing "
                "that the ancient Iron Seal was stolen by agents of {rival}."
            ),
        ),
        NodeTemplate(
            title="A Ledger Left Ajar",
            prompt=(
                "{primary}'s tax clerk is found dead over an open ledger. The final "
                "entry, in a hand that is not his, routes a war chest toward {rival}."
            ),
        ),
        NodeTemplate(
            title="Midnight Summons",
            prompt=(
                "A hooded servant of {primary} wakes you with a sealed summons: the "
                "spymaster believes {rival} has bought three votes on the privy council."
            ),
        ),
    ),
    probes=(
        NodeTemplate(
            title="Footprints in the Wine Cellar",
            prompt=(
                "Beneath the manor you match a muddy boot print to the cellar "
                "steward's shoes -- and to a second, smaller set nobody can explain."
            ),
        ),
        NodeTemplate(
            title="The Poisoner's Receipt",
            prompt=(
                "An apothecary's receipt names the exact dose of widow's-milk that "
                "felled the courier, signed with a merchant mark tied to {rival}."
            ),
        ),
        NodeTemplate(
            title="Intercepted Courier Satchel",
            prompt=(
                "You cut out a rider on the north road. His satchel holds coded "
                "letters scheduling the assassination for the eve of the coronation."
            ),
        ),
    ),
    pressures=(
        NodeTemplate(
            title="The Obsidian Masquerade",
            prompt=(
                "Inside the grand ballroom of {rival}, Lady Aurelia approaches you, "
                "whispering that she knows what you seek and offers an alliance "
                "against her warmongering uncle."
            ),
        ),
        NodeTemplate(
            title="Audience with the Chancellor",
            prompt=(
                "The chancellor of {primary} receives you behind locked doors and "
                "demands to know whether your loyalty is bought or earned -- then "
                "makes an offer that answers the question for you."
            ),
        ),
        NodeTemplate(
            title="The Gilded Barge Summit",
            prompt=(
                "Both houses send envoys to a neutral barge on the river. You are "
                "seated between them, close enough to hear each side lie politely."
            ),
        ),
    ),
    clashes=(
        NodeTemplate(
            title="The Vote of No Confidence",
            prompt=(
                "The council chamber erupts. One speech from you will decide whether "
                "the regency stands or falls -- and who inherits the pieces."
            ),
        ),
        NodeTemplate(
            title="Blackmail at the Banquet",
            prompt=(
                "At the coronation feast you hold letters that could ruin either "
                "house. Both matriarchs are watching which pocket you reach into."
            ),
        ),
    ),
    dilemmas=(
        NodeTemplate(
            title="The Concordia Council",
            prompt=(
                "Both house patriarchs stand before the high court. You hold the "
                "evidence that could either trigger all-out war or forge an "
                "unbreakable blood pact."
            ),
        ),
        NodeTemplate(
            title="Two Seals, One Throne",
            prompt=(
                "You possess two seals: one authentic, one forged. Only you know "
                "which is which, and only one can be presented to the assembled lords."
            ),
        ),
    ),
    climaxes=(
        NodeTemplate(
            title="Clash of Black Iron",
            prompt=(
                "Swords are drawn in the courtyard as both noble retinues clash in "
                "a storm of steel and arcane fury."
            ),
        ),
        NodeTemplate(
            title="The Reading of the Wills",
            prompt=(
                "In the candlelit scriptorium the dead patriarch's true will is read "
                "aloud at last, and half the room reaches for steel while the other "
                "half reaches for quills."
            ),
        ),
    ),
    resolutions=(
        NodeTemplate(
            title="The Concordia Concordat",
            prompt=(
                "Peace reigns across the realm. Both noble houses unite under a "
                "joint banner, hailing you as Champion of the Realm."
            ),
        ),
        NodeTemplate(
            title="Reign of the Shadow Lord",
            prompt=(
                "Both houses lie shattered. You reign from the obsidian throne "
                "amidst a lawless, terrifying new era."
            ),
        ),
        NodeTemplate(
            title="Triumph of Black Iron",
            prompt=(
                "{primary} assumes absolute dominion over the province, rewarding "
                "your heroism with nobility."
            ),
        ),
    ),
)

CRYPT_TABLE = ThemeTable(
    key="crypt",
    summary=(
        "A descent into consecrated ground gone wrong, where grave-goods, "
        "wards, and the dead themselves must be reckoned with."
    ),
    skills=("Religion", "Survival", "Athletics", "Perception", "Arcana"),
    factions=("order_of_the_lantern", "cult_of_the_hollow_sun"),
    pressure_type=QuestNodeType.TACTICAL_ENCOUNTER,
    clash_type=QuestNodeType.TACTICAL_ENCOUNTER,
    keywords=("crypt", "catacomb", "tomb", "sepulcher", "undead", "ossuary"),
    hooks=(
        NodeTemplate(
            title="The Sunken Catacomb Key",
            prompt=(
                "A dying sexton presses a black iron key into your hands and gasps "
                "that the lower catacombs have been unsealed from the inside."
            ),
        ),
        NodeTemplate(
            title="Grave-Goods Gone Missing",
            prompt=(
                "The Order of the Lantern reports three saintly reliquaries stolen "
                "from sealed sarcophagi -- without a single lid pried open."
            ),
        ),
        NodeTemplate(
            title="The Sexton's Confession",
            prompt=(
                "Cornered by torchlight, the graveyard keeper admits he sold the "
                "counting-house bones to strangers who paid in mint-fresh coin."
            ),
        ),
    ),
    probes=(
        NodeTemplate(
            title="Whispers in the Ossuary",
            prompt=(
                "Stacked femurs have been rearranged into spirals that hum when "
                "lantern light passes over them. Something down here is counting."
            ),
        ),
        NodeTemplate(
            title="The Defaced Ward-Stone",
            prompt=(
                "The cornerstone ward has been chiseled away with patient, "
                "worshipful care -- not broken, but unmade."
            ),
        ),
        NodeTemplate(
            title="Bones Out of Order",
            prompt=(
                "Comparing burial ledgers against the niches, forty skeletons are "
                "missing and none of the coffins were opened after the funeral."
            ),
        ),
    ),
    pressures=(
        NodeTemplate(
            title="Crypt Ghoul Ambush",
            prompt=(
                "The flagstone gives way and ghouls pour from the erosion channels, "
                "hungry for the living light of your lantern."
            ),
        ),
        NodeTemplate(
            title="The Flooded Ossuary Pit",
            prompt=(
                "Black water fills the lower gallery to the ceiling grooves, and "
                "something pale circles beneath the surface between you and the stairs."
            ),
        ),
        NodeTemplate(
            title="Wight at the Iron Gate",
            prompt=(
                "A barrow-wight in rusted vestments guards the inner gate, demanding "
                "in a voice like sliding gravel that you return what was taken."
            ),
        ),
    ),
    clashes=(
        NodeTemplate(
            title="Iron Gate Standoff",
            prompt=(
                "The inner gate grinds shut behind you with the wight on one side "
                "and the only exit on the other. Rust flakes drift like red snow."
            ),
        ),
        NodeTemplate(
            title="The Drowning Gallery",
            prompt=(
                "Water surges through the breached aqueduct into the lower gallery. "
                "Reach the airlock stair before the gallery fills -- or open the "
                "floodgate and loose whatever swam in with the water."
            ),
        ),
    ),
    dilemmas=(
        NodeTemplate(
            title="Consecrate or Plunder",
            prompt=(
                "You stand before the unsealed reliquary. Reconsecrating it will "
                "seal the crypt forever -- and bury a king's ransom with it."
            ),
        ),
        NodeTemplate(
            title="The Bound Spirit's Bargain",
            prompt=(
                "The chained spirit of the crypt's founder offers the truth behind "
                "the desecration -- if you break her chain and let her pass upward."
            ),
        ),
    ),
    climaxes=(
        NodeTemplate(
            title="The Bone Choir Rises",
            prompt=(
                "Every skeleton in the ossuary assembles itself into a kneeling "
                "choir, and the hymn they sing tears mortar from the walls."
            ),
        ),
        NodeTemplate(
            title="Desecrator's Altar",
            prompt=(
                "At the heart of the crypt a profaned altar drinks lantern light. "
                "Its keeper turns from the ritual with eyes like blown-out candles."
            ),
        ),
    ),
    resolutions=(
        NodeTemplate(
            title="The Catacombs Re-Sealed",
            prompt=(
                "The ward-stone sings whole again. The Order of the Lantern records "
                "your names in its roll of keepers, and the dead stay dead."
            ),
        ),
        NodeTemplate(
            title="A Cart of Cursed Relics",
            prompt=(
                "You haul the reliquaries to the surface by night. The coin is real; "
                "so, increasingly, are the whispers that follow the cart."
            ),
        ),
        NodeTemplate(
            title="The Sepulcher Claims Another",
            prompt=(
                "The expedition limps home diminished. Below, the crypt quietly "
                "re-hangs its forty skeletons and waits for the next keys."
            ),
        ),
    ),
)

WILDERNESS_TABLE = ThemeTable(
    key="wilderness",
    summary=(
        "A trek through untamed country where weather, terrain, and hungry "
        "things with territory decide the schedule."
    ),
    skills=("Survival", "Nature", "Perception", "Animal Handling", "Stealth"),
    factions=("rangers_guild", "hollow_boar_clan"),
    pressure_type=QuestNodeType.TRAVEL_HAZARD,
    clash_type=QuestNodeType.TACTICAL_ENCOUNTER,
    keywords=("wilderness", "wild", "forest", "hunt", "ranger", "swamp", "pass"),
    hooks=(
        NodeTemplate(
            title="The Missing Survey Crew",
            prompt=(
                "The Rangers' Guild posts a bounty: a survey crew marking the new "
                "road missed its last two check-ins beyond the northern ridge."
            ),
        ),
        NodeTemplate(
            title="Smoke on the Northern Ridge",
            prompt=(
                "Watchtowers report cook-smoke where no homestead stands, moving "
                "a league closer to the pass every night this week."
            ),
        ),
        NodeTemplate(
            title="Toll Taken in Sheep",
            prompt=(
                "Farmers at the forest's edge lose livestock nightly to something "
                "clever enough to open gates and leave no tracks but its own."
            ),
        ),
    ),
    probes=(
        NodeTemplate(
            title="Reading the Broken Trail Markers",
            prompt=(
                "The guild's blazes along the ridge trail have been snapped at a "
                "uniform height -- deliberately, and recently, by someone who knew "
                "exactly which markers mattered."
            ),
        ),
        NodeTemplate(
            title="The Abandoned Ranger Station",
            prompt=(
                "The waystation's stove is still warm. Maps on the table show the "
                "crew's route amended in fresh charcoal, heading somewhere that "
                "isn't on any guild chart."
            ),
        ),
    ),
    pressures=(
        NodeTemplate(
            title="The Swollen Ford",
            prompt=(
                "Spring melt has turned the ford into a brown torrent dragging "
                "whole trees. Crossing costs time, gear, or a very cold swim."
            ),
        ),
        NodeTemplate(
            title="Rockslide in the Pass",
            prompt=(
                "A fresh scar of tumbled boulders blocks the switchbacks. Somewhere "
                "above, loose stone ticks downslope at regular intervals."
            ),
        ),
        NodeTemplate(
            title="Whistling Mire",
            prompt=(
                "The bog path breathes through sinkholes with a low whistle that "
                "swells whenever weight settles on the wrong tussock."
            ),
        ),
    ),
    clashes=(
        NodeTemplate(
            title="Dire Wolf Pack at Dusk",
            prompt=(
                "Grey shapes pace you along the treeline as the light fails, "
                "tightening their circle with each hundred paces."
            ),
        ),
        NodeTemplate(
            title="Harpies on the Crags",
            prompt=(
                "Winged silhouettes wheel above the crag shelf you must cross, "
                "mimicking a child's cry to draw climbers off the ledge."
            ),
        ),
    ),
    dilemmas=(
        NodeTemplate(
            title="The Poacher's Family",
            prompt=(
                "The trail leads to a starving poacher and his children. Turning him "
                "in saves the guild's face; feeding them first costs your provisions "
                "and the guild's favor."
            ),
        ),
        NodeTemplate(
            title="Burn the Blighted Grove?",
            prompt=(
                "The blighted grove is the source of the sickness -- and also the "
                "only shelter for a day's march in any direction. Fire would end "
                "both the threat and the refuge."
            ),
        ),
    ),
    climaxes=(
        NodeTemplate(
            title="Storm at the Standing Stones",
            prompt=(
                "Lightning walks the ring of standing stones where the missing crew "
                "finally makes its stand, armed with survey stakes and fury."
            ),
        ),
        NodeTemplate(
            title="The Alpha's Den",
            prompt=(
                "The cave mouth is strewn with guild buttons. Deep inside, something "
                "large is guarding the thing it learned to hunt men for."
            ),
        ),
    ),
    resolutions=(
        NodeTemplate(
            title="The Pass Stands Open",
            prompt=(
                "The road crew's markers stand true again all the way to the far "
                "slope, and the first honest wagon rolls through at dawn."
            ),
        ),
        NodeTemplate(
            title="A Grove Left to Heal",
            prompt=(
                "The blight is burned back to a scar that will green over. The "
                "hollow-boar clan leaves a carved token at your camp: passage, "
                "freely given, through their country."
            ),
        ),
        NodeTemplate(
            title="Debt Owed to the Wilds",
            prompt=(
                "You get most of the crew home. The rangers log the loss without "
                "blame, but everyone knows the wilds keep the difference."
            ),
        ),
    ),
)

THEMES: Dict[str, ThemeTable] = {
    COURT_TABLE.key: COURT_TABLE,
    CRYPT_TABLE.key: CRYPT_TABLE,
    WILDERNESS_TABLE.key: WILDERNESS_TABLE,
}

# Length plans: sequence of (pool_kind, width) middle layers between the hook
# and the dilemma/climax fork.
LENGTH_PLANS: Dict[str, Tuple[Tuple[str, int], ...]] = {
    "short": (("probe", 1), ("pressure", 1)),
    "medium": (("probe", 2), ("pressure", 2)),
    "long": (("probe", 2), ("pressure", 2), ("probe", 1), ("clash", 1)),
}


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


class QuestGraphGenerator:
    """
    Synthesizes branching non-linear quest DAGs from curated theme tables.

    Parametrization contract (fixes the earlier "fixed narrative" audit
    finding, where every argument produced the same hardcoded DAG):

    * ``theme`` ("court" | "crypt" | "wilderness") selects the content table,
      which determines node types, titles, prompts, skill lists, and factions.
      When omitted, the theme is inferred from keywords in ``campaign_theme``
      (defaulting to court). An explicitly unknown theme raises ``ValueError``.
    * ``party_level`` scales difficulty numbers (DCs) and rewards without
      changing structure.
    * ``length`` ("short" | "medium" | "long") selects how many middle layers
      the DAG has. If a theme's tables cannot fill a requested layer, the
      layer is omitted and ``QuestGraph.coverage_note`` discloses it -- the
      generator never pads with invented filler.
    * ``seed`` drives all sampling (template selection, edge order, skill
      assignment, resolution permutation). Same seed + same arguments yields a
      byte-identical DAG.

    Legacy positional/keyword callers (``campaign_theme``, ``primary_house``,
    ``rival_house``) remain supported unchanged; the legacy default theme maps
    to ``quest_id == "quest_iron_succession"``.
    """

    def __init__(self, seed: Optional[int] = 42):
        self.rng = random.Random(seed)

    # -- parameter resolution ------------------------------------------------

    @staticmethod
    def _resolve_theme(campaign_theme: str, theme: Optional[str]) -> ThemeTable:
        if theme is not None:
            table = THEMES.get(theme.lower())
            if table is None:
                raise ValueError(
                    f"Unknown theme {theme!r}; valid themes: {sorted(THEMES)}"
                )
            return table
        lowered = campaign_theme.lower()
        for table in THEMES.values():
            if table.key == "court":
                continue  # court is the fallback, checked last
            if any(kw in lowered for kw in table.keywords):
                return table
        return THEMES["court"]

    # -- numeric scaling -----------------------------------------------------

    @staticmethod
    def _scaled_dc(base_dc: int, party_level: int) -> int:
        return max(8, min(25, base_dc + party_level // 4))

    @staticmethod
    def _reward_multiplier(party_level: int) -> int:
        return 1 + party_level // 5

    # -- edge construction ---------------------------------------------------

    def _make_edge(
        self,
        index: int,
        source_id: str,
        target_id: str,
        prompt_text: str,
        table: ThemeTable,
        party_level: int,
    ) -> QuestChoiceEdge:
        mult = self._reward_multiplier(party_level)
        checked = self.rng.random() >= 0.25
        skill_check = None
        if checked:
            skill = self.rng.choice(table.skills)
            base_dc = self.rng.randint(11, 15)
            skill_check = (skill, self._scaled_dc(base_dc, party_level))
        positive = self.rng.randint(5, 20)
        negative = -self.rng.randint(5, 20)
        return QuestChoiceEdge(
            choice_id=f"c_{source_id}_{index}",
            target_node_id=target_id,
            prompt_text=prompt_text,
            skill_check_required=skill_check,
            faction_reputation_deltas={
                table.factions[0]: positive,
                table.factions[1]: negative,
            },
            rewards_gold=self.rng.choice((50, 100, 150, 200, 300)) * mult,
            rewards_xp=self.rng.choice((100, 150, 250, 400)) * mult,
        )

    # -- main entry point ----------------------------------------------------

    def generate_campaign_quest(
        self,
        campaign_theme: str = DEFAULT_CAMPAIGN_THEME,
        primary_house: str = "house_vane",
        rival_house: str = "house_silverpeak",
        theme: Optional[str] = None,
        party_level: int = 5,
        length: str = "medium",
    ) -> QuestGraph:
        explicit = theme is not None
        table = self._resolve_theme(campaign_theme, theme)

        if not isinstance(party_level, int) or not 1 <= party_level <= 20:
            raise ValueError("party_level must be an integer between 1 and 20")
        if length not in LENGTH_PLANS:
            raise ValueError(
                f"Unknown length {length!r}; valid lengths: {sorted(LENGTH_PLANS)}"
            )

        fmt_kwargs = {
            "primary": primary_house.replace("_", " ").title(),
            "rival": rival_house.replace("_", " ").title(),
        }

        def realize(template: NodeTemplate) -> NodeTemplate:
            return NodeTemplate(
                title=template.title,
                prompt=template.prompt.format(**fmt_kwargs),
            )

        # Sample content up front so rng consumption is identical regardless
        # of party_level (structure stays fixed across levels).
        hook_tpl = realize(self.rng.choice(table.hooks))
        dilemma_tpl = realize(self.rng.choice(table.dilemmas))
        climax_tpl = realize(self.rng.choice(table.climaxes))
        resolutions = [realize(t) for t in table.resolutions]
        self.rng.shuffle(resolutions)

        pools = {}
        for kind in ("probe", "pressure", "clash"):
            source = {
                "probe": table.probes,
                "pressure": table.pressures,
                "clash": table.clashes,
            }[kind]
            shuffled = list(source)
            self.rng.shuffle(shuffled)
            pools[kind] = shuffled

        # Lay out middle layers, truncating honestly when a pool runs dry.
        layers: List[Tuple[str, QuestNodeType, List[NodeTemplate]]] = []
        omitted_slots = 0
        for kind, width in LENGTH_PLANS[length]:
            available = pools[kind][:width]
            del pools[kind][:width]
            omitted_slots += width - len(available)
            if available:
                node_type = {
                    "probe": QuestNodeType.INVESTIGATION,
                    "pressure": table.pressure_type,
                    "clash": table.clash_type,
                }[kind]
                layers.append((kind, node_type, available))

        coverage_note = None
        if omitted_slots:
            coverage_note = (
                f"Requested length '{length}' truncates for theme '{table.key}': "
                f"{omitted_slots} planned node slot(s) had no remaining curated "
                f"content in the theme tables, so the DAG was generated smaller "
                f"rather than padded with invented filler."
            )

        # Assign deterministic node ids per layer.
        counters: Dict[str, int] = {}

        def next_id(kind: str) -> str:
            n = counters.get(kind, 0)
            counters[kind] = n + 1
            return f"{table.key}_{kind}_{n}"

        nodes: Dict[str, QuestNode] = {}

        hook_id = f"{table.key}_hook"
        nodes[hook_id] = QuestNode(
            node_id=hook_id,
            node_type=QuestNodeType.HOOK,
            title=hook_tpl.title,
            narrative_prompt=hook_tpl.prompt,
            associated_faction_id=table.factions[0],
            choices=[],
        )

        layer_ids: List[List[str]] = []
        for kind, node_type, templates in layers:
            ids = []
            for tpl in templates:
                nid = next_id(kind)
                ids.append(nid)
                nodes[nid] = QuestNode(
                    node_id=nid,
                    node_type=node_type,
                    title=tpl.title,
                    narrative_prompt=tpl.prompt,
                    associated_faction_id=table.factions[0],
                    choices=[],
                )
            layer_ids.append(ids)

        dilemma_id = f"{table.key}_dilemma"
        climax_id = f"{table.key}_climax"
        nodes[dilemma_id] = QuestNode(
            node_id=dilemma_id,
            node_type=QuestNodeType.MORAL_DILEMMA,
            title=dilemma_tpl.title,
            narrative_prompt=dilemma_tpl.prompt,
            choices=[],
        )
        nodes[climax_id] = QuestNode(
            node_id=climax_id,
            node_type=QuestNodeType.CLIMAX,
            title=climax_tpl.title,
            narrative_prompt=climax_tpl.prompt,
            choices=[],
        )

        resolution_ids = [
            f"{table.key}_resolution_{i}" for i in range(len(resolutions))
        ]
        for rid, tpl in zip(resolution_ids, resolutions):
            nodes[rid] = QuestNode(
                node_id=rid,
                node_type=QuestNodeType.RESOLUTION,
                title=tpl.title,
                narrative_prompt=tpl.prompt,
                choices=[],
            )

        # Wire edges forward-only (guaranteed acyclic).
        previous = [hook_id]

        def connect(source_id: str, targets: List[str]) -> None:
            node = nodes[source_id]
            for i, target in enumerate(targets):
                node.choices.append(
                    self._make_edge(
                        i,
                        source_id,
                        target,
                        f"Press on: {nodes[target].title}.",
                        table,
                        party_level,
                    )
                )

        current_layer = 0
        for current_layer in range(len(layer_ids)):
            for src in previous:
                connect(src, layer_ids[current_layer])
            previous = layer_ids[current_layer]

        # Last middle layer forks into the parallel dilemma / climax branch;
        # the dilemma offers two endings, the climax the third.
        for src in previous:
            connect(src, [dilemma_id, climax_id])
        connect(dilemma_id, resolution_ids[0:2])
        connect(climax_id, [resolution_ids[2]])

        if explicit or campaign_theme != DEFAULT_CAMPAIGN_THEME:
            base = _slugify(campaign_theme) if campaign_theme != DEFAULT_CAMPAIGN_THEME else table.key
        else:
            base = "iron_succession" if table.key == "court" else table.key

        return QuestGraph(
            quest_id=f"quest_{base}",
            title=campaign_theme,
            summary=table.summary,
            initial_node_id=hook_id,
            nodes=nodes,
            coverage_note=coverage_note,
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
