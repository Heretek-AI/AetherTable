"""Tests for the Foundry VTT module importer (Pillar 10 interop).

Fixtures are crafted in-test to mirror the REAL Foundry module layout:
a ``module.json`` manifest plus ``packs/*.db`` files where every line is one
JSON document (the documented "Export Pack" NDJSON format).
"""

import json
import os

import pytest

from vtt_orchestrator.compendium.foundry_importer import FoundryModuleImporter


# --- Fixture builders ---------------------------------------------------------------


def goblin_actor(doc_id="act_goblin"):
    """Realistic dnd5e NPC actor document (one NDJSON line)."""
    return {
        "_id": doc_id,
        "name": "Goblin Snapper",
        "type": "npc",
        "img": "icons/svg/goblin.svg",
        "system": {
            "abilities": {
                "str": {"value": 15},
                "dex": {"value": 14},
                "con": {"value": 13},
                "int": {"value": 10},
                "wis": {"value": 8},
                "cha": {"value": 7},
            },
            "attributes": {
                "ac": {"value": 13},
                "hp": {"value": 7, "max": 7},
                "speed": {"value": "30 ft."},
            },
            "details": {"cr": "1/4", "type": {"value": "humanoid"}},
        },
        "items": [
            {
                "_id": "itm_scimitar",
                "name": "Scimitar",
                "type": "weapon",
                "system": {
                    "attack": {"bonus": "+4"},
                    "damage": {"parts": [["1d6+2", "slashing"]]},
                },
            }
        ],
        "flags": {"core": {"sheetClass": "dnd5e.ActorSheet5eNPC"}},
        "ownership": {"default": 0},
    }


def potion_item(doc_id="itm_potion"):
    return {
        "_id": doc_id,
        "name": "Potion of Healing",
        "type": "consumable",
        "system": {
            "description": {"value": "<p>Restores 2d4 + 2 hit points.</p>"},
            "rarity": "common",
            "price": {"value": 50, "denomination": "gp"},
            "quantity": 1,
            "weight": {"value": 0.5},
        },
        "flags": {},
    }


def crypt_scene(doc_id="scn_crypt"):
    return {
        "_id": doc_id,
        "name": "Karas Crypt Antechamber",
        "width": 3200,
        "height": 1800,
        "grid": 100,
        "walls": [
            {"_id": "w1", "c": [0, 0, 400, 0], "ls": True, "move": 0, "sight": 0, "door": False},
            {"_id": "w2", "c": [400, 0, 800, 0], "ls": True, "move": 1, "sight": 1, "door": True},
        ],
        "background": "modules/demo/crypt.jpg",
        "tokens": [],
        "navMode": 1,
    }


def build_module(
    tmp_path,
    manifest=None,
    packs=None,
    write_manifest=True,
    subdir="demo-module",
):
    """Create an on-disk Foundry module layout. ``packs`` maps pack filename ->
    list of documents (serialized NDJSON) or a raw string body."""
    root = tmp_path / subdir
    root.mkdir(parents=True, exist_ok=True)
    if manifest is None:
        manifest = {
            "id": "demo-module",
            "title": "Demo Module",
            "author": "Test Author",
            "version": "1.0.0",
            "packs": [
                {"name": "bestiary", "label": "Bestiary", "path": "packs/bestiary.db", "type": "Actor"},
                {"name": "gear", "label": "Gear", "path": "packs/gear.db", "type": "Item"},
                {"name": "maps", "label": "Maps", "path": "packs/maps.db", "type": "Scene"},
            ],
        }
    if write_manifest:
        (root / "module.json").write_text(json.dumps(manifest), encoding="utf-8")

    defaults = {
        "bestiary.db": [goblin_actor()],
        "gear.db": [potion_item()],
        "maps.db": [crypt_scene()],
    }
    for fname, payload in (packs if packs is not None else defaults).items():
        pack_path = root / "packs" / fname
        pack_path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(payload, str):
            body = payload
        else:
            body = "\n".join(json.dumps(doc) for doc in payload) + "\n"
        pack_path.write_text(body, encoding="utf-8")
    return root


# --- Happy path ---------------------------------------------------------------------


class TestHappyPath:
    def test_imports_monsters_items_and_scene(self, tmp_path):
        result = FoundryModuleImporter().import_module(build_module(tmp_path))

        assert result["module"]["id"] == "demo-module"
        assert result["module"]["title"] == "Demo Module"
        assert result["module"]["version"] == "1.0.0"

        assert len(result["monsters"]) == 1
        gob = result["monsters"][0]
        assert gob["name"] == "Goblin Snapper"
        assert gob["ac"] == 13
        assert gob["hp"] == 7
        assert gob["max_hp"] == 7
        assert gob["speed"] == 30
        assert gob["abilities"] == {
            "STR": 15, "DEX": 14, "CON": 13, "INT": 10, "WIS": 8, "CHA": 7,
        }

        assert len(result["items"]) == 1
        pot = result["items"][0]
        assert pot["name"] == "Potion of Healing"
        assert pot["category"] == "consumable"
        assert pot["rarity"] == "common"
        assert pot["price_value"] == 50
        assert pot["price_denomination"] == "gp"

        assert len(result["maps"]) == 1
        mp = result["maps"][0]
        assert mp["name"] == "Karas Crypt Antechamber"
        assert mp["dimensions"]["width"] == 3200
        assert mp["dimensions"]["height"] == 1800
        assert mp["dimensions"]["grid_size"] == 100
        assert len(mp["walls"]) == 2

        # Nothing failed silently on a fully mappable module.
        assert result["skipped"] == 0
        assert result["imported"] == 3
        assert result["warnings"] == []

    def test_actions_projected_from_embedded_weapon_items(self, tmp_path):
        result = FoundryModuleImporter().import_module(build_module(tmp_path))
        actions = result["monsters"][0]["actions"]
        assert actions == [
            {
                "name": "Scimitar",
                "to_hit": "+4",
                "damage_formula": "1d6+2",
                "damage_type": "slashing",
            }
        ]

    def test_wall_geometry_projects_pixel_coordinates(self, tmp_path):
        result = FoundryModuleImporter().import_module(build_module(tmp_path))
        w1, w2 = result["maps"][0]["walls"]
        assert (w1["x1"], w1["y1"], w1["x2"], w1["y2"]) == (0, 0, 400, 0)
        assert w1["door"] is False
        assert w2["door"] is True


# --- NDJSON parsing -----------------------------------------------------------------


class TestNdjsonParsing:
    def test_multiple_documents_one_per_line(self, tmp_path):
        ogre = goblin_actor("act_ogre")
        ogre["name"] = "Cave Ogre"
        ogre["_id"] = "act_ogre"
        ogre["system"]["attributes"]["ac"]["value"] = 17
        mod_dir = build_module(tmp_path, packs={"bestiary.db": [goblin_actor(), ogre]})
        result = FoundryModuleImporter().import_module(mod_dir)
        assert [m["name"] for m in result["monsters"]] == ["Cave Ogre", "Goblin Snapper"]

    def test_blank_lines_are_tolerated(self, tmp_path):
        body = "\n\n" + json.dumps(goblin_actor()) + "\n\n"
        mod_dir = build_module(tmp_path, packs={"bestiary.db": body})
        result = FoundryModuleImporter().import_module(mod_dir)
        assert len(result["monsters"]) == 1
        assert result["imported"] == 1

    def test_malformed_line_is_reported_and_skipped(self, tmp_path):
        body = (
            json.dumps(goblin_actor())
            + "\n{not valid json\n"
            + json.dumps(potion_item())
        )
        build_module(
            tmp_path,
            packs={
                "bestiary.db": body.splitlines()[0] + "\n{not valid json\n",
                "gear.db": json.dumps(potion_item()),
                "maps.db": "",
            },
        )
        result = FoundryModuleImporter().import_module(tmp_path / "demo-module")
        assert len(result["monsters"]) == 1
        assert result["skipped"] >= 1
        assert any("bestiary" in w and "line 2" in w for w in result["warnings"])


# --- Unmapped-field accounting ------------------------------------------------------


class TestUnmappedAccounting:
    def test_top_level_and_nested_unmapped_fields_are_listed(self, tmp_path):
        result = FoundryModuleImporter().import_module(build_module(tmp_path))
        gob = result["monsters"][0]
        # Top-level fields with no canon projection...
        assert "img" in gob["unmapped"]
        assert "flags" in gob["unmapped"]
        assert "ownership" in gob["unmapped"]
        # ...and consumed-container leftovers (details was never mapped).
        assert "system.details" in gob["unmapped"]

    def test_every_mapped_field_is_absent_from_unmapped(self, tmp_path):
        result = FoundryModuleImporter().import_module(build_module(tmp_path))
        gob = result["monsters"][0]
        for mapped in ("name", "system", "items"):
            assert mapped not in gob["unmapped"]

    def test_non_combat_embedded_items_are_accounted(self, tmp_path):
        actor = goblin_actor()
        actor["items"].append(
            {"_id": "itm_key", "name": "Rusty Key", "type": "loot", "system": {}}
        )
        build_module(tmp_path, packs={"bestiary.db": [actor], "gear.db": [], "maps.db": []})
        result = FoundryModuleImporter().import_module(tmp_path / "demo-module")
        gob = result["monsters"][0]
        assert any("Rusty Key" in u for u in gob["unmapped"])
        # The weapon still projects normally.
        assert [a["name"] for a in gob["actions"]] == ["Scimitar"]

    def test_scene_wall_extra_flags_are_recorded(self, tmp_path):
        result = FoundryModuleImporter().import_module(build_module(tmp_path))
        w1 = result["maps"][0]["walls"][0]
        assert "ls" in w1["unmapped"]
        assert "move" in w1["unmapped"]
        assert "sight" in w1["unmapped"]


# --- Fail-loud contract ---------------------------------------------------------------


class TestFailLoud:
    def test_missing_manifest_raises_value_error(self, tmp_path):
        build_module(tmp_path, write_manifest=False)
        with pytest.raises(ValueError, match="module.json"):
            FoundryModuleImporter().import_module(tmp_path / "demo-module")

    def test_invalid_manifest_json_raises_value_error(self, tmp_path):
        build_module(tmp_path, packs={})
        (tmp_path / "demo-module" / "module.json").write_text("{oops", encoding="utf-8")
        with pytest.raises(ValueError, match="invalid JSON"):
            FoundryModuleImporter().import_module(tmp_path / "demo-module")

    @pytest.mark.parametrize("bad_version", [None, "", 42, "   "])
    def test_invalid_version_raises_value_error(self, tmp_path, bad_version):
        manifest = {
            "id": "demo-module",
            "title": "Demo Module",
            "version": bad_version,
            "packs": [],
        }
        build_module(tmp_path, manifest=manifest, packs={})
        with pytest.raises(ValueError, match="version"):
            FoundryModuleImporter().import_module(tmp_path / "demo-module")


# --- Partial imports / tolerance ------------------------------------------------------


class TestPartialImports:
    def test_missing_pack_file_warns_and_counts_skipped(self, tmp_path):
        build_module(tmp_path, packs={"bestiary.db": [goblin_actor()]})
        result = FoundryModuleImporter().import_module(tmp_path / "demo-module")
        assert len(result["monsters"]) == 1
        assert result["skipped"] == 2  # gear + maps pack files absent
        missing = [w for w in result["warnings"] if "missing pack file" in w]
        assert len(missing) == 2

    def test_empty_pack_is_tolerated(self, tmp_path):
        build_module(tmp_path, packs={"bestiary.db": [], "gear.db": "\n", "maps.db": ""})
        result = FoundryModuleImporter().import_module(tmp_path / "demo-module")
        assert result["monsters"] == []
        assert result["items"] == []
        assert result["maps"] == []
        assert result["imported"] == 0
        assert result["skipped"] == 0
        assert result["warnings"] == []

    def test_unsupported_pack_type_is_skipped_with_warning(self, tmp_path):
        manifest = {
            "id": "demo-module",
            "title": "Demo Module",
            "version": "1.0.0",
            "packs": [
                {"name": "lore", "label": "Lore", "path": "packs/lore.db", "type": "JournalEntry"},
                {"name": "bestiary", "label": "B", "path": "packs/bestiary.db", "type": "Actor"},
            ],
        }
        build_module(tmp_path, manifest=manifest, packs={"bestiary.db": [goblin_actor()]})
        result = FoundryModuleImporter().import_module(tmp_path / "demo-module")
        assert len(result["monsters"]) == 1
        assert result["skipped"] == 1
        assert any("JournalEntry" in w for w in result["warnings"])

    def test_level_db_directory_packs_are_skipped_with_warning(self, tmp_path):
        manifest = {
            "id": "demo-module",
            "title": "Demo Module",
            "version": "1.0.0",
            "packs": [
                {"name": "modern", "label": "M", "path": "packs/modern", "type": "Actor"},
            ],
        }
        build_module(tmp_path, manifest=manifest, packs={})
        (tmp_path / "demo-module" / "packs" / "modern").mkdir(parents=True)
        result = FoundryModuleImporter().import_module(tmp_path / "demo-module")
        assert result["imported"] == 0
        assert result["skipped"] == 1
        assert any("LevelDB" in w for w in result["warnings"])

    def test_document_without_name_is_skipped_with_warning(self, tmp_path):
        anon = goblin_actor()
        anon["name"] = ""
        build_module(tmp_path, packs={"bestiary.db": [anon], "gear.db": [], "maps.db": []})
        result = FoundryModuleImporter().import_module(tmp_path / "demo-module")
        assert result["monsters"] == []
        assert result["skipped"] == 1
        assert any("unnamed" in w.lower() for w in result["warnings"])


# --- Determinism -----------------------------------------------------------------------


class TestDeterministicOutput:
    def test_entries_sorted_by_name_then_id(self, tmp_path):
        b_doc = goblin_actor("act_b")
        b_doc["name"] = "Zombie Brute"
        a_doc = goblin_actor("act_a")
        a_doc["name"] = "Acolyte"
        dup1 = goblin_actor("act_dup1")
        dup1["name"] = "Acolyte"
        dup2 = goblin_actor("act_dup2")
        dup2["name"] = "Acolyte"
        build_module(
            tmp_path,
            packs={
                "bestiary.db": [dup2, b_doc, dup1, a_doc],
                "gear.db": [],
                "maps.db": [],
            },
        )
        result = FoundryModuleImporter().import_module(tmp_path / "demo-module")
        assert [(m["name"], m["source_id"]) for m in result["monsters"]] == [
            ("Acolyte", "act_a"),
            ("Acolyte", "act_dup1"),
            ("Acolyte", "act_dup2"),
            ("Zombie Brute", "act_b"),
        ]

    def test_repeated_import_yields_identical_payload(self, tmp_path):
        mod_dir = build_module(tmp_path)
        first = FoundryModuleImporter().import_module(mod_dir)
        second = FoundryModuleImporter().import_module(mod_dir)
        assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)

    def test_unmapped_lists_are_sorted(self, tmp_path):
        result = FoundryModuleImporter().import_module(build_module(tmp_path))
        unmapped = result["monsters"][0]["unmapped"]
        assert unmapped == sorted(unmapped)


# --- Out-of-scope guard ----------------------------------------------------------------


def test_roll20_export_parsing_is_out_of_scope():
    import vtt_orchestrator.compendium.foundry_importer as fi

    assert not hasattr(fi.FoundryModuleImporter, "import_roll20_export")
    assert getattr(fi, "ROLL20_IN_SCOPE", True) is False
