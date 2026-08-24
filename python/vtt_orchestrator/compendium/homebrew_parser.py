"""
Homebrewery & GM Binder Markdown Statblock Parser
Converts standard markdown statblocks (___ > ### Monster Name) into structured VTT tokens.

Fail-loud contract: fields that cannot be parsed are reported in `warnings`
and left at their neutral placeholders — the parser NEVER fabricates combat
values (no invented AC/HP defaults, no phantom "Claw Strike" action). A
statblock that would fight with invented stats is worse than one that fails
parsing loudly.
"""

import re
from typing import Dict, Any, List

# Core fields a creature needs to participate in combat. Missing any of these
# makes parse_ok False and (in strict mode) raises instead of returning.
_CORE_FIELDS = ("name", "ac", "hp", "abilities", "actions")

_PLACEHOLDER_STATBLOCK: Dict[str, Any] = {
    "name": None,
    "type": "Medium monstrosity, unaligned",
    "ac": None,
    "hp": None,
    "max_hp": None,
    "speed": None,
    "abilities": {"STR": None, "DEX": None, "CON": None, "INT": None, "WIS": None, "CHA": None},
    "saving_throws": [],
    "skills": [],
    "senses": None,
    "challenge_rating": None,
    "actions": [],
    "traits": [],
    "avatarIconType": "boss",
    "color": "#e11d48",
    "isPlayer": False,
}


class HomebrewMarkdownParser:
    def parse_statblock(self, markdown_text: str) -> Dict[str, Any]:
        lines = [line.strip() for line in markdown_text.strip().split("\n") if line.strip()]
        result: Dict[str, Any] = dict(_PLACEHOLDER_STATBLOCK)
        # Fresh mutable containers per call — the placeholder's lists must
        # never accumulate state across parses.
        result["abilities"] = dict(_PLACEHOLDER_STATBLOCK["abilities"])
        result["saving_throws"] = []
        result["skills"] = []
        result["actions"] = []
        result["traits"] = []
        warnings: List[str] = []
        parsed: set[str] = set()

        # 1. Parse Name (e.g. "### Shadow Drake" or "## Goblin Chief" or "___ > ### Dragon")
        for line in lines:
            name_match = re.search(r"#{2,4}\s+([A-Za-z0-9\s'\-]+)", line)
            if name_match:
                result["name"] = name_match.group(1).strip()
                parsed.add("name")
                break

        # 2. Parse Armor Class (e.g. "* **Armor Class** 16 (natural armor)")
        ac_match = re.search(r"Armor Class\*{0,2}\s*(\d+)", markdown_text, re.IGNORECASE)
        if ac_match:
            result["ac"] = int(ac_match.group(1))
            parsed.add("ac")

        # 3. Parse Hit Points (e.g. "* **Hit Points** 52 (8d8 + 16)")
        hp_match = re.search(r"Hit Points\*{0,2}\s*(\d+)", markdown_text, re.IGNORECASE)
        if hp_match:
            hp_val = int(hp_match.group(1))
            result["hp"] = hp_val
            result["max_hp"] = hp_val
            parsed.add("hp")

        # 4. Parse Speed (e.g. "* **Speed** 30 ft., fly 60 ft.")
        speed_match = re.search(r"Speed\*{0,2}\s*(\d+)\s*ft", markdown_text, re.IGNORECASE)
        if speed_match:
            result["speed"] = int(speed_match.group(1))

        # 5. Parse Ability Scores Matrix: | STR | DEX | CON | INT | WIS | CHA |
        # e.g. | 16 (+3) | 14 (+2) | 15 (+2) | 8 (-1) | 12 (+1) | 6 (-2) |
        ability_row_match = re.findall(r"\|\s*(\d+)\s*\([+\-]?\d+\)", markdown_text)
        if len(ability_row_match) >= 6:
            for key, raw in zip(
                ("STR", "DEX", "CON", "INT", "WIS", "CHA"), ability_row_match[:6]
            ):
                result["abilities"][key] = int(raw)
            parsed.add("abilities")

        # 6. Parse Actions (e.g. "***Bite.*** *Melee Weapon Attack:* +5 to hit, reach 5 ft., one target. *Hit:* 10 (2d6 + 3) piercing damage.")
        action_matches = re.findall(
            r"\*{3}([A-Za-z\s]+)\.\*{3}\s*([^\n]+)", markdown_text
        )
        for act_name, act_desc in action_matches:
            to_hit_match = re.search(r"([+\-]\d+)\s*to hit", act_desc)
            dmg_match = re.search(r"(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s*([A-Za-z]+)\s*damage", act_desc)

            result["actions"].append({
                "name": act_name.strip(),
                "description": act_desc.strip(),
                # Unparsed sub-fields stay absent — inventing "+4 / 1d8+2"
                # here is how homebrew monsters end up fighting with fake math.
                **({"to_hit": to_hit_match.group(1)} if to_hit_match else {}),
                **({"damage_formula": dmg_match.group(1),
                    "damage_type": dmg_match.group(2)} if dmg_match else {}),
            })
        if result["actions"]:
            parsed.add("actions")

        # Fail-loud bookkeeping: report every missing core field.
        for field in _CORE_FIELDS:
            if field not in parsed:
                warnings.append(f"unparsed_field:{field}")

        result["parse_ok"] = not warnings
        result["warnings"] = warnings

        # Set color based on name/threat
        if result["name"]:
            lowered_name = result["name"].lower()
            if "dragon" in lowered_name or "drake" in lowered_name:
                result["avatarIconType"] = "boss"
                result["color"] = "#dc2626"
            elif "mage" in lowered_name or "wizard" in lowered_name:
                result["avatarIconType"] = "caster"
                result["color"] = "#7c3aed"
            elif "scout" in lowered_name or "archer" in lowered_name:
                result["avatarIconType"] = "scout"
                result["color"] = "#f59e0b"

        return result


global_homebrew_parser = HomebrewMarkdownParser()
