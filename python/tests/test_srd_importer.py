import pytest
from vtt_orchestrator.compendium.srd_importer import (
    SRDSpellParser,
    SRDMonsterParser,
    SRDClassParser,
    SRDEquipmentParser,
    SRDRulesParser,
)
from vtt_orchestrator.schemas.models import (
    SRDSpellDefinition,
    SRDMonsterDefinition,
    SRDClassDefinition,
    SRDEquipmentItem,
    SRDConditionDefinition,
)


import os

import pytest
from vtt_orchestrator.compendium.srd_importer import (
    SRDSpellParser,
    SRDMonsterParser,
    SRDClassParser,
    SRDEquipmentParser,
    SRDRulesParser,
)
from vtt_orchestrator.schemas.models import (
    SRDSpellDefinition,
    SRDMonsterDefinition,
    SRDClassDefinition,
    SRDEquipmentItem,
    SRDConditionDefinition,
)

# The full-corpus assertions need the cloned 5.1 SRD markdown tree the
# parsers default to; without it they fall back to a tiny hardcoded sample
# (their own designed behavior), so skip instead of failing on environments
# that never checked out the research corpus.
_SRD_SPELLS_DIR = "/tmp/research_repos/dnd.srd.5.1/07_Spells/Spells_Each"
_SRD_MONSTERS_DIR = "/tmp/research_repos/dnd.srd.5.1/10_Monsters/Monsters_Each"


def _require_corpus(path: str) -> None:
    if not os.path.isdir(path):
        pytest.skip(f"SRD markdown corpus not present: {path}")


def test_srd_spell_parser_and_pydantic_validation():
    _require_corpus(_SRD_SPELLS_DIR)
    parser = SRDSpellParser()
    spells = parser.parse_all_spells()
    assert len(spells) >= 300

    fireball = next((s for s in spells if s["name"].lower() == "fireball"), None)
    assert fireball is not None
    assert fireball["level"] == 3
    assert fireball["school"].lower() == "evocation"

    # Pydantic validation
    parsed_model = SRDSpellDefinition(**fireball)
    assert parsed_model.name == fireball["name"]
    assert parsed_model.level == 3


def test_srd_monster_parser_and_pydantic_validation():
    _require_corpus(_SRD_MONSTERS_DIR)
    parser = SRDMonsterParser()
    monsters = parser.parse_all_monsters()
    assert len(monsters) >= 300

    goblin = next((m for m in monsters if m["name"].lower() == "goblin"), None)
    assert goblin is not None
    assert goblin["ac"] >= 10
    assert goblin["hp"] >= 1
    assert "STR" in goblin["abilities"]

    parsed_monster = SRDMonsterDefinition(**goblin)
    assert parsed_monster.name == goblin["name"]


def test_srd_class_parser_and_equipment():
    class_parser = SRDClassParser()
    classes = class_parser.parse_all_classes()
    assert len(classes) >= 6

    fighter = next((c for c in classes if c["name"] == "Fighter"), None)
    assert fighter is not None
    assert fighter["hit_die"] == "d10"
    assert "STR" in fighter["saving_throw_proficiencies"]

    parsed_class = SRDClassDefinition(**fighter)
    assert parsed_class.name == "Fighter"

    equip_parser = SRDEquipmentParser()
    equipment = equip_parser.parse_all_equipment()
    assert len(equipment) >= 10

    plate = next((e for e in equipment if "Plate" in e["name"]), None)
    assert plate is not None
    assert plate["ac_base"] == 18

    parsed_equip = SRDEquipmentItem(**plate)
    assert parsed_equip.ac_base == 18


def test_srd_rules_and_conditions():
    rules_parser = SRDRulesParser()
    rules = rules_parser.parse_all_rules()
    assert len(rules["conditions"]) == 15

    paralyzed = next((c for c in rules["conditions"] if c["name"] == "Paralyzed"), None)
    assert paralyzed is not None
    assert "critical hit" in paralyzed["description"].lower()

    parsed_cond = SRDConditionDefinition(**paralyzed)
    assert parsed_cond.name == "Paralyzed"
