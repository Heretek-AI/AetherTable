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
        """Acid Arrow deals 4d4 acid plus 2d4 acid splash - two expressions."""
        enriched = enrich_spell(_by_name(raw_spells, "Acid Arrow"))
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

    def test_variable_formula_warns_not_guesses(self, raw_spells):
        """'Fire damage equal to 3d6 plus your spellcasting ability modifier'
        is derived damage - emitting bare 3d6 would under-report."""
        enriched = enrich_spell(_by_name(raw_spells, "Flame Blade"))
        assert "damage_formula" not in enriched
        assert "damage_type" not in enriched
        assert enriched["extraction_warnings"]

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
        assert 0 < gained < total, f"suspicious coverage: {gained}/{total}"
        assert stats["enriched"] == sum(1 for s in enriched if "damage_formula" in s)
        assert stats["warned_multi_formula"] >= 1
        assert sum(stats.values()) >= total  # every spell is accounted for somewhere
        print(
            f"\nExtraction coverage: {gained}/{total} spells enriched "
            f"({stats['warned_multi_formula']} multi-formula warned, "
            f"{stats['warned_chosen_type']} chosen-type warned, "
            f"{stats['warned_variable_formula']} variable-formula warned, "
            f"{stats['no_damage_mention']} with no damage mention)"
        )

    def test_every_warning_carrying_spell_stays_field_free_for_that_reason(self, raw_spells):
        enriched, stats = enrich_compendium(raw_spells)
        damaged = sum(1 for s in enriched if "damage_formula" in s)
        assert stats["enriched"] == damaged
        for spell in enriched:
            damage_warned = any(
                "damage" in warning.lower() for warning in spell.get("extraction_warnings", [])
            )
            has_fields = "damage_formula" in spell
            # A spell warned about its damage text must never guess anyway.
            assert not (damage_warned and has_fields), (
                f"{spell['name']}: emitted {spell.get('damage_formula')} "
                f"despite warnings {spell.get('extraction_warnings')}"
            )
