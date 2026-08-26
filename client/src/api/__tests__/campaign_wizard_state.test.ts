/**
 * Iteration 70 — Guided Campaign Setup Wizard (GOALS.md Pillar 2), pure-logic
 * contracts:
 *
 *  1. STEP GATING: the Identity step is the only gated one (a non-blank name
 *     is the single field the lobby API accepts); later steps always advance.
 *  2. PAYLOAD SHAPING: `wizardCreateRequestBody` emits EXACTLY `{ name }` —
 *     no invented server fields for rule version / party size / level.
 *  3. HONESTY LEDGER: `clientOnlyWizardFields` names every client-only
 *     selection so the UI's "server support pending" note cannot drift from
 *     what the code actually sends.
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
  it('sends EXACTLY { name }, trimmed, with no invented fields', () => {
    const body = wizardCreateRequestBody('  The Fall of Baron Vane  ');
    expect(body).toEqual({ name: 'The Fall of Baron Vane' });
    expect(Object.keys(body)).toEqual(['name']);
  });

  it('never leaks rule version, party size or level onto the wire', () => {
    const body = wizardCreateRequestBody(CONFIG.name) as Record<string, unknown>;
    expect(body.rule_version).toBeUndefined();
    expect(body.party_size).toBeUndefined();
    expect(body.starting_level).toBeUndefined();
  });
});

describe('client-only field ledger', () => {
  it('accounts for every selection that has no server field yet', () => {
    const ledger = clientOnlyWizardFields(CONFIG);
    expect(ledger.map((f) => f.field)).toEqual(['Rule version', 'Party size', 'Starting level']);
    expect(ledger[0].value).toBe('SRD 5.1');
    expect(ledger[1].value).toBe('6 seats');
    expect(ledger[2].value).toBe('3');
  });

  it('gives each entry a concrete reason, never a bare apology', () => {
    for (const entry of clientOnlyWizardFields(CONFIG)) {
      expect(entry.reason.length).toBeGreaterThan(8);
    }
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
