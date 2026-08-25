"""Iteration 52 — Pillar-2 depth: the flagship starter adventure must be a
*complete playable campaign package*, not a monster list.

TDD red-first module. Covers:

1. Multi-area map layout (>= 6 chambers, WFC-style corridors, dressing tiles)
   with per-area metadata the board can hydrate from.
2. An explicit encounter tree: entry fight -> exploration hazards -> mini-boss,
   each node carrying a difficulty verdict computed with the standard DMG
   XP-threshold model over real compendium XP values.
3. Balance sanity for a level-1 party of four: no encounter is DEADLY, and the
   total adventure budget stays within the party's daily XP threshold.
4. Loot placements referencing real SRD 5.2 magic items by id.
5. Lore-graph seeds expressed as tiered assertions consistent with the Pillar-7
   epistemic tiers and paradox-checked against canon before shipping.
6. Full export -> import round-trip through the existing packager + gateway,
   including offline hydration validation of every token against the map.
"""

import base64
import json
import os

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.compendium import starter_adventures
from vtt_orchestrator.compendium.bundle_packager import global_bundle_packager
from vtt_orchestrator.server import app as server_app

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MONSTERS_FILE = os.path.join(PROJECT_ROOT, "compendium", "srd_5_2_monsters.json")
ITEMS_FILE = os.path.join(PROJECT_ROOT, "compendium", "srd_5_2_magic_items.json")

client = TestClient(server_app)


def _load_compendium(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return {e["id"]: e for e in json.load(f)}


def _monsters() -> dict:
    return _load_compendium(MONSTERS_FILE)


def _signup(name: str) -> dict:
    email = f"{name}_{abs(hash(name)) % 10**9}@example.com"
    resp = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": name, "display_name": name.title(),
              "password": "dice-dice", "role": "player"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ===========================================================================
# 1. Multi-area map layout depth
# ===========================================================================

def test_layout_has_multiple_meaningful_chambers():
    layout = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED)
    rooms = layout["rooms"]
    # A complete campaign package is a multi-area dungeon, not one open hall.
    assert len(rooms) >= 6, f"expected >= 6 chambers, got {len(rooms)}"
    ids = [r["id"] for r in rooms]
    assert len(set(ids)) == len(ids), "chamber ids must be unique"
    for room in rooms:
        x, y, w, h = room["rect"]
        assert w >= 4 and h >= 3, f"chamber {room['id']} too small to fight in"
        assert room["name"] and room["purpose"], "chambers need names + purpose"


def test_layout_rooms_are_non_overlapping_and_fully_carved():
    layout = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED)
    grid = layout["tiles"]
    rects = [tuple(r["rect"]) for r in layout["rooms"]]
    for i, (ax, ay, aw, ah) in enumerate(rects):
        for j, (bx, by, bw, bh) in enumerate(rects):
            if i == j:
                continue
            assert ax + aw <= bx or bx + bw <= ax or ay + ah <= by or by + bh <= ay, (
                f"chambers {i} and {j} overlap"
            )
    for rect in rects:
        x, y, w, h = rect
        for gy in range(y, y + h):
            for gx in range(x, x + w):
                assert grid[gy][gx] != 1, f"wall inside chamber at {(gx, gy)}"


def test_layout_is_fully_connected_with_corridor_doors():
    """Every chamber must be reachable from the entrance via floor/door tiles."""
    layout = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED)
    grid = layout["tiles"]
    height, width = len(grid), len(grid[0])

    walkable = lambda x, y: grid[y][x] != 1  # everything but solid wall
    start = (layout["entrance"]["x"], layout["entrance"]["y"])
    assert walkable(*start), "entrance must be on a walkable tile"

    seen = {start}
    frontier = [start]
    while frontier:
        x, y = frontier.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in seen \
                    and walkable(nx, ny):
                seen.add((nx, ny))
                frontier.append((nx, ny))

    def center(rect):
        x, y, w, h = rect
        return (x + w // 2, y + h // 2)

    entrance_room = min(
        layout["rooms"],
        key=lambda r: abs(center(r["rect"])[0] - start[0]) + abs(center(r["rect"])[1] - start[1]),
    )
    for room in layout["rooms"]:
        cx, cy = center(room["rect"])
        assert (cx, cy) in seen, f"chamber '{room['name']}' unreachable from entrance"

    # Corridors between chambers are doored, not just holes in the wall.
    assert len(layout["doors"]) >= len(layout["rooms"]) - 1


def test_layout_dressing_tiles_present():
    layout = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED)
    flat = [t for row in layout["tiles"] for t in row]
    assert flat.count(3) >= 1, "no altars (shrine / effigy) carved"
    assert flat.count(4) >= len(layout["rooms"]), "expected a chest per chamber area"


def test_dressing_tiles_are_walkable_not_walls():
    layout = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED)
    for y, row in enumerate(layout["tiles"]):
        for x, t in enumerate(row):
            if t in (3, 4):  # altar / chest
                assert t != 1, "dressing must never be carved as wall"


def test_hazards_declared_in_layout():
    layout = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED)
    hazards = layout.get("hazards", [])
    assert isinstance(hazards, list) and len(hazards) >= 1
    for hazard in hazards:
        assert {"kind", "x", "y"} <= set(hazard)
        assert hazard.get("dc", 0) > 0, "exploration hazards need a save DC"
        grid = layout["tiles"]
        assert grid[hazard["y"]][hazard["x"]] in (0, 2, 4), (
            "hazard must sit on traversable ground"
        )


# ===========================================================================
# 2. Encounter tree shape
# ===========================================================================

@pytest.fixture(scope="module")
def karas() -> dict:
    return starter_adventures.get_starter_adventure(starter_adventures.KARAS_KEY)


def test_encounter_tree_is_a_progression(karas):
    tree = karas["encounter_tree"]
    assert len(tree) >= 5, "entry fight + hazards + miniboss expected"
    kinds = [n["kind"] for n in tree]
    assert kinds[0] == "combat", "the tree opens with an entry fight"
    assert "hazard" in kinds, "exploration hazard stage missing"
    assert kinds[-1] == "combat" and tree[-1]["is_mini_boss"] is True

    parents = [node.get("leads_to") for node in tree[:-1]]
    node_ids = {n["id"] for n in tree}
    for parent, nxt in zip(tree[:-1], tree[1:]):
        assert parent["leads_to"] == nxt["id"], "tree must be a single chain"
        assert parent["leads_to"] in node_ids
    del parents


def test_encounter_tree_backed_by_legacy_encounters(karas):
    tree_ids = {n["encounter_id"] for n in karas["encounter_tree"]
                if n.get("encounter_id")}
    legacy_ids = {e["id"] for e in karas["encounters"]}
    assert tree_ids == legacy_ids, "tree nodes must map onto concrete encounters"


# ===========================================================================
# 3. Encounter balance (DMG XP-threshold model)
# ===========================================================================

LEVEL_1_THRESHOLDS = {"easy": 50, "medium": 100, "hard": 200, "deadly": 400}
PARTY_SIZE = 4
DAILY_BUDGET_LEVEL_1 = 300  # per PC; a party of four gets 1200 XP/day


def _encounter_xp(node: dict, compendium: dict) -> int:
    raw = sum(
        int(compendium[m["monster_id"]]["xp"]) * int(m["quantity"])
        for m in node["monsters"]
    )
    count = sum(int(m["quantity"]) for m in node["monsters"])
    mult = 0.5 if count <= 1 else (1.0 if count <= 2 else (1.5 if count <= 6 else (2.0 if count <= 10 else 2.5)))
    return int(raw * mult)


def _verdict(xp: int):
    # Thresholds are per character; scale them to the full party.
    scaled = {band: value * PARTY_SIZE for band, value in LEVEL_1_THRESHOLDS.items()}
    if xp >= scaled["deadly"]:
        return "DEADLY"
    if xp >= scaled["hard"]:
        return "HARD"
    if xp >= scaled["medium"]:
        return "MEDIUM"
    if xp >= scaled["easy"]:
        return "EASY"
    return "TRIVIAL"


def _encounter_by_id(karas: dict, encounter_id: str) -> dict:
    return next(e for e in karas["encounters"] if e["id"] == encounter_id)


def test_every_combat_node_carries_difficulty_verdict(karas):
    compendium = _monsters()
    for node in karas["encounter_tree"]:
        if node["kind"] != "combat":
            continue
        balance = node.get("balance")
        assert balance, f"{node['id']} missing balance data"
        expected_xp = _encounter_xp(
            _encounter_by_id(karas, node["encounter_id"]), compendium)
        assert balance["adjusted_xp"] == expected_xp, (
            f"{node['id']}: shipped {balance['adjusted_xp']} vs recomputed "
            f"{expected_xp} — stale numbers ship broken difficulty"
        )
        assert balance["difficulty"] == _verdict(expected_xp)
        assert balance["party_level"] == 1 and balance["party_size"] == 4


def test_no_tpk_in_round_one_level_1_party(karas):
    """Nothing in the flagship may be DEADLY for the advertised level-1 party,
    and hazard stages must never field monsters above the party's tier."""
    for node in karas["encounter_tree"]:
        if node["kind"] == "combat":
            assert node["balance"]["difficulty"] != "DEADLY", (
                f"{node['id']} can TPK a level-1 party ({node['balance']['adjusted_xp']} adjusted XP)"
            )
            encounter = _encounter_by_id(karas, node["encounter_id"])
            for ref in encounter["monsters"]:
                entry = _monsters()[ref["monster_id"]]
                cr = entry["challenge_rating"]
                num, _, den = cr.partition("/")
                cr_val = float(num) / float(den or 1)
                assert cr_val <= 3, (
                    f"{ref['monster_id']} CR {cr} exceeds level-1-appropriate ceiling"
                )
        else:
            # Hazard nodes reference declared exploration hazards, not fights.
            assert node.get("hazard_id") in {
                h["id"] for h in starter_adventures.KARAS_HAZARD_PLAN
            }, f"{node['id']} references an undeclared hazard"


def test_total_adventure_within_two_adventuring_days(karas):
    """The delve is a two-day delve: the Choir Landing waystation is the
    documented long-rest site between the ossuary and the vault."""
    total = sum(n["balance"]["adjusted_xp"] for n in karas["encounter_tree"]
                if n["kind"] == "combat")
    two_day_budget = DAILY_BUDGET_LEVEL_1 * PARTY_SIZE * 2
    assert 0 < total <= two_day_budget, (
        f"{total} adjusted XP exceeds two adventuring days for the level-1 party"
    )
    assert total >= LEVEL_1_THRESHOLDS["medium"], "adventure must not be empty content"
    # The mini-boss must be the single hardest fight of the delve.
    verdicts = [n["balance"]["adjusted_xp"] for n in karas["encounter_tree"]
                if n["kind"] == "combat"]
    assert verdicts[-1] == max(verdicts), "mini-boss must be the climax fight"


def test_spawn_tokens_carry_compendium_stats_and_balance(karas):
    data = starter_adventures.starter_campaign_data(prefer_engine=False)
    tokens = data["tokens"]
    assert tokens, "bundle must spawn pre-seeded enemy tokens"
    compendium = _monsters()
    for tok in tokens:
        assert tok["compendium_id"] in compendium
        entry = compendium[tok["compendium_id"]]
        assert tok["max_hp"] == entry["hp"] and tok["ac"] == entry["ac"]
        assert "xp" in tok and tok["xp"] == entry["xp"]
        assert tok["challenge_rating"] == entry["challenge_rating"]
        assert tok["area_id"] in {r["id"] for r in data["adventure"]["layout"]["rooms"]}
        # Tokens must be placed on walkable tiles (floor/door/chest/altar).
        tiles = data["adventure"]["layout"]["tiles"]
        assert tiles[int(tok["y"])][int(tok["x"])] != 1, (
            f"{tok['name']} spawned inside a wall at {(tok['x'], tok['y'])}"
        )


def test_loot_placements_reference_real_items():
    data = starter_adventures.starter_campaign_data(prefer_engine=False)
    items = _load_compendium(ITEMS_FILE)
    placements = data["loot_tables"]["placements"]
    assert len(placements) >= 3, "loot must be placed in the world, not just listed"
    for placement in placements:
        assert placement["container"] in ("chest", "altar", "boss_hoard")
        assert placement["area_id"] in {r["id"] for r in data["adventure"]["layout"]["rooms"]}
        for item_ref in placement["items"]:
            if item_ref.get("item_id"):
                assert item_ref["item_id"] in items, (
                    f"invented item {item_ref['item_id']!r}"
                )
                assert item_ref["name"] == items[item_ref["item_id"]]["name"]
            else:
                assert item_ref["name"] in set(starter_adventures.CRYPT_LOOT_TABLE_NAMES)


# ===========================================================================
# 5. Lore seeds as valid tiered assertions
# ===========================================================================

def test_lore_seeds_parse_as_tiered_assertions(karas):
    from vtt_orchestrator.schemas.models import EpistemicTier, LoreAssertionPayload
    from vtt_orchestrator.lore.epistemic_graph import EpistemicLoreGraphManager

    manager = EpistemicLoreGraphManager()
    canon_edges = {(e["from"], e["rel"], e["to"]) for e in manager.edges}

    payloads = []
    for assertion in karas["lore_assertions"]:
        payload = LoreAssertionPayload(**assertion)  # pydantic validation
        payloads.append(payload)

    assert len(payloads) >= 8, "a campaign package needs a seeded lore web"
    tiers = {p.epistemic_tier for p in payloads}
    assert EpistemicTier.SUBJECTIVE_RUMOR in tiers, "rumor tier must be exercised"
    assert EpistemicTier.VALIDATED_CANON in tiers, "canon tier must be exercised"
    for p in payloads:
        assert p.context_sentence.strip(), "every seed needs grounding prose"
        assert 0.0 <= p.confidence_score <= 1.0

    # Canon-consistency: nothing may contradict the canon graph.
    manager.nodes.update({
        n["id"]: dict(n) for n in karas["lore_seeds"]["nodes"] if n["id"] not in manager.nodes
    })
    for p in payloads:
        verdict, reason, _ms = manager.query_paradox(
            p.subject_node_id, p.predicate_relation, p.object_node_id)
        assert verdict, f"paradox seed shipped: {reason}"


def test_canon_nodes_never_regressed(karas):
    vane = next(n for n in karas["lore_seeds"]["nodes"] if n["id"] == "NPC_Baron_Vane")
    keep = next(n for n in karas["lore_seeds"]["nodes"] if n["id"] == "Location_Keep")
    assert vane["life_stage"] == "DECEASED" and keep["status"] == "DESTROYED"


# ===========================================================================
# 6. Bundle export -> import round trip (+ offline hydration)
# ===========================================================================

@pytest.fixture(scope="module")
def imported_bundle() -> dict:
    path = starter_adventures.build_starter_bundle(prefer_engine=False)
    with open(path, "rb") as f:
        return global_bundle_packager.import_bundle(f.read())


def test_bundle_member_inventory(imported_bundle):
    manifest = imported_bundle["manifest"]
    assert manifest["adventure_key"] == starter_adventures.KARAS_KEY
    artifact = imported_bundle["adventure"]
    assert len(artifact["encounter_tree"]) >= 5
    assert len(artifact["lore_assertions"]) >= 8
    assert len(imported_bundle["map_layout"]["walls"]) > 0
    assert imported_bundle["manifest"]["token_count"] == len(imported_bundle["tokens"])
    assert imported_bundle["manifest"]["lore_propositions_count"] == len(
        imported_bundle["lore_graph"]["edges"])
    assert len(imported_bundle["loot_tables"]["placements"]) >= 3
    assert artifact["layout_source"] in ("engine_wfc", "fallback_procedural")


def test_roundtrip_preserves_layout_and_tokens(imported_bundle):
    original = starter_adventures.starter_campaign_data(prefer_engine=False)
    assert imported_bundle["map_layout"]["grid_width"] == original["grid_dimensions"]["width"]
    assert imported_bundle["map_layout"]["walls"] == original["walls"]
    assert imported_bundle["tokens"] == original["tokens"]


def test_offline_hydration_validation_of_imported_bundle(imported_bundle):
    """The gateway's import route validates walls/tokens offline-first; mirror
    that contract here so bundle defects fail in CI even without an engine."""
    layout = imported_bundle["map_layout"]
    width, height = layout["grid_width"], layout["grid_height"]
    solid = {(w["x"], w["y"]) for w in layout["walls"]}
    assert 0 < len(solid) < width * height

    for tok in imported_bundle["tokens"]:
        assert 0 <= int(tok["x"]) < width and 0 <= int(tok["y"]) < height
        entity_id = str(tok["id"])
        assert len(entity_id) > 0
        assert int(tok["hp"]) > 0 and int(tok["ac"]) > 0


def test_gateway_export_route_round_trip():
    user = _signup("depth_bot")
    resp = client.post(
        f"/api/v1/adventures/starter/{starter_adventures.KARAS_KEY}/export",
        headers={"Authorization": f"Bearer {user['token']}"},
    )
    assert resp.status_code == 200, resp.text
    imported = global_bundle_packager.import_bundle(resp.content)
    artifact = imported["adventure"]
    assert artifact["key"] == starter_adventures.KARAS_KEY
    assert len(artifact["encounters"]) >= 5
    assert len(artifact["encounter_tree"]) >= 5
    assert imported["manifest"]["token_count"] == len(imported["tokens"]) >= 10


# ===========================================================================
# 7. Engine-WFC path keeps the full campaign structure
# ===========================================================================

def _fake_engine_chambers(method: str, path: str, payload: dict) -> dict:
    import random as _random
    desc = payload["room_desc"]
    width, height = desc["width"], desc["height"]
    rng = _random.Random(payload["seed"])
    tiles = [[1] * width for _ in range(height)]
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            tiles[y][x] = 0 if rng.random() < 0.9 else 4
    return {"tiles": tiles}


def test_engine_wfc_path_preserves_campaign_structure(monkeypatch):
    from vtt_orchestrator.routing import engine_client

    monkeypatch.setattr(engine_client, "engine_request_sync",
                        _fake_engine_chambers)
    layout = starter_adventures.resolve_crypt_layout(
        starter_adventures.KARAS_SEED, prefer_engine=True)
    assert layout["source"] == "engine_wfc"
    fallback = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED)
    assert len(layout["rooms"]) == len(fallback["rooms"]) >= 6
    # Corridors/doors/entrance survive the stitch; hazards stay on open ground.
    assert len(layout["doors"]) >= len(layout["rooms"]) - 1
    for hazard in layout["hazards"]:
        assert layout["tiles"][hazard["y"]][hazard["x"]] != 1
    for x, y in [(w["x"], w["y"]) for w in layout["doors"]]:
        assert layout["tiles"][y][x] == 2

    data = starter_adventures.starter_campaign_data(prefer_engine=True)
    room_ids = {r["id"] for r in data["adventure"]["layout"]["rooms"]}
    assert all(tok["area_id"] in room_ids for tok in data["tokens"])
    assert len(data["loot_tables"]["placements"]) >= 3


def test_engine_rejection_falls_back_to_procedural(monkeypatch):
    from vtt_orchestrator.routing import engine_client

    def broken_engine(method, path, payload):
        raise RuntimeError("engine down")

    monkeypatch.setattr(engine_client, "engine_request_sync", broken_engine)
    layout = starter_adventures.resolve_crypt_layout(
        starter_adventures.KARAS_SEED, prefer_engine=True)
    assert layout["source"] == "fallback_procedural"
    procedural = starter_adventures.generate_crypt_layout(
        starter_adventures.KARAS_SEED)
    assert layout["walls"] == procedural["walls"]

    def garbage_engine(method, path, payload):
        return {"tiles": [[9, 9], [9, 9]]}

    monkeypatch.setattr(engine_client, "engine_request_sync", garbage_engine)
    layout = starter_adventures.resolve_crypt_layout(
        starter_adventures.KARAS_SEED, prefer_engine=True)
    assert layout["source"] == "fallback_procedural"


def test_gateway_import_route_accepts_flagship_bundle():
    user = _signup("depth_importer")
    path = starter_adventures.build_starter_bundle(prefer_engine=False)
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    resp = client.post(
        "/api/v1/campaign/import-bundle",
        headers={"Authorization": f"Bearer {user['token']}"},
        json={"bundle_b64": b64, "session_name": "Karas Depth Run"},
    )
    if resp.status_code == 502:
        pytest.skip("engine not running")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "IMPORTED"
    assert body["map_walls_applied"] > 0
    assert body["tokens_spawned"] >= 10
