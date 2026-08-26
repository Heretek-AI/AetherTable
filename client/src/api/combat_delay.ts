/**
 * Iteration 16 (Loop 3) — SRD-optional Delay action client surface.
 *
 * The engine routes landed in commit 4f7b365:
 *   POST /api/v1/sessions/{id}/action/delay        {entity_id}  → DELAY_TAKEN
 *   POST /api/v1/sessions/{id}/action/delay/resume {entity_id}  → DELAY_RESUMED
 *
 * Delaying is FREE — no Action is spent; the cost is forfeiting this round's
 * slot until /action/delay/resume re-seats the combatant right after the
 * current actor at the current initiative count.
 *
 * Wire honesty: both bodies are exactly the engine's SimpleActionReq
 * (`{entity_id}` plus the session id the proxy needs to build the path) with
 * `deny_unknown_fields` upstream, so nothing else is ever sent — no round, no
 * order, no turn index. Every number stays engine-owned and every rejection
 * surfaces VERBATIM as its machine code: NOT_IN_COMBAT, ENTITY_NOT_FOUND,
 * ENTITY_CANNOT_ACT (dying/dead/incapacitated), ALREADY_DELAYED / NOT_DELAYED
 * (409) and the route-level FORBIDDEN_ROLE / ENTITY_NOT_OWNED (403).
 *
 * These calls carry the stored token as Authorization: Bearer like every other
 * mutating call in api/* — the gateway 401s anonymous requests rather than
 * resolving combat under its service principal.
 */

import { authHeaders, getStoredToken } from './auth_headers';
import type { EngineActionOutcome } from './rules_engine';

/** Verbatim body of POST /api/v1/sessions/{id}/action/delay[/resume]. */
export interface EngineDelayResult {
  status?: string;
  entity_id?: string;
  /** Who is parked out of turn order after this call (engine truth). */
  delayed?: string[];
  round?: number;
  turn_index?: number;
  order?: unknown[];
  event_sequence?: number;
}

const NOT_SIGNED_IN: EngineActionOutcome<never> = {
  kind: 'rejected',
  status: 401,
  code: 'NOT_AUTHENTICATED',
  message: 'Sign in to act through the authoritative engine.',
};

async function delayPost<T extends EngineDelayResult>(
  path: '/api/v1/engine/delay' | '/api/v1/engine/delay/resume',
  params: { sessionId: string; entityId: string },
): Promise<EngineActionOutcome<T>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        session_id: params.sessionId,
        entity_id: params.entityId,
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
    console.warn('Rules engine unreachable; the delay was not applied.');
    return { kind: 'unreachable' };
  }
}

function rejectionFrom(
  status: number,
  payload: unknown,
): EngineActionOutcome<never> {
  // FastAPI wraps handler detail in {detail}; the gateway already unwraps the
  // engine JSON there, but 422 validation failures arrive as an array instead.
  const raw = (payload as { detail?: unknown } | null)?.detail ?? payload;
  if (Array.isArray(raw)) {
    const first = raw[0] as Record<string, unknown> | undefined;
    const msg = typeof first?.msg === 'string' ? first.msg : 'invalid request';
    return { kind: 'rejected', status, code: null, message: msg };
  }
  if (typeof raw === 'string') {
    return { kind: 'rejected', status, code: null, message: raw };
  }
  if (raw && typeof raw === 'object') {
    const d = raw as Record<string, unknown>;
    return {
      kind: 'rejected',
      status,
      code: typeof d.error === 'string' ? d.error : null,
      message: typeof d.message === 'string' ? d.message : null,
    };
  }
  return { kind: 'rejected', status, code: null, message: `HTTP ${status}` };
}

/**
 * Park a controlled combatant out of turn order (SRD-optional Delay). Free —
 * no Action spent — but their slot this round is passed over until resume.
 */
export async function delayEntity(params: {
  sessionId: string;
  entityId: string;
}): Promise<EngineActionOutcome<EngineDelayResult>> {
  return delayPost('/api/v1/engine/delay', params);
}

/** Re-seat a delaying combatant immediately after the current actor. */
export async function resumeEntity(params: {
  sessionId: string;
  entityId: string;
}): Promise<EngineActionOutcome<EngineDelayResult>> {
  return delayPost('/api/v1/engine/delay/resume', params);
}

/**
 * Ids of parked combatants read defensively from a RAW projected session-state
 * body (`combat.delayed`) or a bare delay-route response body (`delayed`).
 * Whatever the projection did not expose simply yields an empty list — never a
 * guessed one. Non-string entries are dropped rather than coerced into fake ids.
 */
export function delayedIdsFromSnapshot(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const top = raw as Record<string, unknown>;
  const list =
    Array.isArray(top.delayed)
      ? top.delayed
      : top.combat && typeof top.combat === 'object' && !Array.isArray(top.combat)
        ? (top.combat as Record<string, unknown>).delayed
        : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === 'string');
}
