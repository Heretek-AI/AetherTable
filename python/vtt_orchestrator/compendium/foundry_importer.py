"""Foundry VTT module importer (GOALS.md Pillar 10 interop).

Reads a REAL Foundry module layout and projects it onto AetherTable canon
(monsters / items / maps) with explicit per-entry mapping tables.

Researched manifest schema (verified against live docs 2026-08):
- ``module.json`` is the manifest; core fields include ``id``, ``title``,
  ``version`` and a ``packs`` array.
  https://foundryvtt.com/article/module-development/#manifest
- Each pack entry carries ``name`` (required, unique reference key), ``label``
  (display), ``path`` (pack database file relative to the module dir) and
  ``type`` (one of Adventure | Actor | Cards | Item | JournalEntry | Macro |
  Playlist | RollTable | Scene).
  https://github.com/League-of-Foundry-Developers/foundry-vtt-types
  (foundry/common/abstract/_module.mjs, ManifestFlags/CompendiumTypes)
- "Export Pack" writes each document as ONE JSON object per line in the pack
  file (NDJSON, LF-separated, UTF-8):
  https://foundryvtt.com/article/compendium/
- Actor documents carry combat stats under ``system.attributes.ac.value``,
  ``system.attributes.hp.{value,max}``, ``system.attributes.speed`` and
  ``system.abilities.<abi>.value`` (dnd5e convention); weapons/actions are
  embedded ``items[]`` entries with ``system.attack.bonus`` and
  ``system.damage.parts: [[formula, type]]``.
  Example line from community tooling:
  {"_id":"...","name":"Goblin","type":"npc","system":{"attributes":{"ac":
  {"value":15},"hp":{"value":7,"max":7}}},"items":[...]}
  https://github.com/orangetech7490/foundry-vtt-json-to-compendium
- Scene documents carry pixel dimensions (``width``/``height``/``grid`` grid
  size) and embedded ``walls[]`` entries shaped ``{c: [x1,y1,x2,y2], door,
  ls, move, sight, ...}`` with absolute pixel coordinates:
  https://github.com/levik/foundry-dungeon-importer

Fail-loud contract (mirrors compendium/homebrew_parser.py): a module without
a readable manifest or a valid ``version`` raises ValueError instead of
returning an empty import. Everything that CAN be imported is projected via
the mapping tables below; anything unmappable lands in the per-entry
``unmapped`` list or in module-level ``warnings`` — never silently dropped
and never guessed.

Roll20 export parsing is OUT OF SCOPE this iteration (see ROLL20_IN_SCOPE);
it would be trivially adjacent (a single-character JSON export rather than
module-dir + NDJSON packs) but needs its own fixture corpus first.
"""

import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

# Roll20 export parsing intentionally deferred to a later iteration.
ROLL20_IN_SCOPE = False

# Pack types we can project onto canon today. Others (JournalEntry, RollTable,
# Macro, Playlist, Cards, Adventure) are counted as skipped with a warning.
_SUPPORTED_PACK_TYPES = ("Actor", "Item", "Scene")

_ABILITY_KEYS = ("str", "dex", "con", "int", "wis", "cha")

# --- Per-entry mapping tables -------------------------------------------------------
# dotted source path -> canon field. Containers consumed wholesale by custom
# logic ("system", "items", "walls") are listed separately so the leftover-key
# accounting can distinguish "consumed" from "unmapped".

ACTOR_FIELD_MAP: Dict[str, str] = {
    "name": "name",
    "type": "actor_type",
    "system.attributes.ac.value": "ac",
    "system.attributes.hp.value": "hp",
    "system.attributes.hp.max": "max_hp",
    "system.attributes.speed.value": "speed",
}

ACTOR_CONSUMED_CONTAINERS = ("system", "items", "_id")

ITEM_FIELD_MAP: Dict[str, str] = {
    "name": "name",
    "type": "category",
    "system.description.value": "description",
    "system.rarity": "rarity",
    "system.price.value": "price_value",
    "system.price.denomination": "price_denomination",
    "system.quantity": "quantity",
    "system.weight.value": "weight_lbs",
}

ITEM_CONSUMED_CONTAINERS = ("system", "_id")

SCENE_FIELD_MAP: Dict[str, str] = {
    "name": "name",
    "width": "dimensions.width",
    "height": "dimensions.height",
    "grid": "dimensions.grid_size",
    "gridSize": "dimensions.grid_size",
}

SCENE_CONSUMED_CONTAINERS = ("walls", "_id")

WALL_FIELD_MAP: Dict[str, str] = {
    "c[0]": "x1",
    "c[1]": "y1",
    "c[2]": "x2",
    "c[3]": "y2",
    "door": "door",
}

_SPEED_FT_RE = re.compile(r"^\s*(\d+)\s*(?:ft\.?|feet)?\s*$")


def _get_path(doc: Dict[str, Any], dotted: str) -> Tuple[bool, Any]:
    """Resolve a dotted path; returns (found, value)."""
    cur: Any = doc
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return False, None
        cur = cur[part]
    return True, cur


def _set_path(target: Dict[str, Any], dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    for part in parts[:-1]:
        target = target.setdefault(part, {})
        if not isinstance(target, dict):  # pragma: no cover - defensive
            return
    target[parts[-1]] = value


def _apply_field_map(
    doc: Dict[str, Any],
    field_map: Dict[str, str],
    consumed_containers: Tuple[str, ...],
    out: Dict[str, Any],
) -> List[str]:
    """Project mapped dotted paths into ``out``; return sorted unmapped keys."""
    consumed = set(consumed_containers)
    for src, dst in field_map.items():
        found, value = _get_path(doc, src)
        if not found:
            continue
        root_key = src.split(".")[0]
        # A leaf mapping consumes only its exact path; containers stay open so
        # their un-mapped children can still be reported.
        if "." not in src:
            consumed.add(src)
        _set_path(out, dst, value)

    # Leftover accounting: top-level keys never touched, plus second-level keys
    # inside consumed containers (e.g. system.details on an actor). A child of a
    # consumed container counts as mapped only when some leaf mapping descends
    # into it.
    mapped_children: set[str] = {
        ".".join(src.split(".")[:2]) for src in field_map if "." in src and len(src.split(".")) >= 2
    }
    leftovers: List[str] = []
    for key, value in doc.items():
        if key in consumed:
            # Consumed containers report per-child leftovers (only children no
            # leaf mapping descends into).
            for sub in value if isinstance(value, dict) else ():
                if f"{key}.{sub}" not in mapped_children:
                    leftovers.append(f"{key}.{sub}")
            continue
        # Unknown top-level containers are wholly unmapped: report the container
        # itself ("flags"), not each descendant.
        leftovers.append(key)
    return sorted(set(leftovers))


def _project_speed(raw: Any) -> Any:
    """Numeric feet when the value is clean ('30', '30 ft.'); otherwise pass the
    raw string through untouched — never guess a default speed."""
    if isinstance(raw, (int, float)):
        return int(raw)
    if isinstance(raw, str):
        match = _SPEED_FT_RE.match(raw)
        if match:
            return int(match.group(1))
        return raw
    return None


class FoundryModuleImporter:
    """Import a Foundry VTT module directory into AetherTable canon."""

    def import_module(self, module_dir: str) -> Dict[str, Any]:
        module_dir = os.fspath(module_dir)
        manifest_path = os.path.join(module_dir, "module.json")
        if not os.path.isfile(manifest_path):
            raise ValueError(
                f"FoundryModuleImporter: missing module.json at {manifest_path}"
            )
        try:
            with open(manifest_path, "r", encoding="utf-8") as fh:
                manifest = json.load(fh)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError(
                f"FoundryModuleImporter: invalid JSON in {manifest_path}: {exc}"
            ) from exc
        if not isinstance(manifest, dict):
            raise ValueError(
                f"FoundryModuleImporter: module.json must be a JSON object at "
                f"{manifest_path} (got {type(manifest).__name__})"
            )

        version = manifest.get("version")
        if not isinstance(version, str) or not version.strip():
            raise ValueError(
                f"FoundryModuleImporter: invalid or missing 'version' in "
                f"{manifest_path} (got {version!r})"
            )

        module_id = manifest.get("id") or manifest.get("name") or os.path.basename(
            module_dir
        )
        title = manifest.get("title") or module_id

        warnings: List[str] = []
        monsters: List[Dict[str, Any]] = []
        items: List[Dict[str, Any]] = []
        maps: List[Dict[str, Any]] = []
        imported = 0
        skipped = 0

        packs = manifest.get("packs")
        if packs is None:
            packs = []
            warnings.append("manifest has no 'packs' array")
        if not isinstance(packs, list):
            raise ValueError(
                f"FoundryModuleImporter: 'packs' must be an array in {manifest_path}"
            )

        for index, pack in enumerate(packs):
            pack_name = pack.get("name") if isinstance(pack, dict) else None
            label = f"{pack_name or f'pack[{index}]'}"
            if not isinstance(pack, dict) or not pack.get("path") or not pack.get("type"):
                skipped += 1
                warnings.append(
                    f"malformed pack entry {label}: requires name/label/path/type"
                )
                continue

            pack_type = str(pack["type"])
            handler = {
                "Actor": self._project_actor,
                "Item": self._project_item,
                "Scene": self._project_scene,
            }.get(pack_type)
            if handler is None:
                skipped += 1
                warnings.append(f"unsupported pack type '{pack_type}' in pack {label}")
                continue

            pack_abs = self._contained_pack_path(module_dir, str(pack["path"]))
            if pack_abs is None:
                skipped += 1
                warnings.append(
                    f"pack {label}: path escapes or sits outside the module "
                    f"directory and was not read: {pack['path']}"
                )
                continue
            if os.path.isdir(pack_abs):
                skipped += 1
                warnings.append(
                    f"LevelDB-format pack directory unsupported this iteration: {label}"
                )
                continue
            if not os.path.isfile(pack_abs):
                skipped += 1
                warnings.append(f"missing pack file for {label}: {pack['path']}")
                continue

            documents, bad_lines = self._read_ndjson(pack_abs)
            for line_no, reason in bad_lines:
                warnings.append(
                    f"pack {label}: skipping malformed JSON on line {line_no} ({reason})"
                )
                skipped += 1

            for doc in documents:
                projected = handler(doc)
                if projected is None:
                    skipped += 1
                    warnings.append(
                        f"pack {label}: skipping unnamed document "
                        f"(id={doc.get('_id')!r})"
                    )
                    continue
                if pack_type == "Actor":
                    monsters.append(projected)
                elif pack_type == "Item":
                    items.append(projected)
                else:
                    maps.append(projected)
                imported += 1

        return {
            "module": {"id": module_id, "title": title, "version": version},
            "monsters": self._sorted(monsters),
            "items": self._sorted(items),
            "maps": self._sorted(maps),
            "warnings": warnings,
            "imported": imported,
            "skipped": skipped,
        }

    # --- Manifest path containment ---------------------------------------------------

    @staticmethod
    def _contained_pack_path(module_dir: str, pack_path: str) -> Optional[str]:
        """Resolve a manifest-controlled ``pack.path`` against ``module_dir``
        and return the absolute target ONLY when it stays inside the module
        directory; return None when it escapes (``../``, an absolute path, or
        any other shape that resolves outside the tree). The manifest is
        attacker-controlled input for uploaded modules, so containment is
        checked on the RESOLVED path — the same discipline the extraction
        layer applies to entry names."""
        resolved = os.path.normpath(os.path.join(module_dir, pack_path))
        root = os.path.abspath(module_dir)
        if os.path.commonpath([root, os.path.abspath(resolved)]) != root:
            return None
        return resolved

    # --- NDJSON reading -------------------------------------------------------------

    @staticmethod
    def _read_ndjson(path: str) -> Tuple[List[Dict[str, Any]], List[Tuple[int, str]]]:
        """Parse one-JSON-document-per-line pack content (Export Pack format).

        Blank lines are tolerated (common hand-edited exports); malformed lines
        are reported as (line_number, reason) instead of aborting the pack.
        """
        documents: List[Dict[str, Any]] = []
        bad_lines: List[Tuple[int, str]] = []
        with open(path, "r", encoding="utf-8") as fh:
            for line_no, raw in enumerate(fh, start=1):
                stripped = raw.strip()
                if not stripped:
                    continue
                try:
                    doc = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    bad_lines.append((line_no, f"{exc.msg} at column {exc.colno}"))
                    continue
                if isinstance(doc, dict):
                    documents.append(doc)
                else:
                    bad_lines.append((line_no, f"expected object, got {type(doc).__name__}"))
        return documents, bad_lines

    # --- Per-type projection --------------------------------------------------------

    def _project_actor(self, doc: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        name = doc.get("name")
        if not isinstance(name, str) or not name.strip():
            return None
        out: Dict[str, Any] = {
            "source_id": doc.get("_id"),
            "name": name.strip(),
            "ac": None,
            "hp": None,
            "max_hp": None,
            "speed": None,
            "abilities": {},
            "actions": [],
            "unmapped": [],
        }

        abilities_raw = doc.get("system", {}).get("abilities", {})
        for key in _ABILITY_KEYS:
            entry = abilities_raw.get(key) if isinstance(abilities_raw, dict) else None
            out["abilities"][key.upper()] = (
                entry.get("value") if isinstance(entry, dict) else None
            )

        for item in doc.get("items", []) or []:
            action = self._project_action(item)
            if action is not None:
                out["actions"].append(action)
            else:
                item_name = item.get("name") if isinstance(item, dict) else None
                out["unmapped"].append(
                    f"items[{item_name or '?'}]: no attack/damage data"
                )

        speed_found, speed_val = _get_path(doc, "system.attributes.speed.value")
        if speed_found:
            out["speed"] = _project_speed(speed_val)

        # Re-run the generic map minus the speed leaf (already normalized above)
        remaining_map = {
            k: v for k, v in ACTOR_FIELD_MAP.items()
            if k != "system.attributes.speed.value"
        }
        unmapped = _apply_field_map(doc, remaining_map, ACTOR_CONSUMED_CONTAINERS, out)
        # Ability sub-keys outside the six canonical scores count as unmapped.
        if isinstance(abilities_raw, dict):
            for key in abilities_raw:
                if key.lower() not in _ABILITY_KEYS:
                    unmapped.append(f"system.abilities.{key}")
        out["unmapped"] = sorted(set(out["unmapped"]) | set(unmapped))
        return out

    @staticmethod
    def _project_action(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Embedded weapon/item -> canon action. Only items carrying real attack
        or damage data become actions (no fabricated '+X / YdZ' math)."""
        if not isinstance(item, dict):
            return None
        system = item.get("system", {}) if isinstance(item.get("system"), dict) else {}
        damage_parts = system.get("damage", {}).get("parts") or []
        attack_bonus = system.get("attack", {}).get("bonus")
        if not damage_parts and attack_bonus is None:
            return None
        action: Dict[str, Any] = {
            "name": item.get("name"),
            **({"to_hit": str(attack_bonus)} if attack_bonus is not None else {}),
        }
        if damage_parts and isinstance(damage_parts[0], (list, tuple)) and len(damage_parts[0]) >= 2:
            action["damage_formula"] = damage_parts[0][0]
            action["damage_type"] = damage_parts[0][1]
        elif damage_parts and isinstance(damage_parts[0], str):
            action["damage_formula"] = damage_parts[0]
        return action

    def _project_item(self, doc: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        name = doc.get("name")
        if not isinstance(name, str) or not name.strip():
            return None
        out: Dict[str, Any] = {
            "source_id": doc.get("_id"),
            "name": name.strip(),
            "unmapped": [],
        }
        out["unmapped"] = _apply_field_map(doc, ITEM_FIELD_MAP, ITEM_CONSUMED_CONTAINERS, out)
        return out

    def _project_scene(self, doc: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        name = doc.get("name")
        if not isinstance(name, str) or not name.strip():
            return None
        out: Dict[str, Any] = {
            "source_id": doc.get("_id"),
            "name": name.strip(),
            "dimensions": {},
            "walls": [],
            "unmapped": [],
        }

        walls_raw = doc.get("walls", [])
        if isinstance(walls_raw, list):
            for index, wall in enumerate(walls_raw):
                if not isinstance(wall, dict):
                    continue
                coords = wall.get("c")
                projected_wall: Dict[str, Any] = {}
                if isinstance(coords, (list, tuple)) and len(coords) >= 4:
                    for coord_idx, canon_key in enumerate(("x1", "y1", "x2", "y2")):
                        projected_wall[canon_key] = coords[coord_idx]
                else:
                    projected_wall["unmapped"] = ["c"]
                if "door" in wall:
                    projected_wall["door"] = bool(wall["door"])
                leftovers = [
                    key for key in wall
                    if key != "door" and not (key == "c" and "x1" in projected_wall)
                ]
                projected_wall["unmapped"] = sorted(
                    set(projected_wall.get("unmapped", [])) | set(leftovers)
                )
                out["walls"].append(projected_wall)

        unmapped = _apply_field_map(doc, SCENE_FIELD_MAP, SCENE_CONSUMED_CONTAINERS, out)
        if walls_raw and not isinstance(walls_raw, list):
            unmapped.append("walls")
        out["unmapped"] = sorted(set(out["unmapped"]) | set(unmapped))
        return out

    # --- Determinism ------------------------------------------------------------------

    @staticmethod
    def _sorted(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Stable canonical ordering: name, then source id."""
        return sorted(entries, key=lambda e: (str(e.get("name", "")), str(e.get("source_id", ""))))


global_foundry_importer = FoundryModuleImporter()
