/**
 * Unit tests for the XP-budget half of src/api/encounter_store.ts.
 *
 * Expectations come from the SRD/DMG tables themselves (CR->XP, per-level
 * encounter thresholds, DMG multiplier bands), NOT from the implementation —
 * so any transcription error in either direction fails. Only pure functions
 * are exercised here; the fetch/spawn paths need a live gateway and are
 * covered by integration, not unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  CR_TO_XP,
  crToXp,
  encounterMultiplier,
  parsePrimarySpeedFeet,
  partyThresholds,
  XP_THRESHOLDS_BY_LEVEL,
} from '../encounter_store';

describe('crToXp — SRD "Monster Statistics by Challenge Rating"', () => {
  it('maps known CR values to their exact XP awards', () => {
    expect(crToXp('0')).toBe(10);
    expect(crToXp('1/8')).toBe(25);
    expect(crToXp('1/4')).toBe(50);
    expect(crToXp('1/2')).toBe(100);
    expect(crToXp('1')).toBe(200);
    expect(crToXp('2')).toBe(450);
    expect(crToXp('5')).toBe(1800);
    expect(crToXp('10')).toBe(5900);
    expect(crToXp('17')).toBe(18000);
    expect(crToXp('20')).toBe(25000);
    expect(crToXp('30')).toBe(155000);
  });

  it('is strictly increasing across the integer CR ladder (table sanity)', () => {
    let previous = -1;
    for (let cr = 0; cr <= 30; cr++) {
      const xp = crToXp(String(cr));
      expect(xp).not.toBeNull();
      expect(xp as number).toBeGreaterThan(previous);
      previous = xp as number;
    }
  });

  it('covers every level in the threshold table with an entry for each CR key', () => {
    // The compendium serves CRs as free text; every key we ship must be
    // reachable through crToXp (guards against key/value typos like '1O').
    expect(Object.keys(CR_TO_XP)).toHaveLength(34); // 0..30 plus 1/8, 1/4, 1/2
    for (const key of Object.keys(CR_TO_XP)) {
      expect(crToXp(key)).toBe(CR_TO_XP[key]);
    }
  });

  it('returns null for unmapped CRs instead of guessing', () => {
    expect(crToXp('31')).toBeNull();
    expect(crToXp('3/4')).toBeNull();
    expect(crToXp('ancient dragon')).toBeNull();
    expect(crToXp('')).toBeNull();
  });

  it('tolerates whitespace and missing input', () => {
    expect(crToXp(' 5 ')).toBe(1800);
    // The implementation guards with String(challengeRating ?? ''), so a
    // compendium entry missing the CR field yields null, not a crash.
    expect(crToXp(undefined as unknown as string)).toBeNull();
    expect(crToXp(null as unknown as string)).toBeNull();
  });
});

describe('encounterMultiplier — DMG action-economy bands', () => {
  it('hits every band boundary exactly: 1 / 2 / 3-6 / 7-10 / 11-14 / 15+', () => {
    expect(encounterMultiplier(1)).toBe(1.0);
    expect(encounterMultiplier(2)).toBe(1.5);
    expect(encounterMultiplier(3)).toBe(2.0);
    expect(encounterMultiplier(6)).toBe(2.0);
    expect(encounterMultiplier(7)).toBe(2.5);
    expect(encounterMultiplier(10)).toBe(2.5);
    expect(encounterMultiplier(11)).toBe(3.0);
    expect(encounterMultiplier(14)).toBe(3.0);
    expect(encounterMultiplier(15)).toBe(4.0);
  });

  it('treats zero and negative counts as a single creature (x1.0)', () => {
    expect(encounterMultiplier(0)).toBe(1.0);
    expect(encounterMultiplier(-3)).toBe(1.0);
  });

  it('keeps scaling past 15 creatures at x4.0', () => {
    expect(encounterMultiplier(40)).toBe(4.0);
  });
});

describe('partyThresholds — per-character SRD thresholds scaled by party size', () => {
  it('matches the SRD per-character row for a single level-1 PC', () => {
    expect(partyThresholds(1, 1)).toEqual({ easy: 25, medium: 50, hard: 75, deadly: 100 });
  });

  it('scales a sample party of four level-5 PCs on all four difficulty tiers', () => {
    // Level 5 row is [250, 500, 750, 1100].
    expect(partyThresholds(5, 4)).toEqual({
      easy: 1000,
      medium: 2000,
      hard: 3000,
      deadly: 4400,
    });
  });

  it('uses distinct rows per level (level 3 vs level 12 are not interchangeable)', () => {
    expect(partyThresholds(3, 2)).toEqual({ easy: 150, medium: 300, hard: 450, deadly: 800 });
    expect(partyThresholds(12, 2)).toEqual({ easy: 2000, medium: 4000, hard: 6000, deadly: 9000 });
  });

  it('falls back to the level-5 row for out-of-table levels rather than crashing', () => {
    expect(partyThresholds(99, 1)).toEqual(partyThresholds(5, 1));
    expect(partyThresholds(0, 1)).toEqual(partyThresholds(5, 1));
  });

  it('a party of zero yields all-zero thresholds (degenerate but defined)', () => {
    expect(partyThresholds(5, 0)).toEqual({ easy: 0, medium: 0, hard: 0, deadly: 0 });
  });

  it('the shipped table covers exactly levels 1..20', () => {
    const levels = Object.keys(XP_THRESHOLDS_BY_LEVEL).map(Number).sort((a, b) => a - b);
    expect(levels).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe('parsePrimarySpeedFeet', () => {
  it('reduces a compendium speed line to its leading feet rate', () => {
    expect(parsePrimarySpeedFeet('10 ft., swim 40 ft.')).toBe(10);
    expect(parsePrimarySpeedFeet('30 ft.')).toBe(30);
    expect(parsePrimarySpeedFeet('walk 25 ft., fly 60 ft.')).toBe(25);
    expect(parsePrimarySpeedFeet('0 ft.')).toBe(0);
  });

  it('refuses to guess when nothing numeric-with-feet exists', () => {
    expect(parsePrimarySpeedFeet(undefined)).toBeNull();
    expect(parsePrimarySpeedFeet('')).toBeNull();
    expect(parsePrimarySpeedFeet('burrows through earth')).toBeNull();
    expect(parsePrimarySpeedFeet('teleports 100 squares')).toBeNull();
  });
});
