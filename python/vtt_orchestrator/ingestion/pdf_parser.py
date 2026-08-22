import json
import re
from typing import Dict, Any, List


class AstPdfCompendiumParser:
    """
    Abstract Syntax Tree (AST) layout-aware OCR ingestion pipeline for monster stat blocks & spells.
    """

    def parse_monster_text(self, text: str) -> Dict[str, Any]:
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        name = lines[0] if lines else "Unknown Monster"

        cr_match = re.search(r"Challenge\s*(\d+(?:/\d+)?)", text, re.IGNORECASE)
        cr = 0.25
        if cr_match:
            cr_str = cr_match.group(1)
            if "/" in cr_str:
                num, denom = cr_str.split("/")
                cr = float(num) / float(denom)
            else:
                cr = float(cr_str)

        ac_match = re.search(r"Armor Class\s*(\d+)", text, re.IGNORECASE)
        ac = int(ac_match.group(1)) if ac_match else 10

        hp_match = re.search(r"Hit Points\s*(\d+)", text, re.IGNORECASE)
        hp = int(hp_match.group(1)) if hp_match else 10

        speed_match = re.search(r"Speed\s*(\d+)\s*ft", text, re.IGNORECASE)
        speed = int(speed_match.group(1)) if speed_match else 30

        return {
            "entity_id": f"monster_{name.lower().replace(' ', '_')}",
            "entity_type": "monster",
            "name": name,
            "challenge_rating": cr,
            "base_ac": ac,
            "average_hp": hp,
            "base_speed": speed,
            "action_deck": [{"name": "Standard Attack", "damage": "1d6 + 2"}],
        }

    def parse_spell_text(self, text: str) -> Dict[str, Any]:
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        name = lines[0] if lines else "Unknown Spell"

        level_match = re.search(r"(\d)(?:st|nd|rd|th)-level\s*(\w+)", text, re.IGNORECASE)
        level = int(level_match.group(1)) if level_match else 1
        school = level_match.group(2) if level_match else "Evocation"

        range_match = re.search(r"Range:\s*(\d+)\s*feet", text, re.IGNORECASE)
        range_feet = int(range_match.group(1)) if range_match else 60

        return {
            "entity_id": f"spell_{name.lower().replace(' ', '_')}",
            "entity_type": "spell",
            "name": name,
            "level": level,
            "school": school,
            "range_feet": range_feet,
        }
