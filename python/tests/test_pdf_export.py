import pytest
from vtt_orchestrator.pdf.character_sheet_renderer import CharacterSheetPDFRenderer


def test_character_sheet_pdf_generation():
    renderer = CharacterSheetPDFRenderer()
    mock_character = {
        "name": "Thorin Oakenshield",
        "level": 5,
        "class_name": "Fighter (Champion)",
        "race": "Mountain Dwarf",
        "background": "Soldier",
        "alignment": "Lawful Good",
        "ac": 18,
        "hp": 42,
        "max_hp": 42,
        "speed": "25 ft",
        "str_score": 18,
        "dex_score": 14,
        "con_score": 16,
        "int_score": 10,
        "wis_score": 12,
        "cha_score": 8,
        "passive_perception": 11,
        "actions": [
            {"name": "Greataxe +1", "atk": "+8", "damage": "1d12+5 Slashing", "range": "Melee (5 ft)"},
            {"name": "Heavy Crossbow", "atk": "+5", "damage": "1d10+2 Piercing", "range": "100/400 ft"},
        ],
        "spells": [
            {"name": "Action Surge", "level": 1, "school": "Martial", "casting_time": "1 bonus action", "range": "Self"},
        ],
    }

    pdf_bytes = renderer.render_pdf_bytes(mock_character)
    assert isinstance(pdf_bytes, bytes)
    assert len(pdf_bytes) > 1000
    assert pdf_bytes.startswith(b"%PDF-")
