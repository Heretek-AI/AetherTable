/**
 * Iteration 63 — unit tests for api/entity_status_state.ts.
 *
 * These pin the wire contract against vtt-core's serde output
 * (crates/vtt-core/src/state.rs): `inspiration: bool`, `hands_occupied: u8`
 * saturated at 2, `conditions` as snake_case variants with `Exhaustion(u8)`
 * arriving as `{"exhaustion": level}`, and the session-level
 * `grapple_holders` escaper->holder map. The central discipline under test:
 * an ABSENT field means "the projection did not expose it" and must never be
 * coerced into a zero/free/not-held claim.
 */
import { describe, expect, it } from 'vitest';
import {
  MODELED_HANDS,
  formatHandsLabel,
  grappledBy,
  handsPips,
  parseEntityStatusFromSessionState,
} from '../entity_status_state';

describe('parseEntityStatusFromSessionState', () => {
  it('returns empty maps for non-object bodies', () => {
    expect(parseEntityStatusFromSessionState(null)).toEqual({
      byEntity: {},
      grappleHolders: {},
    });
    expect(parseEntityStatusFromSessionState('nope')).toEqual({
      byEntity: {},
      grappleHolders: {},
    });
    expect(parseEntityStatusFromSessionState({})).toEqual({
      byEntity: {},
      grappleHolders: {},
    });
  });

  it('parses inspiration, hands_occupied and conditions verbatim', () => {
    const snap = {
      entities: {
        hero: {
          id: 'hero',
          inspiration: true,
          hands_occupied: 1,
          conditions: ['grappled', 'prone'],
        },
        orc: { id: 'orc', inspiration: false, hands_occupied: 0, conditions: [] },
      },
    };
    const parsed = parseEntityStatusFromSessionState(snap);
    expect(parsed.byEntity.hero).toEqual({
      inspiration: true,
      handsOccupied: 1,
      conditions: ['grappled', 'prone'],
    });
    // An all-default entity still parses (explicit false / 0 / empty list are
    // real engine state, not absence).
    expect(parsed.byEntity.orc).toEqual({
      inspiration: false,
      handsOccupied: 0,
      conditions: undefined,
    });
  });

  it('keeps absent fields undefined instead of coercing to false/zero', () => {
    const parsed = parseEntityStatusFromSessionState({
      entities: { legacy: { id: 'legacy' } },
    });
    expect(parsed.byEntity.legacy).toBeUndefined();
  });

  it('skips malformed entries and clamps out-of-domain hand counts', () => {
    const parsed = parseEntityStatusFromSessionState({
      entities: {
        broken: null,
        weird: { hands_occupied: 7 },
        negative: { hands_occupied: -3 },
        fractional: { hands_occupied: 1.9 },
      },
    });
    expect(parsed.byEntity.broken).toBeUndefined();
    expect(parsed.byEntity.weird.handsOccupied).toBe(MODELED_HANDS);
    expect(parsed.byEntity.negative.handsOccupied).toBe(0);
    expect(parsed.byEntity.fractional.handsOccupied).toBe(1);
  });

  it('flattens Exhaustion(u8) objects to the variant name', () => {
    const parsed = parseEntityStatusFromSessionState({
      entities: { tired: { conditions: ['poisoned', { exhaustion: 2 }] } },
    });
    expect(parsed.byEntity.tired.conditions).toEqual(['poisoned', 'exhaustion']);
  });

  it('parses the session-level grapple_holders map, dropping junk entries', () => {
    const parsed = parseEntityStatusFromSessionState({
      entities: {},
      grapple_holders: {
        'escaper-uuid': 'holder-uuid',
        dangling: 42,
        empty: '',
      },
    });
    expect(parsed.grappleHolders).toEqual({ 'escaper-uuid': 'holder-uuid' });
  });

  it('tolerates a snapshot that exposes only one of the two maps', () => {
    expect(
      parseEntityStatusFromSessionState({ grapple_holders: { e: 'h' } }).grappleHolders,
    ).toEqual({ e: 'h' });
    expect(
      parseEntityStatusFromSessionState({ entities: { a: { inspiration: true } } }).byEntity,
    ).toEqual({ a: { inspiration: true } });
  });
});

describe('handsPips', () => {
  it('renders nothing when the projection omitted hands_occupied', () => {
    expect(handsPips(undefined)).toEqual([]);
    expect(handsPips({})).toEqual([]);
    expect(handsPips({ inspiration: true })).toEqual([]);
  });

  it('renders exactly MODELED_HANDS pips for every exposed value', () => {
    expect(MODELED_HANDS).toBe(2);
    expect(handsPips({ handsOccupied: 0 })).toEqual([false, false]);
    expect(handsPips({ handsOccupied: 1 })).toEqual([true, false]);
    expect(handsPips({ handsOccupied: 2 })).toEqual([true, true]);
  });
});

describe('formatHandsLabel', () => {
  it('returns null when unexposed, "free" at zero, counts above zero', () => {
    expect(formatHandsLabel(undefined)).toBeNull();
    expect(formatHandsLabel({})).toBeNull();
    expect(formatHandsLabel({ handsOccupied: 0 })).toBe('Hands free');
    expect(formatHandsLabel({ handsOccupied: 1 })).toBe('Hands 1/2 occupied');
    expect(formatHandsLabel({ handsOccupied: 5 })).toBe('Hands 2/2 occupied');
  });
});

describe('grappledBy', () => {
  it('requires the Grappled condition before consulting holders', () => {
    expect(grappledBy({}, {}, 'e1')).toEqual([]);
    expect(grappledBy({ conditions: ['prone'] }, { e1: 'h1' }, 'e1')).toEqual([]);
  });

  it('maps a stamped hold to its holder id', () => {
    expect(
      grappledBy({ conditions: ['grappled'] }, { e1: 'orc-uuid' }, 'e1'),
    ).toEqual(['orc-uuid']);
  });

  it('stays empty when the hold stamp or the entity id is missing', () => {
    expect(grappledBy({ conditions: ['grappled'] }, {}, 'e1')).toEqual([]);
    expect(grappledBy({ conditions: ['grappled'] }, { e1: 'orc' }, undefined)).toEqual([]);
  });
});
