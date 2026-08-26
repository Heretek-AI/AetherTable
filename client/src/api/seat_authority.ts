/**
 * Pure seat-authority helper: which board-token entities THIS seat may act
 * for, feeding the InitiativeTracker's Delay/Resume gating (Loop 3
 * iteration 29, remediating the second audit's F3 finding).
 *
 * WHY IT LIVES HERE: App.tsx computes `controlledEntityIds` inside a 2600-line
 * component with heavy side effects (Yjs relay, WebRTC mesh, engine polls)
 * that a unit test cannot mount. The invariant audit targets is the pure
 * role→ids decision, so it is lifted into the same dependency-light pattern as
 * src/api/streamer_view_state.ts and src/sync/transport_gate.ts: tested
 * directly, and App.tsx consumes it verbatim so the wired app and the pinned
 * contract cannot drift apart.
 *
 * CONTRACT (mirrors the engine's own `may_control_entity` RBAC):
 *   - GM and ADMIN seats act on ANY visible entity — the engine maps
 *     `admin` → `Role::Gm`, so the admin row MUST short-circuit to the full
 *     list. This is the F3 regression: pre-fix, admin fell through
 *     `if (userRole !== 'player') return [];` into the spectator bucket and
 *     the Delayed panel silently rendered no controls for admin.
 *   - PLAYER seats control only the tokens bound to their seat
 *     (`assignedTokenIds`; a `'*'` entry = table authority WITHOUT a physical
 *     body, so it never matches a real token id).
 *   - SPECTATOR (and any unrecognised role) controls nothing.
 *
 * The engine re-verifies every call server-side — this list only shapes UI.
 */
import type { UserRole } from '../types/auth';

/** The only token fields the authority decision reads (structural — any
 *  call site passing App.tsx's `Token[]` satisfies this). */
export interface ControlledTokenLike {
  id: string;
  isPlayer: boolean;
}

/**
 * Entities THIS seat may act for, given the role-projected战斗 board.
 *
 * @param role            session seat role (admin/gm/player/spectator).
 * @param visibleTokens   the SPECTATOR-FILTERED token list — the same array
 *                        App.tsx renders, so hidden tokens are absent before
 *                        authority is discussed (not after).
 * @param assignedTokenIds seat binding from the signed-in account
 *                        (`User.assignedTokenIds`).
 */
export function computeControlledEntityIds(
  role: UserRole,
  visibleTokens: ControlledTokenLike[],
  assignedTokenIds: string[],
): string[] {
  // GM and admin act on anyone (engine maps admin → Role::Gm — F3 fix).
  if (role === 'gm' || role === 'admin') return visibleTokens.map((t) => t.id);
  // Spectators (and anything unrecognised) control nothing.
  if (role !== 'player') return [];
  // Players control only their own bound tokens.
  return visibleTokens
    .filter((t) => t.isPlayer && assignedTokenIds.includes(t.id))
    .map((t) => t.id);
}