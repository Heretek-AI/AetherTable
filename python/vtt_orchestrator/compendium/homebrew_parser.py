"""
Homebrewery & GM Binder Markdown Statblock Parser
Converts standard markdown statblocks (___ > ### Monster Name) into structured VTT tokens.
"""

import re
from typing import Dict, Any, List, Optional


class HomebrewMarkdownParser:
    def parse_statblock(self, markdown_text: str) -> Dict[str, Any]:
        lines = [line.strip() for line in markdown_text.strip().split("\n") if line.strip()]

        result: Dict[str, Any] = {
            "name": "Custom Creature",
            "type": "Medium monstrosity, unaligned",
            "ac": 14,
            "hp": 30,
            "max_hp": 30,
            "speed": 30,
            "abilities": {"STR": 14, "DEX": 14, "CON": 14, "INT": 10, "WIS": 12, "CHA": 8},
            "saving_throws": [],
            "skills": [],
            "senses": "Darkvision 60 ft., passive Perception 12",
            "challenge_rating": "2",
            "actions": [],
            "traits": [],
            "avatarIconType": "boss",
            "color": "#e11d48",
            "isPlayer": False,
        }

        # 1. Parse Name (e.g. "### Shadow Drake" or "## Goblin Chief" or "___ > ### Dragon")
        for line in lines:
            name_match = re.search(r"#{2,4}\s+([A-Za-z0-9\s'\-]+)", line)
            if name_match:
                result["name"] = name_match.group(1).strip()
                break

        # 2. Parse Armor Class (e.g. "* **Armor Class** 16 (natural armor)")
        ac_match = re.search(r"Armor Class\*{0,2}\s*(\d+)", markdown_text, re.IGNORECASE)
        if ac_match:
            result["ac"] = int(ac_match.group(1))

        # 3. Parse Hit Points (e.g. "* **Hit Points** 52 (8d8 + 16)")
        hp_match = re.search(r"Hit Points\*{0,2}\s*(\d+)", markdown_text, re.IGNORECASE)
        if hp_match:
            hp_val = int(hp_match.group(1))
            result["hp"] = hp_val
            result["max_hp"] = hp_val

        # 4. Parse Speed (e.g. "* **Speed** 30 ft., fly 60 ft.")
        speed_match = re.search(r"Speed\*{0,2}\s*(\d+)\s*ft", markdown_text, re.IGNORECASE)
        if speed_match:
            result["speed"] = int(speed_match.group(1))

        # 5. Parse Ability Scores Matrix: | STR | DEX | CON | INT | WIS | CHA |
        # e.g. | 16 (+3) | 14 (+2) | 15 (+2) | 8 (-1) | 12 (+1) | 6 (-2) |
        ability_row_match = re.findall(r"\|\s*(\d+)\s*\([+\-]?\d+\)", markdown_text)
        if len(ability_row_match) >= 6:
            result["abilities"]["STR"] = int(ability_row_match[0])
            result["abilities"]["DEX"] = int(ability_row_match[1])
            result["abilities"]["CON"] = int(ability_row_match[2])
            result["abilities"]["INT"] = int(ability_row_match[3])
            result["abilities"]["WIS"] = int(ability_row_match[4])
            result["abilities"]["CHA"] = int(ability_row_match[5])

        # 6. Parse Actions (e.g. "***Bite.*** *Melee Weapon Attack:* +5 to hit, reach 5 ft., one target. *Hit:* 10 (2d6 + 3) piercing damage.")
        action_matches = re.findall(
            r"\*{3}([A-Za-z\s]+)\.\*{3}\s*([^\n]+)", markdown_text
        )
        for act_name, act_desc in action_matches:
            # Detect to hit and damage formula
            to_hit_match = re.search(r"([+\-]\d+)\s*to hit", act_desc)
            dmg_match = re.search(r"(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s*([A-Za-z]+)\s*damage", act_desc)

            result["actions"].append({
                "name": act_name.strip(),
                "description": act_desc.strip(),
                "to_hit": to_hit_match.group(1) if to_hit_match else "+4",
                "damage_formula": dmg_match.group(1) if dmg_match else "1d8 + 2",
                "damage_type": dmg_match.group(2) if dmg_match else "slashing",
            })

        if not result["actions"]:
            result["actions"].append({
                "name": "Claw Strike",
                "description": "Melee Weapon Attack: +5 to hit, reach 5 ft., one target.",
                "to_hit": "+5",
                "damage_formula": "2d6 + 3",
                "damage_type": "slashing",
            })

        # Set color based on name/threat
        if "dragon" in result["name"].lower() or "drake" in result["name"].lower():
            result["avatarIconType"] = "boss"
            result["color"] = "#dc2626"
        elif "mage" in result["name"].lower() or "wizard" in result["name"].lower():
            result["avatarIconType"] = "caster"
            result["color"] = "#7c3aed"
        elif "scout" in result["name"].lower() or "archer" in result["name"].lower():
            result["avatarIconType"] = "scout"
            result["color"] = "#f59e0b"

        return result


global_homebrew_parser = HomebrewMarkdownParser()
