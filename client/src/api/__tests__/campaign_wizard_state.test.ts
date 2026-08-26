/**
 * Iteration 70 — Guided Campaign Setup Wizard (GOALS.md Pillar 2), pure-logic
 * contracts:
 *
 *  1. STEP GATING: the Identity step is the only gated one (a non-blank name
 *     is required); later steps always advance.
 *  2. PAYLOAD SHAPING: `wizardCreateRequestBody` emits exactly what the
 *     gateway models since iteration 71 — `{ name, rule_version,
 *     starting_level, party_size }` — clamped into the validated bands and
 *     with no invented fields (atmosphere never rides the wire).
 *  3. HONESTY LEDGER: `clientOnlyWizardFields` names every selection that is
 *     still DATA ONLY; it is empty now that all three table selections are
 *     real, so the UI's post-create note reports full wire coverage.
 */

import { describe, expect, it } from 'vitest';
import {
  canAdvanceStep,
  clampPartySize,
  clampStartingLevel,
  clientOnlyWizardFields,
  DEFAULT_PARTY_SIZE,
  reviewRows,
  RULE_VERSION_OPTIONS,
  ruleVersionLabel,
  STARTING_LEVEL_OPTIONS,
  wizardCreateRequestBody,
  WIZARD_STEPS,
  type CampaignWizardConfig,
} from '../campaign_wizard_state';

const CONFIG: CampaignWizardConfig = {
  name: 'The Fall of Baron Vane',
  atmosphereId: 'emberfall',
  ruleVersion: 'srd_5_1',
  partySize: 6,
  startingLevel: 3,
};

describe('wizard step gating', () => {
  it('exposes the four documented steps in order', () => {
    expect([...WIZARD_STEPS]).toEqual(['Identity', 'Ruleset', 'Party', 'Review']);
  });

  it('gates ONLY the Identity step on a non-blank name', () => {
    expect(canAdvanceStep(0, '')).toBe(false);
    expect(canAdvanceStep(0, '   ')).toBe(false);
    // Whitespace-padded names count once trimmed.
    expect(canAdvanceStep(0, '  Ravenmoor  ')).toBe(true);
    expect(canAdvanceStep(1, '')).toBe(true);
    expect(canAdvanceStep(2, '')).toBe(true);
    expect(canAdvanceStep(3, '')).toBe(true);
  });

  it('rejects out-of-range steps outright', () => {
    expect(canAdvanceStep(-1, 'x')).toBe(false);
    expect(canAdvanceStep(WIZARD_STEPS.length, 'x')).toBe(false);
    expect(canAdvanceStep(Number.NaN, 'x')).toBe(false);
  });
});

describe('rule version options', () => {
  it('offers both SRD versions with stable labels', () => {
    expect(RULE_VERSION_OPTIONS.map((rv) => rv.id)).toEqual(['srd_5_2', 'srd_5_1']);
    expect(ruleVersionLabel('srd_5_1')).toBe('SRD 5.1');
    expect(ruleVersionLabel('srd_5_2')).toBe('SRD 5.2');
  });

  it('passes unknown ids through instead of inventing a label', () => {
    expect(ruleVersionLabel('srd_6_draft')).toBe('srd_6_draft');
  });
});

describe('input clamping', () => {
  it('clamps party size into the 2..8 seat band and defaults garbage', () => {
    expect(clampPartySize(1)).toBe(2);
    expect(clampPartySize(99)).toBe(8);
    expect(clampPartySize('5')).toBe(5);
    expect(clampPartySize(4.6)).toBe(5);
    expect(clampPartySize(undefined)).toBe(DEFAULT_PARTY_SIZE);
    expect(clampPartySize('not-a-number')).toBe(DEFAULT_PARTY_SIZE);
  });

  it('snaps starting level to the nearest offered level', () => {
    expect(clampStartingLevel(0)).toBe(1);
    expect(clampStartingLevel(2)).toBe(2);
    expect(clampStartingLevel(10)).toBe(3);
    expect(clampStartingLevel(-7)).toBe(STARTING_LEVEL_OPTIONS[0]);
    expect(clampStartingLevel(null)).toBe(STARTING_LEVEL_OPTIONS[0]);
  });
});

describe('payload shaping — the honest wire contract', () => {
  it('sends the trimmed name plus the three gateway-accepted selections in snake_case', () => {
    const body = wizardCreateRequestBody('  The Fall of Baron Vane  ', {
      ruleVersion: 'srd_5_1',
      partySize: 6,
      startingLevel: 3,
    });
    expect(body).toEqual({
      name: 'The Fall of Baron Vane',
      rule_version: 'srd_5_1',
      starting_level: 3,
      party_size: 6,
    });
    // Exactly the four fields the gateway models — nothing invented.
    expect(Object.keys(body).sort()).toEqual(
      ['name', 'party_size', 'rule_version', 'starting_level'].sort()
    );
  });

  it('re-clamps selections into the legal bands the gateway validates', () => {
    // The create endpoint answers 422 outside rule_version's literal union,
    // level 1..20 or party size 2..8; garbage state must never reach that
    // refusal from client code.
    const body = wizardCreateRequestBody('Doomvault', {
      ruleVersion: 'srd_5_2',
      partySize: 99,
      startingLevel: -7,
    });
    expect(body.party_size).toBe(8); // PARTY_SIZE_MAX
    expect(body.starting_level).toBe(1); // nearest offered level
  });

  it('never leaks the atmosphere preset or any other client-side field', () => {
    const body = wizardCreateRequestBody(CONFIG.name, CONFIG) as unknown as Record<
      string,
      unknown
    >;
    expect(body.atmosphere_id).toBeUndefined();
    expect(body.atmosphereId).toBeUndefined();
    expect(body.ruleVersion).toBeUndefined();
    expect(body.partySize).toBeUndefined();
    expect(body.startingLevel).toBeUndefined();
  });
});

describe('client-only field ledger', () => {
  it('is empty now that rule version, party size and level ride the wire', () => {
    expect(clientOnlyWizardFields(CONFIG)).toEqual([]);
  });
});

describe('review rows', () => {
  it('summarizes every selection with display labels', () => {
    const rows = reviewRows(CONFIG);
    expect(rows[0]).toEqual(['Campaign', 'The Fall of Baron Vane']);
    expect(rows[1]).toEqual(['Atmosphere', 'emberfall']);
    expect(rows[2]).toEqual(['Rules', 'SRD 5.1']);
    expect(rows[3]).toEqual(['Party size', '6 player seats']);
    expect(rows[4]).toEqual(['Starting level', '3']);
  });

  it('shows an honest placeholder rather than an empty name cell', () => {
    expect(reviewRows({ ...CONFIG, name: '   ' })[0][1]).toBe('(unnamed)');
  });
});
