/**
 * Unit tests for src/api/character_math.ts — the shared 5e SRD derivation
 * math consumed by both the CharacterBuilderView wizard and the CharacterSheet
 * HUD. Every expectation below is taken from the SRD tables, not from the
 * implementation, so a regression in either direction fails loudly.
 */
import { describe, expect, it } from 'vitest';
import {
  ABILITY_KEYS,
  computedAC,
  computedHP,
  HIT_DIE_BY_CLASS,
  formatModifier,
  getModifier,
  passivePerception,
  pointBuyCost,
  pointBuyTotal,
  POINT_BUY_COSTS,
  proficiencyBonus,
  racialBonus,
} from '../character_math';

describe('getModifier — floor((score-10)/2) table edges', () => {
  it('maps the 8/9/10/11 straddle correctly', () => {
    // 8 and 9 are BOTH -1 (floor of -1.0 and -0.5); 10 and 11 are both +0.
    expect(getModifier(8)).toBe(-1);
    expect(getModifier(9)).toBe(-1);
    expect(getModifier(10)).toBe(0);
    expect(getModifier(11)).toBe(0);
  });

  it('matches the SRD column at other anchor scores', () => {
    const expected: Record<number, number> = {
      1: -5, 3: -4, 7: -2, 12: 1, 13: 1, 14: 2, 15: 2, 16: 3, 18: 4, 19: 4, 20: 5, 30: 10,
    };
    for (const [score, mod] of Object.entries(expected)) {
      expect(getModifier(Number(score))).toBe(mod);
    }
  });
});

describe('formatModifier', () => {
  it('signs non-negative values explicitly, including zero', () => {
    expect(formatModifier(0)).toBe('+0');
    expect(formatModifier(4)).toBe('+4');
    expect(formatModifier(-1)).toBe('-1');
    expect(formatModifier(-5)).toBe('-5');
  });
});

describe('point-buy costs (27-point budget)', () => {
  it('uses the exact SRD cost ladder', () => {
    expect(POINT_BUY_COSTS).toEqual({ 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 });
    expect(pointBuyCost(8)).toBe(0);
    expect(pointBuyCost(9)).toBe(1);
    expect(pointBuyCost(10)).toBe(2);
    expect(pointBuyCost(11)).toBe(3);
    expect(pointBuyCost(12)).toBe(4);
    expect(pointBuyCost(13)).toBe(5);
    expect(pointBuyCost(14)).toBe(7);
    expect(pointBuyCost(15)).toBe(9);
  });

  it('caps at score 15: nothing above 15 is purchasable (costs 0, not more)', () => {
    // The jump 13->14 (+2) then 14->15 (+2) ends at 15; 16+ must NOT continue
    // the ladder (a naive "+2 forever" implementation would return 11).
    expect(pointBuyCost(16)).toBe(0);
    expect(pointBuyCost(18)).toBe(0);
    expect(pointBuyCost(20)).toBe(0);
  });

  it('costs 0 below the 8 floor', () => {
    expect(pointBuyCost(7)).toBe(0);
    expect(pointBuyCost(3)).toBe(0);
  });

  it('the classic 27-point array sums to exactly 27', () => {
    const standard: Record<string, number> = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
    expect(pointBuyTotal(standard as never)).toBe(9 + 7 + 5 + 4 + 2 + 0);
  });

  it('the maximum legal spread (three 15s, three 8s) spends exactly 27 points', () => {
    const maxLegal = { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 };
    expect(pointBuyTotal(maxLegal)).toBe(27);
  });

  it('rejects an over-budget array (fourth 15 cannot fit in 27 points)', () => {
    const overBudget = { str: 15, dex: 15, con: 15, int: 15, wis: 8, cha: 8 };
    expect(pointBuyTotal(overBudget)).toBe(36);
  });

  it('sums over all six abilities regardless of key order', () => {
    expect(ABILITY_KEYS).toHaveLength(6);
    const allEights = { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
    expect(pointBuyTotal(allEights)).toBe(0);
  });
});

describe('proficiencyBonus — SRD progression', () => {
  it('is +2/+3/+4/+6 at levels 1/5/9/17', () => {
    expect(proficiencyBonus(1)).toBe(2);
    expect(proficiencyBonus(5)).toBe(3);
    expect(proficiencyBonus(9)).toBe(4);
    expect(proficiencyBonus(17)).toBe(6);
  });

  it('steps on the 4-level boundaries, not off by one', () => {
    expect(proficiencyBonus(4)).toBe(2); // last level at +2
    expect(proficiencyBonus(8)).toBe(3); // last level at +3
    expect(proficiencyBonus(12)).toBe(4);
    expect(proficiencyBonus(16)).toBe(5);
    expect(proficiencyBonus(13)).toBe(5);
    expect(proficiencyBonus(20)).toBe(6);
  });

  it('clamps sub-1 levels to the level-1 value instead of going negative', () => {
    expect(proficiencyBonus(0)).toBe(2);
    expect(proficiencyBonus(-7)).toBe(2);
  });
});

describe('passivePerception', () => {
  // Documented formula: 10 + WIS modifier + 2 (Perception proficiency).
  it('adds the proficiency-flavored +2 on top of 10 + WIS mod', () => {
    expect(passivePerception(-1)).toBe(11);
    expect(passivePerception(0)).toBe(12);
    expect(passivePerception(3)).toBe(15);
    expect(passivePerception(5)).toBe(17);
  });
});

describe('computedAC — unarmored defense variants', () => {
  it('Barbarian: 10 + DEX + CON', () => {
    expect(computedAC('Barbarian', 2, 3, 0)).toBe(15);
    expect(computedAC('Barbarian', 5, 5, 0)).toBe(20);
  });

  it('Monk: 10 + DEX + WIS (CON ignored)', () => {
    expect(computedAC('Monk', 3, 4, 2)).toBe(15);
    expect(computedAC('Monk', 3, 0, 4)).toBe(17);
  });

  it('Wizard: mage-armor-equivalent baseline 10 + DEX only', () => {
    expect(computedAC('Wizard', 2, 0, 0)).toBe(12);
    expect(computedAC('Wizard', 5, 0, 0)).toBe(15);
  });

  it('armored default: Scale Mail + Shield with DEX capped at +2', () => {
    expect(computedAC('Fighter', 0, 0, 0)).toBe(16); // 14 + 0 + 2
    expect(computedAC('Fighter', 2, 0, 0)).toBe(18); // 14 + 2 + 2
    expect(computedAC('Fighter', 3, 0, 0)).toBe(18); // cap bites at +2
    expect(computedAC('Paladin', 5, 0, 0)).toBe(18); // cap still bites
  });
});

describe('computedHP', () => {
  // SRD "Hit Points — Hit Dice" per class: Barbarian d12; Fighter and
  // Paladin d10; Bard, Cleric, Druid, Monk, Ranger, Rogue and Warlock d8;
  // Sorcerer and Wizard d6. Level 1 HP is the die MAX + CON mod; each level
  // beyond first adds the SRD take-the-average value (half the die, rounded
  // up, i.e. floor(die/2) + 1) plus the CON mod again.
  it('level 1 uses the correct class hit-die max plus one CON application', () => {
    expect(computedHP('Wizard', 1, 0)).toBe(6);   // d6, not d8
    expect(computedHP('Sorcerer', 1, 1)).toBe(7); // d6
    expect(computedHP('Rogue', 1, 0)).toBe(8);    // d8
    expect(computedHP('Cleric', 1, 2)).toBe(10);  // d8
    expect(computedHP('Fighter', 1, 1)).toBe(11); // d10
    expect(computedHP('Barbarian', 1, 2)).toBe(14); // d12
  });

  it('covers every hit-die tier of the SRD class table', () => {
    expect(HIT_DIE_BY_CLASS).toEqual({
      Barbarian: 12,
      Fighter: 10,
      Paladin: 10,
      Bard: 8,
      Cleric: 8,
      Druid: 8,
      Monk: 8,
      Ranger: 8,
      Rogue: 8,
      Warlock: 8,
      Sorcerer: 6,
      Wizard: 6,
    });
  });

  it('grows by the per-class average (half die + 1) plus CON per level beyond first', () => {
    // Wizard d6 -> +4/level; level 5, CON +2: 6 + 4*4 + 5*2 = 32.
    expect(computedHP('Wizard', 5, 2)).toBe(6 + 4 * 4 + 5 * 2);
    // Paladin d10 -> +6/level; level 3, CON -1: 10 + 2*6 - 3 = 19.
    expect(computedHP('Paladin', 3, -1)).toBe(10 + 2 * 6 + 3 * -1);
    // Barbarian d12 -> +7/level; level 20, CON +5: 12 + 19*7 + 100 = 245.
    expect(computedHP('Barbarian', 20, 5)).toBe(12 + 19 * 7 + 20 * 5);
  });

  it('treats level 0 / negative levels as level 1 rather than producing nonsense', () => {
    expect(computedHP('Wizard', 0, 0)).toBe(6);
    expect(computedHP('Wizard', -3, 1)).toBe(7); // 6 (die max) + 1 (CON)
  });

  it('falls back to the d8 median for an unrecognized class name', () => {
    expect(computedHP('Mystic', 1, 0)).toBe(8);
    expect(computedHP('', 1, 0)).toBe(8);
  });
});

describe('racialBonus', () => {
  it('returns the known ancestry packages and 0 for unknown races', () => {
    expect(racialBonus('Mountain Dwarf', 'str')).toBe(2);
    expect(racialBonus('Mountain Dwarf', 'con')).toBe(2);
    expect(racialBonus('Mountain Dwarf', 'dex')).toBe(0);
    expect(racialBonus('High Elf', 'dex')).toBe(2);
    expect(racialBonus('High Elf', 'int')).toBe(1);
    expect(racialBonus('Human', 'cha')).toBe(1);
    expect(racialBonus('Tiefling', 'cha')).toBe(2);
    expect(racialBonus('Lightfoot Halfling', 'dex')).toBe(2);
    expect(racialBonus('Dragonborn', 'str')).toBe(2);
    expect(racialBonus('Warforged', 'str')).toBe(0);
    expect(racialBonus('', 'str')).toBe(0);
  });
});
