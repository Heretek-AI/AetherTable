/**
 * Iteration 34 (Loop 3) — SRD-optional Surprise adjudication client surface.
 *
 * The engine route landed in iteration 32:
 *   POST /api/v1/sessions/{id}/combat/surprise {entity_id, surprised} →
 *   SURPRISE_GRANTED / SURPRISE_REVOKED
 *
 * The browser never addresses the engine directly: like /combat/begin and
 * /combat/end (and the Delay family in combat_delay.ts), the gateway exposes
 * the proxied form /api/v1/engine/combat/surprise, forwarding only the
 * session reference plus the caller's real identity so the engine's RBAC
 * authorizes the actor. The engine route is first-round-only and GM-admin-only
 * (can_adjudicate_surprise == role.is_gm()); the engine re-verifies both from
 * the caller identity it resolves — the client never guesses who may mark.
 *
 * Wire honesty: the bodies are exactly the engine's SurpriseAdjudicationReq
 * (`{entity_id, surprised}`) plus the session id the proxy needs to build the
 * path — no round, no turn index, no surprised list is ever sent. Every number
 * keeps engine-owned and every rejection surfaces VERBATIM as its machine
 * code: NOT_IN_COMBAT / ENTITY_DELAYED (409), SURPRISE_WINDOW_CLOSED (422,
 * round > 1), ENTITY_NOT_FOUND (404) and the route-level FORBIDDEN_ROLE (403,
 * non-GM adjudication). Re-granting / re-revoking an already-set flag is an
 * idempotent no-op the engine reports with `changed: false` and sequence_id 0.
 *
 * These calls carry the stored token as Authorization: Bearer like every other
 * mutating call in api/* — the gateway 401s anonymous requests rather than
 * resolving combat under its service principal.
 */

import { authHeaders, getStoredToken } from './auth_headers';
import type { EngineActionOutcome } from './rules_engine';
import { rejectionFrom } from './engine_errors';

/** Verbatim body of POST /api/v1/sessions/{id}/combat/surprise. */
export interface EngineSurpriseResult {
  /** "SURPRISE_GRANTED" | "SURPRISE_REVOKED" — what the engine just journaled. */
  status?: string;
  /** Ledger sequence id of the journaled change; 0 for an idempotent no-op. */
  sequence_id?: number;
  /** False when the flag was already in the requested state (no-op). */
  changed?: boolean;
  entity_id?: string;
  round?: number;
  /** Which combatants the engine now holds surprised (engine truth). */
  surprised?: string[];
}

const NOT_SIGNED_IN: EngineActionOutcome<never> = {
  kind: 'rejected',
  status: 401,
  code: 'NOT_AUTHENTICATED',
  message: 'Sign in to adjudicate through the authoritative engine.',
};

async function surprisePost<T extends EngineSurpriseResult>(
  params: { sessionId: string; entityId: string; surprised: boolean },
): Promise<EngineActionOutcome<T>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  try {
    const resp = await fetch('/api/v1/engine/combat/surprise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        session_id: params.sessionId,
        entity_id: params.entityId,
        surprised: params.surprised,
      }),
    });
    const payload: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      // 5xx means nothing was decided; 4xx carries an engine code worth
      // quoting verbatim in the UI.
      if (resp.status >= 500) return { kind: 'unreachable' };
      return rejectionFrom(resp.status, payload);
    }
    return { kind: 'applied', data: payload as T };
  } catch {
    console.warn('Rules engine unreachable; the surprise was not applied.');
    return { kind: 'unreachable' };
  }
}

/**
 * Mark a combatant as surprised for the current round (GM adjudication). First
 * round only — round 2 closes the window (SURPRISE_WINDOW_CLOSED → 422). Also
 * strips their Reaction engine-side.
 */
export async function setSurprised(params: {
  sessionId: string;
  entityId: string;
}): Promise<EngineActionOutcome<EngineSurpriseResult>> {
  return surprisePost({ ...params, surprised: true });
}

/**
 * Revoke a combatant's surprised flag by GM fiat (round 1 only) and restore
 * their Reaction. Idempotent when the entity is not currently surprised.
 */
export async function clearSurprised(params: {
  sessionId: string;
  entityId: string;
}): Promise<EngineActionOutcome<EngineSurpriseResult>> {
  return surprisePost({ ...params, surprised: false });
}

/**
 * Ids of surprised combatants read defensively from a RAW projected
 * session-state body (`combat.surprised`) or a bare surprise-route response
 * body (`surprised`). Whatever the projection did not expose simply yields an
 * empty list — never a guessed one. Non-string entries are dropped rather than
 * coerced into fake ids.
 */
export function surprisedIdsFromSnapshot(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const top = raw as Record<string, unknown>;
  const list =
    Array.isArray(top.surprised)
      ? top.surprised
      : top.combat && typeof top.combat === 'object' && !Array.isArray(top.combat)
        ? (top.combat as Record<string, unknown>).surprised
        : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === 'string');
}