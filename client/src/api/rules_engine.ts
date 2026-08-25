/**
 * Authoritative Rules Engine API client.
 *
 * All dice outcomes resolve server-side: browser -> orchestrator proxy
 * (/api/v1/engine/*) -> Rust vtt-core engine. Every helper returns null when
 * the engine is unreachable so callers can fall back to local rolling and the
 * demo never hard-blocks.
 *
 * EVERY /api/v1/engine/* call carries the caller's identity via the
 * Authorization: Bearer header (like every other HTTP call in api/*) — the
 * gateway 401s anonymous requests instead of resolving combat under its
 * service principal. Signed-out callers get the local-dice fallback for
 * read-style helpers, and an explicit NOT_AUTHENTICATED rejection on mutating
 * ones. Tokens never ride the query string: URLs leak into proxy/access logs,
 * which is exactly what gateway docstrings warn about (WebSocket clients are
 * the documented exception — browsers cannot set headers on the handshake).
 *
 * Mutating actions (heal/rest) additionally report WHY they failed — the
 * gateway surfaces the engine's authoritative rejection verbatim (see
 * `_engine_call` in python/vtt_orchestrator/server.py), so callers can show
 * honest feedback like CANNOT_HEAL_DEAD instead of a silent no-op.
 */

import { authHeaders, getStoredToken } from './auth_headers';
import type { EngineCheckComplication } from './check_outcome';

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
  /** SCREAMING_SNAKE_CASE 4-tier margin (see api/check_outcome.ts). */
  outcome: string;
  /**
   * Fail-forward cost fields from vtt-core's Complication (resource
   * deductions, inflicted conditions, tactical penalty). Present only when
   * the engine resolved a SUCCESS_AT_A_COST or a complicated CRITICAL_FAILURE.
   */
  complication?: EngineCheckComplication | null;
}

/**
 * POST an authenticated engine-proxy call. The stored session token rides in
 * the Authorization: Bearer header exactly like every other /api/v1/engine/*
 * HTTP call in this file (heal/rest/maneuvers); the gateway 401s tokenless
 * requests rather than resolving anything anonymously. Returns null when
 * signed out or unreachable so dice helpers can fall back to local rolling.
 */
async function enginePost<T>(path: string, body: unknown): Promise<T | null> {
  const token = getStoredToken();
  if (!token) return null;
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
  /**
   * SRD inspiration spend (iteration 56 engine contract): burn this attacker's
   * held point to buy Advantage on THIS roll. The ENGINE decides whether the
   * point is actually consumed (a roll already advantaged/disadvantaged cancels
   * into a straight d20 and keeps it); the client only forwards the intent.
   */
  spendInspiration?: boolean;
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
    ...(params.spendInspiration ? { spend_inspiration: true } : {}),
  });
}

export async function engineCheck(params: {
  modifier: number;
  dc: number;
  advantage?: boolean;
  disadvantage?: boolean;
  /** Session-scoped grounding pair — required for an inspiration spend to
   * resolve against real engine state (see CheckActionReq in vtt-server). */
  sessionId?: string;
  entityId?: string;
  /** SRD inspiration spend; see engineAttack for the atomicity contract. */
  spendInspiration?: boolean;
}): Promise<EngineCheckResult | null> {
  return enginePost<EngineCheckResult>('/api/v1/engine/check', {
    modifier: params.modifier,
    dc: params.dc,
    cost_margin: 3,
    advantage: params.advantage ?? false,
    disadvantage: params.disadvantage ?? false,
    // Grounding and the inspiration spend travel together: without BOTH ids
    // the engine has no live entity to consume the point from, so sending a
    // bare spend_inspiration would be silently ignored state-side. A caller
    // asking to spend while ungrounded therefore keeps the legacy body.
    ...(params.sessionId && params.entityId
      ? {
          session_id: params.sessionId,
          entity_id: params.entityId,
          ...(params.spendInspiration ? { spend_inspiration: true } : {}),
        }
      : {}),
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
 * POST variant used by mutating actions. Every gateway engine proxy resolves
 * its caller through `_require_auth` (Authorization Bearer header first,
 * legacy ?token= query param as back-compat); like all other calls in this
 * file these send the Bearer header so the token never lands in a URL.
 */
async function engineActionPost<T>(path: string, body: unknown): Promise<EngineActionOutcome<T>> {
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
    `/api/v1/engine/heal`,
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
    `/api/v1/engine/rest`,
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
 * These calls carry the Bearer header exactly like engineHeal/engineRest so
 * the gateway forwards the real caller to the engine's RBAC.
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

/** Verbatim body of POST /api/v1/sessions/{id}/action/escape-grapple
 * (iteration 49 route). Success/failure of the contest rides on `escaped`
 * plus the two rolls; every field is individually optional because the
 * gateway may wrap rejections before the engine answers. */
export interface EngineEscapeGrappleResult {
  entity_id?: string;
  grappler_id?: string;
  escaped: boolean;
  skill?: 'athletics' | 'acrobatics';
  escaper_natural_roll?: number;
  escaper_total?: number;
  escape_dc?: number;
  forced?: boolean;
  hands_freed_after?: number;
  event_sequence?: number;
}

/**
 * Escape a standing grapple (SRD): contested Athletics/Acrobatics against the
 * HOLDER's Strength DC, spending the escaper's Action. `grapplerId` comes from
 * the session's grapple_holders attribution — never guessed by the client.
 * Rejections surface verbatim: GRAPPLE_NOT_HELD, ENTITY_NOT_OWNED,
 * ACTION_ECONOMY_EXHAUSTED, … The browser dials /api/v1/engine/escape-grapple;
 * when that proxy does not exist upstream yet the gateway's answer is quoted
 * honestly instead of being retried blind.
 */
export async function engineEscapeGrapple(params: {
  sessionId: string;
  entityId: string;
  grapplerId: string;
  skill: 'athletics' | 'acrobatics';
}): Promise<EngineActionOutcome<EngineEscapeGrappleResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineEscapeGrappleResult>(
    `/api/v1/engine/escape-grapple`,
    {
      session_id: params.sessionId,
      entity_id: params.entityId,
      grappler_id: params.grapplerId,
      skill: params.skill,
    },
  );
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
  /** Iteration 63: verbatim engine combat facts when the projection exposed
   * them (your own entity / GM view). Undefined = not exposed. */
  combatStatus?: EngineEntityCombatStatus;
}

/**
 * Engine-exposed combat facts carried ONLY on your own entity's projection
 * (or under GM/admin view). Every field optional: absence means the
 * projection did not expose it, never zero/free/not-held.
 */
export interface EngineEntityCombatStatus {
  inspiration?: boolean;
  hands_occupied?: number;
  conditions?: unknown[];
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
    `/api/v1/engine/grapple`,
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
    `/api/v1/engine/shove`,
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
    `/api/v1/engine/dodge`,
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
    `/api/v1/engine/dash`,
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
    `/api/v1/engine/disengage`,
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
    `/api/v1/engine/stabilize`,
    {
      session_id: params.sessionId,
      healer_id: params.healerId,
      target_id: params.targetId,
    },
  );
}

/** Verbatim body of POST /api/v1/sessions/{id}/action/offhand. */
export interface EngineOffhandResult {
  attacker_id: string;
  target_id: string;
  natural_roll: number;
  attack_roll: number;
  target_ac: number;
  is_hit: boolean;
  is_critical_hit?: boolean;
  total_damage: number;
  target_hp_remaining?: number;
  /** The damage expression actually rolled — the SRD off-hand strike strips
   * a POSITIVE ability modifier from the weapon's own expression. */
  damage_expression_rolled: string;
  ability_mod_withheld_from_damage: boolean;
  offhand_index: number;
  advantage?: boolean;
  help_advantage_consumed?: boolean;
  event_sequence?: number;
}

/** Verbatim body of POST /api/v1/sessions/{id}/action/help. */
export interface EngineHelpResult {
  status: string;
  helper_id: string;
  target_entity_id: string;
  next_attacker_has_advantage_against: string;
  event_sequence?: number;
}

/**
 * Two-Weapon Fighting bonus-action off-hand strike (SRD). Requires the Attack
 * action to have been taken this turn and both weapons Light; a positive
 * ability modifier is withheld from its damage. Rejections surface verbatim:
 * ATTACK_ACTION_REQUIRED, BONUS_ACTION_ECONOMY_EXHAUSTED,
 * MAIN_HAND_WEAPON_NOT_LIGHT, OFFHAND_WEAPON_NOT_LIGHT, …
 */
export async function engineOffhandAttack(params: {
  sessionId: string;
  attackerId: string;
  targetId: string;
  /** Index into the attacker's stat-block attack list for the OFF-HAND weapon. */
  offhandIndex?: number;
}): Promise<EngineActionOutcome<EngineOffhandResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineOffhandResult>(
    `/api/v1/engine/offhand`,
    {
      session_id: params.sessionId,
      attacker_id: params.attackerId,
      target_id: params.targetId,
      offhand_index: params.offhandIndex ?? 0,
    },
  );
}

/**
 * Help action (SRD): spend the helper's Action so an ally gains Advantage on
 * their NEXT attack roll against `targetEntityId`. One qualifying attack
 * consumes it; the round refresh clears it.
 */
export async function engineHelp(params: {
  sessionId: string;
  helperId: string;
  targetEntityId: string;
}): Promise<EngineActionOutcome<EngineHelpResult>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  return engineActionPost<EngineHelpResult>(
    `/api/v1/engine/help`,
    {
      session_id: params.sessionId,
      helper_id: params.helperId,
      target_entity_id: params.targetEntityId,
    },
  );
}

/* --- Spellbook: live compendium + authoritative cast-spell pipeline -------
 *
 * The grimoire list is read from the gateway's SRD compendium
 * (GET /api/v1/compendium/spells); casting posts through the cast-spell
 * proxy (POST /api/v1/engine/cast-spell, authenticated like every engine
 * call) into vtt-core's
 * slot ledger, upcast ladder and concentration lifecycle. Nothing here
 * invents spell statistics: fields the compendium does not carry (damage
 * formula/type, save attribute) are sent as null so the engine — not the
 * browser — decides every number, and a fetch failure is surfaced as an
 * empty state rather than a hardcoded spell list.
 */

/** Verbatim shape of one record from GET /api/v1/compendium/spells. */
export interface EngineCompendiumSpell {
  id: string;
  name: string;
  level: number;
  school: string;
  casting_time: string;
  range: string;
  components: string;
  material_components_costly?: boolean;
  duration: string;
  concentration?: boolean;
  ritual?: boolean;
  classes?: string[];
  description?: string;
  /** The SRD's own "At Higher Levels" text; empty string when none. */
  upcast?: string;
}

/**
 * GET the SRD spell compendium through the orchestrator. Returns null when
 * the gateway is unreachable or answers non-OK — callers must render an
 * honest empty state instead of substituting local data.
 */
export async function fetchCompendiumSpells(
  limit = 400,
): Promise<{ total: number; spells: EngineCompendiumSpell[] } | null> {
  try {
    const resp = await fetch(`/api/v1/compendium/spells?limit=${limit}`);
    if (!resp.ok) return null;
    const payload = (await resp.json()) as {
      total?: number;
      spells?: EngineCompendiumSpell[];
    };
    if (!Array.isArray(payload.spells)) return null;
    return { total: payload.total ?? payload.spells.length, spells: payload.spells };
  } catch {
    console.warn('Compendium unreachable; spellbook has nothing to show.');
    return null;
  }
}

/** Verbatim mirror of vtt_core::rules::SpellDefinition (all fields required
 * by its serde derive — omitting any makes the engine reject with a 422). */
export interface EngineSpellDefinition {
  spell_id: string;
  name: string;
  level: number;
  school: string;
  casting_time: string;
  range_feet: number;
  area_of_effect_shape: null;
  area_of_effect_size_feet: null;
  verbal_component: boolean;
  somatic_component: boolean;
  material_component_desc: string | null;
  save_attribute: null;
  damage_formula: string | null;
  damage_type: string | null;
  duration_rounds: number;
  is_concentration: boolean;
  is_ritual: boolean;
}

/**
 * Map a LIVE compendium record onto the engine's SpellDefinition. Every value
 * is derived from the fetched record itself:
 *   - `range_feet` is the first integer in the compendium `range` string,
 *     0 when it is non-numeric ("Self", "Touch") — the engine requires the
 *     field but never enforces it, so this is display metadata only.
 *   - V/S components come from the components string; a parenthetical after
 *     "M" becomes material_component_desc.
 *   - Fields the SRD fixture genuinely lacks (save attribute, damage formula
 *     and type) stay null: the engine then resolves the cast honestly as a
 *     zero-damage slot expenditure rather than the client guessing dice.
 *   - `duration_rounds` stays 0 — the compendium stores prose durations
 *     ("Concentration, up to 1 minute") that cannot be converted without
 *     inventing a ruling.
 */
export function compendiumSpellToEngineDefinition(
  spell: EngineCompendiumSpell,
): EngineSpellDefinition {
  const rangeMatch = /(\d+)/.exec(spell.range ?? '');
  const comps = spell.components ?? '';
  const materialDesc = /\bM\b\s*\(([^)]*)\)/.exec(comps);
  return {
    spell_id: spell.id,
    name: spell.name,
    level: spell.level,
    school: spell.school,
    casting_time: spell.casting_time,
    range_feet: rangeMatch ? parseInt(rangeMatch[1], 10) : 0,
    area_of_effect_shape: null,
    area_of_effect_size_feet: null,
    verbal_component: /\bV\b/.test(comps),
    somatic_component: /\bS\b/.test(comps),
    material_component_desc: materialDesc ? materialDesc[1] : null,
    save_attribute: null,
    damage_formula: null,
    damage_type: null,
    duration_rounds: 0,
    is_concentration: spell.concentration === true,
    is_ritual: spell.ritual === true,
  };
}

/** Verbatim body of vtt-core's CastSpellResult, unwrapped from the gateway's
 * `{result, target_was_present}` envelope. Quoted verbatim in the UI. */
export interface EngineCastSpellOutcome {
  caster_id: string;
  target_id: string | null;
  spell_id: string;
  /** The slot the ladder actually spent (exact level first, then upward). */
  slot_level_used: number;
  damage_total: number;
  target_hp_remaining: number | null;
  concentration_started: boolean;
  counterspelled: boolean;
}

/**
 * Cast through the authoritative pipeline. The engine spends the slot itself,
 * walks the upcast ladder, starts/replaces concentration and applies damage;
 * refusals arrive as machine codes inside SPELL_REJECTED (NO_SPELL_SLOTS,
 * INVALID_SLOT_LEVEL, COMPONENT_UNAVAILABLE_VERBAL, CASTER_NOT_FOUND, …).
 */
export async function engineCastSpell(params: {
  sessionId: string;
  casterId: string;
  targetId?: string;
  spell: EngineSpellDefinition;
  castLevel: number;
}): Promise<EngineActionOutcome<EngineCastSpellOutcome>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  const outcome = await engineActionPost<{
    result?: EngineCastSpellOutcome;
    target_was_present?: boolean;
  }>(
    `/api/v1/engine/cast-spell`,
    {
      session_id: params.sessionId,
      caster_id: params.casterId,
      target_id: params.targetId,
      spell: params.spell,
      cast_level: Math.max(0, Math.min(9, Math.floor(params.castLevel))),
    },
  );
  if (outcome.kind !== 'applied') return outcome;
  const envelope: { result?: EngineCastSpellOutcome } | null = outcome.data;
  if (!envelope || typeof envelope !== 'object' || !envelope.result) {
    // A 2xx without the documented envelope is a gateway contract break —
    // surfaced as such rather than guessed into a fake success.
    return {
      kind: 'rejected',
      status: 502,
      code: 'MALFORMED_CAST_RESPONSE',
      message: 'cast-spell proxy answered without a result payload',
    };
  }
  return { kind: 'applied', data: envelope.result };
}

/** One projected session entity as the Spellbook may see it. Slot ledger and
 * concentration are present ONLY when the role projection shows this caller
 * their own sheet (or they view as GM/admin) — absence means unverified, not
 * zero, and callers must not treat it as either. */
export interface EngineSpellbookEntity {
  id: string;
  name?: string;
  is_player: boolean;
  is_dead?: boolean;
  current_hp?: number;
  /** Spell-slot level -> remaining count, when the projection exposes it. */
  spell_slots_remaining?: Record<string, number>;
  /** Active concentration ({spell_id, started_round}) when present. */
  concentration?: { spell_id?: string; started_round?: number } | null;
}

function toSpellbookEntity(key: string, e: Record<string, unknown>): EngineSpellbookEntity {
  const rawSlots = e.spell_slots_remaining;
  let slots: Record<string, number> | undefined;
  if (rawSlots && typeof rawSlots === 'object') {
    slots = {};
    for (const [level, count] of Object.entries(rawSlots as Record<string, unknown>)) {
      if (typeof count === 'number') slots[level] = count;
    }
  }
  const rawConc = e.concentration;
  return {
    id: typeof e.id === 'string' ? e.id : key,
    name: typeof e.name === 'string' ? e.name : undefined,
    is_player: e.is_player === true,
    is_dead: e.is_dead === true,
    current_hp: typeof e.current_hp === 'number' ? e.current_hp : undefined,
    spell_slots_remaining: slots,
    concentration:
      rawConc && typeof rawConc === 'object'
        ? {
            spell_id:
              typeof (rawConc as Record<string, unknown>).spell_id === 'string'
                ? ((rawConc as Record<string, unknown>).spell_id as string)
                : undefined,
            started_round:
              typeof (rawConc as Record<string, unknown>).started_round === 'number'
                ? ((rawConc as Record<string, unknown>).started_round as number)
                : undefined,
          }
        : undefined,
  };
}

/**
 * Pull the full projected roster for caster/target picking plus the caster's
 * own sheet (slots + concentration). Uses the existing authenticated
 * session-state read proxy; the projection decides what this caller sees.
 */
export async function engineSessionRoster(
  sessionId: string,
): Promise<EngineActionOutcome<EngineSpellbookEntity[]>> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN;
  const outcome = await engineActionPost<{
    entities?: Record<string, Record<string, unknown>>;
  }>(`/api/v1/engine/session-state`, {
    session_id: sessionId,
  });
  if (outcome.kind === 'applied') {
    const map = outcome.data.entities ?? {};
    return {
      kind: 'applied',
      data: Object.entries(map)
        .filter(([, e]) => e && typeof e === 'object')
        .map(([key, e]) => toSpellbookEntity(key, e)),
    };
  }
  return outcome;
}

/* --- Procedural maps: real WFC generation ---------------------------------
 *
 * POST /api/v1/engine/map/generate proxies vtt-server's WFC route
 * (POST /api/v1/maps/generate -> DungeonGenerator::generate_room), which runs
 * a socket-matching solver with restart-on-contradiction and a flood-fill
 * walkability guarantee. No local synthesis exists here: if the engine cannot
 * produce a map, the outcome says so instead of inventing one.
 */

/** Verbatim body of POST /api/v1/maps/generate: `{width, height, tiles}` with
 * tiles as Vec<Vec<u8>> — 0 floor, 1 wall, 2 door, 3 altar, 4 chest. */
export interface EngineGeneratedMap {
  width: number;
  height: number;
  tiles: number[][];
}

export type EngineMapGenerateOutcome =
  | { kind: 'applied'; data: EngineGeneratedMap }
  | { kind: 'rejected'; status: number; code: string | null; message: string | null }
  /** Engine/gateway unreachable or an unrecognized 5xx — nothing was decided. */
  | { kind: 'unreachable' };

/**
 * Generate a dungeon through the authoritative WFC solver. Same seed ⇒
 * byte-identical tile grid (engine-side RNG); omitting the seed lets the
 * engine apply its documented default (1337). Authenticated like every other
 * engine call: the stored session token rides in the Authorization header and
 * a signed-out caller gets an explicit NOT_AUTHENTICATED rejection (no
 * anonymous map gen).
 *
 * Failure mapping note: vtt-server answers a fully-exhausted solver with HTTP
 * 500 `{"error": "WFC_CONTRADICTION_EXHAUSTED after N attempts"}`, which the
 * gateway forwards verbatim inside `{detail}`. A bare 500 would normally mean
 * "unreachable", so a recognized machine code in the body is promoted to a
 * rejection first — callers can then show its honest meaning ("every collapse
 * attempt contradicted; no map exists") rather than a network error.
 */
const NOT_SIGNED_IN_MAP: EngineMapGenerateOutcome = {
  kind: 'rejected',
  status: 401,
  code: 'NOT_AUTHENTICATED',
  message: 'Sign in to generate maps through the authoritative engine.',
};

export async function engineGenerateMap(params: {
  width: number;
  height: number;
  seed?: number;
  theme?: string;
}): Promise<EngineMapGenerateOutcome> {
  const token = getStoredToken();
  if (!token) return NOT_SIGNED_IN_MAP;
  try {
    const resp = await fetch('/api/v1/engine/map/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        width: params.width,
        height: params.height,
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        theme: params.theme ?? 'dungeon',
      }),
    });
    const payload: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      const raw = (payload as { detail?: unknown } | null)?.detail ?? payload;
      const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      const code = typeof d?.error === 'string' ? d.error : null;
      if (code) {
        return {
          kind: 'rejected',
          status: resp.status,
          code,
          message: typeof d?.message === 'string' ? d.message : null,
        };
      }
      if (resp.status >= 500) return { kind: 'unreachable' };
      return {
        kind: 'rejected',
        status: resp.status,
        code: null,
        message:
          typeof raw === 'string'
            ? raw
            : typeof d?.message === 'string'
              ? d.message
              : `HTTP ${resp.status}`,
      };
    }
    const m = payload as Partial<EngineGeneratedMap> | null;
    const tilesOk =
      !!m &&
      Array.isArray(m.tiles) &&
      m.tiles.length > 0 &&
      m.tiles.every((row) => Array.isArray(row) && row.every((c) => typeof c === 'number'));
    if (!tilesOk || typeof m!.width !== 'number' || typeof m!.height !== 'number') {
      // A 2xx without the documented grid is a gateway contract break.
      return {
        kind: 'rejected',
        status: 502,
        code: 'MALFORMED_MAP_RESPONSE',
        message: 'map/generate proxy answered without a tile grid',
      };
    }
    return { kind: 'applied', data: m as EngineGeneratedMap };
  } catch {
    console.warn('Rules engine unreachable; no map was generated.');
    return { kind: 'unreachable' };
  }
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
    grapple_holders?: Record<string, unknown>;
  }>(`/api/v1/engine/session-state`, {
    session_id: sessionId,
  });
  if (outcome.kind === 'applied') {
    const map = outcome.data.entities ?? {};
    // Iteration 63: pass the engine-exposed combat facts (inspiration /
    // hands_occupied / conditions) through verbatim where the projection
    // carried them — i.e. only on the caller's OWN entity. Board tokens for
    // other creatures simply lack these keys and stay clean.
    const list: EngineEntitySummary[] = Object.entries(map)
      .filter(([, e]) => e && typeof e === 'object')
      .map(([key, e]) => {
        const combatStatus: EngineEntityCombatStatus = {};
        if (typeof e.inspiration === 'boolean') combatStatus.inspiration = e.inspiration;
        if (typeof e.hands_occupied === 'number' && Number.isFinite(e.hands_occupied)) {
          combatStatus.hands_occupied = e.hands_occupied;
        }
        if (Array.isArray(e.conditions)) combatStatus.conditions = e.conditions;
        return {
          id: typeof e.id === 'string' ? e.id : key,
          name: typeof e.name === 'string' ? e.name : undefined,
          is_visible: e.is_visible !== false,
          is_player: e.is_player === true,
          is_dead: e.is_dead === true,
          position: Array.isArray(e.position) ? (e.position as number[]) : undefined,
          current_hp: typeof e.current_hp === 'number' ? e.current_hp : undefined,
          ...(Object.keys(combatStatus).length > 0 ? { combatStatus } : {}),
        };
      })
      .filter((e) => e.is_visible);
    return { kind: 'applied', data: list };
  }
  return outcome;
}
