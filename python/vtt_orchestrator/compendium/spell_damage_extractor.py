"""Conservative damage extraction for the SRD 5.2 spell fixture (iteration 77).

The raw fixture ``compendium/srd_5_2_spells.json`` carries no structured damage
fields, so the engine resolves every cast as an honest zero-damage slot
expenditure (iteration 76 disclosure).  The descriptions DO carry canonical SRD
phrasing such as::

    taking 8d6 Fire damage on a failed save or half as much damage on a
    successful one
    A dart deals 1d4 + 1 Force damage to its target.

This module parses that phrasing into structured fields:

``damage_formula``    e.g. ``"8d6"`` or ``"1d4 + 1"``
``damage_type``       lowercased, e.g. ``"fire"`` / ``"force"``
``save_ability``      ``"DEX"`` when exactly one "Dexterity saving throw" etc.
                      is named
``is_concentration``  mirrored from the fixture's already-structured boolean
``duration_rounds``   heuristic conversion of the duration string at 6 seconds
                      per round

Extraction is deliberately CONSERVATIVE: fields are emitted only when the
canonical pattern matches with high confidence and unambiguously.  Anything
ambiguous (multiple distinct formulas, player-chosen damage types,
ability-modifier-derived formulas, unrecognized type words, indeterminate
durations) stays absent and is itemized in ``extraction_warnings`` instead of
being guessed.

CLI (regenerates the enriched fixture deterministically)::

    python -m vtt_orchestrator.compendium.spell_damage_extractor [--output PATH]
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

__all__ = [
    "DEFAULT_INPUT_PATH",
    "DEFAULT_OUTPUT_PATH",
    "extract_spell_data",
    "enrich_spell",
    "enrich_compendium",
    "main",
]

_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_INPUT_PATH = _REPO_ROOT / "compendium" / "srd_5_2_spells.json"
DEFAULT_OUTPUT_PATH = Path(__file__).resolve().parent / "srd_5_2_spells_enriched.json"

# The thirteen canonical D&D damage types.  A matched word outside this set is
# not a damage type (e.g. prose fragments) and is rejected rather than guessed.
DAMAGE_TYPES = frozenset(
    {
        "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
        "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
    }
)

_SAVE_ABILITIES = {
    "Strength": "STR",
    "Dexterity": "DEX",
    "Constitution": "CON",
    "Intelligence": "INT",
    "Wisdom": "WIS",
    "Charisma": "CHA",
}

# Canonical "<dice> <type> damage" phrasing ("8d6 Fire damage", "1d4 + 1 Force
# damage").  The dice term may carry a flat modifier.
_DAMAGE_RE = re.compile(
    r"\b(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s+([A-Za-z]+)\s+damage\b"
)

# Derived formulas ("<type> damage equal to <dice> plus your spellcasting
# ability modifier") - emitting the bare dice would under-report, so these are
# warned about rather than extracted.
_VARIABLE_FORMULA_RE = re.compile(
    r"\b([A-Za-z]+)\s+damage\s+equal\s+to\s+\d+d\d+", re.IGNORECASE
)

# Player-chosen damage types ("takes 3d8 damage of the chosen type").
_CHOSEN_TYPE_RE = re.compile(r"\b\d+d\d+\s+damage of the chosen type", re.IGNORECASE)

_SAVE_RE = re.compile(
    r"\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw"
)

_DURATION_RE = re.compile(r"(\d+)\s*(round|minute|hour|day)", re.IGNORECASE)
_SECONDS_PER_ROUND = 6
_UNIT_ROUNDS = {
    "round": 1,
    "minute": 10,   # 60 s / 6 s
    "hour": 600,    # 3600 s / 6 s
    "day": 14400,   # 86400 s / 6 s
}


def _normalize_formula(formula: str) -> str:
    """Canonicalize dice-notation spacing, e.g. ``1d4 + 1``, ``20d6``."""
    compact = formula.strip()
    return re.sub(r"\s*([+\-])\s*", r" \1 ", compact)


def extract_damage_expression(description: str) -> tuple[list[tuple[str, str]], list[str]]:
    """Return (unique (formula, type) expressions, warnings) from a description.

    Only canonical ``<dice> <known-type> damage`` phrasings count; anything else
    produces a warning explaining why nothing was emitted.
    """
    warnings: list[str] = []
    found = _DAMAGE_RE.findall(description or "")
    unique: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    rejected_types: list[str] = []

    for formula_raw, type_raw in found:
        damage_type = type_raw.lower()
        if damage_type not in DAMAGE_TYPES:
            if damage_type not in rejected_types:
                rejected_types.append(damage_type)
            continue
        key = (_normalize_formula(formula_raw), damage_type)
        if key not in seen:
            seen.add(key)
            unique.append(key)

    # Sanity-check the dice terms themselves (NdM with plausible N and M).
    validated: list[tuple[str, str]] = []
    for formula, damage_type in unique:
        match = re.fullmatch(r"(\d+)d(\d+)(?: ([+\-]) (\d+))?", formula)
        if not match or int(match.group(1)) > 50 or match.group(2) not in {
            "4", "6", "8", "10", "12", "20", "100"
        }:
            warnings.append(f"implausible_dice_notation_omitted: '{formula} {damage_type}'")
            continue
        validated.append((formula, damage_type))

    if rejected_types:
        warnings.append(
            "unrecognized_damage_type_word_rejected: "
            + ", ".join(f"'{t}'" for t in rejected_types)
        )

    if len(validated) > 1:
        rendered = ", ".join(f"{formula} {dtype}" for formula, dtype in validated)
        warnings.append(f"multiple_damage_formulas_ambiguous: {rendered}")
        return [], warnings

    if not validated:
        if _CHOSEN_TYPE_RE.search(description):
            warnings.append("chosen_damage_type_unspecified: damage type is chosen at cast time")
        elif _VARIABLE_FORMULA_RE.search(description):
            warnings.append(
                "variable_formula_derived_from_modifier: "
                "'<type> damage equal to <dice> plus spellcasting modifier' not reduced to dice"
            )
        elif re.search(r"\bdamage\b", description, re.IGNORECASE) and not re.search(
            r"\bno damage\b", description, re.IGNORECASE
        ):
            warnings.append(
                "no_canonical_damage_expression: description mentions damage but no "
                "'<dice> <type> damage' pattern was found"
            )
    return validated, warnings


def extract_save_ability(description: str) -> tuple[str | None, list[str]]:
    """Return (save ability abbreviation, warnings); None when absent/ambiguous."""
    abilities = {ability for ability in _SAVE_RE.findall(description or "")}
    if len(abilities) == 0:
        return None, []
    if len(abilities) > 1:
        names = ", ".join(sorted(abilities))
        return None, [f"multiple_save_abilities_ambiguous: {names}"]
    return _SAVE_ABILITIES[abilities.pop()], []


def extract_duration_rounds(duration: str) -> tuple[int | None, list[str]]:
    """Heuristically convert a duration string to combat rounds (6 s each)."""
    text = (duration or "").strip()
    if not text:
        return None, []
    lowered = text.lower()
    if lowered == "instantaneous":
        return 0, []
    match = _DURATION_RE.search(lowered)
    if not match:
        return None, [f"duration_rounds_indeterminate: {text!r}"]
    count = int(match.group(1))
    unit = match.group(2)
    return count * _UNIT_ROUNDS[unit], []


def extract_spell_data(spell: dict[str, Any]) -> dict[str, Any]:
    """Extract conservative damage metadata for one spell record.

    Returns a dict containing ``extraction_warnings`` always, plus only those
    structured fields whose extraction met the confidence bar.
    """
    description = spell.get("description", "")
    warnings: list[str] = []

    out: dict[str, Any] = {}
    out["is_concentration"] = bool(spell.get("concentration", False))

    expressions, damage_warnings = extract_damage_expression(description)
    warnings.extend(damage_warnings)
    if expressions:
        formula, damage_type = expressions[0]
        out["damage_formula"] = formula
        out["damage_type"] = damage_type

    save_ability, save_warnings = extract_save_ability(description)
    warnings.extend(save_warnings)
    if save_ability is not None:
        out["save_ability"] = save_ability

    duration_rounds, duration_warnings = extract_duration_rounds(spell.get("duration", ""))
    warnings.extend(duration_warnings)
    if duration_rounds is not None:
        out["duration_rounds"] = duration_rounds

    out["extraction_warnings"] = warnings
    return out


def enrich_spell(spell: dict[str, Any]) -> dict[str, Any]:
    """Copy a spell verbatim and append the extracted fields (absent if ambiguous)."""
    enriched = dict(spell)
    extracted = extract_spell_data(spell)
    warnings = extracted.pop("extraction_warnings")
    enriched.update(extracted)
    enriched["extraction_warnings"] = warnings
    return enriched


def enrich_compendium(spells: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Enrich every spell and account for how each one fared.

    Returns ``(enriched_records, stats)`` where stats partitions the compendium:
    ``total``, ``enriched`` (gained damage fields), and per-warning-category
    counts plus ``no_damage_mention`` for clean no-damage spells.
    """
    enriched_records: list[dict[str, Any]] = []
    stats = {
        "total": len(spells),
        "enriched": 0,
        "warned_multi_formula": 0,
        "warned_chosen_type": 0,
        "warned_variable_formula": 0,
        "warned_no_pattern": 0,
        "warned_save_or_duration_only": 0,
        "no_damage_mention": 0,
    }
    for spell in spells:
        enriched = enrich_spell(spell)
        enriched_records.append(enriched)
        if "damage_formula" in enriched:
            stats["enriched"] += 1
            continue
        joined = " ".join(enriched["extraction_warnings"]).lower()
        if "multiple_damage_formulas" in joined:
            stats["warned_multi_formula"] += 1
        elif "chosen_damage_type" in joined:
            stats["warned_chosen_type"] += 1
        elif "variable_formula" in joined or "no_canonical_damage_expression" in joined:
            stats["warned_variable_formula"] += 1
        elif any(w.startswith(("unrecognized_damage_type", "implausible_dice")) for w in enriched["extraction_warnings"]):
            stats["warned_variable_formula"] += 1
        elif enriched["extraction_warnings"]:
            stats["warned_save_or_duration_only"] += 1
        else:
            stats["no_damage_mention"] += 1
    return enriched_records, stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="vtt_orchestrator.compendium.spell_damage_extractor",
        description="Regenerate the enriched SRD 5.2 spell fixture deterministically.",
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH)
    parser.add_argument("--quiet", action="store_true", help="suppress the coverage report")
    args = parser.parse_args(argv)

    spells = json.loads(args.input.read_text(encoding="utf-8"))
    enriched, stats = enrich_compendium(spells)
    payload = json.dumps(enriched, indent=2, ensure_ascii=False) + "\n"
    args.output.write_text(payload, encoding="utf-8")

    if not args.quiet:
        print(
            f"Extraction coverage: {stats['enriched']}/{stats['total']} spells enriched "
            f"(conservative: ambiguous descriptions stay field-free)"
        )
        for key, value in stats.items():
            if key not in ("total", "enriched"):
                print(f"  {key}: {value}")
        print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
