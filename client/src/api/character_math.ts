/**
 * Shared 5e SRD derivation math — the single source of truth for both the
 * CharacterBuilderView wizard and the in-game CharacterSheet HUD.
 *
 * Pure functions only: no React, no network, no side effects.
 */

export type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export const ABILITY_KEYS: AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export const ABILITY_LABELS: Record<AbilityKey, string> = {
  str: 'STR',
  dex: 'DEX',
  con: 'CON',
  int: 'INT',
  wis: 'WIS',
  cha: 'CHA',
};

/** Standard 5e modifier: floor((score - 10) / 2). */
export function getModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** "+4" / "-1" / "+0" display form of a modifier. */
export function formatModifier(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

/** Racial ability bonuses for the builder's ancestry list (0 when unknown race). */
export function racialBonus(race: string, ability: AbilityKey): number {
  switch (race) {
    case 'Mountain Dwarf':
      return ability === 'str' ? 2 : ability === 'con' ? 2 : 0;
    case 'High Elf':
      return ability === 'dex' ? 2 : ability === 'int' ? 1 : 0;
    case 'Human':
      return 1;
    case 'Tiefling':
      return ability === 'cha' ? 2 : ability === 'int' ? 1 : 0;
    case 'Lightfoot Halfling':
      return ability === 'dex' ? 2 : ability === 'cha' ? 1 : 0;
    case 'Dragonborn':
      return ability === 'str' ? 2 : ability === 'cha' ? 1 : 0;
    default:
      return 0;
  }
}

/** 27-point-buy cost table (5e SRD). Scores outside 8-15 cost 0 (not purchasable). */
export const POINT_BUY_COSTS: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

export function pointBuyCost(score: number): number {
  return POINT_BUY_COSTS[score] ?? 0;
}

export function pointBuyTotal(scores: Record<AbilityKey, number>): number {
  return ABILITY_KEYS.reduce((total, key) => total + pointBuyCost(scores[key]), 0);
}

/** Proficiency bonus by character level (5e SRD progression table). */
export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

/** Passive Perception = 10 + WIS mod + 2 (Perception proficiency assumed). */
export function passivePerception(wisModifier: number): number {
  return 10 + wisModifier + 2;
}

/**
 * Armor class by class archetype. Unarmored Defense variants for Barbarian/Monk,
 * Mage Armor-equivalent baseline for Wizard, otherwise Scale Mail + Shield.
 */
export function computedAC(characterClass: string, dexMod: number, conMod: number, wisMod: number): number {
  if (characterClass === 'Barbarian') return 10 + dexMod + conMod;
  if (characterClass === 'Monk') return 10 + dexMod + wisMod;
  if (characterClass === 'Wizard') return 10 + dexMod;
  return 14 + Math.min(2, dexMod) + 2; // Scale Mail + Shield for Fighter/Paladin
}

/** Hit points at level: hit die max + 6/level average + CON mod per level. */
export function computedHP(characterClass: string, level: number, conMod: number): number {
  const hitDieMax =
    characterClass === 'Barbarian'
      ? 12
      : characterClass === 'Fighter' || characterClass === 'Paladin'
      ? 10
      : 8;
  return hitDieMax + (Math.max(1, level) - 1) * 6 + conMod * Math.max(1, level);
}
