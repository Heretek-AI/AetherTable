"""Tests for the SRD 5.2.1 markdown importer (flat-file layout).

Runs against small checked-in sample fixtures mirroring the real source
format (python/tests/fixtures/srd52_sample/) so no network or external
clone is required.
"""

import os

import pytest

from vtt_orchestrator.compendium.srd52_importer import (
    SRD52StatblockParser,
    SRD52SpellParser,
    SRD52MagicItemParser,
    SRD52FeatParser,
    SRD52GlossaryParser,
    SRD52OriginParser,
)
from vtt_orchestrator.schemas.models import (
    SRDMonsterDefinition,
    SRDSpellDefinition,
    SRDMagicItemDefinition,
    SRDFeatDefinition,
    SRDGlossaryTerm,
)

FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "srd52_sample")


def fixture(name: str) -> str:
    return os.path.join(FIXTURE_DIR, name)


class TestStatblockParser:
    def test_parses_full_monster_statblock(self):
        monsters = SRD52StatblockParser().parse_file(fixture("monsters.md"))
        aboleth = next((m for m in monsters if m["name"] == "Aboleth"), None)
        assert aboleth is not None
        assert aboleth["ac"] == 17
        assert aboleth["hp"] == 150
        assert aboleth["hit_dice"] == "20d10 + 40"
        assert aboleth["abilities"]["STR"] == 21
        assert aboleth["abilities"]["DEX"] == 9
        # Proficient saves differ from the plain ability modifier.
        assert "CON +6" in aboleth["saving_throws"]
        assert "DEX +3" in aboleth["saving_throws"]
        assert aboleth["challenge_rating"] == "10"
        assert aboleth["xp"] == 5900
        assert aboleth["proficiency_bonus"] == 4

    def test_monster_action_sections_are_populated(self):
        monsters = SRD52StatblockParser().parse_file(fixture("monsters.md"))
        aboleth = next(m for m in monsters if m["name"] == "Aboleth")
        trait_names = {t["name"] for t in aboleth["traits"]}
        action_names = {a["name"] for a in aboleth["actions"]}
        legendary_names = {a["name"] for a in aboleth["legendary_actions"]}
        assert "Amphibious" in trait_names
        assert "Tentacle" in action_names
        assert "Dominate Mind (2/Day)" in action_names
        assert "Psychic Drain" in legendary_names

    def test_flat_animal_files_parse_with_category(self):
        animals = SRD52StatblockParser().parse_file(fixture("animals.md"), category="animal")
        assert len(animals) >= 1
        allosaurus = animals[0]
        assert allosaurus["category"] == "animal"
        assert allosaurus["creature_type"].startswith("Beast")
        assert allosaurus["id"].startswith("animal_")
        assert allosaurus["actions"], "flat animal stat block must have actions"

    def test_non_statblock_prose_is_skipped(self):
        monsters = SRD52StatblockParser().parse_file(fixture("rules-glossary.md"))
        assert monsters == []


class TestSpellParser:
    def test_parses_complete_spell_fields(self):
        spells = SRD52SpellParser().parse_file(fixture("spells.md"))
        acid_splash = next((s for s in spells if s["name"] == "Acid Splash"), None)
        assert acid_splash is not None
        model = SRDSpellDefinition(**acid_splash)
        assert model.level == 0
        assert model.school.lower() == "evocation"
        assert "Sorcerer" in acid_splash["classes"]

    def test_descriptions_are_never_truncated_and_upcast_captured(self):
        spells = SRD52SpellParser().parse_file(fixture("spells.md"))
        aid = next(s for s in spells if s["name"] == "Aid")
        assert aid["level"] == 2
        assert not aid["description"].endswith("...")
        assert "Hit Points increase by 5 for each spell slot level above 2" in aid["upcast"]
        assert "spell slot level above 2" not in aid["description"]


class TestMagicItemParser:
    def test_parses_items_with_type_rarity_attunement(self):
        items = SRD52MagicItemParser().parse_file(fixture("magic-items.md"))
        adamantine = next((i for i in items if i["name"] == "Adamantine Armor"), None)
        assert adamantine is not None
        model = SRDMagicItemDefinition(**adamantine)
        assert model.category == "Armor"
        assert model.rarity == "Uncommon"
        assert model.requires_attunement is False
        assert "Critical Hit" in model.description


class TestFeatParser:
    def test_parses_feats_by_category(self):
        feats = SRD52FeatParser().parse_file(fixture("feats.md"))
        alert = next((f for f in feats if f["name"] == "Alert"), None)
        assert alert is not None
        model = SRDFeatDefinition(**alert)
        assert model.category == "Origin"
        assert "Proficiency Bonus" in model.description


class TestOriginParser:
    def test_parses_backgrounds_with_structured_fields(self):
        origins = SRD52OriginParser().parse_file(fixture("character-origins.md"))
        acolyte = next((o for o in origins if o["name"] == "Acolyte"), None)
        assert acolyte is not None
        assert acolyte["kind"] == "background"
        assert "Wisdom" in acolyte["ability_scores"]
        assert "Insight" in acolyte["skill_proficiencies"]

    def test_parses_species_entries(self):
        origins = SRD52OriginParser().parse_file(fixture("character-origins.md"))
        dragonborn = next((o for o in origins if o["name"] == "Dragonborn"), None)
        assert dragonborn is not None
        assert dragonborn["kind"] == "species"
        assert dragonborn["description"]


class TestGlossaryParser:
    def test_parses_terms_with_family_tags(self):
        terms = SRD52GlossaryParser().parse_file(fixture("rules-glossary.md"))
        assert len(terms) >= 3
        attack = next((t for t in terms if t["term"] == "Attack"), None)
        assert attack is not None
        model = SRDGlossaryTerm(**attack)
        assert model.tag == "Action"
        assert "D20 Test" in model.definition or "action" in model.definition.lower()


@pytest.mark.skipif(
    not os.path.isdir("/tmp/research_repos/dnd-5e-srd-markdown"),
    reason="full SRD 5.2 markdown clone not present",
)
class TestFullGeneration:
    def test_run_generation_produces_quality_fixtures(self, tmp_path):
        from vtt_orchestrator.compendium.srd52_importer import run_srd52_generation

        counts = run_srd52_generation(output_dir=str(tmp_path))
        assert counts["monsters"] >= 200
        assert counts["animals"] >= 50
        assert counts["spells"] >= 300
        assert counts["magic_items"] >= 200
        assert counts["rules_glossary"] >= 100

        import json
        monsters = json.load(open(tmp_path / "srd_5_2_monsters.json"))
        with_actions = [m for m in monsters if m["actions"] or m["traits"]]
        assert len(with_actions) / len(monsters) > 0.9, "most stat blocks must be complete"

        spells = json.load(open(tmp_path / "srd_5_2_spells.json"))
        truncated = [s for s in spells if s["description"].endswith("...")]
        assert not truncated, "spell descriptions must never be truncated"
