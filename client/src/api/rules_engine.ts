/**
 * Authoritative Rules Engine API client.
 *
 * All dice outcomes resolve server-side: browser -> orchestrator proxy
 * (/api/v1/engine/*) -> Rust vtt-core engine. Every helper returns null when
 * the engine is unreachable so callers can fall back to local rolling and the
 * demo never hard-blocks.
 *
 * Mutating actions (heal/rest) additionally report WHY they failed — the
 * gateway surfaces the engine's authoritative rejection verbatim (see
 * `_engine_call` in python/vtt_orchestrator/server.py), so callers can show
 * honest feedback like CANNOT_HEAL_DEAD instead of a silent no-op.
 */

import { getStoredToken } from './auth_headers';

export interface EngineAttackResult {
  attack_roll: number;
  natural_roll: number;
  target_ac: number;
  is_hit: boolean;
  is_critical_hit: boolean;
  total_damage: number;
  target_hp_remaining?: number;
}

export interface EngineCheckResult {
  roll: number;
  modifier: number;
  total: number;
  dc: number;
  outcome: string;
}

async function enginePost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    console.warn('Rules engine unavailable; falling back to local dice.');
    return null;
  }
}

export const localD20 = () => Math.floor(Math.random() * 20) + 1;

/** Parse a trailing "+N"/"-N" modifier out of a formula like "1d12+3". */
export const formulaModifier = (formula: string): number => {
  const match = formula.match(/([+-]\s*\d+)\s*$/);
  return match ? parseInt(match[1].replace(/\s/g, ''), 10) : 0;
};

let cachedSessionId: string | null = null;

/** Lazily create (and reuse) one authoritative engine session per client. */
export async function ensureEngineSession(): Promise<string | null> {
  if (cachedSessionId) return cachedSessionId;
  const created = await enginePost<{ session_id: string }>('/api/v1/engine/session', {
    campaign_id: 'aethertable-live',
    session_name: 'Live Tabletop Session',
  });
  cachedSessionId = created?.session_id ?? null;
  return cachedSessionId;
}

export async function engineAttack(params: {
  attackerId: string;
  targetId: string;
  /** Index into the attacker's server-side stat-block attack list. */
  actionIndex?: number;
}): Promise<EngineAttackResult | null> {
  const sessionId = await ensureEngineSession();
  if (!sessionId) return null;
  // Reference-only payload: every modifier, AC and damage die resolves inside
  // vtt-core from the entity stat blocks. Clients never send combat math.
  return enginePost<EngineAttackResult>('/api/v1/engine/attack', {
    session_id: sessionId,
    attacker_id: params.attackerId,
    target_id: params.targetId,
    action_index: params.actionIndex ?? 0,
  });
}

export async function engineCheck(params: {
  modifier: number;
  dc: number;
  advantage?: boolean;
  disadvantage?: boolean;
}): Promise<EngineCheckResult | null> {
  return enginePost<EngineCheckResult>('/api/v1/engine/check', {
    modifier: params.modifier,
    dc: params.dc,
    cost_margin: 3,
    advantage: params.advantage ?? false,
    disadvantage: params.disadvantage ?? false,
  });
}

/* --- Authoritative recovery actions (heal / rest) -------------------------
 *
 * Unlike the dice helpers above, healing and rests have NO local fallback:
 * the HP truth lives in the engine session, so a failed call must change
 * nothing on screen. The outcome union below makes every failure mode
 * explicit — callers render it, they never guess.
 */

export type EngineActionOutcome<T> =
  /** The engine applied the action; `data` is its verbatim response. */
  | { kind: 'applied'; data: T }
  /** The engine (or gateway auth) refused. `code` is the engine's machine
   * rejection code (CANNOT_HEAL_DEAD, ENTITY_NOT_OWNED, …) or null when the
   * gateway answered without one. */
  | { kind: 'rejected'; status: number; code: string | null; message: string | null }
  /** Engine/gateway unreachable or a 5xx — nothing was decided. */
  | { kind: 'unreachable' };

/** Verbatim body of the engine's POST /api/v1/sessions/{id}/heal response. */
export interface EngineHealResult {
  status: string;
  amount_applied: number;
  hp_remaining: number;
  death_saves_reset?: boolean;
}

/** Verbatim body of the engine's POST /api/v1/sessions/{id}/rest response
 * (shape differs per kind — see take_rest in crates/vtt-server/src/server.rs). */
export interface EngineRestResult {
  status?: string;
  restored_entities?: number;
  entities?: Array<{ entity_id: string; hp_remaining: number }>;
  hook?: string;
  note?: string;
}

function rejectionFrom(status: number, payload: unknown): EngineActionOutcome<never> {
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
 * POST variant used by mutating actions. The /api/v1/engine/heal and
 * /api/v1/engine/rest gateway routes declare `token: str = Query(...)` — the
 * token is read from the query string ONLY there (not the header-or-query
 * `_token_from` dependency other routes use), so these calls append ?token=.
 */
async function engineActionPost<T>(path: string, body: unknown): Promise<EngineActionOutcome<T>> {
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      if (resp.status >= 500) return { kind: 'unreachable' };
      return rejectionFrom(resp.status, payload);
    }
    return { kind: 'applied', data: payload as T };
  } catch {
    console.warn('Rules engine unreachable; recovery action was not applied.');
    return { kind: 'unreachable' };
  }
}

const NOT_SIGNED_IN: EngineActionOutcome<never> = {
  kind: 'rejected',
  status: 401,
  code: 'NOT_AUTHENTICATED',
  message: 'Sign in to act through the authoritative engine.',
};

/**
 * Ask the engine to heal an entity. Server-side math clamps `amount` to the
 * missing deficit and refuses dead entities (409 CANNOT_HEAL_DEAD); clients
 * never compute HP themselves.
 */
export async function engineHeal(params: {
  sessionId: string;
  entityId: string;
  amount: number;
}): Promise<EngineActionOutcome<EngineHealResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineHealResult>(
    `/api/v1/engine/heal?token=${encodeURIComponent(token)}`,
    {
      session_id: params.sessionId,
      entity_id: params.entityId,
      amount: Math.max(0, Math.floor(params.amount)),
    },
  );
}

/**
 * Ask the engine to apply a short ("short") or long ("long") rest to the
 * session. Long rests restore controlled entities to max HP engine-side;
 * spell slots are deliberately NOT refilled (slot maxima untracked).
 */
export async function engineRest(params: {
  sessionId: string;
  kind: 'short' | 'long';
}): Promise<EngineActionOutcome<EngineRestResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineRestResult>(
    `/api/v1/engine/rest?token=${encodeURIComponent(token)}`,
    {
      session_id: params.sessionId,
      kind: params.kind,
    },
  );
}
