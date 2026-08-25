/**
 * Iteration 58 — pure badge-state logic for the ConcentrationBadge surface.
 *
 * The engine (vtt-core / vtt-server) owns ALL concentration rules:
 *   - `EntityState.concentration: Option<ConcentrationState{spell_id,
 *     started_round}>` (crates/vtt-core/src/state.rs) is mirrored verbatim
 *     into session-state entity projections;
 *   - damage-triggered CON saves arrive ADDITIVELY in action responses as
 *     `concentration_check` ({dc, total, passed, broken}) or
 *     `concentration_checks` ([same]) — see
 *     crates/vtt-server/src/server.rs `roll_concentration_checks`.
 *
 * These functions only PARSE and FORMAT what a response actually carried.
 * They never roll dice, never compute a DC, and never invent an outcome:
 * a field that is absent stays absent in the rendered text ("reported",
 * no DC shown). That honesty contract is what these tests pin down.
 */
import { describe, expect, it } from 'vitest';

import {
  extractConcentrationSaves,
  formatConcentrationSaveLine,
  parseConcentrationFromSessionState,
  type RawConcentrationSave,
} from '../concentration_state';

describe('parseConcentrationFromSessionState', () => {
  it('returns an empty map for null / non-object bodies instead of throwing', () => {
    expect(parseConcentrationFromSessionState(null)).toEqual({});
    expect(parseConcentrationFromSessionState('nope')).toEqual({});
    expect(parseConcentrationFromSessionState(undefined)).toEqual({});
    expect(parseConcentrationFromSessionState(42)).toEqual({});
  });

  it('returns an empty map when entities is missing or not a map', () => {
    expect(parseConcentrationFromSessionState({})).toEqual({});
    expect(parseConcentrationFromSessionState({ entities: [] })).toEqual({});
    expect(parseConcentrationFromSessionState({ entities: 'x' })).toEqual({});
  });

  it('maps entityId -> {spellId, startedRound} from engine concentration state', () => {
    const snap = {
      entities: {
        lyra: { id: 'lyra', name: 'Lyra', concentration: { spell_id: 'hold_person', started_round: 3 } },
        orc: { id: 'orc', concentration: null },
      },
    };
    expect(parseConcentrationFromSessionState(snap)).toEqual({
      lyra: { spellId: 'hold_person', startedRound: 3 },
    });
  });

  it('keeps partial entries honest: missing spell_id yields undefined, not ""', () => {
    const snap = {
      entities: {
        weird: { concentration: { started_round: 2 } },
        roundless: { concentration: { spell_id: 'bless' } },
        wrongTypes: { concentration: { spell_id: 7, started_round: 'three' } },
        empty: { concentration: { spell_id: null, started_round: 'zero' } },
      },
    };
    expect(parseConcentrationFromSessionState(snap)).toEqual({
      weird: { spellId: undefined, startedRound: 2 },
      roundless: { spellId: 'bless', startedRound: undefined },
      // Both fields non-string/non-number → entry is dropped, not coerced.
    });
    expect(parseConcentrationFromSessionState(snap).wrongTypes).toBeUndefined();
    expect(parseConcentrationFromSessionState(snap).empty).toBeUndefined();
  });

  it('ignores non-object concentration values and dead-entity noise safely', () => {
    const snap = {
      entities: {
        a: { concentration: true },
        b: { concentration: 'bless' },
        c: null,
        d: 'not-an-object',
      },
    };
    expect(parseConcentrationFromSessionState(snap)).toEqual({});
  });
});

describe('extractConcentrationSaves', () => {
  it('returns [] for bodies without any concentration disclosure', () => {
    expect(extractConcentrationSaves(null)).toEqual([]);
    expect(extractConcentrationSaves({ status: 'advanced' })).toEqual([]);
    // A bare string is not a save list even where an array would be expected.
    expect(extractConcentrationSaves({ concentration_checks: 'yes' })).toEqual([]);
    // Entries with no subject AND no numbers disclose nothing usable.
    expect(extractConcentrationSaves({ concentration_check: {} })).toEqual([]);
  });

  it('reads the singular additive field when only one check fired', () => {
    const body = { concentration_check: { dc: 12, total: 17, passed: true, broken: false } };
    expect(extractConcentrationSaves(body)).toEqual([
      { entityId: undefined, naturalRoll: undefined, total: 17, dc: 12, maintained: true, broken: false },
    ]);
  });

  it('reads the plural field with every entry preserved in order', () => {
    const body = {
      concentration_checks: [
        { entity_id: 'lyra', total: 8, dc: 13, passed: false, broken: true },
        { caster_id: 'orc-shaman', total: 15, dc: 10, passed: true },
      ],
    };
    const saves = extractConcentrationSaves(body);
    expect(saves).toHaveLength(2);
    expect(saves[0]).toMatchObject({ entityId: 'lyra', maintained: false, broken: true });
    expect(saves[1]).toMatchObject({ entityId: 'orc-shaman', maintained: true, broken: undefined });
  });

  it('accepts the alternate outcome key names the projection may use', () => {
    const body = {
      concentration_checks: [
        { target_id: 't1', natural_roll: 6, total: 9, dc: 14, concentration_maintained: false },
        { target_id: 't2', success: true },
      ],
    };
    expect(extractConcentrationSaves(body)[0]).toMatchObject({
      entityId: 't1',
      naturalRoll: 6,
      maintained: false,
    });
    expect(extractConcentrationSaves(body)[1]).toMatchObject({ entityId: 't2', maintained: true });
  });

  it('never fabricates numbers: absent fields stay undefined', () => {
    const saves = extractConcentrationSaves({
      concentration_check: { entity_id: 'lyra', passed: false },
    });
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual({
      entityId: 'lyra',
      naturalRoll: undefined,
      total: undefined,
      dc: undefined,
      maintained: false,
      broken: undefined,
    });
  });

  it('drops entries with neither a subject, a number, nor a verdict', () => {
    expect(extractConcentrationSaves({ concentration_check: { broken: null } })).toEqual([]);
  });
});

describe('formatConcentrationSaveLine', () => {
  const named = (id?: string): string | undefined =>
    id === 'lyra' ? 'Lyra' : id === 'orc-shaman' ? 'Orc Shaman' : id;

  it('returns null when nothing about the save is known', () => {
    expect(formatConcentrationSaveLine(null, named)).toBeNull();
    expect(formatConcentrationSaveLine({} as RawConcentrationSave, named)).toBeNull();
  });

  it('renders a held save with every number the response carried', () => {
    const line = formatConcentrationSaveLine(
      { entityId: 'lyra', naturalRoll: 11, total: 17, dc: 12, maintained: true },
      named,
    );
    expect(line).toContain('Lyra');
    expect(line).toContain('d20 11');
    expect(line).toContain('17');
    expect(line).toContain('DC 12');
    expect(line!.toLowerCase()).toContain('held');
    expect(line?.toLowerCase()).not.toContain('broken');
  });

  it('renders a failed save as BROKEN without inventing a roll or DC', () => {
    const line = formatConcentrationSaveLine(
      { entityId: 'lyra', total: 8, dc: 13, maintained: false, broken: true },
      named,
    );
    expect(line).toContain('BROKEN');
    expect(line).not.toContain('d20'); // response carried no natural roll
    expect(line).toContain('DC 13');
    expect(line).toContain('8');
  });

  it('falls back to the raw entity id when no display name resolves', () => {
    const line = formatConcentrationSaveLine({ entityId: 'e-123', maintained: true }, named);
    expect(line).toContain('e-123');
  });

  it('says "unknown combatant" when the response did not identify the caster', () => {
    const line = formatConcentrationSaveLine({ dc: 10, maintained: true }, named);
    expect(line).toContain('unknown combatant');
  });

  it('renders "outcome reported" — never guessed pass/fail — when the body omitted the verdict', () => {
    const line: string | null = formatConcentrationSaveLine(
      { entityId: 'lyra', dc: 12, total: 16 },
      named,
    );
    if (!line) throw new Error('expected a rendered line');
    expect(line).toContain('reported');
    expect(line.toLowerCase()).not.toContain('held');
    expect(line.toLowerCase()).not.toContain('broken');
  });

  it('shows only fields present: no dc -> no "DC", no total -> no arrow total', () => {
    const line = formatConcentrationSaveLine({ entityId: 'lyra', maintained: true }, named);
    expect(line).not.toContain('DC');
    expect(line).not.toContain('d20');
  });
});
