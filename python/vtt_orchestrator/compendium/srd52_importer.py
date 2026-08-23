"""
D&D 5e SRD 5.2.1 Markdown Parser & Ingestion Pipeline
Extracts structured JSON compendiums from the flat-file markdown layout of
github.com/downfallx/dnd-5e-srd-markdown (CC BY 4.0, Wizards of the Coast).

Domains: monsters, spells, magic items, feats, origins (backgrounds &
species), animals, and the rules glossary.
"""

import os
import re
import json
from typing import List, Dict, Any, Optional

# The source markdown uses U+2212 MINUS SIGN in tables; normalize before int().
_MINUS = "−"

DEFAULT_SOURCE_DIR = "/tmp/research_repos/dnd-5e-srd-markdown"


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _to_int(token: str) -> int:
    return int(token.strip().replace(_MINUS, "-"))


def _clean(text: str) -> str:
    """Collapse markdown artifacts (<br>, emsp indents) and whitespace into prose."""
    text = text.replace("<br>", " ").replace("&emsp;", " ")
    return re.sub(r"\s+", " ", text).strip()


def _read(path: str) -> Optional[str]:
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _split_entries(content: str, level: int) -> List[Dict[str, str]]:
    """Split markdown into {name, body} entries delimited by headings of `level`."""
    pattern = re.compile(r"^#{%d}\s+(.+?)\s*$" % level, re.MULTILINE)
    matches = list(pattern.finditer(content))
    entries = []
    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        entries.append({"name": match.group(1).strip(), "body": content[match.end():end]})
    return entries


class SRD52StatblockParser:
    """Parses 5.2 stat blocks (monsters-A-Z.md / animals.md).

    Layout per entry: a `### Name` (or bare `## Name`) heading, italic
    size/type/alignment line, bold AC/Initiative/HP/Speed lines, an HTML
    ability table, bold Skills/Senses/Languages/CR lines, then
    `#### Traits / Actions / Bonus Actions / Legendary Actions / Reactions`
    sections whose powers look like `**_Name._** description`.
    """

    SECTION_KEYS = {
        "traits": "traits",
        "actions": "actions",
        "bonus actions": "bonus_actions",
        "legendary actions": "legendary_actions",
        "reactions": "reactions",
    }

    def parse_file(self, path: str, category: str = "monster") -> List[Dict[str, Any]]:
        content = _read(path)
        if not content:
            return []
        results: List[Dict[str, Any]] = []
        for top in _split_entries(content, 2):
            subentries = _split_entries(top["body"], 3)
            # Grouped bestiary files (monsters-A-Z.md) nest one `###` stat
            # block per creature under a `##` group heading; flat files
            # (animals.md) put the stat block straight under `## Name` with
            # `### Traits/Actions` subsections. Prefer nested blocks that
            # actually contain a stat line; otherwise treat the level-2
            # entry itself as the stat block.
            stat_subentries = [e for e in subentries if "**AC**" in e["body"]]
            candidates = (
                [(e["name"], e["body"]) for e in stat_subentries]
                if stat_subentries
                else [(top["name"], top["body"])]
            )
            for name, body in candidates:
                parsed = self._parse_statblock(name, body, category=category)
                if parsed:
                    parsed["category"] = category
                    if category == "animal":
                        parsed.setdefault("creature_type", "Beast")
                        parsed.setdefault("alignment", "unaligned")
                    results.append(parsed)
        return results

    def _parse_statblock(self, name: str, body: str, category: str = "monster") -> Optional[Dict[str, Any]]:
        ac_match = re.search(r"\*\*AC\*\*\s*(\d+)", body)
        hp_match = re.search(r"\*\*HP\*\*\s*(\d+)\s*(?:\(([^)]+)\))?", body)
        if not ac_match or not hp_match:
            return None  # Not a stat block (group intro / rules prose)

        abilities = {"STR": 10, "DEX": 10, "CON": 10, "INT": 10, "WIS": 10, "CHA": 10}
        saving_throws: List[str] = []

        type_line_match = re.search(r"_([A-Za-z]+)\s+(.+?),\s*([^_]+)_", body)
        size, creature_type, alignment = "Medium", "Humanoid", "unaligned"
        if type_line_match:
            size = type_line_match.group(1)
            creature_type = type_line_match.group(2).strip()
            alignment = type_line_match.group(3).strip()

        for ab in re.finditer(
            r"<td>\s*<strong>(STR|DEX|CON|INT|WIS|CHA)</strong>\s*</td>\s*"
            r"<td>(\d+)</td>\s*<td>([+−]\d+)</td>\s*<td>([+−]\d+)</td>",
            body,
        ):
            key, score, mod, save = ab.groups()
            abilities[key] = int(score)
            if _to_int(save) != _to_int(mod):
                saving_throws.append(f"{key} {_to_int(save):+d}")

        speed_match = re.search(r"\*\*Speed\*\*\s*(.*?)(?:<br>|\n)", body)
        cr_match = re.search(r"\*\*CR\*\*\s*([0-9/]+)\s*\((?:XP\s*([\d,]+))?", body)
        pb_match = re.search(r"PB\s*([+−]?\d+)", body)
        skills_match = re.search(r"\*\*Skills\*\*(.*?)(?:<br>|\n)", body)
        senses_match = re.search(r"\*\*Senses\*\*(.*?)(?:<br>|\n)", body)
        lang_match = re.search(r"\*\*Languages\*\*(.*?)(?:<br>|\n)", body)

        def bold_value(match: Optional[re.Match]) -> str:
            if not match:
                return ""
            return _clean(match.group(1) or match.group(2))

        sections: Dict[str, List[Dict[str, str]]] = {
            "traits": [], "actions": [], "bonus_actions": [], "legendary_actions": [], "reactions": []
        }
        current_key: Optional[str] = None
        for line in body.split("\n"):
            heading = re.match(r"^#{3,4}\s+(.+?)\s*$", line)
            if heading:
                # Section headers appear as `#### Actions` (bestiary) or
                # `### Actions` (flat animal files); creature-name headings
                # never match these keys, so they are simply ignored.
                current_key = self.SECTION_KEYS.get(heading.group(1).strip().lower())
                continue
            if current_key is None:
                continue
            power_match = re.match(r"\*\*_([^_]+?)_\*\*\s*(.*)$", line)
            if power_match:
                sections[current_key].append({
                    "name": power_match.group(1).strip().rstrip("."),
                    "description": _clean(power_match.group(2)),
                })

        result: Dict[str, Any] = {
            "id": ("animal_" if category == "animal" else "monster_") + _slug(name),
            "name": name,
            "size": size,
            "creature_type": creature_type,
            "alignment": alignment,
            "ac": int(ac_match.group(1)),
            "hp": int(hp_match.group(1)),
            "hit_dice": hp_match.group(2) or "",
            "speed": bold_value(speed_match) or "30 ft.",
            "abilities": abilities,
            "saving_throws": saving_throws,
            "skills": [s.strip() for s in bold_value(skills_match).split(",") if s.strip()],
            "damage_vulnerabilities": [],
            "damage_resistances": [],
            "damage_immunities": [],
            "condition_immunities": [],
            "senses": bold_value(senses_match) or "Passive Perception 10",
            "languages": bold_value(lang_match) or "--",
            "traits": sections["traits"],
            "actions": sections["actions"],
            "bonus_actions": sections["bonus_actions"],
            "legendary_actions": sections["legendary_actions"],
            "reactions": sections["reactions"],
        }
        if cr_match:
            result["challenge_rating"] = cr_match.group(1)
            if cr_match.group(2):
                result["xp"] = int(cr_match.group(2).replace(",", ""))
        if pb_match:
            result["proficiency_bonus"] = _to_int(pb_match.group(1))
        return result


class SRD52SpellParser:
    """Parses spells.md: `#### Name` + italic level line + bold field lines."""

    SCHOOLS = ("Abjuration", "Conjuration", "Divination", "Enchantment",
               "Evocation", "Illusion", "Necromancy", "Transmutation")

    def parse_file(self, path: str) -> List[Dict[str, Any]]:
        content = _read(path)
        if not content:
            return []
        spells: List[Dict[str, Any]] = []
        for entry in _split_entries(content, 4):
            spell = self._parse_spell(entry["name"], entry["body"])
            if spell:
                spells.append(spell)
        return spells

    def _parse_spell(self, raw_name: str, body: str) -> Optional[Dict[str, Any]]:
        header_match = re.search(r"_([^_]+)_", body)
        if not header_match:
            return None
        header_text = header_match.group(1)

        level = 0
        school = ""
        level_match = re.search(r"Level\s+(\d+)|(Cantrip)", header_text)
        school_match = re.search("(" + "|".join(self.SCHOOLS) + ")", header_text, re.IGNORECASE)
        if level_match:
            level = int(level_match.group(1)) if level_match.group(1) else 0
        if school_match:
            school = school_match.group(1).capitalize()

        classes: List[str] = []
        class_match = re.search(r"\(([^)]*)\)\s*$", header_text.strip())
        if class_match:
            classes = [c.strip() for c in class_match.group(1).split(",")]

        def field(label: str) -> str:
            m = re.search(r"\*\*" + label + r":\*\*\s*(.*?)(?:\n|$)", body)
            return _clean(m.group(1)) if m else ""

        casting_time = field("Casting Time")
        duration = field("Duration")
        components = field("Components")

        upcast = ""
        upcast_match = re.search(
            r"_(Cantrip Upgrade|Using a Higher-Level Spell Slot)\._\s*(.*?)(?=\n\n|\Z)",
            body, re.DOTALL)
        if upcast_match:
            upcast = _clean(upcast_match.group(2))
        description_body = re.sub(
            r"_(Cantrip Upgrade|Using a Higher-Level Spell Slot)\._.*?(?=\n\n|\Z)",
            "", body, flags=re.DOTALL)
        description_lines = [
            _clean(line) for line in description_body.split("\n")
            if line.strip()
            and not line.strip().startswith("**")
            and not line.strip().startswith("_")
            and not line.strip().startswith("<table")
        ]
        description = " ".join(l for l in description_lines if l)

        return {
            "id": "spell_" + _slug(raw_name),
            "name": raw_name,
            "level": level,
            "school": school,
            "casting_time": casting_time,
            "range": field("Range"),
            "components": components,
            "material_components_costly": bool(re.search(r"gp|worth", components, re.IGNORECASE)),
            "duration": duration,
            "concentration": "concentration" in duration.lower(),
            "ritual": "ritual" in (casting_time + header_text).lower(),
            "classes": classes,
            "description": description,
            "upcast": upcast,
            "full_text": f"#### {raw_name}\n{body}",
        }


class SRD52MagicItemParser:
    """Parses magic-items.md: `#### Name` entries under the `## Magic Items A–Z`
    section. The leading part of the file contains category *rules*, not items.

    Item bodies open with an italic type/rarity line such as
    `_Armor (Any Medium or Heavy), Uncommon (Requires Attunement)_`, whose
    first comma-separated token names the category, followed by prose.
    """

    RARITIES = ("Common", "Uncommon", "Rare", "Very Rare", "Legendary")
    SINGULAR_CATEGORIES = ("Armor", "Potion", "Ring", "Rod", "Scroll",
                           "Staff", "Wand", "Weapon")

    def parse_file(self, path: str) -> List[Dict[str, Any]]:
        content = _read(path)
        if not content:
            return []
        marker = "## Magic Items A–Z"
        if marker in content:
            content = content.split(marker, 1)[1]
        items: List[Dict[str, Any]] = []
        for entry in _split_entries(content, 4):
            items.append(self._parse_item(entry["name"], entry["body"]))
        return items

    def _parse_item(self, name: str, body: str) -> Dict[str, Any]:
        type_line_match = re.search(r"_([^_\n]+)_", body)
        item_type, rarity, attunement, category = "", "", False, "Wondrous Item"
        if type_line_match:
            type_text = type_line_match.group(1)
            # Type token before the rarity clause, e.g.
            # "Armor (Any Medium or Heavy, Except Hide Armor)" or "Potion".
            pre_rarity = re.split(
                r",\s*(?:Very Rare|Uncommon|Legendary|Rare|Common)", type_text
            )[0].strip()
            base_token = re.sub(r"\s*\(.*\)", "", pre_rarity).strip()
            singular = base_token.rstrip("s")
            if singular in self.SINGULAR_CATEGORIES:
                category = singular
            item_type = pre_rarity
            rarity_match = re.search("(" + "|".join(self.RARITIES) + ")", type_text)
            if rarity_match:
                rarity = rarity_match.group(1)
            attunement = "attunement" in type_text.lower()
        description_body = (
            body[type_line_match.end():] if type_line_match else body
        )
        description_lines = [
            _clean(line) for line in description_body.split("\n") if line.strip()
        ]
        return {
            "id": "item_" + _slug(name),
            "name": name,
            "category": category,
            "item_type": item_type,
            "rarity": rarity,
            "requires_attunement": attunement,
            "description": " ".join(description_lines),
            "full_text": f"#### {name}\n{body}",
        }


class SRD52FeatParser:
    """Parses feats.md: `#### Name` under `### Origin/General/Fighting Style/Epic Boon Feats`."""

    def parse_file(self, path: str) -> List[Dict[str, Any]]:
        content = _read(path)
        if not content:
            return []
        feats: List[Dict[str, Any]] = []
        current_category = ""
        for match in re.finditer(r"^(#{3,4})\s+(.+?)\s*$", content, re.MULTILINE):
            level, heading = len(match.group(1)), match.group(2).strip()
            if level == 3:
                category_match = re.match(r"(Origin|General|Fighting Style|Epic Boon)\s+Feats?$", heading)
                current_category = category_match.group(1) if category_match else ""
                continue
            if not current_category:
                continue
            end = match.end()
            next_heading = re.search(r"^#{4}\s+", content[end:], re.MULTILINE)
            body_end = end + next_heading.start() if next_heading else len(content)
            body = content[end:body_end]
            prereq_match = re.search(r"_Prerequisite[:.]?_\s*(.*?)(?:\n|$)", body)
            feats.append({
                "id": "feat_" + _slug(heading),
                "name": heading,
                "category": current_category,
                "prerequisite": _clean(prereq_match.group(1)) if prereq_match else "",
                "description": _clean(re.sub(r"_Prerequisite[:.]?_.*?(?:\n|$)", "", body)),
                "full_text": f"#### {heading}\n{body}",
            })
        return feats


class SRD52GlossaryParser:
    """Parses rules-glossary.md `#### Term` definitions under `## Rules Definitions`.

    Entries may carry a family tag in brackets, e.g. `#### Attack [Action]`.
    """

    def parse_file(self, path: str) -> List[Dict[str, Any]]:
        content = _read(path)
        if not content or "## Rules Definitions" not in content:
            return []
        section = content.split("## Rules Definitions", 1)[1]
        terms: List[Dict[str, Any]] = []
        for entry in _split_entries(section, 4):
            tag = ""
            name = entry["name"]
            bracket = re.search(r"\[(.+?)\]", name)
            if bracket:
                tag = bracket.group(1)
                name = re.sub(r"\s*\[.+?\]", "", name).strip()
            terms.append({
                "id": "gloss_" + _slug(name),
                "term": name,
                "tag": tag,
                "definition": _clean(entry["body"]),
            })
        return terms


class SRD52OriginParser:
    """Parses character-origins.md into backgrounds and species.

    Backgrounds (`### Background Descriptions`) carry bold field lines
    (**Ability Scores:**, **Feat:**, **Skill Proficiencies:**, ...).
    Species (`### Species Descriptions`) are prose entries with trait labels.
    """

    def parse_file(self, path: str) -> List[Dict[str, Any]]:
        content = _read(path)
        if not content:
            return []
        origins: List[Dict[str, Any]] = []
        section_map = {"Background": "background", "Species": "species"}
        current_kind = ""
        # Track which descriptive section each #### entry belongs to by
        # remembering the most recent `### X Descriptions` heading.
        for match in re.finditer(r"^(#{3,4})\s+(.+?)\s*$", content, re.MULTILINE):
            level, heading = len(match.group(1)), match.group(2).strip()
            if level == 3:
                for key, kind in section_map.items():
                    if heading.startswith(key) and "Descriptions" in heading:
                        current_kind = kind
                continue
            if not current_kind:
                continue
            end = match.end()
            next_heading = re.search(r"^#{4}\s+", content[end:], re.MULTILINE)
            body_end = end + next_heading.start() if next_heading else len(content)
            body = content[end:body_end]

            fields: Dict[str, str] = {}
            if current_kind == "background":
                for label in ("Ability Scores", "Feat", "Skill Proficiencies",
                              "Tool Proficiency", "Equipment"):
                    field_match = re.search(
                        r"\*\*" + label + r":?\*\*\s*(.*?)(?=\n\*\*|\Z)", body, re.DOTALL)
                    if field_match:
                        fields[label.lower().replace(" ", "_")] = _clean(field_match.group(1))
            origins.append({
                "id": f"{current_kind}_" + _slug(heading),
                "name": heading,
                "kind": current_kind,
                **fields,
                "description": _clean(body),
                "full_text": f"#### {heading}\n{body}",
            })
        return origins


def run_srd52_generation(source_dir: str = DEFAULT_SOURCE_DIR, output_dir: Optional[str] = None) -> Dict[str, int]:
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
    compendium_dir = output_dir or os.path.join(base_dir, "compendium")
    os.makedirs(compendium_dir, exist_ok=True)

    statblock_parser = SRD52StatblockParser()
    monsters = statblock_parser.parse_file(os.path.join(source_dir, "monsters-A-Z.md"), category="monster")
    animals = statblock_parser.parse_file(os.path.join(source_dir, "animals.md"), category="animal")
    spells = SRD52SpellParser().parse_file(os.path.join(source_dir, "spells.md"))
    magic_items = SRD52MagicItemParser().parse_file(os.path.join(source_dir, "magic-items.md"))
    feats = SRD52FeatParser().parse_file(os.path.join(source_dir, "feats.md"))
    glossary = SRD52GlossaryParser().parse_file(os.path.join(source_dir, "rules-glossary.md"))
    origins = SRD52OriginParser().parse_file(os.path.join(source_dir, "character-origins.md"))

    outputs = {
        "srd_5_2_monsters.json": monsters,
        "srd_5_2_animals.json": animals,
        "srd_5_2_spells.json": spells,
        "srd_5_2_magic_items.json": magic_items,
        "srd_5_2_feats.json": feats,
        "srd_5_2_origins.json": origins,
        "srd_5_2_rules_glossary.json": glossary,
    }
    counts: Dict[str, int] = {}
    for filename, data in outputs.items():
        with open(os.path.join(compendium_dir, filename), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        domain = filename.replace("srd_5_2_", "").replace(".json", "")
        counts[domain] = len(data)

    print("[SRD52Importer] Generated compendium fixtures:")
    for domain, count in counts.items():
        print(f"  - {domain}: {count} entries")
    return counts


if __name__ == "__main__":
    run_srd52_generation()
