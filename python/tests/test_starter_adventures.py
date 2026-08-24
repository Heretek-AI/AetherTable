"""Backlog item 5.4 — starter adventure module tests (TDD).

Covers "The Sunken Crypt of Karas": real .vttbundle construction through the
existing packager, encounters referencing REAL SRD 5.2 compendium monsters,
canon-consistent lore-graph seeds, deterministic seeded layout generation,
and the gateway export route's token requirement.
"""

import json
import os
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.compendium.bundle_packager import (
    CampaignBundlePackager,
    global_bundle_packager,
)
from vtt_orchestrator.compendium import starter_adventures
from vtt_orchestrator.server import app as server_app
from vtt_orchestrator.lore.epistemic_graph import canon_seed_nodes

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MONSTERS_FILE = os.path.join(PROJECT_ROOT, "compendium", "srd_5_2_monsters.json")

client = TestClient(server_app)


def _load_compendium_monsters() -> dict:
    with open(MONSTERS_FILE, "r", encoding="utf-8") as f:
        entries = json.load(f)
    return {m["id"]: m for m in entries}


def _signup(name: str) -> dict:
    email = f"{name}_{abs(hash(name + str(time.time()))) % 10**8}@example.com"
    resp = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": name, "display_name": name.title(),
              "password": "dice-dice", "role": "player"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- Catalog -------------------------------------------------------------------

def test_list_starter_adventures_exposes_karas():
    catalog = starter_adventures.list_starter_adventures()
    assert isinstance(catalog, list) and len(catalog) >= 1
    karas = [a for a in catalog if a["key"] == starter_adventures.KARAS_KEY]
    assert len(karas) == 1
    meta = karas[0]
    assert meta["title"] == "The Sunken Crypt of Karas"
    assert meta["level_range"] == "1-3"
    assert meta["encounter_count"] == 3


# --- Bundle construction -------------------------------------------------------

def test_build_starter_bundle_writes_real_vttbundle(tmp_path):
    path = starter_adventures.build_starter_bundle(output_dir=str(tmp_path))
    assert os.path.exists(path)
    assert path.endswith(".vttbundle")
    with open(path, "rb") as f:
        raw = f.read()
    assert raw.startswith(b"PK")  # zip signature

    imported = global_bundle_packager.import_bundle(raw)
    manifest = imported["manifest"]
    assert manifest["title"] == "The Sunken Crypt of Karas"
    # Packager rules: spec version + counts consistent with payload.
    assert manifest["spec_version"] == CampaignBundlePackager.BUNDLE_SPEC_VERSION
    assert manifest["token_count"] == len(imported["tokens"])
    assert manifest["lore_propositions_count"] == len(
        imported.get("lore_graph", {}).get("edges", [])
    )


def test_bundle_contains_structured_adventure_artifact(tmp_path):
    path = starter_adventures.build_starter_bundle(output_dir=str(tmp_path))
    with open(path, "rb") as f:
        imported = global_bundle_packager.import_bundle(f.read())

    artifact = imported["adventure"]
    assert artifact["key"] == starter_adventures.KARAS_KEY
    assert len(artifact["encounters"]) == 3

    # Layout provenance must be documented in the artifact: either the engine's
    # WFC produced it or the documented in-module fallback did.
    layout = imported["map_layout"]
    source = artifact["layout_source"]
    assert source in ("engine_wfc", "fallback_procedural")
    assert layout["grid_width"] > 0 and layout["grid_height"] > 0
    assert len(layout["walls"]) > 0


def test_encounters_reference_real_compendium_monsters():
    compendium = _load_compendium_monsters()
    adventure = starter_adventures.get_starter_adventure(starter_adventures.KARAS_KEY)

    referenced = []
    for encounter in adventure["encounters"]:
        assert encounter["monsters"], f"{encounter['id']} has no monsters"
        for ref in encounter["monsters"]:
            monster_id = ref["monster_id"]
            assert monster_id in compendium, (
                f"Invented monster {monster_id!r} — not in srd_5_2_monsters.json"
            )
            assert ref["name"] == compendium[monster_id]["name"], (
                f"Name mismatch for {monster_id}: {ref['name']!r} vs compendium "
                f"{compendium[monster_id]['name']!r}"
            )
            assert int(ref["quantity"]) >= 1
            referenced.append(monster_id)

    # Three distinct encounters draw on at least three distinct stat blocks.
    assert len(set(referenced)) >= 3


def test_loot_references_follow_crypt_theme_conventions_names_only():
    adventure = starter_adventures.get_starter_adventure(starter_adventures.KARAS_KEY)
    allowed = set(starter_adventures.CRYPT_LOOT_TABLE_NAMES)
    for encounter in adventure["encounters"]:
        for loot in encounter["loot"]:
            assert loot["theme"] == "crypt"
            assert loot["name"] in allowed, (
                f"Loot {loot['name']!r} not part of the crypt loot-table theme"
            )
    # Names only — no rolled gp values / quantities are asserted by this module.
    assert all("value_gp" not in loot and "quantity" not in loot
               for e in adventure["encounters"] for loot in e["loot"])


def test_content_note_is_x_card_safe():
    adventure = starter_adventures.get_starter_adventure(starter_adventures.KARAS_KEY)
    note = adventure["content_note"]
    assert note and "X-card" in note


# --- Lore graph canon ----------------------------------------------------------

def test_lore_seeds_match_canon_node_ids():
    canon = canon_seed_nodes()
    adventure = starter_adventures.get_starter_adventure(starter_adventures.KARAS_KEY)
    seeds = adventure["lore_seeds"]

    seed_ids = {n["id"] for n in seeds["nodes"]}
    # Canon nodes reused by the adventure must keep their exact ids.
    for required in ("NPC_Baron_Vane", "Location_Keep"):
        assert required in seed_ids
        assert required in canon

    for node in seeds["nodes"]:
        if node["id"] in canon:
            assert node["type"] == canon[node["id"]].get("type", "Entity")
        else:
            # New adventure-local nodes use a namespaced prefix so they can be
            # told apart from canon during retcon audits.
            assert node["id"].startswith("Location_Sunken_Crypt") or node["id"].startswith("NPC_Karas")

    for edge in seeds["edges"]:
        assert edge["to"] in seed_ids and edge["from"] in seed_ids
    # Canon consistency: Vane previously ruled Oakhaven Keep; the adventure
    # must never re-assert him ruling it now (he is DECEASED, keep DESTROYED).
    vane = next(n for n in seeds["nodes"] if n["id"] == "NPC_Baron_Vane")
    keep = next(n for n in seeds["nodes"] if n["id"] == "Location_Keep")
    assert vane["life_stage"] == "DECEASED"
    assert keep["status"] == "DESTROYED"
    assert not any(e["rel"] == "RULES" and e["from"] == "NPC_Baron_Vane"
                   for e in seeds["edges"])


# --- Determinism ---------------------------------------------------------------

def test_deterministic_seed_reproduces_identical_layouts():
    a = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED)
    b = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED)
    c = starter_adventures.generate_crypt_layout(starter_adventures.KARAS_SEED + 1)
    assert a == b
    assert a != c  # different seeds diverge
    # Sealed perimeter, same tile encoding as the engine's WFC output.
    grid = a["tiles"]
    assert grid[0] == [1] * len(grid[0])
    assert all(row[0] == 1 and row[-1] == 1 for row in grid)


def test_full_build_is_deterministic_across_calls(tmp_path):
    first = starter_adventures.starter_campaign_data(prefer_engine=False)
    second = starter_adventures.starter_campaign_data(prefer_engine=False)
    assert first["walls"] == second["walls"]
    assert first["adventure"]["layout_source"] == second["adventure"]["layout_source"]

    p1 = starter_adventures.build_starter_bundle(output_dir=str(tmp_path), prefer_engine=False)
    p2 = starter_adventures.build_starter_bundle(output_dir=str(tmp_path), prefer_engine=False)
    with open(p1, "rb") as f1, open(p2, "rb") as f2:
        i1 = global_bundle_packager.import_bundle(f1.read())
        i2 = global_bundle_packager.import_bundle(f2.read())
    assert i1["map_layout"] == i2["map_layout"]
    assert i1["adventure"] == i2["adventure"]


# --- Gateway routes --------------------------------------------------------------

def test_gateway_lists_starter_adventures_without_auth():
    resp = client.get("/api/v1/adventures/starter")
    assert resp.status_code == 200
    body = resp.json()
    keys = [a["key"] for a in body["adventures"]]
    assert starter_adventures.KARAS_KEY in keys


def test_export_route_requires_token():
    key = starter_adventures.KARAS_KEY

    missing = client.post(f"/api/v1/adventures/starter/{key}/export")
    assert missing.status_code == 422  # FastAPI: required query param absent

    invalid = client.post(
        f"/api/v1/adventures/starter/{key}/export", params={"token": "garbage.token"}
    )
    assert invalid.status_code == 401


def test_export_route_returns_importable_bundle():
    user = _signup("starterbot")

    resp = client.post(
        f"/api/v1/adventures/starter/{starter_adventures.KARAS_KEY}/export",
        params={"token": user["token"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/zip"
    assert resp.content.startswith(b"PK")
    assert "karas" in resp.headers.get("content-disposition", "").lower()

    imported = global_bundle_packager.import_bundle(resp.content)
    assert imported["manifest"]["title"] == "The Sunken Crypt of Karas"

    unknown = client.post(
        "/api/v1/adventures/starter/not_an_adventure/export",
        params={"token": user["token"]},
    )
    assert unknown.status_code == 404
