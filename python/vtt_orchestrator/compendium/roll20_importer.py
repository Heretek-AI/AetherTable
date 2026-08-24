"""Roll20 character importer (GOALS.md Pillar 10 interop).

Reads a REAL Roll20 JSON character/campaign export and projects it onto
AetherTable's character shape (the ``CharacterCreateRequest`` shape served by
``server.py``: name / character_class / level / race / background /
alignment / abilities{STR..CHA} / hp / ac / speed) with explicit per-field
mapping tables, mirroring compendium/foundry_importer.py conventions.

Researched export schema (verified against live sources 2026-08):
- A Roll20 **attribute** object carries ``name``, ``current`` and ``max``
  (plus its owning ``characterid``); values are strings.
  https://help.roll20.net/hc/en-us/articles/360037772793-API-Objects
- Community single-character exporters serialize one character as
  ``{"schema_version": 1, "name": ..., "avatar": ..., "bio": ...,
  "attribs": [{"name": ..., "current": ..., "max": ...}, ...]}`` — the raw
  character model's ``attribs`` collection dumped verbatim:
  https://github.com/justas-d/roll20-character-exporter-importer
  (plugin/roll20-io-payload.js: ``data.attribs = pc.attribs``, imported back
  field-by-field as name/current/max)
- Campaign-wide exports are those same per-character objects gathered into a
  list (or a wrapper object carrying a ``characters`` array).
- The official 5e OGL sheet stores scores and mods as SEPARATE flat
  attributes — ``strength`` / ``strength_mod`` through ``charisma`` /
  ``charisma_mod``; hit points as ``hp`` holding ``current`` AND ``max`` on
  one attribute (some sheet versions add a dedicated ``hp_max``), plus
  ``hp_temp``; armor as ``ac``; movement either as ``speed`` or as
  ``armor_speed`` in the armor section — newer sheet versions moved movement
  into repeating rows, which is why ``armor_speed`` is the reliable alias:
  https://wiki.roll20.net/Black_Cursor/5E_Character_Sheet and the
  community-maintained per-version attribute index
  https://github.com/Roll20/roll20-character-sheets/issues/239
- Class/race/background are ordinary text attributes (``race``,
  ``background``, ``alignment``, ``class`` / multiclass ``class1_name``,
  ``level`` / ``class1_level``) — Roll20 has no dedicated structure for
  them; they are just more name/value pairs.

Mapping decisions (documented conventions, never silent guesses):
- **Explicit mod wins**: an explicit ``<ability>_mod`` attribute beats a mod
  derived from the score; disagreement emits a warning and keeps the
  explicit value.
- **Mod from score** uses the exact 5e formula ``floor((score - 10) / 2)``
  and is emitted silently (lossless).
- **Score from lone mod** uses the convention ``score = 10 + 2 * mod``,
  which is exact only for even mods — so it ALWAYS emits a warning naming
  the convention instead of looking authoritative.
- **Missing core stats** (six abilities, hp/max_hp, ac, speed) become
  ``None`` plus a warning — never fabricated defaults.
- Non-numeric values stay out of typed fields (warning, ``None``); every
  attribute name with no projection lands in the sorted ``unmapped`` list;
  duplicate attribute names keep the FIRST occurrence and warn.
- Speed strings like ``"30 ft."`` normalize to integer feet; anything else
  passes through untouched (never defaulted) AND emits an
  ``unparsable_speed`` warning so the raw text can never masquerade as
  authoritative movement data.

Fail-loud contract: anything that is not a recognizable Roll20 export
(non-mapping scalar, object with neither ``attribs`` nor ``characters``,
empty campaign, unnamed single character) raises ValueError instead of
returning an empty import. Single-character imports return the projected
character dict directly; campaign imports return an envelope
``{"characters": [...], "imported", "skipped", "warnings"}``. Output
ordering (characters by name+source_id, unmapped lists sorted) is
deterministic across runs.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

_ABILITIES = ("STR", "DEX", "CON", "INT", "WIS", "CHA")

# --- Mapping tables ------------------------------------------------------------------
# Roll20 attribute name -> canon ability key. Full names are the official 5e
# OGL sheet; three-letter shorthands appear in community/NPC sheets.

_SCORE_ATTRS: Dict[str, str] = {
    "strength": "STR",
    "dexterity": "DEX",
    "constitution": "CON",
    "intelligence": "INT",
    "wisdom": "WIS",
    "charisma": "CHA",
    "str": "STR",
    "dex": "DEX",
    "con": "CON",
    "int": "INT",
    "wis": "WIS",
    "cha": "CHA",
}

_MOD_ATTRS: Dict[str, str] = {}
for _full, _short, _canon in (
    ("strength", "str", "STR"),
    ("dexterity", "dex", "DEX"),
    ("constitution", "con", "CON"),
    ("intelligence", "int", "INT"),
    ("wisdom", "wis", "WIS"),
    ("charisma", "cha", "CHA"),
):
    _MOD_ATTRS[f"{_full}_mod"] = _canon
    _MOD_ATTRS[f"{_short}_mod"] = _canon

# Text-valued identity fields. First matching attribute name wins, so the
# plain names precede their multiclass variants.
_TEXT_ATTRS: Tuple[Tuple[str, str], ...] = (
    ("race", "race"),
    ("background", "background"),
    ("alignment", "alignment"),
    ("class", "character_class"),
    ("class1_name", "character_class"),
)

# Integer-valued combat stats. First matching attribute name wins, so plain
# "speed" is preferred over the "armor_speed" alias.
_INT_ATTRS: Tuple[Tuple[str, str], ...] = (
    ("ac", "ac"),
    ("speed", "speed"),
    ("armor_speed", "speed"),
    ("level", "level"),
    ("base_level", "level"),
    ("class1_level", "level"),
)

_HP_CURRENT_ATTRS = ("hp", "hit_points")
_HP_MAX_ATTRS = ("hp_max", "max_hp")
_TEMP_HP_ATTRS = ("hp_temp", "temp_hp")

_SPEED_FT_RE = re.compile(r"^\s*(\d+)\s*(?:ft\.?|feet)?\s*$")
_INT_VALUE_RE = re.compile(r"^\s*([+-]?\d+)\s*$")
_FLOAT_VALUE_RE = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*$")

# Top-level document keys consumed structurally (never reported as unmapped).
_CONSUMED_DOC_KEYS = ("name", "id", "_id", "schema_version")

_ABILITY_LABELS = {
    "STR": "strength",
    "DEX": "dexterity",
    "CON": "constitution",
    "INT": "intelligence",
    "WIS": "wisdom",
    "CHA": "charisma",
}


def _coerce_number(raw: Any) -> Optional[Any]:
    """Int/float from a Roll20 attribute value, else None (caller warns)."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        return int(raw) if float(raw).is_integer() else raw
    if isinstance(raw, str):
        if _INT_VALUE_RE.match(raw):
            return int(raw.strip())
        match = _FLOAT_VALUE_RE.match(raw)
        if match:
            value = float(match.group(1))
            return int(value) if value.is_integer() else value
    return None


def _project_speed(raw: Any) -> Tuple[Optional[Any], bool]:
    """Numeric feet for clean values ('30', '30 ft.'); anything else passes
    through untouched rather than guessing a default speed — but with
    ``parsed_ok=False`` so the caller ALWAYS warns about the passthrough
    instead of letting an unparsable string masquerade as authoritative data.

    Returns ``(value, parsed_ok)``: parsed_ok=True means value is integer
    feet; parsed_ok=False means the raw text was kept verbatim (or None when
    there was no text at all).
    """
    if isinstance(raw, bool):
        return None, False
    if isinstance(raw, (int, float)):
        return int(raw), True
    if isinstance(raw, str):
        match = _SPEED_FT_RE.match(raw)
        if match:
            return int(match.group(1)), True
        stripped = raw.strip()
        return (stripped or None), False
    return None, False


class Roll20CharacterImporter:
    """Import a Roll20 JSON character or campaign export into AetherTable canon."""

    def import_character(self, json_doc: Any) -> Dict[str, Any]:
        """Import one single-character export OR a whole campaign export.

        Single-character dict -> projected character dict. List (or
        ``{"characters": [...]}``) -> campaign envelope. Anything else raises
        ValueError (fail loud, mirrors compendium/foundry_importer.py).
        """
        if isinstance(json_doc, list):
            return self._import_campaign(list(json_doc))
        if isinstance(json_doc, dict):
            if isinstance(json_doc.get("characters"), list):
                return self._import_campaign(list(json_doc["characters"]))
            if "attribs" in json_doc:
                if not isinstance(json_doc["attribs"], list):
                    raise ValueError(
                        "Roll20CharacterImporter: 'attribs' must be an array of "
                        f"{{name, current, max}} objects, got "
                        f"{type(json_doc['attribs']).__name__}"
                    )
                return self._project_character(json_doc)
            raise ValueError(
                "Roll20CharacterImporter: unrecognized export object: expected "
                "an 'attribs' array (single character) or a 'characters' array "
                "(campaign export)"
            )
        raise ValueError(
            "Roll20CharacterImporter: expected a Roll20 JSON export "
            f"(dict or list), got {type(json_doc).__name__}"
        )

    # --- Campaign handling -----------------------------------------------------------

    def _import_campaign(self, characters: List[Any]) -> Dict[str, Any]:
        if not characters:
            raise ValueError(
                "Roll20CharacterImporter: campaign export contains no characters"
            )
        projected: List[Dict[str, Any]] = []
        warnings: List[str] = []
        skipped = 0
        for index, doc in enumerate(characters):
            label = f"character[{index}]"
            if not isinstance(doc, dict):
                skipped += 1
                warnings.append(f"skipping malformed {label}: expected object")
                continue
            if not isinstance(doc.get("name"), str) or not doc["name"].strip():
                skipped += 1
                warnings.append(
                    f"skipping unnamed {label} (id={doc.get('id') or doc.get('_id')!r})"
                )
                continue
            try:
                projected.append(self._project_character(doc))
            except ValueError as exc:
                skipped += 1
                warnings.append(f"skipping {label}: {exc}")
        return {
            "characters": self._sorted(projected),
            "warnings": warnings,
            "imported": len(projected),
            "skipped": skipped,
        }

    # --- Single character ------------------------------------------------------------

    def _project_character(self, doc: Dict[str, Any]) -> Dict[str, Any]:
        name = doc.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("unnamed character export (missing/empty 'name')")
        warnings: List[str] = []

        attrs, collect_warnings = self._collect_attributes(doc.get("attribs"))
        warnings.extend(collect_warnings)

        out: Dict[str, Any] = {
            "source_id": doc["id"] if doc.get("id") is not None else doc.get("_id"),
            "name": name.strip(),
            "character_class": None,
            "level": None,
            "race": None,
            "background": None,
            "alignment": None,
            "abilities": {},
            "ability_mods": {},
            "hp": None,
            "max_hp": None,
            "temp_hp": None,
            "ac": None,
            "speed": None,
            "warnings": warnings,
            "unmapped": [],
        }

        self._apply_text_attrs(attrs, out)
        self._apply_int_attrs(attrs, out, warnings)
        self._apply_hit_points(attrs, out, warnings)
        self._apply_abilities(attrs, out, warnings)
        self._warn_missing_core(out)

        consumed = (
            set(_SCORE_ATTRS)
            | set(_MOD_ATTRS)
            | {src for src, _dst in _TEXT_ATTRS}
            | {src for src, _dst in _INT_ATTRS}
            | set(_HP_CURRENT_ATTRS)
            | set(_HP_MAX_ATTRS)
            | set(_TEMP_HP_ATTRS)
        )
        unmapped = [attr_name for attr_name in attrs if attr_name not in consumed]
        unmapped.extend(
            key for key in doc if key not in _CONSUMED_DOC_KEYS and key != "attribs"
        )
        out["unmapped"] = sorted(set(unmapped))
        return out

    # --- Attribute collection ----------------------------------------------------------

    @staticmethod
    def _collect_attributes(attribs: Any) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
        """Flatten attribs[] into {name: {'current': .., 'max': ..}}.

        The FIRST occurrence of an attribute name wins (later ones are
        reported); this keeps output deterministic regardless of export order.
        """
        entries: Dict[str, Dict[str, Any]] = {}
        warnings: List[str] = []
        for index, attr in enumerate(attribs):
            if not isinstance(attr, dict) or not attr.get("name"):
                warnings.append(
                    f"skipping malformed attribute entry at index {index}: "
                    "requires at least 'name'"
                )
                continue
            attr_name = str(attr["name"])
            if attr_name in entries:
                warnings.append(
                    f"duplicate attribute '{attr_name}'; keeping first value "
                    f"{entries[attr_name].get('current')!r} over {attr.get('current')!r}"
                )
                continue
            entries[attr_name] = {
                "current": attr.get("current"),
                "max": attr.get("max"),
            }
        return entries, warnings

    @staticmethod
    def _first_present(
        entries: Dict[str, Dict[str, Any]], candidates: Tuple[str, ...]
    ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        for candidate in candidates:
            if candidate in entries:
                return entries[candidate], candidate
        return None, None

    # --- Field application ---------------------------------------------------------------

    @staticmethod
    def _apply_text_attrs(entries: Dict[str, Dict[str, Any]], out: Dict[str, Any]) -> None:
        for src, dst in _TEXT_ATTRS:
            if out[dst] is not None or src not in entries:
                continue
            text = str(entries[src].get("current") or "").strip()
            if text:
                out[dst] = text

    def _apply_int_attrs(
        self,
        entries: Dict[str, Dict[str, Any]],
        out: Dict[str, Any],
        warnings: List[str],
    ) -> None:
        for src, dst in _INT_ATTRS:
            if out[dst] is not None or src not in entries:
                continue
            raw = entries[src].get("current")
            if dst == "speed":
                projected, parsed_ok = _project_speed(raw)
                if not parsed_ok:
                    # Unparsable movement text passes through verbatim, but it
                    # must never look authoritative: warn every time.
                    warnings.append(
                        f"unparsable_speed: value for '{src}' ({raw!r}) does not "
                        "read as a number of feet; kept verbatim"
                    )
                out[dst] = projected
                continue
            number = _coerce_number(raw)
            if number is None:
                warnings.append(f"non-numeric value for '{src}': {raw!r}")
                continue
            value = int(number)
            if value != number:
                warnings.append(
                    f"non-integer value for '{src}': {raw!r}; truncated to {value}"
                )
            out[dst] = value

    def _apply_hit_points(
        self,
        entries: Dict[str, Dict[str, Any]],
        out: Dict[str, Any],
        warnings: List[str],
    ) -> None:
        hp_entry, hp_src = self._first_present(entries, _HP_CURRENT_ATTRS)
        if hp_src is None:
            warnings.append("missing core stat 'hp'")
            warnings.append("missing core stat 'max_hp'")
        else:
            hp_number = _coerce_number(hp_entry.get("current"))
            if hp_number is None:
                warnings.append(f"non-numeric value for '{hp_src}': {hp_entry.get('current')!r}")
                warnings.append("missing core stat 'max_hp'")
            else:
                out["hp"] = int(hp_number)
                # Official sheet stores max on the same attribute object...
                max_number = _coerce_number(hp_entry.get("max"))
                if max_number is not None:
                    out["max_hp"] = int(max_number)

        if out["max_hp"] is None and hp_src is not None:
            # ...falling back to a dedicated hp_max/max_hp attribute.
            max_entry, max_src = self._first_present(entries, _HP_MAX_ATTRS)
            if max_entry is not None:
                max_number = _coerce_number(max_entry.get("current"))
                if max_number is None:
                    warnings.append(f"non-numeric value for '{max_src}': {max_entry.get('current')!r}")
                else:
                    out["max_hp"] = int(max_number)
            else:
                warnings.append("missing core stat 'max_hp'")

        temp_entry, temp_src = self._first_present(entries, _TEMP_HP_ATTRS)
        if temp_entry is not None:
            temp_number = _coerce_number(temp_entry.get("current"))
            if temp_number is None:
                warnings.append(f"non-numeric value for '{temp_src}': {temp_entry.get('current')!r}")
            else:
                out["temp_hp"] = int(temp_number)

    # --- Abilities ------------------------------------------------------------------------

    def _apply_abilities(
        self,
        entries: Dict[str, Dict[str, Any]],
        out: Dict[str, Any],
        warnings: List[str],
    ) -> None:
        for canon in _ABILITIES:
            out["abilities"][canon] = self._score_for(canon, entries, warnings)
            out["ability_mods"][canon] = self._mod_for(canon, entries, out, warnings)

    def _score_for(
        self,
        canon: str,
        entries: Dict[str, Dict[str, Any]],
        warnings: List[str],
    ) -> Optional[int]:
        label = _ABILITY_LABELS[canon]
        score_src = self._find_key(entries, _SCORE_ATTRS, canon)
        if score_src is not None:
            score = _coerce_number(entries[score_src].get("current"))
            if score is None:
                warnings.append(
                    f"non-numeric value for '{score_src}': "
                    f"{entries[score_src].get('current')!r}"
                )
                return None
            return int(score)
        # No score anywhere: fall back to score = 10 + 2 * mod — loudly,
        # because the convention is exact only for even mods.
        mod_src = self._find_key(entries, _MOD_ATTRS, canon)
        if mod_src is not None:
            mod = _coerce_number(entries[mod_src].get("current"))
            if mod is not None:
                warnings.append(
                    f"missing '{label}'; derived score from '{mod_src}' using "
                    "convention score = 10 + 2 * mod (exact only for even mods)"
                )
                return 10 + 2 * int(mod)
        warnings.append(f"missing core stat '{label}'")
        return None

    def _mod_for(
        self,
        canon: str,
        entries: Dict[str, Dict[str, Any]],
        out: Dict[str, Any],
        warnings: List[str],
    ) -> Optional[int]:
        label = _ABILITY_LABELS[canon]
        explicit: Optional[int] = None
        explicit_src: Optional[str] = None
        mod_src = self._find_key(entries, _MOD_ATTRS, canon)
        if mod_src is not None:
            parsed = _coerce_number(entries[mod_src].get("current"))
            if parsed is None:
                warnings.append(
                    f"non-numeric value for '{mod_src}': "
                    f"{entries[mod_src].get('current')!r}"
                )
            else:
                explicit = int(parsed)
                explicit_src = mod_src

        score = out["abilities"].get(canon)
        derived: Optional[int] = None
        if score is not None:
            derived = (int(score) - 10) // 2  # exact 5e formula

        if explicit is None:
            return derived
        if derived is not None and explicit != derived:
            warnings.append(
                f"explicit '{explicit_src}' {explicit:+d} disagrees with derived "
                f"{derived:+d} from {label} {score}; keeping explicit"
            )
        return explicit

    @staticmethod
    def _find_key(
        entries: Dict[str, Dict[str, Any]], table: Dict[str, str], canon: str
    ) -> Optional[str]:
        """First attribute name in the table mapping to this ability."""
        for attr_name, mapped_canon in table.items():
            if mapped_canon == canon and attr_name in entries:
                return attr_name
        return None

    # --- Core-stat completeness -------------------------------------------------------------

    def _warn_missing_core(self, out: Dict[str, Any]) -> None:
        warnings = out["warnings"]
        for canon in _ABILITIES:
            label = _ABILITY_LABELS[canon]
            missing_marker = f"missing core stat '{label}'"
            # Dedup ONLY against the exact missing-stat notice. A garbage-value
            # warning that merely quotes the label ("non-numeric value for
            # 'strength': 'mighty'") does NOT cover the fact that the score is
            # absent, so the missing-stat warning still fires.
            if out["abilities"][canon] is None and missing_marker not in warnings:
                warnings.append(missing_marker)
        if out["ac"] is None:
            warnings.append("missing core stat 'ac'")
        if out["speed"] is None:
            warnings.append("missing core stat 'speed'")

    # --- Determinism ------------------------------------------------------------------

    @staticmethod
    def _sorted(characters: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Stable canonical ordering: name, then source id."""
        return sorted(
            characters,
            key=lambda c: (str(c.get("name", "")), str(c.get("source_id", ""))),
        )


global_roll20_importer = Roll20CharacterImporter()
