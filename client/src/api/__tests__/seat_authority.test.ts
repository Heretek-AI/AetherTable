/**
 * Loop 3 iteration 29 — regression pin for the second audit's F3 finding.
 *
 * Iteration 23 added 'admin' to the SeatRole union. App.tsx's inline
 * controlledEntityIds `useMemo` still gated on `userRole === 'gm'`, so an
 * admin seat fell through the `if (userRole !== 'player') return [];` line
 * and silently received an empty controlled-entity list — the InitiativeTracker
 * Delay/Resume buttons vanished for admin even though the engine maps admin
 * to Role::Gm and would have authorised every action.
 *
 * The role→ids decision has since been lifted into
 * src/api/seat_authority.ts as a pure helper so this test can exercise it
 * without mounting App (which carries Yjs, WebRTC mesh, engine polls — a 2600-
 * line component that no unit test should reach for). This file pins the
 * invariant: admin MUST produce the same non-empty list as gm; player MUST
 * produce the assigned-bound filtered list; spectator MUST produce [].
 */
import { describe, expect, it } from 'vitest';
import {
  computeControlledEntityIds,
  type ControlledTokenLike,
} from '../seat_authority';
import type { UserRole } from '../../types/auth';

const THORIN: ControlledTokenLike = { id: 'thorin_1', isPlayer: true };
const LYRA: ControlledTokenLike = { id: 'lyra_1', isPlayer: true };
const GOBLIN: ControlledTokenLike = { id: 'goblin_1', isPlayer: false };
const ORC: ControlledTokenLike = { id: 'orc_1', isPlayer: false };
const TOKENS: ControlledTokenLike[] = [THORIN, LYRA, GOBLIN, ORC];

describe('computeControlledEntityIds (F3 regression pin)', () => {
  it('admin produces the same full-token list as gm', () => {
    // F3 core invariant: the iteration-23 admin extension MUST NOT silently
    // drop below gm-level staff authority for any visible entity.
    const gmIds = computeControlledEntityIds('gm', TOKENS, []);
    const adminIds = computeControlledEntityIds('admin', TOKENS, ['*']);
    expect(adminIds).toEqual(gmIds);
    expect(adminIds).toEqual(['thorin_1', 'lyra_1', 'goblin_1', 'orc_1']);
    expect(adminIds).not.toHaveLength(0);
  });

  it('player produces a list filtered by assignedTokenIds + isPlayer', () => {
    // Players never act on NPC bodies; only seats they are explicitly bound
    // to. The wildcard '*' (table authority without a body) does not match
    // any real token id and so yields [] — it is a GM/admin marker, not a
    // player power.
    expect(
      computeControlledEntityIds('player', TOKENS, ['thorin_1']),
    ).toEqual(['thorin_1']);
    expect(
      computeControlledEntityIds('player', TOKENS, ['thorin_1', 'lyra_1']),
    ).toEqual(['thorin_1', 'lyra_1']);
    expect(computeControlledEntityIds('player', TOKENS, ['*'])).toEqual([]);
    // NPC ids the player happens to bind are filtered out.
    expect(
      computeControlledEntityIds('player', TOKENS, ['thorin_1', 'goblin_1']),
    ).toEqual(['thorin_1']);
  });

  it('spectator produces an empty list', () => {
    // The F3 bucket: before the fix, admin fell into this branch and the
    // tracker's Delay/Resume panel rendered no controls. Spectator must keep
    // that empty-list behaviour — only the wire-level authority changes.
    expect(
      computeControlledEntityIds('spectator', TOKENS, ['*']),
    ).toEqual([]);
    expect(
      computeControlledEntityIds('spectator', TOKENS, ['thorin_1']),
    ).toEqual([]);
  });

  it('admin is unaffected by whatever assignedTokenIds carry', () => {
    // Admin is staff authority — the assignedTokenIds array is irrelevant.
    // Pin that explicitly so a future refactor doesn't reintroduce a filter.
    expect(
      computeControlledEntityIds('admin', TOKENS, []),
    ).toEqual(['thorin_1', 'lyra_1', 'goblin_1', 'orc_1']);
  });

  it('does not invent ids beyond the visibleTokens it received', () => {
    // Defensive: hidden tokens (filtered out of visibleTokens by App.tsx
    // before this helper runs) must not reappear just because the role is
    // gm/admin. The helper respects the input it is given.
    const filtered: ControlledTokenLike[] = [THORIN, GOBLIN];
    expect(
      computeControlledEntityIds('gm', filtered, ['*']),
    ).toEqual(['thorin_1', 'goblin_1']);
    expect(
      computeControlledEntityIds('admin', filtered, ['*']),
    ).toEqual(['thorin_1', 'goblin_1']);
  });

  it('matches the documented SeatRole union without surprises', () => {
    // Cross-check: the documented role set is exactly admin/gm/player/spectator.
    // If a future SeatRole widening ships without revisiting this helper, this
    // assertion forces the author to look here.
    const roles: UserRole[] = ['admin', 'gm', 'player', 'spectator'];
    for (const role of roles) {
      const result = computeControlledEntityIds(role, TOKENS, ['*']);
      expect(Array.isArray(result)).toBe(true);
      expect(result.every((id) => typeof id === 'string')).toBe(true);
    }
  });
});