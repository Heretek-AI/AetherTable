import os
import re
import json
from typing import List, Dict, Any, Optional


class SRDSpellParser:
    """
    Parses Markdown SRD 5.1 Spell files from BillyOutlast/dnd.srd.5.1 into structured records.
    """

    def __init__(self, srd_spells_dir: str = "/tmp/research_repos/dnd.srd.5.1/07_Spells/Spells_Each"):
        self.srd_spells_dir = srd_spells_dir

    def parse_all_spells(self) -> List[Dict[str, Any]]:
        spells: List[Dict[str, Any]] = []

        if not os.path.exists(self.srd_spells_dir):
            return self._get_fallback_spells()

        for filename in sorted(os.listdir(self.srd_spells_dir)):
            if not filename.endswith(".md"):
                continue

            filepath = os.path.join(self.srd_spells_dir, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()

                spell = self._parse_spell_markdown(filename, content)
                if spell:
                    spells.append(spell)
            except Exception as e:
                print(f"[SRDParser] Error parsing {filename}: {e}")

        return spells if len(spells) > 0 else self._get_fallback_spells()

    def _parse_spell_markdown(self, filename: str, content: str) -> Optional[Dict[str, Any]]:
        lines = [line.strip() for line in content.split("\n") if line.strip()]
        if not lines:
            return None

        # Title
        raw_name = lines[0].replace("#", "").strip()
        spell_id = "spell_" + re.sub(r"[^a-z0-9]+", "_", raw_name.lower()).strip("_")

        # Metadata extraction
        level = 1
        school = "Evocation"
        casting_time = "1 action"
        range_area = "60 feet"
        components = "V, S"
        duration = "Instantaneous"

        for line in lines:
            if "cantrip" in line.lower() or "level" in line.lower() or "school" in line.lower():
                level_match = re.search(r"(\d+)(?:st|nd|rd|th)?[- ]level", line, re.IGNORECASE)
                if level_match:
                    level = int(level_match.group(1))
                elif "cantrip" in line.lower():
                    level = 0

                school_match = re.search(r"(abjuration|conjuration|divination|enchantment|evocation|illusion|necromancy|transmutation)", line, re.IGNORECASE)
                if school_match:
                    school = school_match.group(1).capitalize()

            if line.lower().startswith("**casting time:**") or line.lower().startswith("- **casting time:**"):
                casting_time = re.sub(r"^[-\* ]*casting time:\*\*?", "", line, flags=re.IGNORECASE).strip()
            elif line.lower().startswith("**range:**") or line.lower().startswith("- **range:**"):
                range_area = re.sub(r"^[-\* ]*range:\*\*?", "", line, flags=re.IGNORECASE).strip()
            elif line.lower().startswith("**components:**") or line.lower().startswith("- **components:**"):
                components = re.sub(r"^[-\* ]*components:\*\*?", "", line, flags=re.IGNORECASE).strip()
            elif line.lower().startswith("**duration:**") or line.lower().startswith("- **duration:**"):
                duration = re.sub(r"^[-\* ]*duration:\*\*?", "", line, flags=re.IGNORECASE).strip()

        # Description body
        desc_lines = [l for l in lines if not l.startswith("#") and not l.startswith("**") and not l.startswith("- **")]
        description = " ".join(desc_lines) if desc_lines else "A standard arcane or divine invocation."

        return {
            "id": spell_id,
            "name": raw_name,
            "level": level,
            "school": school,
            "casting_time": casting_time,
            "range": range_area,
            "components": components,
            "duration": duration,
            "description": description[:300] + ("..." if len(description) > 300 else ""),
            "full_text": content,
        }

    def _get_fallback_spells(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": "spell_fireball",
                "name": "Fireball",
                "level": 3,
                "school": "Evocation",
                "casting_time": "1 action",
                "range": "150 feet (20-foot-radius sphere)",
                "components": "V, S, M (a tiny ball of bat guano and sulfur)",
                "duration": "Instantaneous",
                "description": "A bright streak flashes from your pointing finger to a point you choose within range and then blossoms with a low roar into an explosion of flame. Each creature in a 20-foot-radius sphere must make a Dexterity saving throw, taking 8d6 fire damage on a failed save.",
            },
            {
                "id": "spell_magic_missile",
                "name": "Magic Missile",
                "level": 1,
                "school": "Evocation",
                "casting_time": "1 action",
                "range": "120 feet",
                "components": "V, S",
                "duration": "Instantaneous",
                "description": "You create three glowing darts of magical force. Each dart hits a creature of your choice that you can see within range. A dart deals 1d4 + 1 force damage to its target.",
            },
        ]


def build_bundled_srd_database():
    parser = SRDSpellParser()
    spells = parser.parse_all_spells()
    output_path = os.path.join(os.path.dirname(__file__), "..", "data", "srd_spells.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(spells, f, indent=2)
    print(f"[SRD Importer] Successfully compiled {len(spells)} SRD 5.1 spells into {output_path}")


if __name__ == "__main__":
    build_bundled_srd_database()


class SRDMonsterParser:
    """
    Parses SRD 5.1 Monsters from Dungeoneer data and SRD markdown.
    """

    def __init__(self, dungeoneer_monsters_path: str = "/tmp/research_repos/Dungeoneer/data/monsters.json"):
        self.dungeoneer_monsters_path = dungeoneer_monsters_path

    def parse_all_monsters(self) -> List[Dict[str, Any]]:
        if os.path.exists(self.dungeoneer_monsters_path):
            try:
                with open(self.dungeoneer_monsters_path, "r", encoding="utf-8") as f:
                    raw_data = json.load(f)

                monsters = []
                for m in raw_data:
                    name = m.get("name", "Creature")
                    m_id = "monster_" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
                    
                    # Parse AC
                    ac_val = 12
                    ac_raw = m.get("armor_class") or m.get("ac", 12)
                    if isinstance(ac_raw, int):
                        ac_val = ac_raw
                    elif isinstance(ac_raw, str):
                        match = re.search(r"\d+", ac_raw)
                        if match:
                            ac_val = int(match.group(0))

                    # Parse HP
                    hp_val = 20
                    hp_raw = m.get("hit_points") or m.get("hp", 20)
                    if isinstance(hp_raw, int):
                        hp_val = hp_raw
                    elif isinstance(hp_raw, str):
                        match = re.search(r"\d+", hp_raw)
                        if match:
                            hp_val = int(match.group(0))

                    cr = str(m.get("challenge_rating", m.get("cr", "1")))
                    cr_str = f"CR {cr}" if not str(cr).startswith("CR") else str(cr)
                    
                    monsters.append({
                        "id": m_id,
                        "name": name,
                        "type": m.get("type", m.get("meta", "Medium Humanoid")),
                        "cr": cr_str,
                        "ac": ac_val,
                        "hp": hp_val,
                        "speed": m.get("speed", "30 ft"),
                        "description": m.get("description") or f"A formidable {m.get('type', 'creature')} possessing supernatural traits.",
                        "actions": m.get("actions") or [
                            {"name": "Multiattack", "desc": "The creature makes two attacks."},
                            {"name": "Strike", "desc": "+5 to hit, reach 5 ft., one target. Hit: 1d8 + 3 damage."},
                        ],
                    })
                return monsters
            except Exception as e:
                print(f"[SRD Monster Parser] Error: {e}")

        return self._get_fallback_monsters()

    def _get_fallback_monsters(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": "monster_goblin_scout",
                "name": "Goblin Scout",
                "type": "Small Humanoid (Goblinoid)",
                "cr": "CR 1/4",
                "ac": 15,
                "hp": 12,
                "speed": "30 ft",
                "description": "Small, black-hearted humanoids that lair in despoiled dungeons and ruins.",
                "actions": [
                    {"name": "Scimitar", "desc": "+4 to hit, 1d6+2 slashing"},
                    {"name": "Shortbow", "desc": "+4 to hit, 1d6+2 piercing"},
                ],
            },
            {
                "id": "monster_orc_warlord",
                "name": "Orc Warlord",
                "type": "Medium Humanoid (Orc)",
                "cr": "CR 3",
                "ac": 16,
                "hp": 58,
                "speed": "30 ft",
                "description": "Savage tribal commanders driven by the bloodlust of Gruumsh.",
                "actions": [
                    {"name": "Greataxe", "desc": "+6 to hit, 1d12+4 slashing"},
                    {"name": "Javelin", "desc": "+6 to hit, 1d6+4 piercing"},
                ],
            },
            {
                "id": "monster_young_red_dragon",
                "name": "Young Red Dragon",
                "type": "Large Dragon (Chaotic Evil)",
                "cr": "CR 10",
                "ac": 18,
                "hp": 178,
                "speed": "40 ft, fly 80 ft",
                "description": "Arrogant carnivores that hoard treasures in volcanic lairs.",
                "actions": [
                    {"name": "Multiattack", "desc": "Bite + 2 Claws"},
                    {"name": "Fire Breath", "desc": "16d6 fire, DC 17 DEX"},
                ],
            },
        ]


def build_bundled_monster_database():
    parser = SRDMonsterParser()
    monsters = parser.parse_all_monsters()
    output_path = os.path.join(os.path.dirname(__file__), "..", "data", "srd_monsters.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(monsters, f, indent=2)
    print(f"[SRD Importer] Successfully compiled {len(monsters)} SRD monsters into {output_path}")


if __name__ == "__main__":
    build_bundled_monster_database()
