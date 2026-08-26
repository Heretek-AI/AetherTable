/**
 * Iteration 76 — pure parser + resolution call for the opportunity-attack
 * surface (engine commit 76787ff).
 *
 * The engine's POST /api/v1/sessions/{id}/move response carries ADDITIVE
 * disclosure fields when leaving an armed enemy's reach provoked an
 * opportunity attack — and since iterations 72+74 those provocations PEND
 * rather than auto-resolving: the reacting side spends its REACTION through
 * POST /sessions/{id}/action/opportunity-attack. The move response carries:
 *
 *   - `opportunity_attacks_detail[]` (plural, every provoked attacker), each
 *     entry {provoked_by, reaction_type, pending_opportunity: "/action/
 *     opportunity-attack", available};
 *   - `opportunity_attack` (singular legacy mirror of the first entry);
 *   - both fields OMITTED entirely when nothing was provoked (mover
 *     disengaged / no adjacent armed enemy) — absence stays silent.
 *
 * GATEWAY STATUS (honest note for the python owner): python/vtt_orchestrator/
 * server.py proxies `/api/v1/engine/move` (so disclosure fields reach the
 * browser) but does NOT yet expose `/api/v1/engine/opportunity-attack`. This
 * module posts the documented ids-only contract to that proxy path anyway;
 * until the proxy lands the gateway answers 404/405, which surfaces here as a
 * plain `{kind:'rejected'}` — never as a fabricated success.
 *
 * Everything except `engineOpportunityAttack` is pure: it never invents an
 * attack, never fabricates a name or roll, and renders only fields the
 * response actually carried.
 */

import { authHeaders, getStoredToken } from './auth_headers';

export interface PendingOpportunityAttack {
  /** Entity whose armed reaction was triggered (the one who gets to swing). */
  provokedBy?: string;
  /** The mover who left reach — omitted by some engine shapes; not guessed. */
  moverId?: string;
  /** Engine-declared endpoint that resolves this swing, when disclosed. */
  pendingEndpoint?: string;
  available?: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const strField = (o: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
};

const boolField = (o: Record<string, unknown>, key: string): boolean | undefined =>
  typeof o[key] === 'boolean' ? (o[key] as boolean) : undefined;

const parseOaEntry = (raw: unknown): PendingOpportunityAttack | null => {
  const o = asRecord(raw);
  if (!o) return null;
  // Without a provoking entity the entry discloses nothing usable — drop it
  // rather than render "something provoked something".
  const provokedBy = strField(o, 'provoked_by', 'attacker_id', 'provokedBy');
  if (!provokedBy) return null;
  return {
    provokedBy,
    moverId: strField(o, 'mover_id', 'mover', 'target_id'),
    pendingEndpoint: strField(o, 'pending_opportunity', 'pending_endpoint'),
    available: boolField(o, 'available'),
  };
};

/**
 * Walk a raw move (or any action) response body and pull every pending
 * opportunity-attack disclosure it carried. Prefers the plural
 * `opportunity_attacks_detail`, falls back to singular `opportunity_attack`
 * when no list form was present. Returns [] for anything else — including the
 * common case where the engine omitted both fields because nothing fired.
 */
export function extractPendingOpportunityAttacks(raw: unknown): PendingOpportunityAttack[] {
  const top = asRecord(raw);
  if (!top) return [];

  const fromList = (list: unknown): PendingOpportunityAttack[] =>
    Array.isArray(list)
      ? list.map(parseOaEntry).filter((e): e is PendingOpportunityAttack => e !== null)
      : [];

  const plural = fromList(top.opportunity_attacks_detail);
  if (plural.length > 0) return plural;

  const altPlural = fromList(top.opportunity_attacks);
  if (altPlural.length > 0) return altPlural;

  const hasList = Array.isArray(top.opportunity_attacks_detail) || Array.isArray(top.opportunity_attacks);
  if (hasList) return [];
  const single = parseOaEntry(top.opportunity_attack);
  return single ? [single] : [];
}

/**
 * Render one pending OA as a chat/system line: "X provoked an opportunity
 * attack against Y". Only names what the response carried; returns null for
 * entries with nothing usable so callers can drop them.
 */
export function formatOpportunityAttackLine(
  oa: PendingOpportunityAttack | null | undefined,
  resolveName: (entityId?: string) => string | undefined,
): string | null {
  if (!oa || !oa.provokedBy) return null;
  const attacker = resolveName(oa.provokedBy) ?? oa.provokedBy;
  if (oa.moverId) {
    const mover = resolveName(oa.moverId) ?? oa.moverId;
    return `⚔ ${attacker} provoked an opportunity attack against ${mover}`;
  }
  return `⚔ ${attacker} provoked an opportunity attack`;
}

/** Verbatim body of POST /api/v1/sessions/{id}/action/opportunity-attack. */
export interface OpportunityAttackResult {
  status?: string;
  attacker_id?: string;
  target_id?: string;
  natural_roll?: number;
  attack_roll?: number;
  target_ac?: number;
  is_hit?: boolean;
  is_critical_hit?: boolean;
  total_damage?: number;
  target_hp_remaining?: number;
}

export type OpportunityAttackOutcome =
  | { kind: 'applied'; data: OpportunityAttackResult }
  | { kind: 'rejected'; status: number; code: string | null; message: string | null }
  | { kind: 'unreachable' };

function rejectionFrom(status: number, payload: unknown): OpportunityAttackOutcome {
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
 * Resolve ONE pending opportunity attack through the reaction economy. Same
 * ids-only contract as /action/attack ({session_id, attacker_id, target_id});
 * the engine buys the swing with the attacker's REACTION and refuses anything
 * that is not a currently-pending pairing.
 *
 * NOTE: the orchestrator gateway does not proxy this route yet, so in live
 * deployments this resolves to a 404 rejection ("gateway support pending") —
 * surfaced honestly to callers instead of swallowed.
 */
export async function engineOpportunityAttack(params: {
  sessionId: string;
  attackerId: string;
  targetId: string;
}): Promise<OpportunityAttackOutcome> {
  const token = getStoredToken();
  if (!token) {
    return {
      kind: 'rejected',
      status: 401,
      code: 'NOT_AUTHENTICATED',
      message: 'Sign in to act through the authoritative engine.',
    };
  }
  try {
    const resp = await fetch('/api/v1/engine/opportunity-attack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        session_id: params.sessionId,
        attacker_id: params.attackerId,
        target_id: params.targetId,
      }),
    });
    const payload: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      if (resp.status >= 500) return { kind: 'unreachable' };
      return rejectionFrom(resp.status, payload);
    }
    return { kind: 'applied', data: payload as OpportunityAttackResult };
  } catch {
    console.warn('Rules engine unreachable; opportunity attack was not resolved.');
    return { kind: 'unreachable' };
  }
}
