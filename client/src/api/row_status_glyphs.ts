/**
 * Iteration 84 — pure row-state shaping for the InitiativeTracker's compact
 * per-combatant status glyphs.
 *
 * The engine owns all of this state (crates/vtt-core/src/state.rs) and
 * mirrors it verbatim into the session-state projection, which App.tsx already
 * polls and parses:
 *
 *   - `EntityState.conditions` — snake_case variants; `Exhaustion(u8)`
 *     serializes as `{"exhaustion": <level>}` (flattened to `'exhaustion'` by
 *     api/entity_status_state.ts).
 *   - `entities[id].concentration = { spell_id, started_round }`
 *     (parsed by api/concentration_state.ts).
 *
 * The tracker must never invent a status: every glyph below renders ONLY when
 * the projection actually carried the underlying field. An absent conditions /
 * concentration entry means "the engine did not expose it", so the row stays
 * clean instead of showing a fabricated "healthy".
 *
 * Everything here is pure: it takes already-parsed session-state projections
 * plus one raw snapshot (for the exhaustion level, which only the wire form
 * preserves) and returns display data or nothing.
 */

import type { ConcentrationInfo } from './concentration_state';
import type { EntityCombatStatus } from './entity_status_state';

/** One condition tag on a combatant row (engine name kept verbatim). */
export interface ConditionTag {
  /** Engine snake_case spelling (`grappled`, `prone`, …). */
  name: string;
}

/** Exhaustion glyph payload — level is shown only when actually exposed. */
export interface ExhaustionGlyph {
  /** Engine-exposed SRD exhaustion level (1–6). */
  level: number;
}

/** The complete set of status glyphs for ONE combatant row. */
export interface CombatantRowStatus {
  exhaustion?: ExhaustionGlyph;
  concentration?: ConcentrationInfo;
  conditions: ConditionTag[];
}

const EMPTY_STATUS: CombatantRowStatus = { conditions: [] };

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Pull the strongest exhaustion LEVEL back out of the raw conditions array of
 * one entity in a session-state body. `parseEntityStatusFromSessionState`
 * deliberately flattens `{"exhaustion": N}` to the bare variant name, which is
 * right for matching but loses the number the tracker wants to display — so
 * this reads the original wire object instead. Returns undefined when the
 * projection exposed no exhaustion at all (never coerced to 0).
 */
export function exhaustionLevelFromRaw(rawConditions: unknown): number | undefined {
  if (!Array.isArray(rawConditions)) return undefined;
  let best: number | undefined;
  for (const cond of rawConditions) {
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) continue;
    const level = asNumber((cond as Record<string, unknown>).exhaustion);
    if (level === undefined) continue;
    // Level 0 / negative means "no exhaustion" — no glyph, never clamped up
    // into a fabricated level 1.
    if (level <= 0) continue;
    // SRD exhaustion tops out at 6; clamp out-of-domain values rather than
    // displaying an impossible level the engine could not have sent.
    const clamped = Math.max(1, Math.min(6, Math.floor(level)));
    best = best === undefined ? clamped : Math.max(best, clamped);
  }
  return best;
}

/**
 * Shape everything a single combatant row should show. Renders nothing for a
 * combatant whose projection carried no conditions / concentration / raw
 * exhaustion — `hasContent` false means "render no strip at all".
 *
 * @param entityId      combatant id from the engine's initiative order
 * @param entityStatus  parsed `entities[id]` combat facts (may be undefined)
 * @param concentration parsed active-concentration info (may be undefined)
 * @param rawSnapshot   RAW session-state body, consulted only for the numeric
 *                      exhaustion level inside `entities[id].conditions`
 */
export function combatantRowStatus(
  entityId: string,
  entityStatus: EntityCombatStatus | null | undefined,
  concentration: ConcentrationInfo | null | undefined,
  rawSnapshot: unknown,
): CombatantRowStatus {
  const conditions: ConditionTag[] = (entityStatus?.conditions ?? [])
    .filter((name) => name !== 'exhaustion') // rendered as its own numbered glyph
    .map((name) => ({ name }));

  const level = exhaustionLevelFromRaw(
    readRawConditions(rawSnapshot, entityId),
  );

  const out: CombatantRowStatus = {
    ...(level !== undefined ? { exhaustion: { level } } : {}),
    ...(concentration ? { concentration } : {}),
    conditions,
  };
  return out;
}

/** True when at least one glyph would render — callers skip the strip otherwise. */
export function hasRowStatus(status: CombatantRowStatus): boolean {
  return (
    status.exhaustion !== undefined ||
    status.concentration !== undefined ||
    status.conditions.length > 0
  );
}

/** The shared empty shape, exported for tests and callers that need it. */
export function emptyRowStatus(): CombatantRowStatus {
  return EMPTY_STATUS;
}

// ----------------------------------------------------------------- internals

/** Read one entity's raw `conditions` array out of an untyped snapshot body. */
function readRawConditions(snapshot: unknown, entityId: string): unknown {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return undefined;
  }
  const entities = (snapshot as Record<string, unknown>).entities;
  if (!entities || typeof entities !== 'object' || Array.isArray(entities)) {
    return undefined;
  }
  const entity = (entities as Record<string, unknown>)[entityId];
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    return undefined;
  }
  return (entity as Record<string, unknown>).conditions;
}
