/**
 * Unit tests for the GOALS.md Pillar-8 fail-forward outcome band shaper.
 *
 * The Rust engine resolves every ability check on a FOUR-tier margin
 * (crates/vtt-core/src/actions.rs resolve_check_4tier) and returns the tier
 * plus an optional Complication carrying the actual fail-forward costs:
 * resource deductions, inflicted conditions and a tactical penalty. These
 * tests pin the client-side mapping from that verbatim payload onto the
 * presentation contract — including the HONEST "engine unresolved" state for
 * responses that arrive without a recognizable tier (the client must never
 * invent a success/failure the ledger did not record).
 */
import { describe, expect, it } from 'vitest';
import {
  checkPassed,
  formatResourceDeductions,
  logOutcomeForTier,
  shapeCheckOutcome,
  summarizeComplication,
  type EngineCheckPayload,
} from '../check_outcome';

const baseResult = (over: Partial<EngineCheckPayload>): EngineCheckPayload => ({
  roll: 11,
  modifier: 3,
  total: 14,
  dc: 12,
  outcome: 'SUCCESS',
  ...over,
});

describe('formatResourceDeductions', () => {
  it('formats a single deduction as a signed cost', () => {
    expect(formatResourceDeductions({ stamina: 3 })).toEqual(['stamina −3']);
  });

  it('formats several deductions deterministically', () => {
    expect(formatResourceDeductions({ stamina: 5, hp: 2 })).toEqual([
      'hp −2',
      'stamina −5',
    ]);
  });

  it('skips zero and negative garbage rather than showing fake costs', () => {
    expect(formatResourceDeductions({ stamina: 0, hp: -1 })).toEqual([]);
  });

  it('returns empty for absent maps', () => {
    expect(formatResourceDeductions(undefined)).toEqual([]);
  });
});

describe('summarizeComplication', () => {
  it('joins description, costs, conditions and penalty into one line', () => {
    const line = summarizeComplication({
      description: 'You barely manage to pull it off, but overextend your position',
      resource_deductions: { stamina: 3 },
      inflicted_conditions: [],
      tactical_penalty: 'Loss of footing, movement halved next turn',
    });
    expect(line).toBe(
      'You barely manage to pull it off, but overextend your position — ' +
        'stamina −3; Loss of footing, movement halved next turn',
    );
  });

  it('names inflicted conditions', () => {
    const line = summarizeComplication({
      description: 'Catastrophic stumble or tool breakage',
      resource_deductions: { stamina: 5 },
      inflicted_conditions: ['prone'],
      tactical_penalty: 'Grants advantage to enemy next turn',
    });
    expect(line).toContain('prone');
    expect(line).toContain('Grants advantage to enemy next turn');
  });

  it('is null when the engine sent no complication', () => {
    expect(summarizeComplication(null)).toBeNull();
    expect(summarizeComplication(undefined)).toBeNull();
  });

  it('survives an empty complication object without fabricating text', () => {
    expect(summarizeComplication({})).toBeNull();
  });
});

describe('shapeCheckOutcome — the four engine tiers', () => {
  it('maps plain SUCCESS to the standard success treatment (no cost text)', () => {
    const shaped = shapeCheckOutcome(baseResult({}));
    expect(shaped.tier).toBe('success');
    expect(shaped.passed).toBe(true);
    expect(shaped.headline).toMatch(/success/i);
    expect(shaped.detail).toBeNull();
  });

  it('maps CRITICAL_SUCCESS distinctly', () => {
    const shaped = shapeCheckOutcome(
      baseResult({ roll: 20, total: 23, outcome: 'CRITICAL_SUCCESS' }),
    );
    expect(shaped.tier).toBe('critical_success');
    expect(shaped.passed).toBe(true);
    expect(shaped.detail).toBeNull();
  });

  it('surfaces SUCCESS_AT_A_COST as its own band with the real cost fields', () => {
    const shaped = shapeCheckOutcome(
      baseResult({
        roll: 9,
        total: 12,
        dc: 14,
        outcome: 'SUCCESS_AT_A_COST',
        complication: {
          description: 'You barely manage to pull it off, but overextend your position',
          resource_deductions: { stamina: 3 },
          inflicted_conditions: [],
          tactical_penalty: 'Loss of footing, movement halved next turn',
        },
      }),
    );
    expect(shaped.tier).toBe('success_at_cost');
    // Fail-forward still counts as a mechanical pass...
    expect(shaped.passed).toBe(true);
    // ...but the cost is quoted verbatim from the engine's Complication.
    expect(shaped.headline).toMatch(/cost/i);
    expect(shaped.detail).toContain('stamina −3');
    expect(shaped.detail).toContain('movement halved');
  });

  it('maps CRITICAL_FAILURE as a failure and quotes its complication', () => {
    const shaped = shapeCheckOutcome(
      baseResult({
        roll: 1,
        total: 4,
        outcome: 'CRITICAL_FAILURE',
        complication: {
          description: 'Catastrophic stumble or tool breakage',
          resource_deductions: { stamina: 5 },
          inflicted_conditions: ['prone'],
          tactical_penalty: 'Grants advantage to enemy next turn',
        },
      }),
    );
    expect(shaped.tier).toBe('critical_failure');
    expect(shaped.passed).toBe(false);
    expect(shaped.detail).toContain('prone');
    expect(shaped.detail).toContain('stamina −5');
  });

  it('treats a complication-less CRITICAL_FAILURE as a plain failure', () => {
    const shaped = shapeCheckOutcome(
      baseResult({ roll: 7, total: 8, dc: 16, outcome: 'CRITICAL_FAILURE' }),
    );
    expect(shaped.tier).toBe('critical_failure');
    expect(shaped.passed).toBe(false);
    expect(shaped.detail).toBeNull();
  });
});

describe('shapeCheckOutcome — the honest unresolved state', () => {
  it('refuses to grade a response whose outcome field is missing', () => {
    const raw = baseResult({});
    delete (raw as Partial<EngineCheckPayload>).outcome;
    const shaped = shapeCheckOutcome(raw);
    expect(shaped.tier).toBe('unresolved');
    expect(shaped.passed).toBe(false);
    expect(shaped.headline.toLowerCase()).toContain('unresolved');
  });

  it('refuses to grade an unrecognized outcome label', () => {
    const shaped = shapeCheckOutcome(baseResult({ outcome: 'MAYBE' }));
    expect(shaped.tier).toBe('unresolved');
    expect(shaped.passed).toBe(false);
  });

  it('handles a null payload (engine answered nothing usable)', () => {
    const shaped = shapeCheckOutcome(null);
    expect(shaped.tier).toBe('unresolved');
    expect(shaped.passed).toBe(false);
  });

  it('keeps the numeric facts visible even when the tier is unknown', () => {
    const shaped = shapeCheckOutcome(baseResult({ total: 17, dc: 12, outcome: undefined }));
    expect(shaped.rollTotal).toBe(17);
    expect(shaped.dc).toBe(12);
  });
});

describe('presentation helpers', () => {
  it('checkPassed agrees with the tier across the whole band', () => {
    expect(checkPassed('critical_success')).toBe(true);
    expect(checkPassed('success')).toBe(true);
    expect(checkPassed('success_at_cost')).toBe(true);
    expect(checkPassed('critical_failure')).toBe(false);
    expect(checkPassed('unresolved')).toBe(false);
  });

  it('logOutcomeForTier maps onto the roll-history badge vocabulary', () => {
    expect(logOutcomeForTier('critical_success')).toBe('success');
    expect(logOutcomeForTier('success')).toBe('success');
    expect(logOutcomeForTier('success_at_cost')).toBe('success_at_cost');
    expect(logOutcomeForTier('critical_failure')).toBe('failure');
    expect(logOutcomeForTier('unresolved')).toBe('unresolved');
  });
});
