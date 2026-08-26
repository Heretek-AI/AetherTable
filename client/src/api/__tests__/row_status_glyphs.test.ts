/**
 * Iteration 84 — unit tests for api/row_status_glyphs.ts.
 *
 * These pin the InitiativeTracker row-state shaping against the real
 * session-state wire shapes (crates/vtt-core/src/state.rs serde output as it
 * arrives in GET /api/v1/engine/session-state):
 *   - `conditions` with `Exhaustion(u8)` arriving as `{"exhaustion": <level>}`;
 *   - `entities[id].concentration = { spell_id, started_round }`;
 *
 * The central discipline under test mirrors iterations 58/63: an ABSENT field
 * means "the engine did not expose it" and must never become a fabricated
 * glyph, a zero exhaustion level, or a guessed condition tag.
 */
import { describe, expect, it } from 'vitest';
import {
  combatantRowStatus,
  exhaustionLevelFromRaw,
  hasRowStatus,
} from '../row_status_glyphs';
import { parseConcentrationFromSessionState } from '../concentration_state';
import { parseEntityStatusFromSessionState } from '../entity_status_state';

const SNAP = {
  entities: {
    lyra: {
      id: 'lyra',
      inspiration: true,
      conditions: ['grappled', 'prone', { exhaustion: 2 }],
      concentration: { spell_id: 'hold_person', started_round: 3 },
    },
    orc: { id: 'orc' },
    tired_only: { id: 'tired_only', conditions: [{ exhaustion: 5 }] },
    flat_conditions: { id: 'flat_conditions', conditions: ['prone'] },
  },
};

const parsed = () => ({
  status: parseEntityStatusFromSessionState(SNAP),
  concentration: parseConcentrationFromSessionState(SNAP),
});

describe('exhaustionLevelFromRaw', () => {
  it('returns undefined when no exhaustion object is present', () => {
    expect(exhaustionLevelFromRaw(undefined)).toBeUndefined();
    expect(exhaustionLevelFromRaw('nope')).toBeUndefined();
    expect(exhaustionLevelFromRaw(['prone', 'grappled'])).toBeUndefined();
    // Never coerced to level 0 — absence stays absence.
    expect(exhaustionLevelFromRaw([])).toBeUndefined();
  });

  it('reads the level from the Exhaustion(u8) wire object', () => {
    expect(exhaustionLevelFromRaw([{ exhaustion: 2 }])).toBe(2);
    expect(exhaustionLevelFromRaw(['poisoned', { exhaustion: 5 }])).toBe(5);
  });

  it('keeps the strongest of multiple exhaustion entries', () => {
    expect(exhaustionLevelFromRaw([{ exhaustion: 1 }, { exhaustion: 4 }])).toBe(4);
  });

  it('clamps out-of-domain levels into the SRD 1..6 band', () => {
    expect(exhaustionLevelFromRaw([{ exhaustion: 99 }])).toBe(6);
    expect(exhaustionLevelFromRaw([{ exhaustion: 0.9 }])).toBe(1);
    // A zero/negative entry carries no displayable level.
    expect(exhaustionLevelFromRaw([{ exhaustion: 0 }])).toBeUndefined();
    expect(exhaustionLevelFromRaw([{ exhaustion: -2 }])).toBeUndefined();
  });
});

describe('combatantRowStatus', () => {
  const { status, concentration } = parsed();

  it('shapes every glyph from real fields for a fully-loaded combatant', () => {
    const row = combatantRowStatus(
      'lyra',
      status.byEntity.lyra,
      concentration.lyra,
      SNAP,
    );
    expect(row.exhaustion).toEqual({ level: 2 });
    expect(row.concentration).toEqual({ spellId: 'hold_person', startedRound: 3 });
    // Exhaustion is rendered by its own numbered glyph, not duplicated as a
    // plain condition tag.
    expect(row.conditions).toEqual([
      { name: 'grappled' },
      { name: 'prone' },
    ]);
    expect(hasRowStatus(row)).toBe(true);
  });

  it('renders NOTHING for a combatant whose projection exposed nothing', () => {
    const row = combatantRowStatus('orc', status.byEntity.orc, concentration.orc, SNAP);
    expect(status.byEntity.orc).toBeUndefined();
    expect(concentration.orc).toBeUndefined();
    expect(row.conditions).toEqual([]);
    expect(row.exhaustion).toBeUndefined();
    expect(row.concentration).toBeUndefined();
    expect(hasRowStatus(row)).toBe(false);
  });

  it('shows the exhaustion number without inventing other glyphs', () => {
    const row = combatantRowStatus(
      'tired_only',
      status.byEntity.tired_only,
      undefined,
      SNAP,
    );
    expect(row.exhaustion).toEqual({ level: 5 });
    expect(row.conditions).toEqual([]);
    expect(row.concentration).toBeUndefined();
  });

  it('keeps plain condition tags verbatim in engine snake_case', () => {
    const row = combatantRowStatus(
      'flat_conditions',
      status.byEntity.flat_conditions,
      undefined,
      SNAP,
    );
    expect(row.conditions).toEqual([{ name: 'prone' }]);
    expect(hasRowStatus(row)).toBe(true);
  });

  it('tolerates an unusable raw snapshot without dropping parsed glyphs', () => {
    const row = combatantRowStatus(
      'lyra',
      status.byEntity.lyra,
      concentration.lyra,
      null,
    );
    expect(row.exhaustion).toBeUndefined(); // level needs the raw wire form
    expect(row.concentration).toEqual({ spellId: 'hold_person', startedRound: 3 });
    expect(row.conditions.map((c) => c.name)).toEqual(['grappled', 'prone']);
  });

  it('never fabricates a glyph for ids absent from the snapshot entirely', () => {
    const row = combatantRowStatus('ghost_uuid', undefined, undefined, SNAP);
    expect(row.conditions).toEqual([]);
    expect(hasRowStatus(row)).toBe(false);
  });
});
