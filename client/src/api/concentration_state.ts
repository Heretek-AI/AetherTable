/**
 * Iteration 58 — pure parser/formatter for the ConcentrationBadge surface.
 *
 * The browser has no opinion on concentration math. `vtt-core` owns the SRD
 * rule (one spell at a time, CON save vs DC = max(10, damage/2), replacement
 * on recast — see crates/vtt-core/src/rules.rs) and `vtt-server` serialises
 * its result additively into action responses:
 *
 *   - Per-entity active concentration is mirrored verbatim into session-state
 *     projections: `entities[id].concentration = { spell_id, started_round }`
 *     (see `ConcentrationState` in crates/vtt-core/src/state.rs).
 *   - Damage-triggered checks ride along on POST /api/v1/sessions/{id}/turn/next
 *     (and any attack response) as either `concentration_check` (singular) or
 *     `concentration_checks` (plural). The Rust `ConcentrationCheckOutcome`
 *     (`crates/vtt-server/src/server.rs`) carries `{dc, total, passed,
 *     broken}`, but the parser here also tolerates `natural_roll`,
 *     `concentration_maintained`, `success`, `caster_id`/`target_id` aliases
 *     so existing fixtures keep working.
 *
 * Everything in this module is pure. It never casts dice, never invents an
 * outcome, and never trusts a number it did not parse from the response.
 */

export interface ConcentrationInfo {
  spellId?: string;
  startedRound?: number;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const asBool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : undefined;

/**
 * Parse the per-entity concentration map out of an engine session-state
 * response body. Returns an empty map for anything that is not the documented
 * `{ entities: { id -> { concentration: { spell_id, started_round } } } }`
 * shape — failure here never throws, because every caller renders an empty
 * map as "no concentration" rather than as a crash.
 */
export function parseConcentrationFromSessionState(
  raw: unknown,
): Record<string, ConcentrationInfo> {
  const top = asRecord(raw);
  const entities = top ? asRecord(top.entities) : null;
  if (!entities) return {};

  const out: Record<string, ConcentrationInfo> = {};
  for (const [key, entityRaw] of Object.entries(entities)) {
    const entity = asRecord(entityRaw);
    if (!entity) continue;
    const conc = asRecord(entity.concentration);
    if (!conc) continue;
    const spellId = asString(conc.spell_id);
    const startedRound = asNumber(conc.started_round);
    // An empty object reveals nothing usable; skip rather than emit a record
    // that would still look "actively concentrating" to the renderer.
    if (spellId === undefined && startedRound === undefined) continue;
    out[key] = { spellId, startedRound };
  }
  return out;
}

/** One raw save disclosure from a turn / attack response body. */
export interface RawConcentrationSave {
  entityId?: string;
  naturalRoll?: number;
  total?: number;
  dc?: number;
  /** undefined = the response did not say; rendered as "reported", not guessed. */
  maintained?: boolean;
  broken?: boolean;
}

const MAINTENANCE_KEYS = ['maintained', 'concentration_maintained', 'success', 'passed'];

/**
 * Walk an arbitrary response body and pull every concentration-check field it
 * carried. Supports the singular `concentration_check` (one check fired) and
 * plural `concentration_checks` (multiple) forms the engine emits additively;
 * drops entries that have neither a subject nor any numbers.
 */
export function extractConcentrationSaves(raw: unknown): RawConcentrationSave[] {
  const top = asRecord(raw);
  if (!top) return [];

  const collect = (entry: unknown): RawConcentrationSave | null => {
    const o = asRecord(entry);
    if (!o) return null;
    const entityId = asString(
      o.entity_id ?? o.target_id ?? o.caster_id ?? o.entityId,
    );
    const naturalRoll = asNumber(o.natural_roll ?? o.natural ?? o.roll);
    const total = asNumber(o.total);
    const dc = asNumber(o.dc);
    if (!entityId && naturalRoll === undefined && total === undefined && dc === undefined) {
      return null;
    }
    let maintained: boolean | undefined;
    for (const k of MAINTENANCE_KEYS) {
      const v = asBool(o[k]);
      if (v !== undefined) {
        maintained = v;
        break;
      }
    }
    const broken = asBool(o.broken);
    return { entityId, naturalRoll, total, dc, maintained, broken };
  };

  const fromList = (list: unknown): RawConcentrationSave[] =>
    Array.isArray(list)
      ? list.map(collect).filter((e): e is RawConcentrationSave => e !== null)
      : [];

  const plural = fromList(top.concentration_checks);
  if (plural.length > 0) return plural;
  const singular = collect(top.concentration_check);
  return singular ? [singular] : [];
}

/**
 * Render one disclosure as a single chat/toast line. Renders ONLY fields the
 * response carried; missing numbers are omitted, missing verdicts become
 * "outcome reported" rather than a fabricated pass/fail. Returns null when
 * the entry has nothing usable (so callers can drop it).
 */
export function formatConcentrationSaveLine(
  save: RawConcentrationSave | null | undefined,
  resolveName: (entityId?: string) => string | undefined,
): string | null {
  if (!save) return null;
  const hasAnything =
    save.entityId !== undefined ||
    save.naturalRoll !== undefined ||
    save.total !== undefined ||
    save.dc !== undefined ||
    save.maintained !== undefined ||
    save.broken !== undefined;
  if (!hasAnything) return null;

  const name = save.entityId
    ? resolveName(save.entityId) ?? save.entityId
    : 'unknown combatant';

  const parts: string[] = [`✦ ${name}'s concentration save`];
  if (save.naturalRoll !== undefined) parts.push(`d20 ${save.naturalRoll}`);
  if (save.total !== undefined) parts.push(`total ${save.total}`);
  if (save.dc !== undefined) parts.push(`DC ${save.dc}`);
  parts.push(
    save.maintained === true
      ? '— HELD'
      : save.maintained === false || save.broken === true
      ? '— BROKEN'
      : '— outcome reported',
  );
  return parts.join(' · ');
}
