/**
 * Authoritative Rules Engine API client.
 *
 * All dice outcomes resolve server-side: browser -> orchestrator proxy
 * (/api/v1/engine/*) -> Rust vtt-core engine. Every helper returns null when
 * the engine is unreachable so callers can fall back to local rolling and the
 * demo never hard-blocks.
 */

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
  attackBonus: number;
  targetAc: number;
  damageExpression: string;
  damageType?: string;
}): Promise<EngineAttackResult | null> {
  const sessionId = await ensureEngineSession();
  if (!sessionId) return null;
  return enginePost<EngineAttackResult>('/api/v1/engine/attack', {
    session_id: sessionId,
    attacker_id: params.attackerId,
    target_id: params.targetId,
    attack_bonus: params.attackBonus,
    target_ac: params.targetAc,
    damage_expression: params.damageExpression,
    damage_type: params.damageType ?? 'slashing',
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
