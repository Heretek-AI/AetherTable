/**
 * Unit tests for src/sync/transport_gate.ts.
 *
 * Iteration-4 audit follow-up: the Rust WS LWW relay fails closed in
 * non-session rooms (`aethertable-live`) for any caller whose role is not
 * gm/admin. The Yjs relay (scripts/ysync-server.mjs) is HMAC-only and does
 * not gate by role. The transport_gate helper centralizes the decision so
 * App.tsx can render an honest "sign in as GM to move tokens on this legacy
 * transport" banner instead of faking authority.
 *
 * We assert:
 *  - Yjs accepts any authenticated non-spectator.
 *  - Legacy LWW admits GM/admin only; player/spectator are refused.
 *  - Missing transport or missing session is refused for every role.
 *  - Spectators are denied on every transport — no fabricated cursor control.
 *  - The refused verdict NEVER silently upgrades to canMove=true.
 */
import { describe, expect, it } from 'vitest';
import { canMoveTokensOnTransport } from '../../sync/transport_gate';

describe('canMoveTokensOnTransport', () => {
  it('admits GM on the Yjs relay', () => {
    expect(canMoveTokensOnTransport('YJS', 'gm', true)).toEqual({ canMove: true });
  });

  it('admits player on the Yjs relay (HMAC-only, no role gate)', () => {
    expect(canMoveTokensOnTransport('YJS', 'player', true)).toEqual({ canMove: true });
  });

  it('admits admin on the Yjs relay', () => {
    expect(canMoveTokensOnTransport('YJS', 'admin', true)).toEqual({ canMove: true });
  });

  it('denies spectators on the Yjs relay', () => {
    const verdict = canMoveTokensOnTransport('YJS', 'spectator', true);
    expect(verdict.canMove).toBe(false);
    expect(verdict.blocked?.reason).toBe('LEGACY_FALLBACK_NON_GM');
  });

  it('admits GM on the legacy LWW relay', () => {
    expect(canMoveTokensOnTransport('LEGACY_LWW', 'gm', true)).toEqual({ canMove: true });
  });

  it('admits admin on the legacy LWW relay', () => {
    expect(canMoveTokensOnTransport('LEGACY_LWW', 'admin', true)).toEqual({ canMove: true });
  });

  it('refuses players on the legacy LWW relay (iteration 4 audit follow-up)', () => {
    const verdict = canMoveTokensOnTransport('LEGACY_LWW', 'player', true);
    expect(verdict.canMove).toBe(false);
    expect(verdict.blocked?.reason).toBe('LEGACY_FALLBACK_NON_GM');
    expect(verdict.blocked?.detail).toMatch(/legacy LWW relay fails closed/i);
  });

  it('refuses spectators on the legacy LWW relay', () => {
    const verdict = canMoveTokensOnTransport('LEGACY_LWW', 'spectator', true);
    expect(verdict.canMove).toBe(false);
  });

  it('refuses every role when no transport is bound', () => {
    const roles = ['gm', 'admin', 'player', 'spectator'] as const;
    for (const role of roles) {
      const verdict = canMoveTokensOnTransport(null, role, true);
      expect(verdict.canMove).toBe(false);
      expect(verdict.blocked?.reason).toBe('NO_TRANSPORT');
    }
  });

  it('refuses every role when the caller is signed out', () => {
    const roles = ['gm', 'admin', 'player', 'spectator'] as const;
    for (const role of roles) {
      const verdict = canMoveTokensOnTransport('YJS', role, false);
      expect(verdict.canMove).toBe(false);
      expect(verdict.blocked?.reason).toBe('NOT_SIGNED_IN');
    }
  });

  it('never fabricates authority: refused verdicts carry an honest detail string', () => {
    const verdict = canMoveTokensOnTransport('LEGACY_LWW', 'player', true);
    expect(verdict.canMove).toBe(false);
    expect(verdict.blocked?.detail).toBeTruthy();
    // Must point the operator at a real remediation, not magic.
    expect(verdict.blocked?.detail).toMatch(/sign in as gm|vite_ysync_ws_url/i);
  });
});