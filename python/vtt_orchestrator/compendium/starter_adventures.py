"""Starter adventure modules (GOALS.md Pillar 2).

Out-of-the-box adventures packaged as real ``.vttbundle`` archives through
:class:`~vtt_orchestrator.compendium.bundle_packager.CampaignBundlePackager`.

Design rules for every starter adventure defined here:

* **Monsters are references, never inventions.** Encounters name stat blocks
  that exist in ``compendium/srd_5_2_monsters.json`` by ``monster_id``; AC/HP
  for spawned tokens are copied verbatim from that compendium.
* **Deterministic dungeons.** The crypt layout derives from a fixed integer
  seed. At build time we first ask the authoritative Rust engine's WFC
  (``POST /api/v1/maps/generate``, same seeded contract); if the engine is
  unreachable we fall back to :func:`generate_crypt_layout`, an in-module
  seeded procedural generator using the SAME tile encoding (0 floor, 1 wall,
  2 door, 3 altar, 4 chest). Which generator produced a given bundle is
  recorded in the bundled artifact as ``adventure.layout_source``
  (``"engine_wfc"`` or ``"fallback_procedural"``).
* **Loot is names-only** and drawn from the vtt-wfc themed loot-table
  conventions (see ``crates/vtt-wfc/src/loot_tables.rs``): this adventure
  uses the ``crypt`` theme. No gp values or quantities are rolled here.
  Milestone finds additionally reference REAL SRD 5.2 magic items by
  compendium id (``srd_5_2_magic_items.json``) and are bound to concrete
  containers on the map as loot placements.
* **Encounters are balanced by math, not vibes.** Every combat node ships a
  recomputed DMG XP-threshold verdict (:func:`encounter_balance`) for the
  advertised level-1 party of four; an import-time audit
  (:func:`_finalize_adventure`) rejects any encounter that lands DEADLY or
  fields stat blocks above the level-appropriate CR ceiling. The encounter
  tree runs entry fight -> exploration hazards -> mini-boss, with hazard
  stages materialized as markers on traversable map tiles.
* **Lore seeds extend canon without contradicting it.** Node ids reuse the
  canon graph seeds from
  :func:`~vtt_orchestrator.lore.epistemic_graph.canon_seed_nodes`
  (Baron Aldous Vane stays DECEASED, Oakhaven Keep stays DESTROYED);
  adventure-local nodes carry a namespaced prefix. The same web is shipped as
  Pillar-7 tiered assertions: canon facts at VALIDATED_CANON, table color at
  SUBJECTIVE_RUMOR — every seed passes paradox review before it ships.
"""

import copy
import json
import os
import random
import tempfile
from typing import Any, Dict, List, Optional

from ..routing import engine_client
from .bundle_packager import global_bundle_packager

PROJECT_ROOT = os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
COMPENDIUM_DIR = os.path.join(PROJECT_ROOT, "compendium")
MONSTERS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_monsters.json")

# Tile encoding shared with crates/vtt-wfc DungeonGenerator::generate_room.
TILE_FLOOR = 0
TILE_WALL = 1
TILE_DOOR = 2
TILE_ALTAR = 3
TILE_CHEST = 4

# --- The Sunken Crypt of Karas -------------------------------------------------

KARAS_KEY = "sunken_crypt_of_karas"
KARAS_TITLE = "The Sunken Crypt of Karas"
KARAS_SEED = 20260823  # fixed so every GM gets the identical dungeon
KARAS_WIDTH = 44
KARAS_HEIGHT = 30
KARAS_ROOM_COUNT = 8

# Exploration hazards woven between the fights (see ``encounter_tree``). The
# layout generator materializes each onto a traversable tile of the area that
# follows its anchor encounter, so the board ships the hazard where the tree
# promises it.
KARAS_HAZARD_PLAN = (
    {
        "id": "haz_01_flooded_siphon",
        "name": "Flooded Siphon",
        "after": "enc_01_drowned_nave",
        "kind": "drowning_current",
        "save": "STR",
        "dc": 13,
        "description": (
            "A siphon channel drains the nave; swimming against it pulls "
            "creatures under unless they brace."
        ),
    },
    {
        "id": "haz_02_collapsing_niche",
        "name": "Collapsing Niche",
        "after": "enc_03_ossuary_gallery",
        "kind": "collapsing_ceiling",
        "save": "DEX",
        "dc": 12,
        "description": (
            "Cabal digging has undermined the ossuary shelving; bones and "
            "stone come down on anyone prying at the niches."
        ),
    },
)

# Names mirror the `crypt` theme rows of crates/vtt-wfc/src/loot_tables.rs
# (names only — value bands / weights stay owned by the Rust tables).
CRYPT_LOOT_TABLE_NAMES = (
    "Moldering Coin Purse",
    "Grave Moss Salve",
    "Silvered Ritual Dagger",
    "Vial of Grave-Iron Salt",
    "Signet Ring of House Vane",
    "Bone-Charm of Warding",
    "Crown of the Drowned King",
)

# Real SRD 5.2 magic items (srd_5_2_magic_items.json ids) used as placed loot.
MAGIC_ITEM_IDS = {
    "healing": "item_potions_of_healing",
    "scroll": "item_spell_scroll",
    "bat_cloak": "item_cloak_of_the_bat",
}

# Encounter-balance model: standard DMG XP thresholds for a 4-PC level-1
# party, plus the official encounter multipliers by hostile count. Shipped
# balance numbers are recomputed from these tables at build time, so a stale
# hand-written difficulty label can never ship.
PARTY_LEVEL = 1
PARTY_SIZE = 4
XP_THRESHOLDS = {
    1: {"easy": 50, "medium": 100, "hard": 200, "deadly": 400},
}
DAILY_XP_BUDGET_PER_PC = {1: 300}
_ENCOUNTER_MULTIPLIERS = (
    (1, 0.5), (2, 1.0), (6, 1.5), (10, 2.0), (15, 2.5),
)
CR_CEILING_FOR_PARTY_LEVEL = {1: 3}  # nothing above CR 3 vs level-1 PCs

_MONSTER_CACHE: Optional[Dict[str, Dict[str, Any]]] = None

ITEMS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_magic_items.json")
_ITEM_CACHE: Optional[Dict[str, Dict[str, Any]]] = None


def _load_monster_compendium() -> Dict[str, Dict[str, Any]]:
    """Load srd_5_2_monsters.json keyed by compendium id (cached)."""
    global _MONSTER_CACHE
    if _MONSTER_CACHE is None:
        with open(MONSTERS_FILE, "r", encoding="utf-8") as f:
            entries = json.load(f)
        _MONSTER_CACHE = {m["id"]: m for m in entries}
    return _MONSTER_CACHE


def _load_item_compendium() -> Dict[str, Dict[str, Any]]:
    """Load srd_5_2_magic_items.json keyed by compendium id (cached)."""
    global _ITEM_CACHE
    if _ITEM_CACHE is None:
        with open(ITEMS_FILE, "r", encoding="utf-8") as f:
            entries = json.load(f)
        _ITEM_CACHE = {i["id"]: i for i in entries}
    return _ITEM_CACHE


def _m(monster_id: str, quantity: int, role: str) -> Dict[str, Any]:
    """Reference a REAL compendium stat block by id. Raises KeyError loudly at
    definition time if the id does not exist — invented stats never ship."""
    compendium = _load_monster_compendium()
    entry = compendium[monster_id]
    return {"monster_id": monster_id, "name": entry["name"],
            "quantity": quantity, "role": role}


# --- Encounter balance (standard DMG XP-threshold model) -------------------------

def _encounter_multiplier(hostile_count: int) -> float:
    for bound, multiplier in _ENCOUNTER_MULTIPLIERS:
        if hostile_count <= bound:
            return multiplier
    raise ValueError(f"unsupported hostile count: {hostile_count}")


def encounter_balance(
    monster_refs: List[Dict[str, Any]],
    party_level: int = PARTY_LEVEL,
    party_size: int = PARTY_SIZE,
) -> Dict[str, Any]:
    """Compute the DMG difficulty verdict for one encounter.

    Uses the real ``xp`` field of every referenced stat block, applies the
    official encounter multiplier for the hostile count, and compares the
    adjusted total against the level-appropriate threshold table scaled by
    party size. Shipped numbers are recomputed from this at build time.
    """
    thresholds = {
        band: value * party_size
        for band, value in XP_THRESHOLDS[party_level].items()
    }
    raw_xp = sum(
        int(_load_monster_compendium()[ref["monster_id"]]["xp"]) * int(ref["quantity"])
        for ref in monster_refs
    )
    hostiles = sum(int(ref["quantity"]) for ref in monster_refs)
    adjusted_xp = int(raw_xp * _encounter_multiplier(hostiles))

    if adjusted_xp >= thresholds["deadly"]:
        difficulty = "DEADLY"
    elif adjusted_xp >= thresholds["hard"]:
        difficulty = "HARD"
    elif adjusted_xp >= thresholds["medium"]:
        difficulty = "MEDIUM"
    elif adjusted_xp >= thresholds["easy"]:
        difficulty = "EASY"
    else:
        difficulty = "TRIVIAL"

    max_cr = max(
        float(cr_num := str(_load_monster_compendium()[ref["monster_id"]]
                            ["challenge_rating"]).partition("/")[0])
        / float(str(_load_monster_compendium()[ref["monster_id"]]
                    ["challenge_rating"]).partition("/")[2] or 1)
        for ref in monster_refs
    )
    ceiling = CR_CEILING_FOR_PARTY_LEVEL.get(party_level)
    return {
        "model": "dmg_xp_threshold",
        "party_level": party_level,
        "party_size": party_size,
        "raw_xp": raw_xp,
        "adjusted_xp": adjusted_xp,
        "difficulty": difficulty,
        "within_cr_ceiling": ceiling is None or max_cr <= ceiling,
    }


_ADVENTURES: Dict[str, Dict[str, Any]] = {
    KARAS_KEY: {
        "key": KARAS_KEY,
        "title": KARAS_TITLE,
        "seed": KARAS_SEED,
        "level_range": "1-3",
        "ruleset": "D&D 5e SRD",
        "synopsis": (
            "When the flood tunnels beneath ruined Oakhaven Keep broke open, "
            "they revealed the drowned crypt of House Vane. The Shadow Cabal "
            "has sent diggers after the Sunblade's resting records; the party "
            "must descend before the Cabal claims what Baron Aldous Vane took "
            "to his grave."
        ),
        "content_note": (
            "X-card safe: gothic horror themes only (undead, flooded tombs, "
            "desecrated heraldry). Contains no sexual content, graphic "
            "torture, self-harm, or real-world trauma analogues. Any player "
            "may tap out of a scene with the X-card at any time, no "
            "explanation needed."
        ),
        "encounters": [
            {
                "id": "enc_01_drowned_nave",
                "name": "The Drowned Nave",
                "order": 1,
                "area_hint": "room_1",
                "read_aloud": (
                    "Ankle-deep water mirrors a ceiling of black stone. Votive "
                    "candles burn above the floodline — someone keeps them lit."
                ),
                "monsters": [
                    _m("monster_cultist", 2, "skirmisher"),
                    _m("monster_skeleton", 2, "guard"),
                ],
                "loot": [
                    {"theme": "crypt", "name": "Moldering Coin Purse"},
                    {"theme": "crypt", "name": "Grave Moss Salve"},
                ],
                "tactics": (
                    "Cabal diggers loose the skeletons to hold the choir steps "
                    "while they slip away toward the ossuary."
                ),
            },
            {
                "id": "enc_02_flooded_cloister",
                "name": "Flooded Cloister",
                "order": 2,
                "area_hint": "room_2",
                "read_aloud": (
                    "Waist-high water fills the cloister walk. Something pale "
                    "circles beneath the surface between the columns."
                ),
                "monsters": [
                    _m("monster_shadow", 2, "ambusher"),
                ],
                "loot": [
                    {"theme": "crypt", "name": "Vial of Grave-Iron Salt"},
                ],
                "tactics": (
                    "Shadows strike from the flooded dark and retreat along the "
                    "column shadows; light sources deny them their cover."
                ),
            },
            {
                "id": "enc_03_ossuary_gallery",
                "name": "Ossuary Gallery",
                "order": 3,
                "area_hint": "room_4",
                "read_aloud": (
                    "Shelves of Vane family bones line the gallery. Several "
                    "niches have been dug out from the OTHER side."
                ),
                "monsters": [
                    _m("monster_zombie", 2, "wall-of-bodies"),
                    _m("monster_ghoul", 1, "flanker"),
                ],
                "loot": [
                    {"theme": "crypt", "name": "Silvered Ritual Dagger"},
                ],
                "tactics": (
                    "Zombies bottleneck the corridor while the ghoul circles "
                    "through the collapsed niche behind the party."
                ),
            },
            {
                "id": "enc_04_sunken_scriptorium",
                "name": "Sunken Scriptorium",
                "order": 4,
                "area_hint": "room_6",
                "read_aloud": (
                    "Ink clouds the floodwater where the Cabal's diggers "
                    "ransacked the scriptorium shelves — and one shelf is "
                    "still chewing."
                ),
                "monsters": [
                    _m("monster_mimic", 1, "ambush"),
                    _m("monster_cultist", 2, "diggers"),
                ],
                "loot": [
                    {"theme": "crypt", "name": "Bone-Charm of Warding"},
                ],
                "tactics": (
                    "The mimic poses as a document chest while cultists probe "
                    "the party's flanks for the Sunblade records."
                ),
            },
            {
                "id": "enc_05_vault_of_house_vane",
                "name": "The Vault of House Vane",
                "order": 5,
                "area_hint": "room_8",
                "is_mini_boss": True,
                "read_aloud": (
                    "Beneath a stone effigy of Baron Aldous Vane, the flood "
                    "has polished a sarcophagus lid worn smooth by recent "
                    "prying hands. The Drowned Steward rises."
                ),
                "monsters": [
                    _m("monster_wight", 1, "mini-boss"),
                    _m("monster_skeleton", 1, "honor-guard"),
                ],
                "loot": [
                    {"theme": "crypt", "name": "Signet Ring of House Vane"},
                    {"theme": "crypt", "name": "Crown of the Drowned King"},
                ],
                "tactics": (
                    "The wight (the Drowned Steward raised in Vane's service) "
                    "spends its life drain on whoever holds the signet ring "
                    "while its lone skeleton guard seals the vault door."
                ),
            },
        ],
        # The playable spine: entry fight -> exploration hazards -> mini-boss.
        # Hazard nodes carry no monsters; they gate progression between areas
        # and are materialized onto the map as hazard markers by the layout.
        "encounter_tree": [
            {
                "id": "node_01_entry",
                "kind": "combat",
                "encounter_id": "enc_01_drowned_nave",
                "leads_to": "node_02_hazard_siphon",
                "objective": "Clear the Cabal diggers from the nave.",
            },
            {
                "id": "node_02_hazard_siphon",
                "kind": "hazard",
                "hazard_id": "haz_01_flooded_siphon",
                "leads_to": "node_03_explore",
                "objective": "Brace against the siphon or find the valve.",
            },
            {
                "id": "node_03_explore",
                "kind": "combat",
                "encounter_id": "enc_02_flooded_cloister",
                "leads_to": "node_04_hazard_niche",
                "objective": "Survive the cloister ambush.",
            },
            {
                "id": "node_04_hazard_niche",
                "kind": "hazard",
                "hazard_id": "haz_02_collapsing_niche",
                "leads_to": "node_05_ossuary",
                "objective": "Cross the gallery without bringing it down.",
            },
            {
                "id": "node_05_ossuary",
                "kind": "combat",
                "encounter_id": "enc_03_ossuary_gallery",
                "leads_to": "node_06_scriptorium",
                "objective": "Break the zombie line and cut off the flanking ghoul.",
            },
            {
                "id": "node_06_scriptorium",
                "kind": "combat",
                "encounter_id": "enc_04_sunken_scriptorium",
                "leads_to": "node_07_vault",
                "objective": "Recover the Sunblade records before the mimic eats them.",
            },
            {
                "id": "node_07_vault",
                "kind": "combat",
                "encounter_id": "enc_05_vault_of_house_vane",
                "is_mini_boss": True,
                "leads_to": None,
                "objective": "Lay the Drowned Steward back to rest.",
            },
        ],
        "lore_seeds": {
            "nodes": [
                {"id": "NPC_Baron_Vane", "name": "Baron Aldous Vane",
                 "life_stage": "DECEASED", "type": "Entity"},
                {"id": "Location_Keep", "name": "Oakhaven Keep",
                 "status": "DESTROYED", "type": "Location"},
                {"id": "Faction_Shadow_Cabal", "name": "Shadow Cabal",
                 "hostility": 0.85, "type": "Faction"},
                {"id": "Item_Sunblade", "name": "Sunblade of Pelor",
                 "rarity": "rare", "type": "Entity"},
                {"id": "Location_Sunken_Crypt_of_Karas",
                 "name": "The Sunken Crypt of Karas",
                 "status": "INTACT", "type": "Location"},
                {"id": "NPC_Karas_Drowned_Steward",
                 "name": "The Drowned Steward",
                 "life_stage": "UNDEAD", "type": "Entity"},
            ],
            "edges": [
                {"from": "NPC_Baron_Vane", "rel": "PREVIOUSLY_RULED",
                 "to": "Location_Keep", "weight": 1.0},
                {"from": "Location_Sunken_Crypt_of_Karas", "rel": "BENEATH",
                 "to": "Location_Keep", "weight": 1.0},
                {"from": "NPC_Baron_Vane", "rel": "ENTOMBED_IN",
                 "to": "Location_Sunken_Crypt_of_Karas", "weight": 1.0},
                {"from": "NPC_Karas_Drowned_Steward", "rel": "GUARDS",
                 "to": "Location_Sunken_Crypt_of_Karas", "weight": 1.0},
                {"from": "Faction_Shadow_Cabal", "rel": "SEEKS",
                 "to": "Item_Sunblade", "weight": 0.9},
            ],
        },
        # Pillar-7: the same lore web expressed as tiered assertions that flow
        # through LoreAssertionPayload validation and paradox review. Canon
        # facts ship as VALIDATED_CANON; adventure-specific color enters at
        # SUBJECTIVE_RUMOR so tables can promote or discard it in play.
        "lore_assertions": [
            {
                "proposing_entity_id": "starter_adventure:karas",
                "subject_node_id": "NPC_Baron_Vane",
                "predicate_relation": "ENTOMBED_IN",
                "object_node_id": "Location_Sunken_Crypt_of_Karas",
                "confidence_score": 1.0,
                "epistemic_tier": "VALIDATED_CANON",
                "context_sentence": (
                    "Baron Aldous Vane was laid to rest beneath the crypt "
                    "that now floods under his ruined keep."
                ),
            },
            {
                "proposing_entity_id": "starter_adventure:karas",
                "subject_node_id": "Location_Sunken_Crypt_of_Karas",
                "predicate_relation": "BENEATH",
                "object_node_id": "Location_Keep",
                "confidence_score": 1.0,
                "epistemic_tier": "VALIDATED_CANON",
                "context_sentence": (
                    "The flood tunnels that broke open lead down into the "
                    "drowned crypt below Oakhaven Keep."
                ),
            },
            {
                "proposing_entity_id": "starter_adventure:karas",
                "subject_node_id": "NPC_Karas_Drowned_Steward",
                "predicate_relation": "GUARDS",
                "object_node_id": "Location_Sunken_Crypt_of_Karas",
                "confidence_score": 1.0,
                "epistemic_tier": "VALIDATED_CANON",
                "context_sentence": (
                    "In life the Steward kept the Vane vaults; undeath has "
                    "not ended the watch."
                ),
            },
            {
                "proposing_entity_id": "starter_adventure:karas",
                "subject_node_id": "Faction_Shadow_Cabal",
                "predicate_relation": "SEEKS",
                "object_node_id": "Item_Sunblade",
                "confidence_score": 0.95,
                "epistemic_tier": "VALIDATED_CANON",
                "context_sentence": (
                    "Cabal diggers ransacked the scriptorium hunting the "
                    "Sunblade's resting records."
                ),
            },
            {
                "proposing_entity_id": "starter_adventure:karas",
                "subject_node_id": "NPC_Baron_Vane",
                "predicate_relation": "COMMISSIONED",
                "object_node_id": "Location_Sunken_Crypt_of_Karas",
                "confidence_score": 0.9,
                "epistemic_tier": "PROPOSED_FACT",
                "context_sentence": (
                    "Masons' marks suggest the Baron ordered the crypt cut "
                    "in his own lifetime."
                ),
            },
            {
                "proposing_entity_id": "starter_adventure:karas",
                "subject_node_id": "NPC_Karas_Drowned_Steward",
                "predicate_relation": "SERVED",
                "object_node_id": "NPC_Baron_Vane",
                "confidence_score": 0.85,
                "epistemic_tier": "PROPOSED_FACT",
                "context_sentence": (
                    "A seneschal's signet buried with the steward ties him "
                    "to House Vane's service."
                ),
            },
            {
                "proposing_entity_id": "starter_adventure:karas",
                "subject_node_id": "Faction_Shadow_Cabal",
                "predicate_relation": "DUG_FROM",
                "object_node_id": "Location_Sunken_Crypt_of_Karas",
                "confidence_score": 0.6,
                "epistemic_tier": "SUBJECTIVE_RUMOR",
                "context_sentence": (
                    "Fishermen whisper that the Cabal tunnelled in from the "
                    "sea caves, not from the keep."
                ),
            },
            {
                "proposing_entity_id": "starter_adventure:karas",
                "subject_node_id": "Item_Sunblade",
                "predicate_relation": "HIDDEN_IN",
                "object_node_id": "Location_Sunken_Crypt_of_Karas",
                "confidence_score": 0.5,
                "epistemic_tier": "SUBJECTIVE_RUMOR",
                "context_sentence": (
                    "Tavern talk claims the Sunblade itself lies in the "
                    "vault — though the records only mention its resting place."
                ),
            },
            {
                "proposing_entity_id": "starter_adventure:karas",
                "subject_node_id": "NPC_Karas_Drowned_Steward",
                "predicate_relation": "HOARDS",
                "object_node_id": "Item_Sunblade",
                "confidence_score": 0.4,
                "epistemic_tier": "SUBJECTIVE_RUMOR",
                "context_sentence": (
                    "Some say the Steward clutches a sun-hilted blade in the "
                    "dark of the vault."
                ),
            },
        ],
    },
}


def _finalize_adventure(adventure: Dict[str, Any]) -> None:
    """Attach recomputed balance verdicts and validate the encounter tree.

    Runs at import time: an unbalanced or structurally broken flagship fails
    loudly at build, never at the table.
    """
    hazard_ids = {h["id"] for h in KARAS_HAZARD_PLAN}
    for plan in KARAS_HAZARD_PLAN:
        if plan["after"] not in {e["id"] for e in adventure["encounters"]}:
            raise ValueError(
                f"hazard {plan['id']} anchors on unknown encounter {plan['after']}")

    for enc in adventure["encounters"]:
        balance = encounter_balance(
            enc["monsters"], party_level=PARTY_LEVEL, party_size=PARTY_SIZE)
        enc["balance"] = balance
        if balance["difficulty"] == "DEADLY":
            raise ValueError(
                f"{enc['id']} is DEADLY ({balance['adjusted_xp']} adjusted XP) "
                f"for a level-{PARTY_LEVEL} party of {PARTY_SIZE} — rebalance it")
        if not balance["within_cr_ceiling"]:
            raise ValueError(f"{enc['id']} fields monsters above the CR ceiling")

    node_ids = [n["id"] for n in adventure["encounter_tree"]]
    if len(set(node_ids)) != len(node_ids):
        raise ValueError("encounter tree node ids must be unique")
    for idx, node in enumerate(adventure["encounter_tree"]):
        nxt = node.get("leads_to")
        if idx < len(adventure["encounter_tree"]) - 1 and nxt != \
                adventure["encounter_tree"][idx + 1]["id"]:
            raise ValueError(f"{node['id']} must lead to the next tree node")
        if node["kind"] == "combat" and node["encounter_id"] not in {
                e["id"] for e in adventure["encounters"]}:
            raise ValueError(f"{node['id']} references unknown encounter")
        if node["kind"] == "hazard" and node.get("hazard_id") not in hazard_ids:
            raise ValueError(f"{node['id']} references unknown hazard")

    mini_boss_nodes = [n for n in adventure["encounter_tree"]
                       if n.get("is_mini_boss")]
    if len(mini_boss_nodes) != 1 or mini_boss_nodes[0] is not \
            adventure["encounter_tree"][-1]:
        raise ValueError("the tree must end with exactly one mini-boss node")

    # The tree is what the board consumes, so combat nodes carry their own
    # balance verdict instead of forcing a lookup into the legacy list.
    by_id = {e["id"]: e["balance"] for e in adventure["encounters"]}
    for node in adventure["encounter_tree"]:
        if node["kind"] == "combat":
            node["balance"] = dict(by_id[node["encounter_id"]])


_finalize_adventure(_ADVENTURES[KARAS_KEY])


def list_starter_adventures() -> List[Dict[str, Any]]:
    """Metadata for every available starter bundle."""
    catalog = []
    for key in sorted(_ADVENTURES):
        adv = _ADVENTURES[key]
        tree = adv.get("encounter_tree", [])
        catalog.append({
            "key": key,
            "title": adv["title"],
            "level_range": adv["level_range"],
            "ruleset": adv["ruleset"],
            "seed": adv["seed"],
            "encounter_count": len(adv["encounters"]),
            "encounter_tree_length": len(tree),
            "hazard_count": sum(1 for n in tree if n["kind"] == "hazard"),
            "mini_boss": next(
                (e["name"] for e in adv["encounters"] if e.get("is_mini_boss")),
                None,
            ),
            "balance_summary": {
                "model": "dmg_xp_threshold",
                "party_level": PARTY_LEVEL,
                "party_size": PARTY_SIZE,
                "total_adjusted_xp": sum(
                    enc["balance"]["adjusted_xp"] for enc in adv["encounters"]),
            },
            "monster_ids": sorted({
                ref["monster_id"] for enc in adv["encounters"]
                for ref in enc["monsters"]
            }),
            "loot_theme": "crypt",
            "synopsis": adv["synopsis"],
            "content_note": adv["content_note"],
        })
    return catalog


def get_starter_adventure(key: str = KARAS_KEY) -> Dict[str, Any]:
    """Return a deep copy of the structured adventure definition."""
    if key not in _ADVENTURES:
        raise KeyError(f"Unknown starter adventure: {key}")
    return copy.deepcopy(_ADVENTURES[key])


# Kept as a stable alias for callers/tests that treat the definition as an
# immutable singleton artifact.
def get_starter_adventures_cached() -> Dict[str, Any]:
    return get_starter_adventure(KARAS_KEY)


# --- Deterministic layout --------------------------------------------------------

def _carve_room(grid: List[List[int]], rect) -> None:
    x, y, w, h = rect
    for gy in range(y, y + h):
        for gx in range(x, x + w):
            grid[gy][gx] = TILE_FLOOR


def _inside(rect, gx: int, gy: int) -> bool:
    x, y, w, h = rect
    return x <= gx < x + w and y <= gy < y + h


def _crypt_structure(
    seed: int = KARAS_SEED,
    width: int = KARAS_WIDTH,
    height: int = KARAS_HEIGHT,
) -> Dict[str, Any]:
    """Deterministic structural pass: chambers, corridors, dressing, hazards.

    Same input seed ⇒ byte-identical output using the engine's tile encoding
    (0 floor, 1 wall, 2 door, 3 altar, 4 chest) with a fully sealed perimeter.
    The flagship layout is a full multi-area descent: eight named chambers
    (nave -> cloister -> ossuary wing -> scriptorium -> the Vane vault), an
    explicit entrance tile on the flooded stair, doored corridors between
    areas, a chest per area, altars at shrine and effigy, and the adventure's
    exploration hazards materialized onto traversable tiles.

    Purely in-module; the engine-WFC path reuses this structure and only
    swaps the chamber interiors for authoritative engine tiles.
    """
    rng = random.Random(f"sunken-crypt:{seed}")
    target_rooms = max(KARAS_ROOM_COUNT, 6)

    grid: List[List[int]] = [[TILE_WALL] * width for _ in range(height)]
    occupied: List[tuple] = []  # rects including their 1-tile moat

    def _fits(cand: tuple) -> bool:
        rx, ry, rw, rh = cand
        ex, ey, ew, eh = rx - 2, ry - 2, rw + 4, rh + 4
        return all(
            ex + ew <= r[0] or r[0] + r[2] <= ex or ey + eh <= r[1]
            or r[1] + r[3] <= ey
            for r in occupied
        )

    # Place non-overlapping chambers with a guaranteed walkable ring so
    # corridors can always route between them.
    rooms: List[tuple] = []
    for _ in range(8000):
        if len(rooms) >= target_rooms:
            break
        rw = rng.randint(4, 7)
        rh = rng.randint(4, 7)
        rx = rng.randint(2, max(2, width - rw - 2))
        ry = rng.randint(2, max(2, height - rh - 2))
        cand = (rx, ry, rw, rh)
        if _fits(cand):
            occupied.append((rx - 1, ry - 1, rw + 2, rh + 2))
            rooms.append(cand)
            _carve_room(grid, cand)

    # Chain every chamber into the growing network so no area is orphaned.
    def connect(a: tuple, b: tuple) -> tuple:
        ax, ay = a[0] + a[2] // 2, a[1] + a[3] // 2
        bx, by = b[0] + b[2] // 2, b[1] + b[3] // 2
        path: List[tuple] = []
        if rng.random() < 0.5:  # horizontal-first vs vertical-first L
            path += [(gx, ay) for gx in range(ax, bx, 1 if bx >= ax else -1)]
            path += [(bx, gy) for gy in range(ay, by, 1 if by >= ay else -1)]
        else:
            path += [(ax, gy) for gy in range(ay, by, 1 if by >= ay else -1)]
            path += [(gx, by) for gx in range(ax, bx, 1 if bx >= ax else -1)]
        path.append((bx, by))

        door_spots = {
            idx for idx, (gx, gy) in enumerate(path)
            if not _inside(a, gx, gy) and not _inside(b, gx, gy)
        }
        first_outside_a = next(
            (i for i, (gx, gy) in enumerate(path) if not _inside(a, gx, gy)), None)
        last_outside_b = next(
            (i for i in range(len(path) - 1, -1, -1) if not _inside(b, *path[i])),
            None)
        carved = []
        for idx, (gx, gy) in enumerate(path):
            if idx in (first_outside_a, last_outside_b) and idx in door_spots:
                grid[gy][gx] = TILE_DOOR
            elif grid[gy][gx] == TILE_WALL:
                grid[gy][gx] = TILE_FLOOR
            carved.append((gx, gy))
        return carved

    connected: List[tuple] = [rooms[0]]
    unconnected: List[tuple] = rooms[1:]
    corridors: List[List[tuple]] = []

    def _dist(a: tuple, b: tuple) -> int:
        ax, ay = a[0] + a[2] // 2, a[1] + a[3] // 2
        bx, by = b[0] + b[2] // 2, b[1] + b[3] // 2
        return abs(ax - bx) + abs(ay - by)

    while unconnected:
        pair = min(
            ((a, b) for a in connected for b in unconnected),
            key=lambda p: _dist(*p),
        )
        corridors.append(connect(*pair))
        connected.append(pair[1])
        unconnected.remove(pair[1])

    # A couple of extra loops make the descent feel like a real warren rather
    # than a chain of airlocks.
    extra_budget = 2
    for a, b in random.Random(f"loops:{seed}").sample(
        [(rooms[i], rooms[j])
         for i in range(len(rooms)) for j in range(i + 2, len(rooms))],
        min(extra_budget, max(0, len(rooms) * (len(rooms) - 1) // 2)),
    ):
        if _dist(a, b) <= max(width, height) // 2:
            corridors.append(connect(a, b))

    # Entrance: the flooded stair lands just outside the first chamber's wall
    # and is tunnelled straight into it.
    ex, ey, ew, eh = rooms[0]
    if ey > 1:
        entrance = (ex + ew // 2, ey - 1)
    else:
        entrance = (ex + ew // 2, ey + eh)
    if grid[entrance[1]][entrance[0]] == TILE_WALL:
        grid[entrance[1]][entrance[0]] = TILE_FLOOR

    # Chamber identity follows the encounter tree's descent order: nearest to
    # the entrance first, vault (altar + hoard) farthest away.
    order = sorted(range(len(rooms)), key=lambda i: (
        abs((rooms[i][0] + rooms[i][2] // 2) - entrance[0])
        + abs((rooms[i][1] + rooms[i][3] // 2) - entrance[1]),
        i,
    ))
    ordered = [rooms[i] for i in order]

    chamber_names = [
        "The Drowned Nave", "Flooded Cloister", "Choir Landing",
        "Ossuary Gallery", "Bone Workshop", "Sunken Scriptorium",
        "Steward's Watch", "The Vault of House Vane",
    ]
    purposes = [
        "entry_fight", "ambush", "waystation", "exploration_hazard",
        "hazard_workshop", "exploration", "guard_post", "mini_boss",
    ]
    room_meta: List[Dict[str, Any]] = []
    hazard_by_area: Dict[int, Dict[str, Any]] = {}
    hazard_plan = {h["after"]: h for h in KARAS_HAZARD_PLAN}

    # Hazards sit on the floor of the area AFTER their anchor encounter, so
    # the map matches the tree's progression promises exactly.
    anchor_order = [e["id"] for e in _ADVENTURES[KARAS_KEY]["encounters"]]
    for plan_idx, enc_id in enumerate(anchor_order[:-1]):
        plan = hazard_plan.get(enc_id)
        if plan is None:
            continue
        target_index = min(plan_idx + 1, len(ordered) - 1)
        hazard_by_area[target_index] = dict(plan)

    # Encounters map onto areas in descent order; the mini-boss always owns
    # the farthest chamber (the Vane vault). Intermediate chambers past the
    # scripted fights stay unclaimed exploration space.
    encounter_ids = [e["id"] for e in _ADVENTURES[KARAS_KEY]["encounters"]]
    area_to_encounter: Dict[int, str] = {}
    for i, enc_id in enumerate(encounter_ids[:-1]):
        if i < len(ordered) - 1:
            area_to_encounter[i] = enc_id
    area_to_encounter[len(ordered) - 1] = encounter_ids[-1]

    dressing_rng = random.Random(f"dressing:{seed}")
    for i, rect in enumerate(ordered):
        x, y, w, h = rect
        is_vault = i == len(ordered) - 1
        if is_vault or i == 0:
            cx, cy = x + w // 2, y + h // 2
            grid[cy][cx] = TILE_ALTAR
        # One lootable container per area (the vault hoards a chest beside
        # its effigy altar).
        for _ in range(16):
            cx = dressing_rng.randint(x, x + w - 1)
            cy = dressing_rng.randint(y, y + h - 1)
            if grid[cy][cx] == TILE_FLOOR:
                grid[cy][cx] = TILE_CHEST
                break
        meta: Dict[str, Any] = {
            "id": f"room_{i + 1}",
            "name": chamber_names[i] if i < len(chamber_names) else f"Chamber {i + 1}",
            "purpose": purposes[i] if i < len(purposes) else "exploration",
            "encounter_id": area_to_encounter.get(i),
            "rect": list(rect),
        }
        hazard = hazard_by_area.get(i)
        if hazard:
            hx = hy = None
            for _ in range(24):
                hx = dressing_rng.randint(x, x + w - 1)
                hy = dressing_rng.randint(y, y + h - 1)
                if grid[hy][hx] in (TILE_FLOOR, TILE_DOOR, TILE_CHEST):
                    break
            if hx is not None:
                meta["hazard_id"] = hazard["id"]
                hazard_by_area[i]["x"] = hx
                hazard_by_area[i]["y"] = hy
        room_meta.append(meta)

    hazards = [dict(h) for h in hazard_by_area.values() if "x" in h]

    return {
        "seed": seed,
        "width": width,
        "height": height,
        "tiles": grid,
        "entrance": {"x": entrance[0], "y": entrance[1]},
        "hazards": hazards,
        "rooms": room_meta,
        "corridors": [[list(p) for p in c] for c in corridors],
        "generator": "starter_adventures._crypt_structure",
    }


def _finalize_layout(structure: Dict[str, Any], source: str) -> Dict[str, Any]:
    """Derive walls/doors from the final tile grid and stamp provenance."""
    grid = structure["tiles"]
    height, width = len(grid), len(grid[0])
    return dict(
        structure,
        source=source,
        walls=[
            {"x": gx, "y": gy}
            for gy in range(height)
            for gx in range(width)
            if grid[gy][gx] == TILE_WALL
        ],
        doors=[
            {"x": gx, "y": gy}
            for gy in range(height)
            for gx in range(width)
            if grid[gy][gx] == TILE_DOOR
        ],
    )


def generate_crypt_layout(
    seed: int = KARAS_SEED,
    width: int = KARAS_WIDTH,
    height: int = KARAS_HEIGHT,
) -> Dict[str, Any]:
    """Seeded procedural fallback dungeon (deterministic, engine-independent)."""
    return _finalize_layout(_crypt_structure(seed, width, height),
                            source="fallback_procedural")


def _engine_wfc_chamber(seed: int, room_index: int, width: int,
                        height: int) -> Optional[List[List[int]]]:
    """Ask the authoritative engine's WFC for ONE chamber's tiles.

    Returns None (never raises) when the engine is unreachable/rejects so the
    documented fallback keeps that chamber's procedural interior.
    """
    try:
        resp = engine_client.engine_request_sync(
            "POST",
            "/api/v1/maps/generate",
            {
                "room_desc": {
                    "room_id": room_index + 1,
                    "x": 0,
                    "y": 0,
                    "width": width,
                    "height": height,
                    "theme": "dungeon",
                },
                "seed": seed + room_index,
            },
        )
        tiles = resp.get("tiles")
        if not isinstance(tiles, list) or len(tiles) != height:
            return None
        if any(not isinstance(row, list) or len(row) != width for row in tiles):
            return None
        if any(
            not isinstance(t, int) or not 0 <= t <= TILE_CHEST
            for row in tiles for t in row
        ):
            return None
        return tiles
    except Exception:
        return None


def _composite_is_connected(structure: Dict[str, Any]) -> bool:
    """Every chamber center must be reachable from the entrance over non-wall
    tiles. Guards the engine-stitched composite against sealed chambers."""
    grid = structure["tiles"]
    height, width = len(grid), len(grid[0])
    start = (structure["entrance"]["x"], structure["entrance"]["y"])
    seen = {start}
    frontier = [start]
    while frontier:
        x, y = frontier.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if (0 <= nx < width and 0 <= ny < height and (nx, ny) not in seen
                    and grid[ny][nx] != TILE_WALL):
                seen.add((nx, ny))
                frontier.append((nx, ny))

    def center(rect):
        rx, ry, rw, rh = rect
        return (rx + rw // 2, ry + rh // 2)

    return all(center(room["rect"]) in seen for room in structure["rooms"])


def _try_engine_chambers(structure: Dict[str, Any], seed: int) -> Optional[Dict[str, Any]]:
    """Swap every chamber's interior for engine-WFC tiles, keeping this
    module's corridors/dressing/hazards as the connective tissue. All-or-
    nothing: any rejected chamber (or a connectivity regression after
    stitching) falls back to the fully procedural layout so provenance stays
    honest."""
    stitched = copy.deepcopy(structure)
    grid = stitched["tiles"]
    for index, room in enumerate(stitched["rooms"]):
        rx, ry, rw, rh = room["rect"]
        chamber = _engine_wfc_chamber(seed, index, rw, rh)
        if chamber is None:
            return None
        for ly, row in enumerate(chamber):
            for lx, tile in enumerate(row):
                # Keep structural dressing (doors on the chamber boundary are
                # outside the rect; chests/altars inside may be re-rolled).
                grid[ry + ly][rx + lx] = tile

    # Re-seat hazards and guarantee one lootable container per chamber on the
    # engine tiles (the procedural dressing may have been re-rolled away).
    for index, room in enumerate(stitched["rooms"]):
        rx, ry, rw, rh = room["rect"]
        walkable_cells = [
            (rx + lx, ry + ly)
            for ly in range(rh) for lx in range(rw)
            if grid[ry + ly][rx + lx] != TILE_WALL
        ]
        if not walkable_cells:
            return None

        if not any(grid[y][x] in (TILE_CHEST, TILE_ALTAR)
                   for x, y in walkable_cells):
            gx, gy = walkable_cells[0]
            grid[gy][gx] = TILE_CHEST

    for hazard in stitched["hazards"]:
        hx, hy = hazard.get("x"), hazard.get("y")
        if hx is None or grid[hy][hx] == TILE_WALL:
            room = next((r for r in stitched["rooms"]
                         if r.get("hazard_id") == hazard["id"]), None)
            if room is None:
                return None
            rx, ry, rw, rh = room["rect"]
            spot = next(
                ((rx + lx, ry + ly) for ly in range(rh) for lx in range(rw)
                 if grid[ry + ly][rx + lx] != TILE_WALL),
                None,
            )
            if spot is None:
                return None
            hazard["x"], hazard["y"] = spot

    # Re-carve the known corridor spines through the engine tiles: the
    # connective tissue is this module's contract, engine tiles own the rest.
    for corridor in stitched["corridors"]:
        for gx, gy in corridor:
            if grid[gy][gx] == TILE_WALL:
                grid[gy][gx] = TILE_FLOOR

    # Open apertures wherever the corridor network meets a chamber whose
    # engine-tiled boundary came back solid, otherwise the stitch seals it.
    height, width = len(grid), len(grid[0])
    for room in stitched["rooms"]:
        rx, ry, rw, rh = room["rect"]
        for lx in range(rw):
            for ly in range(rh):
                if not (lx in (0, rw - 1) or ly in (0, rh - 1)):
                    continue  # interior cells keep the engine's verdict
                gx, gy = rx + lx, ry + ly
                if grid[gy][gx] != TILE_WALL:
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = gx + dx, gy + dy
                    if rx <= nx < rx + rw and ry <= ny < ry + rh:
                        continue  # only corridor-side neighbours open a wall
                    if (0 <= nx < width and 0 <= ny < height
                            and grid[ny][nx] in (TILE_FLOOR, TILE_DOOR)):
                        grid[gy][gx] = TILE_FLOOR
                        break

    if not _composite_is_connected(stitched):
        return None
    stitched["generator"] = (
        "vtt-wfc DungeonGenerator chambers + starter_adventures corridors "
        "(via /api/v1/maps/generate)")
    return stitched


def resolve_crypt_layout(seed: int = KARAS_SEED, prefer_engine: bool = True) -> Dict[str, Any]:
    """Engine WFC first, documented seeded fallback second. Provenance is part
    of the returned layout and is mirrored into the bundled artifact."""
    structure = _crypt_structure(seed, KARAS_WIDTH, KARAS_HEIGHT)
    if prefer_engine:
        stitched = _try_engine_chambers(structure, seed)
        if stitched is not None:
            return _finalize_layout(stitched, source="engine_wfc")
    return _finalize_layout(structure, source="fallback_procedural")


# --- Bundle assembly ---------------------------------------------------------------

def _spawn_tokens(adventure: Dict[str, Any], layout: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Turn encounter monster references into canvas tokens using REAL stat
    block numbers (AC/HP/XP/CR straight from the compendium) placed on
    walkable tiles of the encounter's own area."""
    compendium = _load_monster_compendium()
    rng = random.Random(f"tokens:{adventure['seed']}")
    grid = layout["tiles"]
    height = layout.get("height", len(grid))
    width = layout.get("width", len(grid[0]) if grid else 0)
    rooms = layout.get("rooms") or []

    def _walkable(tx: int, ty: int) -> bool:
        return 0 <= tx < width and 0 <= ty < height and grid[ty][tx] != TILE_WALL

    def _room_for(encounter_id: str) -> Optional[Dict[str, Any]]:
        claimed = [r for r in rooms if r.get("encounter_id") == encounter_id]
        if claimed:
            return claimed[0]
        return None

    taken: set = set()

    def spot_for(encounter: Dict[str, Any]) -> tuple:
        """Deterministic placement inside the encounter's area on a tile the
        party can actually reach (never a wall, never double-booked)."""
        room = _room_for(encounter["id"])
        candidates = None
        if room is not None:
            x, y, w, h = room["rect"]
            candidates = [
                (gx, gy)
                for gy in range(y, y + h)
                for gx in range(x, x + w)
                if _walkable(gx, gy) and (gx, gy) not in taken
            ]
        if not candidates:
            candidates = [
                (gx, gy)
                for gy in range(height)
                for gx in range(width)
                if _walkable(gx, gy) and (gx, gy) not in taken
            ]
        pick = rng.choice(candidates)
        taken.add(pick)
        return pick

    tokens: List[Dict[str, Any]] = []
    for enc_index, encounter in enumerate(adventure["encounters"]):
        for ref in encounter["monsters"]:
            entry = compendium[ref["monster_id"]]
            hp = int(entry.get("hp", 10))
            dex_mod = (int(entry.get("abilities", {}).get("DEX", 10)) - 10) // 2
            for n in range(int(ref["quantity"])):
                tx, ty = spot_for(encounter)
                tokens.append({
                    "id": f"tok_{encounter['id']}_{ref['monster_id']}_{n}",
                    "name": (
                        entry["name"] if ref["quantity"] == 1
                        else f"{entry['name']} {chr(ord('A') + n)}"
                    ),
                    "compendium_id": ref["monster_id"],
                    "encounter_id": encounter["id"],
                    "role": ref["role"],
                    "area_id": next(
                        (r["id"] for r in rooms
                         if r.get("encounter_id") == encounter["id"]), None),
                    "x": tx,
                    "y": ty,
                    "hp": hp,
                    "max_hp": hp,
                    "ac": int(entry.get("ac", 10)),
                    "xp": int(entry.get("xp", 0)),
                    "challenge_rating": entry.get("challenge_rating"),
                    "initiative_bonus": dex_mod,
                    "color": "#dc2626" if ref["role"] in ("boss", "mini-boss")
                    else "#94a3b8",
                    "is_player": False,
                })
    return tokens


# --- Loot placement ---------------------------------------------------------------

def _room_containing(layout: Dict[str, Any], x: int, y: int) -> Optional[Dict[str, Any]]:
    for room in layout.get("rooms", []):
        rx, ry, rw, rh = room["rect"]
        if rx <= x < rx + rw and ry <= y < ry + rh:
            return room
    return None


def loot_placements(layout: Dict[str, Any], adventure: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Bind loot to concrete containers on the map.

    Themed crypt-table names stay value-free (the Rust tables still own the
    rolls); real SRD 5.2 magic items are referenced by compendium id so an
    invented item id fails loudly here rather than silently in play.
    """
    item_compendium = _load_item_compendium()
    for role, item_id in MAGIC_ITEM_IDS.items():
        if item_id not in item_compendium:
            raise KeyError(
                f"Magic item {role}={item_id!r} is not in srd_5_2_magic_items.json")

    grid = layout["tiles"]
    containers: List[Dict[str, Any]] = []
    for gy, row in enumerate(grid):
        for gx, tile in enumerate(row):
            if tile in (TILE_CHEST, TILE_ALTAR):
                room = _room_containing(layout, gx, gy)
                containers.append({
                    "area_id": room["id"] if room else None,
                    "is_vault": bool(room and room.get("purpose") == "mini_boss"),
                    "tile_x": gx,
                    "tile_y": gy,
                    "kind": "chest" if tile == TILE_CHEST else "altar",
                })
    if not containers:
        return []

    vault = next((c for c in containers if c["is_vault"]), containers[-1])
    regular = [c for c in containers if c is not vault]

    # Deterministic spread: themed encounter loot fills the route chests in
    # descent order; magic items anchor the milestone finds.
    themed = [dict(item) for enc in adventure["encounters"] for item in enc["loot"]]
    buckets: Dict[int, List[Dict[str, Any]]] = {}
    for idx, item in enumerate(themed):
        target = regular[idx % len(regular)] if regular else vault
        buckets.setdefault(id(target), []).append(item)

    magic_route = [
        (regular[0] if regular else vault, {"name": "Potions of Healing",
                                            "item_id": MAGIC_ITEM_IDS["healing"]}),
        (regular[len(regular) // 2] if regular else vault,
         {"name": "Spell Scroll", "item_id": MAGIC_ITEM_IDS["scroll"]}),
        (vault, {"name": "Cloak of the Bat", "item_id": MAGIC_ITEM_IDS["bat_cloak"]}),
    ]
    for container, item in magic_route:
        buckets.setdefault(id(container), []).append(item)

    placements: List[Dict[str, Any]] = []
    for container in [*regular, vault]:
        items = buckets.pop(id(container), [])
        if not items:
            continue
        placements.append({
            "id": f'loot_{container["tile_x"]}_{container["tile_y"]}',
            "container": (
                "boss_hoard" if container is vault else container["kind"]
            ),
            "area_id": container["area_id"],
            "x": container["tile_x"],
            "y": container["tile_y"],
            "items": items,
        })
    return placements


def starter_campaign_data(key: str = KARAS_KEY, prefer_engine: bool = True) -> Dict[str, Any]:
    """Assemble full packager-ready campaign payload for a starter adventure."""
    adventure = get_starter_adventure(key)
    layout = resolve_crypt_layout(adventure["seed"], prefer_engine=prefer_engine)
    adventure["layout_source"] = layout["source"]

    loot_tables = {
        "conventions": {
            "note": "Names only; values/quantities roll server-side from vtt-wfc themed tables.",
            "themes": {"crypt": list(CRYPT_LOOT_TABLE_NAMES)},
        },
        "by_encounter": {
            enc["id"]: [dict(l) for l in enc["loot"]]
            for enc in adventure["encounters"]
        },
        "placements": loot_placements(layout, adventure),
    }

    combat_nodes = [n for n in adventure["encounter_tree"] if n["kind"] == "combat"]
    return {
        "title": adventure["title"],
        "author": "AetherTable Starter Adventures",
        "ruleset": adventure["ruleset"],
        "grid_dimensions": {"width": layout["width"], "height": layout["height"]},
        "walls": layout["walls"],
        "tokens": _spawn_tokens(adventure, layout),
        "dynasties": {"houses": [{"id": "house_vane", "name": "House Vane"}]},
        "lore_graph": {
            "nodes": adventure["lore_seeds"]["nodes"],
            "edges": adventure["lore_seeds"]["edges"],
        },
        "loot_tables": loot_tables,
        # Full artifact: definition + layout detail (tiles/doors/hazards/
        # corridors/entrance) + documented generator provenance, persisted as
        # adventure.json.
        "adventure": dict(adventure, layout={
            k: layout[k] for k in (
                "tiles", "doors", "hazards", "corridors", "rooms",
                "entrance", "generator", "seed", "source",
            )
            if k in layout
        }, balance_summary={
            "model": "dmg_xp_threshold",
            "party_level": PARTY_LEVEL,
            "party_size": PARTY_SIZE,
            "total_adjusted_xp": sum(
                enc["balance"]["adjusted_xp"]
                for enc in adventure["encounters"]
            ),
            "difficulty_ceiling": max(
                (enc["balance"]["difficulty"] for enc in adventure["encounters"]),
                key=lambda d: ("TRIVIAL", "EASY", "MEDIUM", "HARD", "DEADLY").index(d),
            ),
            "combat_node_count": len(combat_nodes),
        }),
    }


def build_starter_bundle_bytes(key: str = KARAS_KEY, prefer_engine: bool = True) -> bytes:
    """Build the .vttbundle archive in memory."""
    return global_bundle_packager.export_bundle(starter_campaign_data(key, prefer_engine))


def build_starter_bundle(
    key: str = KARAS_KEY,
    output_dir: Optional[str] = None,
    prefer_engine: bool = True,
) -> str:
    """Build a starter adventure .vttbundle on disk and return its path.

    Defaults to a per-user temp directory so tests/builds never dirty the repo;
    pass ``output_dir`` to place bundles somewhere durable.
    """
    directory = output_dir or os.path.join(tempfile.gettempdir(), "aethertable_starter_bundles")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"{key}.vttbundle")
    with open(path, "wb") as f:
        f.write(build_starter_bundle_bytes(key, prefer_engine=prefer_engine))
    return path
