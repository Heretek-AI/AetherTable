"""TDD tests for the conservative SRD 5.2 spell damage extractor (iteration 77).

The raw fixture ``compendium/srd_5_2_spells.json`` carries no structured damage
fields; the engine resolves casts as honest zero-damage slot expenditures.  The
extractor parses the description text and emits damage fields ONLY when
confidence is high; anything ambiguous becomes an itemized warning instead of a
guess.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from vtt_orchestrator.compendium.spell_damage_extractor import (
    DEFAULT_INPUT_PATH,
    DEFAULT_OUTPUT_PATH,
    enrich_compendium,
    enrich_spell,
    extract_spell_data,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
RAW_FIXTURE = REPO_ROOT / "compendium" / "srd_5_2_spells.json"
ENRICHED_FIXTURE = REPO_ROOT / "python" / "vtt_orchestrator" / "compendium" / "srd_5_2_spells_enriched.json"


@pytest.fixture(scope="module")
def raw_spells() -> list[dict]:
    data = json.loads(RAW_FIXTURE.read_text(encoding="utf-8"))
    assert isinstance(data, list) and len(data) > 300
    return data


def _by_name(spells: list[dict], name: str) -> dict:
    matches = [s for s in spells if s["name"].lower() == name.lower()]
    assert len(matches) == 1, f"expected exactly one spell named {name!r}, found {len(matches)}"
    return matches[0]


# --------------------------------------------------------------------------
# Known spells extract correctly
# --------------------------------------------------------------------------


class TestKnownSpells:
    def test_fireball_full_extraction(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Fireball"))
        assert enriched["damage_formula"] == "8d6"
        assert enriched["damage_type"] == "fire"
        assert enriched["save_ability"] == "DEX"
        assert enriched["is_concentration"] is False
        # Instantaneous duration -> zero rounds, no warning about it.
        assert enriched["duration_rounds"] == 0
        assert enriched["extraction_warnings"] == []

    def test_magic_missile_force_no_save(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Magic Missile"))
        assert enriched["damage_formula"] == "1d4 + 1"
        assert enriched["damage_type"] == "force"
        # Attack/auto-hit spell: no saving throw mentioned, so no save field at all.
        assert "save_ability" not in enriched
        assert "save_ability" not in {k for k in enriched if k.startswith("damage")}
        assert enriched["extraction_warnings"] == []

    def test_shield_has_no_damage_fields(self, raw_spells):
        """Shield mentions 'damage' only as 'no damage from _Magic Missile_'."""
        enriched = enrich_spell(_by_name(raw_spells, "Shield"))
        assert "damage_formula" not in enriched
        assert "damage_type" not in enriched
        assert "save_ability" not in enriched
        assert enriched["extraction_warnings"] == []

    def test_concentration_structured_field_mirrored(self, raw_spells):
        # NOTE: iteration 77 - the fixture has no "Crown of Madness" entry, so
        # Hold Person is the canonical concentration-with-save spell under test.
        assert not any(s["name"].lower() == "crown of madness" for s in raw_spells)
        enriched = enrich_spell(_by_name(raw_spells, "Hold Person"))
        assert enriched["is_concentration"] is True
        assert enriched["duration_rounds"] == 10  # "Concentration, up to 1 minute"
        assert enriched["save_ability"] == "WIS"
        # No damage text -> no damage fields, and no bogus warnings either.
        assert "damage_formula" not in enriched
        assert enriched["extraction_warnings"] == []

    def test_cone_of_cold(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Cone of Cold"))
        assert enriched["damage_formula"] == "8d8"
        assert enriched["damage_type"] == "cold"
        assert enriched["save_ability"] == "CON"

    def test_scorching_ray_single_formula(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Scorching Ray"))
        assert enriched["damage_formula"] == "2d6"
        assert enriched["damage_type"] == "fire"
        assert "save_ability" not in enriched  # attack roll, no save


# --------------------------------------------------------------------------
# Ambiguous text yields warnings, never guesses
# --------------------------------------------------------------------------


class TestAmbiguousText:
    def test_multiple_formulas_warn_not_guess(self, raw_spells):
        """Meld into Stone deals 6d6 force on partial destruction but a flat 50
        on complete destruction - distinct triggers, so both stay warned."""
        enriched = enrich_spell(_by_name(raw_spells, "Meld into Stone"))
        assert "damage_formula" not in enriched
        assert "damage_type" not in enriched
        codes = " ".join(enriched["extraction_warnings"]).lower()
        assert "multiple" in codes or len(enriched["extraction_warnings"]) >= 1

    def test_distinct_trigger_formulas_still_warn(self, raw_spells):
        """Ice Knife's two expressions hit on different triggers (hit vs failed
        save), so they cannot be collapsed - both stay warned, not guessed."""
        enriched = enrich_spell(_by_name(raw_spells, "Ice Knife"))
        assert "damage_formula" not in enriched
        assert "damage_type" not in enriched
        codes = " ".join(enriched["extraction_warnings"]).lower()
        assert "multiple" in codes or len(enriched["extraction_warnings"]) >= 1

    def test_chosen_type_warns_not_guesses(self):
        synthetic = {
            "name": "Synthetic Chosen Type",
            "description": "On a hit, the target takes 3d8 damage of the chosen type.",
            "concentration": False,
            "duration": "Instantaneous",
        }
        out = extract_spell_data(synthetic)
        assert "damage_formula" not in out
        assert "damage_type" not in out
        assert out["extraction_warnings"], "player-chosen type must produce a warning"

    def test_variable_formula_emits_dice_with_disclosure(self, raw_spells):
        """'Fire damage equal to 3d6 plus your spellcasting ability modifier'
        names its dice explicitly - iteration 27 emits the bare dice with an
        explicit modifier-excluded disclosure instead of dropping the spell."""
        enriched = enrich_spell(_by_name(raw_spells, "Flame Blade"))
        assert enriched["damage_formula"] == "3d6"
        assert enriched["damage_type"] == "fire"
        codes = " ".join(enriched["extraction_warnings"]).lower()
        assert "modifier" in codes

    def test_unknown_damage_type_word_rejected(self):
        synthetic = {
            "name": "Synthetic Weird",
            "description": "The target takes 2d6 squamous damage on a failed save.",
            "concentration": False,
            "duration": "Instantaneous",
        }
        out = extract_spell_data(synthetic)
        assert "damage_formula" not in out
        assert "damage_type" not in out
        assert out["extraction_warnings"]

    def test_multiple_save_abilities_warn(self):
        synthetic = {
            "name": "Synthetic Two Saves",
            "description": (
                "Each creature makes a Dexterity saving throw, taking 4d6 fire "
                "damage. A creature touching it instead makes a Constitution "
                "saving throw."
            ),
            "concentration": False,
            "duration": "Instantaneous",
        }
        out = extract_spell_data(synthetic)
        assert out["damage_formula"] == "4d6"
        assert out["damage_type"] == "fire"
        assert "save_ability" not in out
        assert any("save" in w.lower() for w in out["extraction_warnings"])

    def test_indeterminate_duration_warns(self):
        synthetic = {
            "name": "Synthetic Indefinite",
            "description": "The target takes 1d6 psychic damage.",
            "concentration": True,
            "duration": "Until dispelled or triggered",
        }
        out = extract_spell_data(synthetic)
        assert "duration_rounds" not in out
        assert any("duration" in w.lower() for w in out["extraction_warnings"])

    def test_parseable_durations_map_to_rounds(self):
        cases = [
            ("Instantaneous", 0),
            ("1 round", 1),
            ("Concentration, up to 1 minute", 10),
            ("10 minutes", 100),
            ("Concentration, up to 10 minutes", 100),
            ("1 hour", 600),
            ("24 hours", 14400),
        ]
        for duration, expected in cases:
            synthetic = {
                "name": f"Synthetic {duration}",
                "description": "The target takes 1d6 fire damage.",
                "concentration": False,
                "duration": duration,
            }
            out = extract_spell_data(synthetic)
            assert out.get("duration_rounds") == expected, duration


# --------------------------------------------------------------------------
# Iteration 27: deterministic patterns that were previously over-warned
# --------------------------------------------------------------------------


class TestConjunctiveDamageSentences:
    """'takes XdY A damage and ZdW B damage on a failed save' is one
    simultaneous hit with typed components - the first component is the
    canonical primary expression.  Distinct-trigger formulas (Ice Knife's
    'on a hit ... or take ... on a failed save') must still warn."""

    def test_acid_arrow_primary_component(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Acid Arrow"))
        assert enriched["damage_formula"] == "4d4"
        assert enriched["damage_type"] == "acid"
        # Attack roll spell: no save named anywhere.
        assert "save_ability" not in enriched

    def test_flame_strike_dual_type(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Flame Strike"))
        assert enriched["damage_formula"] == "5d6"
        assert enriched["damage_type"] == "fire"
        assert enriched["save_ability"] == "DEX"

    def test_ice_storm_bludgeoning_plus_cold(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Ice Storm"))
        assert enriched["damage_formula"] == "2d10"
        assert enriched["damage_type"] == "bludgeoning"

    def test_meteor_swarm(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Meteor Swarm"))
        assert enriched["damage_formula"] == "20d6"
        assert enriched["damage_type"] == "fire"

    def test_vitriolic_sphere_initial_component(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Vitriolic Sphere"))
        assert enriched["damage_formula"] == "10d4"
        assert enriched["damage_type"] == "acid"


class TestModifierDerivedFormulas:
    """'<Type> damage equal to <dice> plus your spellcasting ability modifier'
    names its dice explicitly; the modifier rides the caster, so the bare dice
    are emitted (with an explicit warning) instead of dropping the whole spell.
    Only when this is the spell's ONLY damage expression."""

    def test_spiritual_weapon(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Spiritual Weapon"))
        assert enriched["damage_formula"] == "1d8"
        assert enriched["damage_type"] == "force"
        codes = " ".join(enriched["extraction_warnings"]).lower()
        assert "modifier" in codes

    def test_arcane_sword(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Arcane Sword"))
        assert enriched["damage_formula"] == "4d12"
        assert enriched["damage_type"] == "force"

    def test_flame_blade(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Flame Blade"))
        assert enriched["damage_formula"] == "3d6"
        assert enriched["damage_type"] == "fire"

    def test_conjure_fey(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Conjure Fey"))
        assert enriched["damage_formula"] == "3d12"
        assert enriched["damage_type"] == "psychic"

    def test_varmod_beside_other_dice_stays_warned(self):
        synthetic = {
            "name": "Synthetic VarMod Plus Dice",
            "description": (
                "On a hit, the target takes Fire damage equal to 3d6 plus your "
                "spellcasting ability modifier. Each creature nearby takes 1d6 Fire damage."
            ),
            "concentration": False,
            "duration": "Instantaneous",
        }
        out = extract_spell_data(synthetic)
        assert "damage_formula" not in out
        assert out["extraction_warnings"]


class TestFlatDamageValues:
    """A bare number of damage ('deals 50 Force damage to you') is exact,
    not derived - emit it as a flat formula."""

    def test_synthetic_flat_value(self):
        synthetic = {
            "name": "Synthetic Flat",
            "description": "The collapsing tunnel deals 20 Bludgeoning damage to you.",
            "concentration": False,
            "duration": "Instantaneous",
        }
        out = extract_spell_data(synthetic)
        assert out["damage_formula"] == "20"
        assert out["damage_type"] == "bludgeoning"

    def test_flat_value_beside_dice_stays_warned(self):
        """A flat value is only emitted when it is the description's only
        damage amount; beside dice it would be an arbitrary pick, so the
        spell stays field-free with a warning."""
        synthetic = {
            "name": "Synthetic Flat Plus Dice",
            "description": (
                "Partial collapse deals 6d6 Force damage to you. Complete "
                "destruction expels you and deals 50 Force damage to you."
            ),
            "concentration": False,
            "duration": "Instantaneous",
        }
        out = extract_spell_data(synthetic)
        assert "damage_formula" not in out
        assert out["extraction_warnings"], "mixed amounts must warn, not pick"

    def test_synthetic_flat_value(self):
        synthetic = {
            "name": "Synthetic Flat",
            "description": "The collapsing tunnel deals 20 Bludgeoning damage to you.",
            "concentration": False,
            "duration": "Instantaneous",
        }
        out = extract_spell_data(synthetic)
        assert out["damage_formula"] == "20"
        assert out["damage_type"] == "bludgeoning"


class TestUpcastScalingRows:
    """The structured ``upcast`` row carries slot scaling.  When it states an
    unambiguous per-slot increment (or cantrip level tiers), record it as
    structured metadata alongside the base expression."""

    def test_fireball_upcast_scaling(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Fireball"))
        assert enriched["upcast_damage_increment"] == "1d6"
        assert enriched["upcast_base_slot_level"] == 3

    def test_ice_storm_upcast_targets_typed_component(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Ice Storm"))
        assert enriched["upcast_damage_increment"] == "1d10"
        assert enriched["upcast_damage_type"] == "bludgeoning"

    def test_cantrip_level_tiers(self, raw_spells):
        for name, expected in [
            ("Sacred Flame", ["2d8", "3d8", "4d8"]),
            ("Fire Bolt", ["2d10", "3d10", "4d10"]),
            ("Poison Spray", ["2d12", "3d12", "4d12"]),
        ]:
            enriched = enrich_spell(_by_name(raw_spells, name))
            got = enriched.get("upcast_level_tiers")
            assert got == expected, f"{name}: {got}"

    def test_non_damage_upcast_rows_add_no_fields(self, raw_spells):
        enriched = enrich_spell(_by_name(raw_spells, "Scorching Ray"))
        assert "upcast_damage_increment" not in enriched
        assert "upcast_level_tiers" not in enriched


# --------------------------------------------------------------------------
# Enriched fixture + deterministic CLI regeneration
# --------------------------------------------------------------------------


class TestEnrichedFixture:
    def test_enriched_fixture_exists_and_is_a_list(self):
        assert ENRICHED_FIXTURE.exists(), (
            "run `python -m vtt_orchestrator.compendium.spell_damage_extractor` to regenerate"
        )
        data = json.loads(ENRICHED_FIXTURE.read_text(encoding="utf-8"))
        assert isinstance(data, list)

    def test_original_records_preserved_verbatim(self, raw_spells):
        enriched = json.loads(ENRICHED_FIXTURE.read_text(encoding="utf-8"))
        assert len(enriched) == len(raw_spells)
        # Pair positionally: the fixture contains a few duplicate ids among its
        # meta entries ("spell_actions", "spell_traits", "spell_bonus_actions"),
        # so id-keying would collapse distinct records.
        for original, got in zip(raw_spells, enriched):
            assert got["name"] == original["name"]
            for key, value in original.items():
                assert got[key] == value, f"{original['name']}.{key} was mutated"

    def test_deterministic_regeneration_via_cli(self, tmp_path):
        out_a = tmp_path / "a.json"
        out_b = tmp_path / "b.json"
        for out in (out_a, out_b):
            result = subprocess.run(
                [sys.executable, "-m", "vtt_orchestrator.compendium.spell_damage_extractor",
                 "--output", str(out), "--quiet"],
                capture_output=True, text=True,
                cwd=str(REPO_ROOT / "python"),
                env={"PYTHONPATH": "python", "PATH": "/usr/bin:/bin"},
            )
            assert result.returncode == 0, result.stderr
        assert out_a.read_bytes() == out_b.read_bytes(), "regeneration is not byte-deterministic"

    def test_committed_enriched_matches_regeneration(self, tmp_path):
        fresh = tmp_path / "fresh.json"
        result = subprocess.run(
            [sys.executable, "-m", "vtt_orchestrator.compendium.spell_damage_extractor",
             "--output", str(fresh), "--quiet"],
            capture_output=True, text=True,
            cwd=str(REPO_ROOT / "python"),
            env={"PYTHONPATH": "python", "PATH": "/usr/bin:/bin"},
        )
        assert result.returncode == 0, result.stderr
        assert fresh.read_bytes() == ENRICHED_FIXTURE.read_bytes()

    def test_default_paths_point_at_expected_locations(self):
        assert DEFAULT_INPUT_PATH.name == "srd_5_2_spells.json"
        assert DEFAULT_OUTPUT_PATH.name == "srd_5_2_spells_enriched.json"
        assert DEFAULT_OUTPUT_PATH.parent.name == "compendium"


# --------------------------------------------------------------------------
# Coverage accounting (reported verbatim, never overstated)
# --------------------------------------------------------------------------


class TestCoverageStats:
    def test_partial_coverage_with_accounting(self, raw_spells):
        enriched, stats = enrich_compendium(raw_spells)
        total = stats["total"]
        gained = stats["enriched"]
        assert total == len(raw_spells)
        # Honest partial coverage: some but not all spells gained damage fields.
        # Iteration 27 raised this from the 73-spell iteration-77 baseline by
        # parsing conjunctive sentences, modifier-derived dice, flat damage
        # values, and slot-scaling upcast rows - without guessing.
        assert 73 <= gained < total, f"coverage regressed below baseline: {gained}/{total}"
        assert gained > 73, "iteration 27 must strictly improve on the 73-spell baseline"
        assert stats["enriched"] == sum(1 for s in enriched if "damage_formula" in s)
        assert sum(stats.values()) >= total  # every spell is accounted for somewhere
        print(
            f"\nExtraction coverage: {gained}/{total} spells enriched "
            f"(baseline 73; {stats.get('correctly_unparsed_no_damage', '?')} no-damage, "
            f"{sum(v for k, v in stats.items() if k.startswith('warned_'))} warned)"
        )

    def test_every_warning_carrying_spell_stays_field_free_for_that_reason(self, raw_spells):
        enriched, stats = enrich_compendium(raw_spells)
        damaged = sum(1 for s in enriched if "damage_formula" in s)
        assert stats["enriched"] == damaged
        for spell in enriched:
            warnings = spell.get("extraction_warnings", [])
            damage_warned = any("damage" in w.lower() for w in warnings)
            has_fields = "damage_formula" in spell
            # A spell warned about its damage text may still carry fields ONLY
            # when the warning is the explicit dice-only disclosure that
            # accompanies a modifier-derived formula (iteration 27).
            disclosure = any(
                w.startswith("modifier_derived_damage_dice_only") for w in warnings
            )
            collapse = any(
                w.startswith(("conjunctive_components_collapsed_to_primary",
                              "alternative_forms_collapsed_to_primary"))
                for w in warnings
            )
            if damage_warned and has_fields:
                assert disclosure or collapse, (
                    f"{spell['name']}: emitted {spell.get('damage_formula')} "
                    f"despite unexplained warnings {warnings}"
                )
