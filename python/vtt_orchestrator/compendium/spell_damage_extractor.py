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
    "extract_upcast_scaling",
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
# ability modifier").  Iteration 27: when such a sentence is the spell's ONLY
# damage expression, the named dice are emitted with an explicit warning that
# the spellcasting-ability modifier is not included; in any other context they
# stay warned-about rather than extracted.
_VARIABLE_FORMULA_RE = re.compile(
    r"\b([A-Za-z]+)\s+damage\s+equal\s+to\s+\d+d\d+", re.IGNORECASE
)

_MODIFIER_DERIVED_RE = re.compile(
    r"\b([A-Za-z]+)\s+damage\s+equal\s+to\s+(\d+d\d+)\s+plus\s+"
    r"your\s+spellcasting\s+ability\s+modifier",
    re.IGNORECASE,
)

# Exact flat damage values ("deals 50 Force damage to you").  A bare number of
# hit points is exact, not derived, so it extracts as a flat formula.
_FLAT_DAMAGE_RE = re.compile(
    r"\b(?:takes|taking|deals|dealing|suffers?)\s+(\d+)\s+[A-Za-z]+\s+damage\b",
    re.IGNORECASE,
)

# Slot-scaling upcast rows (iteration 27).  Two canonical shapes exist:
#   "The damage increases by 1d6 for each spell slot level above 3."
#   "The Fire damage increases by 1d10 for each spell slot level above 4."
_UPCAST_INCREMENT_RE = re.compile(
    r"^(?:[A-Z][A-Za-z ,']{0,40}?)?The (?:initial )?(?:damage|healing) "
    r"increase[s]?\s+by\s+(?P<inc>\d+d\d+)\s+(?:for|per)\s+(?:each|every)\s+"
    r"(?:spell\s+)?slot\s+level\s+above\s+(?P<base>\d+)\.?$",
    re.IGNORECASE,
)

_UPCAST_TYPED_INCREMENT_RE = re.compile(
    r"^The\s+(?P<type>[A-Z][a-z]+)\s+damage\s+increase[s]?\s+by\s+"
    r"(?P<inc>\d+d\d+)\s+(?:for|per)\s+(?:each|every)\s+(?:spell\s+)?"
    r"slot\s+level\s+above\s+(?P<base>\d+)\.?$",
    re.IGNORECASE,
)

# Cantrip scaling: "The damage increases by 1d8 when you reach levels
# 5 (2d8), 11 (3d8), and 17 (4d8)."  The parenthetical totals are canonical.
_UPCAST_TIER_RE = re.compile(
    r"^The damage increase[s]?\s+by\s+\d+d\d+\s+when\s+you\s+reach\s+levels\s+"
    r"(?P<tiers>.+)\.$",
    re.IGNORECASE,
)
_TIER_TOTAL_RE = re.compile(r"(\d+)\s*\((\d+d\d+)\)")

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
    """Return (primary (formula, type) expression, warnings) from a description.

    Canonical ``<dice> <known-type> damage`` phrasings count; iteration 27 adds
    three deterministic rescues for previously over-warned shapes:

    1. Conjunctive sentences ("takes 5d6 Fire damage and 5d6 Radiant damage on
       a failed save") are one simultaneous hit with typed components; the
       first component is emitted as the primary expression.
    2. Modifier-derived sentences ("<Type> damage equal to <dice> plus your
       spellcasting ability modifier"), when they are the spell's only damage
       expression, emit their named dice with an explicit warning that the
       modifier is excluded.
    3. Exact flat values ("deals 50 Force damage") extract as a flat formula.

    Anything genuinely choice-dependent (cast-time type choices, alignment-
    dependent types, distinct triggers per component, multiple independent
    formulas) stays field-free and itemized in warnings - never guessed.
    """
    text = description or ""
    warnings: list[str] = []
    unique: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    rejected_types: list[str] = []
    sentence_of: dict[tuple[str, str], str] = {}

    for sentence in _split_sentences(text):
        for formula_raw, type_raw in _DAMAGE_RE.findall(sentence):
            damage_type = type_raw.lower()
            if damage_type not in DAMAGE_TYPES:
                if damage_type not in rejected_types:
                    rejected_types.append(damage_type)
                continue
            key = (_normalize_formula(formula_raw), damage_type)
            if key not in seen:
                seen.add(key)
                unique.append(key)
                sentence_of[key] = sentence.strip()

    # Sanity-check the dice terms themselves (NdM with plausible N and M).
    validated: list[tuple[str, str]] = []
    implausible: list[str] = []
    for formula, damage_type in unique:
        match = re.fullmatch(r"(\d+)d(\d+)(?: ([+\-]) (\d+))?", formula)
        if not match or int(match.group(1)) > 50 or match.group(2) not in {
            "4", "6", "8", "10", "12", "20", "100"
        }:
            implausible.append(f"'{formula} {damage_type}'")
            continue
        validated.append((formula, damage_type))
    if implausible:
        warnings.append(f"implausible_dice_notation_omitted: {', '.join(implausible)}")

    if len(validated) > 1:
        rescued = _rescue_multi_formula(validated, sentence_of)
        if rescued is not None:
            primary, rescue_warning = rescued
            warnings.append(rescue_warning)
            return [primary], warnings
        rendered = ", ".join(f"{formula} {dtype}" for formula, dtype in validated)
        warnings.append(f"multiple_damage_formulas_ambiguous: {rendered}")
        return [], warnings

    # A canonical dice expression coexisting with a modifier-derived or flat
    # amount means several distinct damage events - picking one would
    # misrepresent the spell, so warn instead of emitting.
    if len(validated) == 1 and (_MODIFIER_DERIVED_RE.search(text)):
        warnings.append(
            "variable_formula_derived_from_modifier: description mixes '<type> "
            "damage equal to <dice> plus spellcasting modifier' with another "
            f"amount ({validated[0][0]} {validated[0][1]}); not reduced"
        )
        return [], warnings
    if len(validated) == 1 and _FLAT_DAMAGE_RE.search(text):
        warnings.append(
            "mixed_flat_and_dice_amounts_ambiguous: description names both "
            f"a flat damage value and '{validated[0][0]} {validated[0][1]}'"
        )
        return [], warnings

    if not validated:
        modifier_match = _MODIFIER_DERIVED_RE.search(text)
        if modifier_match:
            outside = _MODIFIER_DERIVED_RE.sub(" ", text)
            if not re.search(r"\d+d\d+|\b\d+\s+[A-Za-z]+\s+damage\b", outside):
                dtype = modifier_match.group(1).lower()
                dice = _normalize_formula(modifier_match.group(2))
                if dtype in DAMAGE_TYPES:
                    warnings.append(
                        "modifier_derived_damage_dice_only: emitting "
                        f"'{dice} {dtype}' excludes the spellcasting-ability modifier "
                        "named in the description"
                    )
                    return [(dice, dtype)], warnings

        flat_matches = list(_FLAT_DAMAGE_RE.finditer(text))
        for flat_match in flat_matches:
            dtype_word = re.match(
                r"\b(?:takes|taking|deals|dealing|suffers?)\s+(\d+)\s+([A-Za-z]+)\s+damage\b",
                flat_match.group(0),
                re.IGNORECASE,
            )
            dtype = (dtype_word.group(2) if dtype_word else "").lower()
            outside = (
                text[:flat_match.start()] + " " + text[flat_match.end():]
            )
            if dtype in DAMAGE_TYPES and not re.search(r"\d+d\d+", outside) and not any(
                other != flat_match for other in flat_matches
            ):
                return [(flat_match.group(1), dtype)], warnings

        if _CHOSEN_TYPE_RE.search(text):
            warnings.append("chosen_damage_type_unspecified: damage type is chosen at cast time")
        elif _VARIABLE_FORMULA_RE.search(text):
            warnings.append(
                "variable_formula_derived_from_modifier: "
                "'<type> damage equal to <dice> plus spellcasting modifier' not reduced to dice"
            )
        elif re.search(r"\bdamage\b", text, re.IGNORECASE) and not re.search(
            r"\bno damage\b", text, re.IGNORECASE
        ):
            warnings.append(
                "no_canonical_damage_expression: description mentions damage but no "
                "'<dice> <type> damage' pattern was found"
            )
    return validated, warnings


def _split_sentences(text: str) -> list[str]:
    """Split a description into sentences on '.', '!' and '?' terminators."""
    return [chunk for chunk in re.split(r"(?<=[.!?])\s+", text or "") if chunk]


# A conjunctive sentence names several components of ONE simultaneous hit
# ("takes 5d6 Fire damage and 5d6 Radiant damage on a failed save"); an
# alternative sentence offers cast-time options ("3d8 Radiant or Necrotic").
_CONJUNCTIVE_RE = re.compile(r"\bdamage\s+and\s+(?:another\s+)?\d+d\d+", re.IGNORECASE)

_ALTERNATIVE_RE = re.compile(r"damage\s+\(?or\s+\d+d\d+|[A-Za-z]+\s+damage\s+\(if", re.IGNORECASE)

# Choice-dependent phrasing inside the damage sentence blocks any multi-formula
# rescue: which component applies depends on a decision the text cannot make.
_CHOICE_DEPENDENT_RE = re.compile(
    r"chosen|your\s+choice|spirit's\s+type|warm\s+shield|chill\s+shield|"
    r"\(if\s+you\s+are\s+evil\)|weapon's\s+normal\s+damage\s+type|"
    r"damage\s+is\s+[A-Z][a-z]+,\s*[A-Z]",
    re.IGNORECASE,
)


def _rescue_multi_formula(
    validated: list[tuple[str, str]],
    sentence_of: dict[tuple[str, str], str],
) -> tuple[tuple[str, str], str] | None:
    """Return ((formula, type), warning) when all formulas share one conjunctive
    or alternative sentence; None when the formulas are genuinely ambiguous."""
    sentences = {sentence_of.get(key, "") for key in validated}
    if len(sentences) != 1:
        return None  # components trigger on different events (e.g. Ice Knife)
    sentence = next(iter(sentences))
    if _CHOICE_DEPENDENT_RE.search(sentence):
        return None
    joined = ", ".join(f"{formula} {dtype}" for formula, dtype in validated)
    if _CONJUNCTIVE_RE.search(sentence):
        return (
            validated[0],
            f"conjunctive_components_collapsed_to_primary: '{joined}' are typed "
            "components of one hit; only the first is reported",
        )
    if _ALTERNATIVE_RE.search(sentence):
        return (
            validated[0],
            f"alternative_forms_collapsed_to_primary: '{joined}' are alternatives; "
            "only the first is reported",
        )
    return None


def extract_upcast_scaling(upcast: str) -> tuple[dict[str, Any], list[str]]:
    """Parse a structured ``upcast`` row into slot-scaling metadata.

    Recognized shapes (iteration 27):
      ``The damage increases by 1d6 for each spell slot level above 3.``
      ``The Fire damage increases by 1d10 for each spell slot level above 4.``
      ``The damage increases by 1d8 when you reach levels 5 (2d8), ...`` (cantrips)

    Returns ({}, []) when the row scales something other than damage (extra
    targets, duration, range) so no fields are fabricated.
    """
    text = (upcast or "").strip()
    if not text:
        return {}, []

    typed = _UPCAST_TYPED_INCREMENT_RE.match(text)
    plain = _UPCAST_INCREMENT_RE.match(text)
    tiered = _UPCAST_TIER_RE.match(text)

    out: dict[str, Any] = {}
    if typed:
        damage_type = typed.group("type").lower()
        if damage_type in DAMAGE_TYPES:
            out["upcast_damage_increment"] = typed.group("inc")
            out["upcast_base_slot_level"] = int(typed.group("base"))
            out["upcast_damage_type"] = damage_type
        return out, []
    if plain:
        out["upcast_damage_increment"] = plain.group("inc")
        out["upcast_base_slot_level"] = int(plain.group("base"))
        return out, []
    if tiered:
        totals = [
            total
            for _, total in sorted(
                _TIER_TOTAL_RE.findall(tiered.group("tiers")), key=lambda p: int(p[0])
            )
        ]
        if totals:
            out["upcast_level_tiers"] = totals
        return out, []
    return {}, []


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

    # Slot-scaling metadata from the structured upcast row.  Recorded whenever a
    # damage-scaling row parses, but only when the spell itself yielded exactly
    # one base expression (scaling an ambiguous base would compound the guess).
    scaling, _ = extract_upcast_scaling(spell.get("upcast", ""))
    if scaling and len(expressions) == 1:
        out.update(scaling)

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
        "correctly_unparsed_no_damage": 0,
        "no_damage_mention": 0,
    }
    for spell in spells:
        enriched = enrich_spell(spell)
        enriched_records.append(enriched)
        if "damage_formula" in enriched:
            stats["enriched"] += 1
            continue
        warnings = enriched.get("extraction_warnings", [])
        joined = " ".join(warnings).lower()
        if "multiple_damage_formulas" in joined:
            stats["warned_multi_formula"] += 1
        elif "chosen_damage_type" in joined:
            stats["warned_chosen_type"] += 1
        elif "variable_formula" in joined or "no_canonical_damage_expression" in joined:
            stats["warned_variable_formula"] += 1
        elif any(w.startswith(("unrecognized_damage_type", "implausible_dice")) for w in warnings):
            stats["warned_variable_formula"] += 1
        elif warnings:
            stats["warned_save_or_duration_only"] += 1
        else:
            # No damage fields and no warnings: the spell deals no damage
            # (buffs, control, utility) - correctly left unenriched.
            stats["correctly_unparsed_no_damage"] += 1
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
