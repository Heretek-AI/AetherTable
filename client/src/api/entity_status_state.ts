/**
 * Iteration 63 — pure parsers/formatters for the engine-exposed combat-state
 * fields the character sheet now displays.
 *
 * The browser has no opinion on any of this state. `vtt-core` owns it
 * (crates/vtt-core/src/state.rs):
 *
 *   - `EntityState.inspiration: bool`      — SRD one-point inspiration hold
 *     (iterations 41/54; granted/revoked/consumed only by the engine).
 *   - `EntityState.hands_occupied: u8`     — bound-hand ledger, saturated at
 *     `MODELED_HANDS == 2`; today written ONLY by won grapples and their
 *     escapes/rewinds (the engine has no equip/wield pipeline yet).
 *   - `EntityState.conditions: Vec<Condition>` — serde snake_case variants;
 *     `Exhaustion(u8)` serializes as the object `{"exhaustion": <level>}`.
 *   - `GameSession.grapple_holders: {escaper_id -> holder_id}` — who is
 *     actually holding whom (audit F-A4#3), needed to aim POST
 *     /action/escape-grapple.
 *
 * All four travel to the browser VERBATIM inside the session-state projection,
 * but ONLY for entities the caller owns (or views as GM/admin) — other
 * creatures arrive as board tokens with these fields stripped. An ABSENT field
 * therefore means "the projection did not say", never "zero/free/not held":
 * every helper here keeps that distinction and callers render nothing rather
 * than a guess.
 *
 * Everything in this module is pure. It never fetches, never mutates, and
 * never invents a value it did not parse.
 */

/** vtt-core `EntityState::MODELED_HANDS` — the engine saturates at two. */
export const MODELED_HANDS = 2;

/** The engine-exposed combat facts for ONE entity, all individually optional. */
export interface EntityCombatStatus {
  /** Held SRD inspiration point (`EntityState.inspiration`). */
  inspiration?: boolean;
  /** Occupied hands, clamped to `0..MODELED_HANDS` (`hands_occupied`). */
  handsOccupied?: number;
  /** Condition names in engine snake_case (`grappled`, `prone`, …). */
  conditions?: string[];
}

/** One parsed session snapshot: per-entity status plus the hold attribution. */
export interface ParsedSessionEntityStatus {
  byEntity: Record<string, EntityCombatStatus>;
  /** Escaper id -> holder id (`GameSession.grapple_holders`), UUID strings. */
  grappleHolders: Record<string, string>;
}

const EMPTY: ParsedSessionEntityStatus = { byEntity: {}, grappleHolders: {} };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Parse the per-entity combat status out of an engine session-state response
 * body. Returns empty maps for anything that is not the documented
 * `{ entities: {...}, grapple_holders: {...} }` shape — failure here never
 * throws, because every caller renders an empty result as "nothing exposed"
 * rather than as a crash.
 */
export function parseEntityStatusFromSessionState(raw: unknown): ParsedSessionEntityStatus {
  const top = asRecord(raw);
  const entities = top ? asRecord(top.entities) : null;
  const rawHolders = top ? asRecord(top.grapple_holders) : null;
  if (!entities && !rawHolders) return EMPTY;

  const byEntity: Record<string, EntityCombatStatus> = {};
  if (entities) {
    for (const [key, entityRaw] of Object.entries(entities)) {
      const entity = asRecord(entityRaw);
      if (!entity) continue;
      const status: EntityCombatStatus = {};

      // inspiration: strictly boolean. A legacy snapshot without the serde
      // default stays undefined (= "not exposed"), never coerced to false.
      if (typeof entity.inspiration === 'boolean') {
        status.inspiration = entity.inspiration;
      }

      // hands_occupied: finite numbers only, clamped into 0..MODELED_HANDS.
      if (typeof entity.hands_occupied === 'number' && Number.isFinite(entity.hands_occupied)) {
        status.handsOccupied = Math.max(
          0,
          Math.min(MODELED_HANDS, Math.floor(entity.hands_occupied)),
        );
      }

      // conditions: Vec<Condition> in snake_case; Exhaustion(u8) arrives as
      // {"exhaustion": level}. Names are kept verbatim — display code owns
      // prettifying, matching stays on the exact engine spelling.
      if (Array.isArray(entity.conditions)) {
        const names: string[] = [];
        for (const cond of entity.conditions) {
          if (typeof cond === 'string' && cond.length > 0) {
            names.push(cond);
          } else if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
            for (const k of Object.keys(cond as Record<string, unknown>)) names.push(k);
          }
        }
        if (names.length > 0) status.conditions = names;
      }

      if (
        status.inspiration !== undefined ||
        status.handsOccupied !== undefined ||
        status.conditions !== undefined
      ) {
        byEntity[key] = status;
      }
    }
  }

  const grappleHolders: Record<string, string> = {};
  if (rawHolders) {
    for (const [escaper, holder] of Object.entries(rawHolders)) {
      if (typeof holder === 'string' && holder.length > 0) grappleHolders[escaper] = holder;
    }
  }

  return { byEntity, grappleHolders };
}

/**
 * Two inked pips for the hands tracker, `true` = occupied. Empty array when
 * the projection did not expose `hands_occupied` (no render — never "both
 * hands free") and for any out-of-domain value.
 */
export function handsPips(status: EntityCombatStatus | null | undefined): boolean[] {
  const occupied = status?.handsOccupied;
  if (typeof occupied !== 'number' || !Number.isFinite(occupied)) return [];
  const clamped = Math.max(0, Math.min(MODELED_HANDS, Math.floor(occupied)));
  return Array.from({ length: MODELED_HANDS }, (_, i) => i < clamped);
}

/**
 * Human label for the hands tracker, or null when the field was not exposed.
 * Zero reads "free" (the common case deserves the friendly wording); anything
 * above reports the count against MODELED_HANDS.
 */
export function formatHandsLabel(status: EntityCombatStatus | null | undefined): string | null {
  const occupied = status?.handsOccupied;
  if (typeof occupied !== 'number' || !Number.isFinite(occupied)) return null;
  const clamped = Math.max(0, Math.min(MODELED_HANDS, Math.floor(occupied)));
  return clamped === 0 ? 'Hands free' : `Hands ${clamped}/${MODELED_HANDS} occupied`;
}

/**
 * Ids of the creatures holding THIS entity, from the session's hold
 * attribution. Empty when the entity is not grappled, when the projection did
 * not expose `grapple_holders`, or when the hold stamp is missing — an escape
 * action needs a named grappler, so "grappled but holder unknown" renders the
 * condition without offering the button.
 */
export function grappledBy(
  status: EntityCombatStatus | null | undefined,
  grappleHolders: Record<string, string>,
  entityId: string | undefined,
): string[] {
  if (!status?.conditions?.includes('grappled') || !entityId) return [];
  const holder = grappleHolders[entityId];
  return typeof holder === 'string' && holder.length > 0 ? [holder] : [];
}
