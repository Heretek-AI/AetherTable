/**
 * Transport-aware token-move gate.
 *
 * Iteration-4 hardening closed token writes on the Rust WS LWW relay in
 * NON-SESSION rooms (`aethertable-live`, the lobby/fallback) unless the
 * caller holds role=gm. The Yjs relay (the default transport when
 * VITE_YSYNC_WS_URL points at a reachable y-websocket server, see
 * scripts/ysync-server.mjs) is intentionally not role-gated on the server
 * — it merges Y.Doc updates causally and only verifies the HMAC token, so
 * any authenticated user may write token positions there.
 *
 * This module is a PURE helper so the gating decision can be unit-tested
 * without standing up a relay. App.tsx uses it to decide whether to:
 *   - relay a token move through the current transport (canMove === true), or
 *   - drop the move and surface an honest "GM role required" banner.
 *
 * The function NEVER fabricates GM authority. It just refuses the write.
 */
import type { UserRole } from '../types/auth';

export type TransportKind = 'YJS' | 'LEGACY_LWW';

/**
 * Which sync transport this browser session currently has bound (mirror of
 * App.tsx's `transportKind` state, kept in a module-shared alias so the
 * re-probe policy in transport_reprobe.ts speaks the same vocabulary).
 */
export type BoundTransport = TransportKind | null;

/** What the UI shows when canMove === false; absent when the move is allowed. */
export interface TokenMoveBlocked {
  reason:
    | 'NOT_SIGNED_IN'
    | 'LEGACY_FALLBACK_NON_GM'
    | 'NO_TRANSPORT';
  detail: string;
}

export interface TokenMoveVerdict {
  canMove: boolean;
  /** Populated only when canMove is false. */
  blocked?: TokenMoveBlocked;
}

/**
 * Decide whether the caller may push a token position update on the active
 * transport.
 *
 * @param transport  which client is currently bound to syncClientRef. The
 *                   Yjs relay accepts writes from any authenticated user; the
 *                   Rust engine LWW relay fails closed in non-session rooms
 *                   (iteration 4 audit, may_control_token in vtt-server).
 * @param role       the signed-in user's role (admin/gm/player/spectator).
 *                   Admin == GM for transport-control purposes; spectators
 *                   are denied everywhere.
 * @param signedIn   true when a session token is present in sessionStorage.
 */
export function canMoveTokensOnTransport(
  transport: TransportKind | null,
  role: UserRole,
  signedIn: boolean,
): TokenMoveVerdict {
  if (!signedIn) {
    return {
      canMove: false,
      blocked: {
        reason: 'NOT_SIGNED_IN',
        detail:
          'Sign in to move tokens — the active sync transport requires an authenticated HMAC session.',
      },
    };
  }
  if (!transport) {
    return {
      canMove: false,
      blocked: {
        reason: 'NO_TRANSPORT',
        detail: 'No sync transport is connected; token positions cannot be relayed.',
      },
    };
  }
  if (role === 'spectator') {
    return {
      canMove: false,
      blocked: {
        reason: 'LEGACY_FALLBACK_NON_GM',
        detail: 'Spectator role cannot move tokens on any transport.',
      },
    };
  }
  if (transport === 'YJS') {
    // The Yjs relay merges Y.Doc updates causally with HMAC-only auth; any
    // authenticated non-spectator may write token positions.
    return { canMove: true };
  }
  // LEGACY_LWW: relay audit (iteration 4) fails closed in non-session rooms
  // for player/spectator; only gm/admin keep administrative control. We
  // refuse the write and surface the honest state — we DO NOT mint a GM
  // token or pretend authority the client does not have.
  if (role === 'gm' || role === 'admin') {
    return { canMove: true };
  }
  return {
    canMove: false,
    blocked: {
      reason: 'LEGACY_FALLBACK_NON_GM',
      detail:
        'The legacy LWW relay fails closed for non-GM tokens in non-session rooms ' +
        "(iteration 4 audit). Sign in as GM, or reconnect once VITE_YSYNC_WS_URL " +
        'points at a reachable Yjs relay so token moves merge causally there instead.',
    },
  };
}