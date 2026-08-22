import pytest
from vtt_orchestrator.compendium.bundle_packager import CampaignBundlePackager
from vtt_orchestrator.compendium.homebrew_parser import HomebrewMarkdownParser


def test_bundle_packager_export_and_import():
    packager = CampaignBundlePackager()

    campaign_data = {
        "title": "The Siege of Sunspire",
        "author": "Grand Master John",
        "ruleset": "D&D 5e SRD",
        "grid_dimensions": {"width": 20, "height": 16},
        "walls": [{"x": 5, "y": 5}, {"x": 5, "y": 6}],
        "tokens": [
            {"id": "tok_1", "name": "Thorin Oakenshield", "x": 4, "y": 4, "hp": 42, "maxHp": 42, "ac": 18, "color": "#3b82f6", "isPlayer": True}
        ],
        "dynasties": {"houses": [{"id": "house_silverthorn", "name": "House Silverthorn"}]},
        "lore_graph": {"edges": [{"from": "Thorin", "rel": "POSSESSES", "to": "Sunblade"}]},
        "loot_tables": {"chest_tier_1": ["50 gp", "Potion of Healing"]},
    }

    # Export
    zip_bytes = packager.export_bundle(campaign_data)
    assert len(zip_bytes) > 0
    assert zip_bytes.startswith(b"PK")  # Standard zip signature

    # Import
    imported = packager.import_bundle(zip_bytes)
    assert imported["manifest"]["title"] == "The Siege of Sunspire"
    assert imported["manifest"]["token_count"] == 1
    assert imported["map_layout"]["grid_width"] == 20
    assert len(imported["tokens"]) == 1
    assert imported["tokens"][0]["name"] == "Thorin Oakenshield"


def test_homebrew_markdown_parser():
    parser = HomebrewMarkdownParser()

    sample_md = """
    ___
    > ## Shadow Drake
    >*Medium dragon, neutral evil*
    > ___
    > * **Armor Class** 16 (natural armor)
    > * **Hit Points** 52 (8d8 + 16)
    > * **Speed** 30 ft., fly 60 ft.
    > ___
    > | STR | DEX | CON | INT | WIS | CHA |
    > | 16 (+3) | 15 (+2) | 14 (+2) | 6 (-2) | 12 (+1) | 8 (-1) |
    > ___
    > * **Skills** Stealth +6, Perception +3
    > * **Damage Resistances** necrotic
    > * **Senses** darkvision 120 ft., passive Perception 13
    > * **Challenge** 3 (700 XP)
    > ___
    > ### Actions
    > ***Bite.*** *Melee Weapon Attack:* +5 to hit, reach 5 ft., one target. *Hit:* 10 (2d6 + 3) piercing damage.
    >
    > ***Shadow Breath (Recharge 5-6).*** The drake exhales shadowy flames in a 15-foot cone.
    """

    creature = parser.parse_statblock(sample_md)
    assert creature["name"] == "Shadow Drake"
    assert creature["ac"] == 16
    assert creature["hp"] == 52
    assert creature["speed"] == 30
    assert creature["abilities"]["STR"] == 16
    assert creature["abilities"]["INT"] == 6
    assert len(creature["actions"]) >= 1
    assert creature["actions"][0]["name"] == "Bite"
    assert creature["actions"][0]["to_hit"] == "+5"
