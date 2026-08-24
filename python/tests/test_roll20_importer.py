"""Tests for the Roll20 character importer (Pillar 10 interop).

Fixtures are crafted in-test to mirror the REAL Roll20 JSON export shapes:
a single-character export ``{schema_version, name, avatar, bio, attribs[]}``
where every attribute is a ``{name, current, max}`` triple, and multi-
character campaign exports (either a bare list of those objects or a
wrapper object with a ``characters`` array). See roll20_importer.py's
module docstring for the researched sources these shapes come from.
"""

import json

import pytest

from vtt_orchestrator.compendium.roll20_importer import Roll20CharacterImporter


# --- Fixture builders ---------------------------------------------------------------


def _attr(name, current, max_=None):
    attr = {"name": name, "current": current}
    if max_ is not None:
        attr["max"] = max_
    return attr


def thorin(doc_id=None):
    """Realistic 5e OGL-sheet single-character export (fully mappable)."""
    doc = {
        "schema_version": 1,
        "name": "Thorin",
        "avatar": "https://s3.amazonaws.com/files.d20.io/images/x.png",
        "bio": "<p>Dwarf fighter of the Karas guard.</p>",
        "attribs": [
            _attr("strength", "15"),
            _attr("strength_mod", "2"),
            _attr("dexterity", "14"),
            _attr("dexterity_mod", "2"),
            _attr("constitution", "13"),
            _attr("constitution_mod", "1"),
            _attr("intelligence", "10"),
            _attr("intelligence_mod", "0"),
            _attr("wisdom", "8"),
            _attr("wisdom_mod", "-1"),
            _attr("charisma", "7"),
            _attr("charisma_mod", "-2"),
            _attr("hp", "22", max_="26"),
            _attr("hp_temp", "0"),
            _attr("ac", "16"),
            _attr("speed", "30 ft."),
            _attr("race", "Hill Dwarf"),
            _attr("background", "Soldier"),
            _attr("alignment", "Neutral Good"),
            _attr("class", "Fighter"),
            _attr("level", "5"),
            # Community-sheet extras with no AetherTable projection.
            _attr("pb", "3"),
            _attr("initiative_bonus", "2"),
            _attr("passive_wisdom", "9"),
        ],
    }
    if doc_id is not None:
        doc["id"] = doc_id
    return doc


def brann(doc_id="chr_brann"):
    doc = thorin(doc_id)
    doc["name"] = "Brann"
    doc["attribs"] = [
        _attr("strength", "16"),
        _attr("strength_mod", "3"),
        _attr("dexterity", "12"),
        _attr("constitution", "14"),
        _attr("intelligence", "8"),
        _attr("wisdom", "10"),
        _attr("charisma", "12"),
        _attr("hp", "30", max_="30"),
        _attr("ac", "18"),
        _attr("armor_speed", "25"),
        _attr("level", "6"),
    ]
    return doc


# --- Happy path ---------------------------------------------------------------------


class TestHappyPath:
    def test_single_character_export_maps_scores_and_core_stats(self):
        out = Roll20CharacterImporter().import_character(thorin())

        assert out["name"] == "Thorin"
        assert out["abilities"] == {
            "STR": 15, "DEX": 14, "CON": 13, "INT": 10, "WIS": 8, "CHA": 7,
        }
        assert out["ability_mods"] == {
            "STR": 2, "DEX": 2, "CON": 1, "INT": 0, "WIS": -1, "CHA": -2,
        }
        assert out["hp"] == 22
        assert out["max_hp"] == 26
        assert out["temp_hp"] == 0
        assert out["ac"] == 16
        assert out["speed"] == 30  # "30 ft." normalized to feet
        assert out["character_class"] == "Fighter"
        assert out["level"] == 5
        assert out["race"] == "Hill Dwarf"
        assert out["background"] == "Soldier"
        assert out["alignment"] == "Neutral Good"
        # Fully mappable export: nothing guessed, nothing dropped silently.
        assert out["warnings"] == []

    def test_explicit_mod_wins_over_derived_and_disagreement_warns(self):
        doc = thorin()
        # floor((15-10)/2) = +2, so claim +4 explicitly: explicit must win.
        for attr in doc["attribs"]:
            if attr["name"] == "strength_mod":
                attr["current"] = "4"
        out = Roll20CharacterImporter().import_character(doc)

        assert out["ability_mods"]["STR"] == 4
        assert any(
            "strength_mod" in w and "disagree" in w for w in out["warnings"]
        )

    def test_mod_derived_from_score_when_mod_missing(self):
        doc = thorin()
        doc["attribs"] = [
            a for a in doc["attribs"] if a["name"] != "dexterity_mod"
        ]
        out = Roll20CharacterImporter().import_character(doc)
        # floor((14-10)/2) = +2, exact 5e formula, no warning needed.
        assert out["ability_mods"]["DEX"] == 2
        assert not any("dexterity_mod" in w for w in out["warnings"])

    def test_score_derived_from_lone_even_mod_records_convention(self):
        doc = thorin()
        doc["attribs"] = [a for a in doc["attribs"] if a["name"] != "wisdom"]
        out = Roll20CharacterImporter().import_character(doc)
        # Convention: score = 10 + 2 * mod (exact only for even mods), so a
        # lone mod MUST surface a warning instead of looking authoritative.
        assert out["abilities"]["WIS"] == 8  # 10 + 2 * (-1)... see warning
        assert any("wisdom" in w and "convention" in w for w in out["warnings"])

    def test_speed_alias_armor_speed(self):
        out = Roll20CharacterImporter().import_character(brann())
        assert out["speed"] == 25

    def test_max_hp_via_dedicated_hp_max_attribute(self):
        doc = thorin()
        doc["attribs"] = [
            _attr("hp", "22") if a["name"] == "hp" else a for a in doc["attribs"]
        ]
        doc["attribs"].append(_attr("hp_max", "26"))
        out = Roll20CharacterImporter().import_character(doc)
        assert out["hp"] == 22
        assert out["max_hp"] == 26

    def test_source_id_taken_from_id_field(self):
        out = Roll20CharacterImporter().import_character(thorin("chr_thorin"))
        assert out["source_id"] == "chr_thorin"


# --- Multi-character campaign exports ------------------------------------------------


class TestCampaignExport:
    def test_bare_list_of_characters_is_imported(self):
        result = Roll20CharacterImporter().import_character([thorin(), brann()])
        assert result["imported"] == 2
        assert result["skipped"] == 0
        assert [c["name"] for c in result["characters"]] == ["Brann", "Thorin"]

    def test_characters_key_wrapper_object_is_imported(self):
        result = Roll20CharacterImporter().import_character(
            {"characters": [thorin(), brann()]}
        )
        assert result["imported"] == 2
        assert len(result["characters"]) == 2

    def test_unnamed_character_is_skipped_with_warning(self):
        anon = thorin("chr_anon")
        anon["name"] = ""
        result = Roll20CharacterImporter().import_character([anon, brann()])
        assert [c["name"] for c in result["characters"]] == ["Brann"]
        assert result["skipped"] == 1
        assert any("unnamed" in w.lower() for w in result["warnings"])

    def test_empty_campaign_export_fails_loud(self):
        with pytest.raises(ValueError, match="no characters"):
            Roll20CharacterImporter().import_character([])
        with pytest.raises(ValueError, match="no characters"):
            Roll20CharacterImporter().import_character({"characters": []})


# --- Fail-loud contract ---------------------------------------------------------------


class TestFailLoud:
    @pytest.mark.parametrize("garbage", [None, 42, "thorin.json", 3.14])
    def test_non_mapping_input_raises_value_error(self, garbage):
        with pytest.raises(ValueError):
            Roll20CharacterImporter().import_character(garbage)

    def test_dict_without_attribs_or_characters_raises_value_error(self):
        with pytest.raises(ValueError, match="attribs"):
            Roll20CharacterImporter().import_character({"name": "Thorin"})

    def test_non_list_attribs_raises_value_error(self):
        with pytest.raises(ValueError, match="attribs"):
            Roll20CharacterImporter().import_character({"name": "T", "attribs": {}})


# --- Honest accounting -----------------------------------------------------------------


class TestUnmappedAccounting:
    def test_unmapped_attributes_are_listed_sorted(self):
        out = Roll20CharacterImporter().import_character(thorin())
        assert out["unmapped"] == sorted(out["unmapped"])
        for name in ("pb", "initiative_bonus", "passive_wisdom"):
            assert name in out["unmapped"]
        assert "avatar" in out["unmapped"]
        assert "bio" in out["unmapped"]

    def test_mapped_fields_never_appear_in_unmapped(self):
        out = Roll20CharacterImporter().import_character(thorin())
        for mapped in (
            "strength", "strength_mod", "hp", "ac", "speed", "race",
            "class", "level", "name", "schema_version",
        ):
            assert mapped not in out["unmapped"]

    def test_duplicate_attribute_names_keep_first_and_warn(self):
        doc = thorin()
        doc["attribs"].append(_attr("strength", "18"))
        out = Roll20CharacterImporter().import_character(doc)
        assert out["abilities"]["STR"] == 15
        assert any("duplicate" in w.lower() and "strength" in w for w in out["warnings"])

    def test_non_numeric_score_warns_and_stays_none(self):
        doc = thorin()
        for attr in doc["attribs"]:
            if attr["name"] == "strength":
                attr["current"] = "mighty"
        out = Roll20CharacterImporter().import_character(doc)
        assert out["abilities"]["STR"] is None
        assert any("strength" in w and "non-numeric" in w for w in out["warnings"])
        # A value we could not parse is not silently reclassified as unmapped.
        assert "strength" not in out["unmapped"]


# --- Speed projection honesty -----------------------------------------------------------


class TestSpeedProjection:
    def test_unparsable_speed_passes_through_with_warning(self):
        """A movement string the regex cannot reduce to feet ('walk 30 ft.')
        is passed through verbatim AND surfaced as an unparsable-speed
        warning — never silently handed downstream as if authoritative."""
        doc = thorin()
        for attr in doc["attribs"]:
            if attr["name"] == "speed":
                attr["current"] = "walk 30 ft."
        out = Roll20CharacterImporter().import_character(doc)

        assert out["speed"] == "walk 30 ft."
        assert any(
            "unparsable" in w.lower() and "speed" in w.lower()
            for w in out["warnings"]
        )

    def test_empty_speed_value_still_warns(self):
        doc = thorin()
        for attr in doc["attribs"]:
            if attr["name"] == "speed":
                attr["current"] = "   "
        out = Roll20CharacterImporter().import_character(doc)
        assert any("speed" in w.lower() for w in out["warnings"])

    def test_numeric_and_ft_suffixed_speeds_stay_warning_free(self):
        assert Roll20CharacterImporter().import_character(thorin())["warnings"] == []
        assert Roll20CharacterImporter().import_character(brann())["warnings"] == []


# --- Missing core stats: warnings, never defaults --------------------------------------


class TestMissingCoreStats:
    def test_removed_core_stats_warn_and_default_to_none(self):
        doc = thorin()
        drop = {"ac", "speed", "wisdom"}
        doc["attribs"] = [a for a in doc["attribs"] if a["name"] not in drop]
        doc["attribs"] = [a for a in doc["attribs"] if a["name"] != "wisdom_mod"]
        out = Roll20CharacterImporter().import_character(doc)

        assert out["ac"] is None
        assert out["speed"] is None
        assert out["abilities"]["WIS"] is None
        warned = " ".join(out["warnings"])
        assert "'ac'" in warned
        assert "'speed'" in warned
        assert "'wisdom'" in warned

    def test_garbage_value_does_not_suppress_missing_core_stat_warning(self):
        """The dedup heuristic must only suppress against real 'missing core
        stat' warnings — a garbage-value warning quoting the same label is
        not a substitute for the missing-stat notice."""
        doc = thorin()
        for attr in doc["attribs"]:
            if attr["name"] == "strength":
                attr["current"] = "mighty"
        out = Roll20CharacterImporter().import_character(doc)

        assert out["abilities"]["STR"] is None
        assert any("non-numeric value for 'strength'" in w for w in out["warnings"])
        assert any("missing core stat 'strength'" in w for w in out["warnings"])

    def test_missing_hp_reports_both_halves(self):
        doc = thorin()
        doc["attribs"] = [a for a in doc["attribs"] if a["name"] != "hp"]
        out = Roll20CharacterImporter().import_character(doc)
        assert out["hp"] is None
        assert out["max_hp"] is None
        warned = " ".join(out["warnings"])
        assert "'hp'" in warned
        assert "'max_hp'" in warned


# --- Determinism ------------------------------------------------------------------------


class TestDeterministicOutput:
    def test_characters_sorted_by_name_then_source_id(self):
        b = thorin("chr_b")
        b["name"] = "Zelda"
        a = thorin("chr_a")
        a["name"] = "Aria"
        dup1 = thorin("chr_dup1")
        dup1["name"] = "Aria"
        dup2 = thorin("chr_dup2")
        dup2["name"] = "Aria"
        result = Roll20CharacterImporter().import_character([dup2, b, dup1, a])
        assert [(c["name"], c["source_id"]) for c in result["characters"]] == [
            ("Aria", "chr_a"),
            ("Aria", "chr_dup1"),
            ("Aria", "chr_dup2"),
            ("Zelda", "chr_b"),
        ]

    def test_repeated_import_yields_identical_payload(self):
        importer = Roll20CharacterImporter()
        doc = [thorin("chr_1"), brann("chr_2")]
        first = json.dumps(importer.import_character(doc), sort_keys=True)
        second = json.dumps(importer.import_character(doc), sort_keys=True)
        assert first == second

    def test_output_survives_json_round_trip(self):
        out = Roll20CharacterImporter().import_character(thorin())
        reparsed = json.loads(json.dumps(out))
        assert reparsed == out
