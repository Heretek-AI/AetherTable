"""Shared DMG encounter-balance model (XP thresholds + multipliers).

Extracted from :mod:`vtt_orchestrator.compendium.starter_adventures` so the
build-time adventure audit and the runtime gateway route
(``POST /api/v1/engine/encounter/balance``) compute difficulty from ONE table
instead of two copies that can drift. The starter-adventure module re-exports
the moved names for backward compatibility.
"""

import json
import os
from typing import Any, Dict, List

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
COMPENDIUM_DIR = os.path.join(PROJECT_ROOT, "compendium")
MONSTERS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_monsters.json")

# Standard DMG XP thresholds per character BY PARTY LEVEL, plus the official
# encounter multipliers by hostile count and the per-PC daily XP budget.
# Shipped balance numbers are recomputed from these tables at build time, so a
# stale hand-written difficulty label can never ship.
XP_THRESHOLDS: Dict[int, Dict[str, int]] = {
    1: {"easy": 50, "medium": 100, "hard": 200, "deadly": 400},
    2: {"easy": 100, "medium": 200, "hard": 400, "deadly": 600},
    3: {"easy": 150, "medium": 300, "hard": 550, "deadly": 900},
    4: {"easy": 250, "medium": 500, "hard": 750, "deadly": 1100},
    5: {"easy": 500, "medium": 1000, "hard": 1500, "deadly": 2200},
    6: {"easy": 600, "medium": 1000, "hard": 1500, "deadly": 2500},
    7: {"easy": 750, "medium": 1300, "hard": 1800, "deadly": 2800},
    8: {"easy": 1000, "medium": 1600, "hard": 2100, "deadly": 3600},
    9: {"easy": 1100, "medium": 1900, "hard": 2600, "deadly": 4400},
    10: {"easy": 1200, "medium": 2000, "hard": 2800, "deadly": 5000},
    11: {"easy": 1250, "medium": 2100, "hard": 2900, "deadly": 5200},
    12: {"easy": 1400, "medium": 2400, "hard": 3300, "deadly": 6000},
    13: {"easy": 1500, "medium": 2600, "hard": 3600, "deadly": 6500},
    14: {"easy": 1700, "medium": 2900, "hard": 3900, "deadly": 7000},
    15: {"easy": 1800, "medium": 3000, "hard": 4200, "deadly": 7500},
    16: {"easy": 2000, "medium": 3200, "hard": 4500, "deadly": 8000},
    17: {"easy": 2100, "medium": 3400, "hard": 4800, "deadly": 8500},
    18: {"easy": 2200, "medium": 3600, "hard": 5000, "deadly": 9000},
    19: {"easy": 2400, "medium": 3800, "hard": 5300, "deadly": 9500},
    20: {"easy": 2500, "medium": 4000, "hard": 5700, "deadly": 10500},
}
DAILY_XP_BUDGET_PER_PC = {level: bands["easy"] * 6 for level, bands in XP_THRESHOLDS.items()}
_ENCOUNTER_MULTIPLIERS = (
    (1, 0.5), (2, 1.0), (6, 1.5), (10, 2.0), (15, 2.5),
)
# The DMG table's top band ("15 or more") is open-ended: any horde larger than
# 15 keeps the 2.5x multiplier rather than raising.
_ENCOUNTER_MULTIPLIER_CEILING = _ENCOUNTER_MULTIPLIERS[-1][1]
CR_CEILING_FOR_PARTY_LEVEL: Dict[int, int] = {1: 3}  # nothing above CR 3 vs level-1 PCs

_MONSTER_CACHE: Dict[str, Dict[str, Any]] = {}


def load_monster_compendium() -> Dict[str, Dict[str, Any]]:
    """Load srd_5_2_monsters.json keyed by compendium id (cached)."""
    if not _MONSTER_CACHE:
        with open(MONSTERS_FILE, "r", encoding="utf-8") as f:
            entries = json.load(f)
        _MONSTER_CACHE.update({m["id"]: m for m in entries})
    return _MONSTER_CACHE


def _encounter_multiplier(hostile_count: int) -> float:
    """Official DMG multiplier for a given number of hostiles in one fight.

    The top table band ("15 or more") is open-ended, so any larger horde keeps
    the 2.5x ceiling instead of raising.
    """
    for bound, multiplier in _ENCOUNTER_MULTIPLIERS:
        if hostile_count <= bound:
            return multiplier
    return _ENCOUNTER_MULTIPLIER_CEILING


def monster_challenge_rating_value(entry: Dict[str, Any]) -> float:
    """Parses '1/4' / '0' / '10' into a comparable float."""
    cr = str(entry["challenge_rating"])
    num, _, den = cr.partition("/")
    return float(num) / float(den or 1)


def encounter_balance(
    monster_refs: List[Dict[str, Any]],
    party_level: int = 1,
    party_size: int = 4,
) -> Dict[str, Any]:
    """Compute the DMG difficulty verdict for one encounter.

    Uses the real ``xp`` field of every referenced stat block, applies the
    official encounter multiplier for the hostile count, and compares the
    adjusted total against the level-appropriate threshold table scaled by
    party size.

    Raises ``KeyError`` naming any unknown ``monster_id`` — callers translate
    that into an honest client-facing error rather than inventing stats.
    """
    compendium = load_monster_compendium()
    thresholds = {
        band: value * party_size
        for band, value in XP_THRESHOLDS[party_level].items()
    }
    raw_xp = sum(
        int(compendium[ref["monster_id"]]["xp"]) * int(ref["quantity"])
        for ref in monster_refs
    )
    hostiles = sum(int(ref["quantity"]) for ref in monster_refs)
    multiplier = _encounter_multiplier(hostiles)
    adjusted_xp = int(raw_xp * multiplier)

    if adjusted_xp >= thresholds["deadly"]:
        difficulty = "DEADLY"
    elif adjusted_xp >= thresholds["hard"]:
        difficulty = "HARD"
    elif adjusted_xp >= thresholds["medium"]:
        difficulty = "MEDIUM"
    elif adjusted_xp >= thresholds["easy"]:
        difficulty = "EASY"
    else:
        difficulty = "TRIVIAL"

    max_cr = max(
        monster_challenge_rating_value(compendium[ref["monster_id"]])
        for ref in monster_refs
    )
    ceiling = CR_CEILING_FOR_PARTY_LEVEL.get(party_level)
    return {
        "model": "dmg_xp_threshold",
        "party_level": party_level,
        "party_size": party_size,
        "raw_xp": raw_xp,
        "adjusted_xp": adjusted_xp,
        "multiplier": multiplier,
        "difficulty": difficulty,
        "within_cr_ceiling": ceiling is None or max_cr <= ceiling,
    }
