/**
 * Unit tests for the X-card rewind reconciliation planner
 * (src/ui/safetyXCard.ts, iteration 28).
 *
 * The engine rewinds FULL state server-side and embeds a role-projected
 * GameSession snapshot in its x-card response (see trigger_safety_rewind in
 * crates/vtt-server/src/server.rs); the gateway forwards it verbatim inside
 * `engine_rewind.snapshot`. These tests pin what the client may conclude from
 * that projection — and, just as importantly, what it must NOT touch when the
 * projection withholds data.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLocalRewindPlan,
  computeTokenReconciliation,
  parseEngineRewind,
  parseRewoundSnapshot,
  type RewoundSessionSnapshot,
} from '../safetyXCard';

describe('parseEngineRewind — snapshot extraction', () => {
  const GM_BODY = {
    status: 'SAFETY_INTERVENTION_ACTIVATED',
    target_sequence_id: 4,
    engine_rewind: {
      status: 'SAFETY_REWIND_SUCCESS',
      rewind_report: { reverted_event_count: 3, restored_entities: 2, removed_entities: 1 },
      snapshot: {
        session_id: '11111111-1111-1111-1111-111111111111',
        entities: {
          hero: {
            id: 'hero', name: 'Thorin', current_hp: 30, max_hp: 42,
            position: [4, 5, 0], is_player: true, is_dead: false,
          },
          orc: {
            id: 'orc', name: 'Orc Warlord', position: [10, 4, 0],
            is_player: false, is_dead: false,
          },
        },
        ledger: { current_sequence: 4 },
      },
    },
  };

  it('extracts status, counts AND the embedded post-rewind snapshot', () => {
    const parsed = parseEngineRewind(GM_BODY);
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('SAFETY_REWIND_SUCCESS');
    expect(parsed!.report).toEqual({
      reverted_event_count: 3,
      restored_entities: 2,
      removed_entities: 1,
    });
    expect(parsed!.snapshot).not.toBeNull();
    expect(parsed!.snapshot!.session_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(Object.keys(parsed!.snapshot!.entities).sort()).toEqual(['hero', 'orc']);
  });

  it('coerces each projected entity defensively (id fallback to map key)', () => {
    const parsed = parseEngineRewind(GM_BODY)!;
    expect(parsed.snapshot!.entities.hero).toMatchObject({
      id: 'hero',
      name: 'Thorin',
      current_hp: 30,
      position: [4, 5, 0],
      is_player: true,
      is_dead: false,
    });
  });

  it('returns snapshot: null (not a crash) on an older engine without one', () => {
    const parsed = parseEngineRewind({
      engine_rewind: {
        status: 'SAFETY_REWIND_SUCCESS',
        rewind_report: { reverted_event_count: 1 },
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.snapshot).toBeNull();
  });

  it('drops malformed entity entries instead of guessing them into shape', () => {
    const snapshot = parseRewoundSnapshot({
      entities: {
        good: { id: 'g1', current_hp: 7 },
        broken_string: 'nope',
        broken_null: null,
      },
    });
    expect(snapshot).not.toBeNull();
    expect(Object.keys(snapshot!.entities)).toEqual(['good']);
    expect(snapshot!.entities.good.current_hp).toBe(7);
  });

  it('yields null for a non-object or entity-less snapshot body', () => {
    expect(parseRewoundSnapshot(null)).toBeNull();
    expect(parseRewoundSnapshot('x')).toBeNull();
    expect(parseRewoundSnapshot({})).toBeNull();
    expect(parseRewoundSnapshot({ entities: 'nope' })).toBeNull();
  });

  it('treats a non-array or non-numeric position as undisclosed', () => {
    const snapshot = parseRewoundSnapshot({
      entities: {
        a: { id: 'a', position: 'nowhere' },
        b: { id: 'b', position: ['x', null] },
        c: { id: 'c', position: [2, 3] },
      },
    })!;
    expect(snapshot.entities.a.position).toBeUndefined();
    expect(snapshot.entities.b.position).toBeUndefined();
    expect(snapshot.entities.c.position).toEqual([2, 3]);
  });

  it('still returns null for an unusable x-card body (offline / non-JSON)', () => {
    expect(parseEngineRewind(null)).toBeNull();
    expect(parseEngineRewind({})).toBeNull();
    expect(parseEngineRewind({ engine_rewind: {} })).toBeNull();
  });
});

describe('computeTokenReconciliation — patch planning', () => {
  const tokens = [
    { id: 'hero', hp: 8, x: 6, y: 6 },   // wounded + moved during reverted turn
    { id: 'orc', hp: 58, x: 10, y: 4 },  // board-token view only (player role)
  ];

  it('plans HP+position patches for fully-disclosed sheets (GM / own sheet)', () => {
    const snapshot: RewoundSessionSnapshot = {
      session_id: 's',
      entities: {
        hero: { id: 'hero', current_hp: 30, position: [4, 4, 0] },
        orc: { id: 'orc', current_hp: 58, position: [10, 4, 0] },
      },
    };
    const plan = computeTokenReconciliation(tokens, snapshot);
    expect(plan.empty).toBe(false);
    expect(plan.patches).toEqual([
      { id: 'hero', hp: 30, x: 4, y: 4 },
      { id: 'orc', hp: 58, x: 10, y: 4 },
    ]);
    expect(plan.provablyRemovedTokenIds).toEqual([]);
    // Both matched ⇒ nothing unmatched.
    expect(plan.unmatchedEntityIds).toEqual([]);
  });

  it('patches ONLY disclosed fields — a player-role projection never fakes HP', () => {
    const snapshot: RewoundSessionSnapshot = {
      entities: {
        // Public board-token projection of someone else's creature:
        orc: { id: 'orc', name: 'Orc Warlord', position: [9, 3, 0], is_player: false },
        // Own sheet travels unredacted:
        hero: { id: 'hero', current_hp: 30, position: [4, 4, 0] },
      },
    };
    const plan = computeTokenReconciliation(tokens, snapshot);
    expect(plan.patches).toContainEqual({ id: 'hero', hp: 30, x: 4, y: 4 });
    // Position yes, HP no — absence means withheld, not zero.
    expect(plan.patches).toContainEqual({ id: 'orc', x: 9, y: 3 });
    expect(plan.patches.find((p) => p.id === 'orc')?.hp).toBeUndefined();
  });

  it('leaves everything untouched when the snapshot is missing or empty', () => {
    expect(computeTokenReconciliation(tokens, null)).toMatchObject({
      patches: [], provablyRemovedTokenIds: [], unmatchedEntityIds: [], empty: true,
    });
    expect(computeTokenReconciliation(tokens, undefined)).toMatchObject({ empty: true });
    expect(computeTokenReconciliation(tokens, { entities: {} })).toMatchObject({ empty: true });
  });

  it('claims removal only on a privileged view; otherwise hidden NPCs survive', () => {
    const privileged: RewoundSessionSnapshot = {
      entities: {
        survivor: { id: 'survivor', current_hp: 12 },
        // 'orc' is gone from authoritative state under this full view.
      },
    };
    const planPriv = computeTokenReconciliation(tokens, privileged);
    expect(planPriv.empty).toBe(false);
    expect(planPriv.provablyRemovedTokenIds.sort()).toEqual(['hero', 'orc']);

    // Player-role projection: absence could just mean "hidden from me".
    const playerView: RewoundSessionSnapshot = {
      entities: { someAlly: { id: 'someAlly', position: [1, 1, 0] } },
    };
    const planPlayer = computeTokenReconciliation(tokens, playerView);
    expect(planPlayer.provablyRemovedTokenIds).toEqual([]);
  });

  it('honors ownedTokenIds so a player can drop their own removed token', () => {
    const playerView: RewoundSessionSnapshot = {
      entities: { other: { id: 'other', position: [1, 1, 0] } },
    };
    const plan = computeTokenReconciliation(tokens, playerView, {
      ownedTokenIds: ['hero'],
    });
    expect(plan.provablyRemovedTokenIds).toEqual(['hero']);
  });

  it('reports unmatched snapshot entities instead of fabricating local tokens', () => {
    const snapshot: RewoundSessionSnapshot = {
      entities: {
        hero: { id: 'hero', current_hp: 30 },
        spawned_elsewhere: { id: 'spawned_elsewhere', current_hp: 11 },
      },
    };
    const plan = computeTokenReconciliation([{ id: 'hero', hp: 8, x: 0, y: 0 }], snapshot);
    expect(plan.unmatchedEntityIds).toEqual(['spawned_elsewhere']);
    expect(plan.patches).toHaveLength(1);
  });

  it('matches by payload id even when the map key differs', () => {
    const snapshot: RewoundSessionSnapshot = {
      entities: {
        'uuid-key': { id: 'hero', current_hp: 30, position: [4, 4, 0] },
      },
    };
    const plan = computeTokenReconciliation(
      [{ id: 'hero', hp: 8, x: 0, y: 0 }],
      snapshot
    );
    expect(plan.patches).toEqual([{ id: 'hero', hp: 30, x: 4, y: 4 }]);
    expect(plan.unmatchedEntityIds).toEqual([]);
  });

  it('emits no patch for a matched entity that discloses nothing usable', () => {
    const snapshot: RewoundSessionSnapshot = {
      entities: { ghost: { id: 'ghost' } },
    };
    const plan = computeTokenReconciliation(
      [{ id: 'ghost', hp: 10, x: 1, y: 1 }],
      snapshot
    );
    expect(plan.empty).toBe(false);
    expect(plan.patches).toEqual([]);
  });
});

describe('chat pruning regression guard (iteration 11 behavior intact)', () => {
  it('anchors doomed lines on the latest turn-pass marker', () => {
    const plan = computeLocalRewindPlan([
      { id: 'm1', role: 'dm', content: 'before' },
      { id: 'm2', role: 'system', content: 'Turn passed to Lyra (Round 2).' },
      { id: 'm3', role: 'player', content: 'I attack' },
    ]);
    expect(plan.droppedCount).toBe(1);
    expect([...plan.doomedIds]).toEqual(['m3']);
  });

  it('prunes nothing without a turn boundary', () => {
    const plan = computeLocalRewindPlan([
      { id: 'm1', role: 'player', content: 'hi' },
    ]);
    expect(plan.droppedCount).toBe(0);
    expect(plan.doomedIds.size).toBe(0);
  });
});
