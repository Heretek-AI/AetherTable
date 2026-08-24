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
* **Lore seeds extend canon without contradicting it.** Node ids reuse the
  canon graph seeds from
  :func:`~vtt_orchestrator.lore.epistemic_graph.canon_seed_nodes`
  (Baron Aldous Vane stays DECEASED, Oakhaven Keep stays DESTROYED);
  adventure-local nodes carry a namespaced prefix.
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
KARAS_WIDTH = 32
KARAS_HEIGHT = 22

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

_MONSTER_CACHE: Optional[Dict[str, Dict[str, Any]]] = None


def _load_monster_compendium() -> Dict[str, Dict[str, Any]]:
    """Load srd_5_2_monsters.json keyed by compendium id (cached)."""
    global _MONSTER_CACHE
    if _MONSTER_CACHE is None:
        with open(MONSTERS_FILE, "r", encoding="utf-8") as f:
            entries = json.load(f)
        _MONSTER_CACHE = {m["id"]: m for m in entries}
    return _MONSTER_CACHE


def _m(monster_id: str, quantity: int, role: str) -> Dict[str, Any]:
    """Reference a REAL compendium stat block by id. Raises KeyError loudly at
    definition time if the id does not exist — invented stats never ship."""
    compendium = _load_monster_compendium()
    entry = compendium[monster_id]
    return {"monster_id": monster_id, "name": entry["name"],
            "quantity": quantity, "role": role}


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
                    _m("monster_swarm_of_crawling_claws", 1, "hazard-skirmisher"),
                    _m("monster_skeleton", 3, "guard"),
                ],
                "loot": [
                    {"theme": "crypt", "name": "Moldering Coin Purse"},
                    {"theme": "crypt", "name": "Grave Moss Salve"},
                ],
                "tactics": (
                    "The claws drag a front-rank PC under the waterline while "
                    "skeletons hold the choir steps."
                ),
            },
            {
                "id": "enc_02_ossuary_gallery",
                "name": "Ossuary Gallery",
                "order": 2,
                "area_hint": "room_3",
                "read_aloud": (
                    "Shelves of Vane family bones line the gallery. Several "
                    "niches have been dug out from the OTHER side."
                ),
                "monsters": [
                    _m("monster_zombie", 4, "wall-of-bodies"),
                    _m("monster_ghoul", 2, "flanker"),
                ],
                "loot": [
                    {"theme": "crypt", "name": "Vial of Grave-Iron Salt"},
                    {"theme": "crypt", "name": "Silvered Ritual Dagger"},
                ],
                "tactics": (
                    "Zombies bottleneck the corridor while ghouls circle "
                    "through the collapsed niche behind the party."
                ),
            },
            {
                "id": "enc_03_vault_of_house_vane",
                "name": "The Vault of House Vane",
                "order": 3,
                "area_hint": "room_5",
                "read_aloud": (
                    "Beneath a stone effigy of Baron Aldous Vane, the flood "
                    "has polished a sarcophagus lid worn smooth by recent "
                    "prying hands."
                ),
                "monsters": [
                    _m("monster_wight", 1, "boss"),
                    _m("monster_specter", 2, "escort"),
                ],
                "loot": [
                    {"theme": "crypt", "name": "Signet Ring of House Vane"},
                    {"theme": "crypt", "name": "Bone-Charm of Warding"},
                    {"theme": "crypt", "name": "Crown of the Drowned King"},
                ],
                "tactics": (
                    "The wight (the Drowned Steward raised in Vane's service) "
                    "spends its life drain on whoever holds the signet ring; "
                    "specters harry ranged attackers."
                ),
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
    },
}


def list_starter_adventures() -> List[Dict[str, Any]]:
    """Metadata for every available starter bundle."""
    catalog = []
    for key in sorted(_ADVENTURES):
        adv = _ADVENTURES[key]
        catalog.append({
            "key": key,
            "title": adv["title"],
            "level_range": adv["level_range"],
            "ruleset": adv["ruleset"],
            "seed": adv["seed"],
            "encounter_count": len(adv["encounters"]),
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


def generate_crypt_layout(
    seed: int = KARAS_SEED,
    width: int = KARAS_WIDTH,
    height: int = KARAS_HEIGHT,
) -> Dict[str, Any]:
    """Seeded procedural fallback dungeon generator (deterministic).

    Same input seed ⇒ byte-identical output. Emits the engine's tile encoding
    (0 floor, 1 wall, 2 door, 3 altar, 4 chest) with a fully sealed perimeter
    and a single connected region (rooms chained by L-corridors), matching the
    walkability guarantees of crates/vtt-wfc.
    """
    rng = random.Random(f"sunken-crypt:{seed}")

    grid: List[List[int]] = [[TILE_WALL] * width for _ in range(height)]

    # Place five non-overlapping chambers (retry budget keeps determinism).
    target_rooms = 5
    rooms: List[tuple] = []
    for _ in range(2000):
        if len(rooms) >= target_rooms:
            break
        rw = rng.randint(5, 9)
        rh = rng.randint(4, 7)
        rx = rng.randint(2, width - rw - 2)
        ry = rng.randint(2, height - rh - 2)
        cand = (rx, ry, rw, rh)
        expanded = (rx - 2, ry - 2, rw + 4, rh + 4)
        if any(
            not (expanded[0] + expanded[2] <= r[0] or r[0] + r[2] <= expanded[0]
                 or expanded[1] + expanded[3] <= r[1] or r[1] + r[3] <= expanded[1])
            for r in rooms
        ):
            continue
        rooms.append(cand)
        _carve_room(grid, cand)

    # Chain rooms with L-corridors; door the entry/exit cells.
    def connect(a: tuple, b: tuple) -> None:
        ax, ay = a[0] + a[2] // 2, a[1] + a[3] // 2
        bx, by = b[0] + b[2] // 2, b[1] + b[3] // 2
        path = []
        if rng.random() < 0.5:  # horizontal-first vs vertical-first
            xs = range(ax, bx, 1 if bx >= ax else -1)
            path += [(gx, ay) for gx in xs]
            ys = range(ay, by, 1 if by >= ay else -1)
            path += [(bx, gy) for gy in ys]
        else:
            ys = range(ay, by, 1 if by >= ay else -1)
            path += [(ax, gy) for gy in ys]
            xs = range(ax, bx, 1 if bx >= ax else -1)
            path += [(gx, by) for gx in xs]
        path.append((bx, by))

        door_spots = []
        for idx, (gx, gy) in enumerate(path):
            if not _inside(a, gx, gy) and not _inside(b, gx, gy):
                door_spots.append(idx)
        first_outside_a = next(
            (i for i, (gx, gy) in enumerate(path) if not _inside(a, gx, gy)), None
        )
        last_outside_b = next(
            (i for i in range(len(path) - 1, -1, -1)
             if not _inside(b, *path[i])), None
        )
        for idx, (gx, gy) in enumerate(path):
            if idx in (first_outside_a, last_outside_b) and idx in door_spots:
                grid[gy][gx] = TILE_DOOR
            elif grid[gy][gx] == TILE_WALL:
                grid[gy][gx] = TILE_FLOOR

    for i in range(len(rooms) - 1):
        connect(rooms[i], rooms[i + 1])

    # Dressing: chest in every chamber but the boss vault; altar in the first
    # (desecrated shrine) and last (Vane's effigy) chambers.
    dressing_rng = random.Random(f"dressing:{seed}")
    room_meta = []
    chamber_names = [
        "The Drowned Nave", "Flooded Cloister", "Ossuary Gallery",
        "Sunken Scriptorium", "The Vault of House Vane",
    ]
    for i, rect in enumerate(rooms):
        x, y, w, h = rect
        if i == len(rooms) - 1:
            grid[y + h // 2][x + w // 2] = TILE_ALTAR
        elif i == 0:
            cx, cy = x + w // 2, y + h // 2
            if grid[cy][cx] == TILE_FLOOR:
                grid[cy][cx] = TILE_ALTAR
        if i != len(rooms) - 1:
            for _ in range(8):
                cx, cy = rng.randint(x, x + w - 1), rng.randint(y, y + h - 1)
                if grid[cy][cx] == TILE_FLOOR:
                    grid[cy][cx] = TILE_CHEST
                    break
        room_meta.append({
            "id": i + 1,
            "name": chamber_names[i] if i < len(chamber_names) else f"Chamber {i + 1}",
            "rect": list(rect),
        })

    walls = [
        {"x": gx, "y": gy}
        for gy in range(height)
        for gx in range(width)
        if grid[gy][gx] == TILE_WALL
    ]

    return {
        "seed": seed,
        "width": width,
        "height": height,
        "tiles": grid,
        "walls": walls,
        "doors": [
            {"x": gx, "y": gy}
            for gy in range(height)
            for gx in range(width)
            if grid[gy][gx] == TILE_DOOR
        ],
        "rooms": room_meta,
        "generator": "starter_adventures.generate_crypt_layout",
        "source": "fallback_procedural",
    }


def _engine_wfc_layout(seed: int, width: int, height: int) -> Optional[Dict[str, Any]]:
    """Ask the authoritative engine's WFC for the crypt layout.

    Returns None (never raises) when the engine is unreachable/rejects so the
    documented fallback takes over.
    """
    try:
        resp = engine_client.engine_request_sync(
            "POST",
            "/api/v1/maps/generate",
            {
                "room_desc": {
                    "room_id": 1,
                    "x": 0,
                    "y": 0,
                    "width": width,
                    "height": height,
                    "theme": "dungeon",
                },
                "seed": seed,
            },
        )
        tiles = resp.get("tiles")
        if not isinstance(tiles, list) or len(tiles) != height:
            return None
        if any(not isinstance(row, list) or len(row) != width for row in tiles):
            return None
        return {
            "seed": seed,
            "width": width,
            "height": height,
            "tiles": tiles,
            "walls": [
                {"x": gx, "y": gy}
                for gy, row in enumerate(tiles)
                for gx, t in enumerate(row)
                if t == TILE_WALL
            ],
            "rooms": [],
            "generator": "vtt-wfc DungeonGenerator (via /api/v1/maps/generate)",
            "source": "engine_wfc",
        }
    except Exception:
        return None


def resolve_crypt_layout(seed: int = KARAS_SEED, prefer_engine: bool = True) -> Dict[str, Any]:
    """Engine WFC first, documented seeded fallback second. Provenance is part
    of the returned layout and is mirrored into the bundled artifact."""
    if prefer_engine:
        engine_layout = _engine_wfc_layout(seed, KARAS_WIDTH, KARAS_HEIGHT)
        if engine_layout is not None:
            return engine_layout
    return generate_crypt_layout(seed)


# --- Bundle assembly ---------------------------------------------------------------

def _spawn_tokens(adventure: Dict[str, Any], layout: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Turn encounter monster references into canvas tokens using REAL stat
    block numbers (AC/HP straight from the compendium) at deterministic spots."""
    compendium = _load_monster_compendium()
    rng = random.Random(f"tokens:{adventure['seed']}")
    rooms = layout.get("rooms") or []

    def spot_for(encounter_index: int) -> tuple:
        """Deterministic placement: encounter N fights in chamber N (boss in
        the last chamber); anywhere walkable-ish if no room metadata exists."""
        if rooms:
            if encounter_index == len(adventure["encounters"]) - 1:
                room = rooms[-1]
            else:
                room = rooms[min(encounter_index, len(rooms) - 1)]
            x, y, w, h = room["rect"]
            return rng.randint(x, x + w - 1), rng.randint(y, y + h - 1)
        return (rng.randint(2, max(2, layout["width"] - 3)),
                rng.randint(2, max(2, layout["height"] - 3)))

    tokens: List[Dict[str, Any]] = []
    for enc_index, encounter in enumerate(adventure["encounters"]):
        for ref in encounter["monsters"]:
            entry = compendium[ref["monster_id"]]
            hp = int(entry.get("hp", 10))
            for n in range(int(ref["quantity"])):
                tx, ty = spot_for(enc_index)
                tokens.append({
                    "id": f"tok_{encounter['id']}_{ref['monster_id']}_{n}",
                    "name": (
                        entry["name"] if ref["quantity"] == 1
                        else f"{entry['name']} {chr(ord('A') + n)}"
                    ),
                    "compendium_id": ref["monster_id"],
                    "encounter_id": encounter["id"],
                    "role": ref["role"],
                    "x": tx,
                    "y": ty,
                    "hp": hp,
                    "max_hp": hp,
                    "ac": int(entry.get("ac", 10)),
                    "color": "#dc2626" if ref["role"] == "boss" else "#94a3b8",
                    "is_player": False,
                })
    return tokens


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
    }

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
        # Full artifact: definition + layout detail (tiles/doors/rooms) +
        # documented generator provenance, persisted as adventure.json.
        "adventure": dict(adventure, layout={
            k: layout[k] for k in ("tiles", "doors", "rooms", "generator", "seed", "source")
            if k in layout
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
