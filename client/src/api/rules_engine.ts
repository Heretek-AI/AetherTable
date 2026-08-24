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

/* --- Combat maneuvers (grapple/shove/dodge/dash/disengage/stabilize) -------
 *
 * Same contract as heal/rest above: no local fallback, no optimistic state —
 * the engine rolls the contests against server-side stat blocks and either
 * applies them to its ledger or refuses with a machine code the UI quotes
 * verbatim (ATTACKER_NOT_FOUND, OUT_OF_REACH, ACTION_ECONOMY_EXHAUSTED, …).
 * The gateway routes declare `token: str = Query(...)`, so these calls append
 * ?token= exactly like engineHeal/engineRest.
 */

/** Verbatim body of POST /api/v1/sessions/{id}/action/grapple. */
export interface EngineGrappleResult {
  attacker_id: string;
  defender_id: string;
  attacker_natural_roll: number;
  attacker_total: number;
  defender_natural_roll: number;
  defender_total: number;
  defender_skill: 'athletics' | 'acrobatics';
  success: boolean;
  applied_condition?: string | null;
  escape_dc?: number;
  winner_side?: string;
  margin?: number;
  distance_feet?: number;
  event_sequence?: number;
}

/** Verbatim body of POST /api/v1/sessions/{id}/action/shove. */
export interface EngineShoveResult {
  attacker_id: string;
  defender_id: string;
  attacker_natural_roll: number;
  attacker_total: number;
  defender_natural_roll: number;
  defender_total: number;
  shove_effect: 'prone' | 'push_5ft';
  success: boolean;
  applied_condition?: string | null;
  pushed_from?: number[];
  pushed_to?: number[];
  push_distance_feet?: number;
  winner_side?: string;
  margin?: number;
  event_sequence?: number;
}

/** Verbatim body of POST /api/v1/sessions/{id}/action/{dodge|dash|disengage}
 * (the three share one shape; each carries only its own flag plus movement). */
export interface EngineStandardActionResult {
  status?: string;
  entity_id: string;
  dodge_until_next_turn?: boolean;
  disengaged_until_next_turn?: boolean;
  dashed_this_turn?: boolean;
  movement_remaining_feet?: number;
  event_sequence?: number;
}

/** Verbatim body of POST /api/v1/sessions/{id}/action/stabilize. */
export interface EngineStabilizeResult {
  healer_id: string;
  target_id: string;
  natural_roll: number;
  medicine_modifier?: number;
  total?: number;
  dc?: number;
  success: boolean;
  successes_after?: number;
  failures_after?: number;
  is_stabilized_after?: boolean;
  event_sequence?: number;
}

/**
 * One visible entity from the projected session state (POST
 * /api/v1/engine/session-state). Mirrors the gateway's role projection: other
 * players' and hostile entities expose only board-token facts (no HP/AC), so
 * "downed" is only detectable when `current_hp` is present.
 */
export interface EngineEntitySummary {
  id: string;
  name?: string;
  is_visible?: boolean;
  is_player?: boolean;
  is_dead?: boolean;
  position?: number[];
  /** Only present for YOUR OWN entity or when viewing as GM/admin. */
  current_hp?: number;
}

/** Ask the engine to resolve a grapple contest (attacker spends their Action). */
export async function engineGrapple(params: {
  sessionId: string;
  attackerId: string;
  defenderId: string;
  /** Defender's contested skill choice. */
  defenderSkill: 'athletics' | 'acrobatics';
}): Promise<EngineActionOutcome<EngineGrappleResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineGrappleResult>(
    `/api/v1/engine/grapple?token=${encodeURIComponent(token)}`,
    {
      session_id: params.sessionId,
      attacker_id: params.attackerId,
      defender_id: params.defenderId,
      defender_skill: params.defenderSkill,
    },
  );
}

/** Ask the engine to resolve a shove (prone or 5 ft push on success). */
export async function engineShove(params: {
  sessionId: string;
  attackerId: string;
  defenderId: string;
  shoveEffect: 'prone' | 'push_5ft';
}): Promise<EngineActionOutcome<EngineShoveResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineShoveResult>(
    `/api/v1/engine/shove?token=${encodeURIComponent(token)}`,
    {
      session_id: params.sessionId,
      attacker_id: params.attackerId,
      defender_id: params.defenderId,
      shove_effect: params.shoveEffect,
    },
  );
}

/** Dodge: attackers roll against this entity with disadvantage until its next turn. */
export async function engineDodge(params: {
  sessionId: string;
  entityId: string;
}): Promise<EngineActionOutcome<EngineStandardActionResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineStandardActionResult>(
    `/api/v1/engine/dodge?token=${encodeURIComponent(token)}`,
    { session_id: params.sessionId, entity_id: params.entityId },
  );
}

/** Dash: double movement this turn, engine-side budget accounting. */
export async function engineDash(params: {
  sessionId: string;
  entityId: string;
}): Promise<EngineActionOutcome<EngineStandardActionResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineStandardActionResult>(
    `/api/v1/engine/dash?token=${encodeURIComponent(token)}`,
    { session_id: params.sessionId, entity_id: params.entityId },
  );
}

/** Disengage: opportunity attacks are refused until the entity's next turn. */
export async function engineDisengage(params: {
  sessionId: string;
  entityId: string;
}): Promise<EngineActionOutcome<EngineStandardActionResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineStandardActionResult>(
    `/api/v1/engine/disengage?token=${encodeURIComponent(token)}`,
    { session_id: params.sessionId, entity_id: params.entityId },
  );
}

/** Stabilize a dying ally with a Medicine check resolved by the engine. */
export async function engineStabilize(params: {
  sessionId: string;
  healerId: string;
  targetId: string;
}): Promise<EngineActionOutcome<EngineStabilizeResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineStabilizeResult>(
    `/api/v1/engine/stabilize?token=${encodeURIComponent(token)}`,
    {
      session_id: params.sessionId,
      healer_id: params.healerId,
      target_id: params.targetId,
    },
  );
}

/**
 * Read the caller-projected entity roster for a session through the gateway's
 * read proxy. Hidden entities are filtered out for players by the projection
 * itself; we additionally drop any that still claim invisibility defensively.
 */
export async function engineSessionEntities(
  sessionId: string,
): Promise<EngineActionOutcome<EngineEntitySummary[]>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  const outcome = await engineActionPost<{
    session_id: string;
    entities?: Record<string, Record<string, unknown>>;
  }>(`/api/v1/engine/session-state?token=${encodeURIComponent(token)}`, {
    session_id: sessionId,
  });
  if (outcome.kind === 'applied') {
    const map = outcome.data.entities ?? {};
    const list: EngineEntitySummary[] = Object.entries(map)
      .filter(([, e]) => e && typeof e === 'object')
      .map(([key, e]) => ({
        id: typeof e.id === 'string' ? e.id : key,
        name: typeof e.name === 'string' ? e.name : undefined,
        is_visible: e.is_visible !== false,
        is_player: e.is_player === true,
        is_dead: e.is_dead === true,
        position: Array.isArray(e.position) ? (e.position as number[]) : undefined,
        current_hp: typeof e.current_hp === 'number' ? e.current_hp : undefined,
      }))
      .filter((e) => e.is_visible);
    return { kind: 'applied', data: list };
  }
  return outcome;
}
