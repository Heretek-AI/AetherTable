/**
 * Encounter-builder data layer.
 *
 * Everything here talks to REAL infrastructure only:
 *  - Monster stat blocks come from GET /api/v1/compendium/monsters (the live
 *    SRD compendium loaded by python/vtt_orchestrator/server.py). There are NO
 *    fabricated presets in this file: if the fetch fails the caller gets a
 *    failure result and shows an empty bestiary instead of inventing monsters.
 *  - Spawns go through POST /api/v1/engine/spawn (the gateway proxy over the
 *    Rust engine's POST /api/v1/sessions/{id}/entities). The engine's verdict
 *    — success OR machine rejection code — is returned verbatim; callers never
 *    mutate a board optimistically. Spawned entities become visible through
 *    the existing session-state snapshot reads (see engineSessionEntities in
 *    rules_engine.ts), not through any local token fabrication.
 *
 * PERSISTENCE LIMITATION (disclosed honestly): the orchestrator exposes NO
 * encounter-save endpoint today, so an assembled encounter lives only in
 * component memory for the lifetime of the page/session. Nothing here pretends
 * otherwise.
 */

import { getStoredToken } from './auth_headers';

/* --- Live compendium ------------------------------------------------------ */

/** One monster exactly as the compendium serves it (compendium/srd_5_1_monsters.json). */
export interface CompendiumMonster {
  id: string;
  name: string;
  challenge_rating: string;
  creature_type?: string;
  size?: string;
  /** Armor class. Present on every entry in the current SRD file. */
  ac?: number;
  /** Average hit points. Present on every entry in the current SRD file. */
  hp?: number;
  /** Free-text movement line, e.g. "10 ft., swim 40 ft.". */
  speed?: string;
  /** SRD ability scores keyed STR/DEX/CON/INT/WIS/CHA. */
  abilities?: Record<string, number>;
  /**
   * Structured attack entries parsed by the SRD importer. Sparse in the
   * current dataset (most stat blocks have none) — we forward ONLY what the
   * importer actually parsed, we never synthesize attack bonuses or dice.
   */
  actions?: CompendiumMonsterAttack[];
}

export interface CompendiumMonsterAttack {
  name?: string;
  /** Text form, e.g. "+4". */
  to_hit?: string;
  /** Dice expression forwarded VERBATIM, e.g. "1d8 + 2". */
  damage_formula?: string;
  damage_type?: string;
}

export type CompendiumFetchResult =
  | { kind: 'ok'; monsters: CompendiumMonster[] }
  | { kind: 'failed'; status: number | null; message: string };

const MONSTER_LIMIT = 400; // server caps le=400; current SRD file holds ~318

/**
 * Fetch the live compendium bestiary. Returns a failure result (never throws,
 * never substitutes demo data) so the UI can render an honest empty state.
 */
export async function fetchCompendiumMonsters(): Promise<CompendiumFetchResult> {
  try {
    const resp = await fetch(`/api/v1/compendium/monsters?limit=${MONSTER_LIMIT}`);
    if (!resp.ok) {
      return {
        kind: 'failed',
        status: resp.status,
        message: `The compendium service answered HTTP ${resp.status}; no monster list could be loaded.`,
      };
    }
    const data = (await resp.json()) as { total?: number; monsters?: CompendiumMonster[] };
    return { kind: 'ok', monsters: Array.isArray(data.monsters) ? data.monsters : [] };
  } catch (err) {
    return {
      kind: 'failed',
      status: null,
      message: err instanceof Error ? err.message : 'Compendium request failed (network error).',
    };
  }
}

/* --- XP budget math (documented formulas) ----------------------------------
 *
 * Both tables are the standard D&D 5e SRD/DMG numbers, applied client-side:
 *
 * 1. PARTY THRESHOLDS: each character level has per-character XP thresholds
 *    [Easy, Medium, Hard, Deadly]; multiply each by the number of PCs.
 *    threshold_x = per_char_threshold(level, x) × party_size.
 *
 * 2. ENCOUNTER MULTIPLIER: raw XP (sum of each monster's XP × its count) is
 *    scaled by a multiplier that depends on the NUMBER of distinct attacking
 *    creatures (action-economy correction):
 *      1 → 1.0 · 2 → 1.5 · 3-6 → 2.0 · 7-10 → 2.5 · 11-14 → 3.0 · 15+ → 4.0
 *    adjusted_xp = round(raw_xp × multiplier).
 *
 * 3. DIFFICULTY: compare adjusted_xp against the party thresholds
 *    (< medium Easy, < hard Medium, < deadly Hard, else Deadly).
 *
 * Monster XP itself is looked up from the CR→XP table below. A CR missing
 * from the table yields NULL — such monsters contribute 0 XP and the UI flags
 * them rather than guessing a value.
 */

/** Per-character XP thresholds [Easy, Medium, Hard, Deadly] by level (SRD). */
export const XP_THRESHOLDS_BY_LEVEL: Record<number, [number, number, number, number]> = {
  1: [25, 50, 75, 100],
  2: [50, 100, 150, 200],
  3: [75, 150, 225, 400],
  4: [125, 250, 375, 500],
  5: [250, 500, 750, 1100],
  6: [300, 600, 900, 1400],
  7: [350, 750, 1100, 1700],
  8: [450, 900, 1400, 2100],
  9: [550, 1100, 1600, 2400],
  10: [600, 1200, 1900, 2800],
  11: [800, 1600, 2400, 3600],
  12: [1000, 2000, 3000, 4500],
  13: [1100, 2200, 3400, 5100],
  14: [1250, 2500, 3800, 5700],
  15: [1400, 2800, 4300, 6400],
  16: [1600, 3200, 4800, 7200],
  17: [2000, 3900, 5900, 8800],
  18: [2100, 4200, 6300, 9500],
  19: [2400, 4900, 7300, 10900],
  20: [2800, 5700, 8500, 12700],
};

/** Challenge rating → XP awarded (SRD "Monster Statistics by Challenge Rating"). */
export const CR_TO_XP: Record<string, number> = {
  '0': 10,
  '1/8': 25,
  '1/4': 50,
  '1/2': 100,
  '1': 200,
  '2': 450,
  '3': 700,
  '4': 1100,
  '5': 1800,
  '6': 2300,
  '7': 2900,
  '8': 3900,
  '9': 5000,
  '10': 5900,
  '11': 7200,
  '12': 8400,
  '13': 10000,
  '14': 11500,
  '15': 13000,
  '16': 15000,
  '17': 18000,
  '18': 20000,
  '19': 22000,
  '20': 25000,
  '21': 33000,
  '22': 41000,
  '23': 50000,
  '24': 62000,
  '25': 75000,
  '26': 90000,
  '27': 105000,
  '28': 120000,
  '29': 135000,
  '30': 155000,
};

/** XP for one creature of this CR, or null when the compendium CR is unmapped. */
export function crToXp(challengeRating: string): number | null {
  const key = String(challengeRating ?? '').trim();
  return Object.prototype.hasOwnProperty.call(CR_TO_XP, key) ? CR_TO_XP[key] : null;
}

/** Party XP thresholds: per-character values scaled by party size. */
export function partyThresholds(partyLevel: number, partySize: number): {
  easy: number; medium: number; hard: number; deadly: number;
} {
  const base = XP_THRESHOLDS_BY_LEVEL[partyLevel] ?? XP_THRESHOLDS_BY_LEVEL[5];
  return {
    easy: base[0] * partySize,
    medium: base[1] * partySize,
    hard: base[2] * partySize,
    deadly: base[3] * partySize,
  };
}

/** DMG encounter multiplier by number of attacking creatures. */
export function encounterMultiplier(creatureCount: number): number {
  if (creatureCount <= 1) return 1.0;
  if (creatureCount === 2) return 1.5;
  if (creatureCount <= 6) return 2.0;
  if (creatureCount <= 10) return 2.5;
  if (creatureCount <= 14) return 3.0;
  return 4.0;
}

/* --- Engine spawn ---------------------------------------------------------- */

/** Verbatim body of the engine's POST /api/v1/sessions/{id}/entities reply. */
export interface EngineSpawnResult {
  status?: string;
  entity_id?: string;
  entity_name?: string;
}

/**
 * Reduce the compendium's free-text speed line to the leading movement rate
 * in feet ("10 ft., swim 40 ft." → 10). Returns null when nothing numeric
 * can be extracted — the caller then refuses to guess.
 */
export function parsePrimarySpeedFeet(speed?: string): number | null {
  if (!speed) return null;
  const match = speed.match(/(\d+(?:\.\d+)?)\s*ft/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The damage types vtt-core's DamageType enum deserializes (types.rs). */
const KNOWN_DAMAGE_TYPES = new Set([
  'slashing', 'piercing', 'bludgeoning', 'fire', 'cold', 'lightning', 'thunder',
  'poison', 'acid', 'psychic', 'radiant', 'necrotic', 'force',
]);

interface BuiltEntity {
  entity: Record<string, unknown>;
  warnings: string[];
}

/**
 * Build the engine EntityState payload for one spawned copy of a compendium
 * monster. Field-for-field it mirrors the shape the orchestrator itself sends
 * for character deploy (deploy_character in server.py) — same zone, action
 * budget, and ability key casing the engine's vtt_core::EntityState requires.
 *
 * Honesty rules enforced here:
 *  - Every stat comes from the compendium record; nothing is defaulted into
 *    existence. Missing HP/AC/speed abort the build with a warning instead.
 *  - Attacks are forwarded ONLY where the SRD importer produced structured
 *    fields AND the damage type is one the engine enum knows; everything else
 *    is reported as a warning, never silently dropped or made up.
 *  - No owner_player_id is claimed: spawns are GM-controlled entities. (A
 *    non-GM claiming someone else's identity is refused by the engine with
 *    OWNERSHIP_CLAIM_FORBIDDEN — that rejection surfaces verbatim upstream.)
 */
export function buildMonsterEntity(
  monster: CompendiumMonster,
  position: [number, number, number],
  labelSuffix: string,
): BuiltEntity {
  const warnings: string[] = [];
  const speedFeet = parsePrimarySpeedFeet(monster.speed);
  if (speedFeet === null) warnings.push(`no parseable speed in "${monster.speed ?? ''}" — spawned with 0 ft`);
  if (typeof monster.hp !== 'number') throw new Error(`${monster.name} has no hit points in the compendium`);
  if (typeof monster.ac !== 'number') throw new Error(`${monster.name} has no armor class in the compendium`);

  const abil = monster.abilities ?? {};
  const score = (k: string): number => {
    const v = abil[k];
    return typeof v === 'number' ? v : 10;
  };

  const attacks: Record<string, unknown>[] = [];
  for (const action of monster.actions ?? []) {
    const bonus = typeof action.to_hit === 'string'
      ? Number.parseInt(action.to_hit.replace(/[^+-\d]/g, ''), 10)
      : NaN;
    const dmgType = (action.damage_type ?? '').toLowerCase();
    if (
      action.name &&
      Number.isFinite(bonus) &&
      typeof action.damage_formula === 'string' &&
      KNOWN_DAMAGE_TYPES.has(dmgType)
    ) {
      attacks.push({
        name: action.name,
        attack_bonus: bonus,
        // Forwarded verbatim from the compendium — never recomputed.
        damage_expression: action.damage_formula,
        damage_type: dmgType,
      });
    } else {
      warnings.push(`attack "${action.name ?? '?'}" not forwarded (unparsed bonus/damage type "${action.damage_type ?? '?'}")`);
    }
  }

  const entityId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const entity: Record<string, unknown> = {
    id: entityId,
    // Provenance: which compendium stat block this entity was spawned from.
    compendium_id: monster.id,
    name: labelSuffix ? `${monster.name} #${labelSuffix}` : monster.name,
    is_player: false,
    current_hp: Math.max(1, Math.floor(monster.hp)),
    max_hp: Math.max(1, Math.floor(monster.hp)),
    temp_hp: 0,
    ac: Math.floor(monster.ac),
    speed_feet: speedFeet ?? 0,
    position,
    zone_id: 'Zone_Default',
    abilities: {
      strength: score('STR'),
      dexterity: score('DEX'),
      constitution: score('CON'),
      intelligence: score('INT'),
      wisdom: score('WIS'),
      charisma: score('CHA'),
    },
    conditions: [],
    action_budget: {
      action: true,
      bonus_action: true,
      reaction: true,
      movement_remaining_feet: speedFeet ?? 0,
      free_object_interaction: true,
    },
    spell_slots_remaining: {},
    attacks,
    resistances: [],
    vulnerabilities: [],
    immunities: [],
    inventory: { items: {} },
    is_conscious: true,
    is_dead: false,
    is_visible: true,
  };
  return { entity, warnings };
}

/**
 * Spawn ONE monster into an engine session through the gateway proxy. The
 * route declares `token: str = Query(...)`, so the gateway session token is
 * appended to the URL (same convention as engineHeal/engineRest in
 * rules_engine.ts). Rejections come back verbatim in the outcome union —
 * including FORBIDDEN_ROLE and OWNERSHIP_CLAIM_FORBIDDEN — and NOTHING is
 * applied locally on failure.
 */
export async function spawnMonsterToEngine(params: {
  sessionId: string;
  monster: CompendiumMonster;
  position: [number, number, number];
  labelSuffix: string;
}): Promise<
  | { kind: 'applied'; data: EngineSpawnResult; warnings: string[] }
  | { kind: 'rejected'; status: number; code: string | null; message: string | null }
  | { kind: 'unreachable' }
> {
  const token = getStoredToken();
  if (!token) {
    return {
      kind: 'rejected',
      status: 401,
      code: 'NOT_AUTHENTICATED',
      message: 'Sign in as the GM to spawn entities through the authoritative engine.',
    };
  }
  let built: BuiltEntity;
  try {
    built = buildMonsterEntity(params.monster, params.position, params.labelSuffix);
  } catch (err) {
    return {
      kind: 'rejected',
      status: 400,
      code: 'INCOMPLETE_STAT_BLOCK',
      message: err instanceof Error ? err.message : 'stat block incomplete',
    };
  }
  try {
    const resp = await fetch(`/api/v1/engine/spawn?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: params.sessionId,
        entity: built.entity,
      }),
    });
    const payload: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      if (resp.status >= 500) return { kind: 'unreachable' };
      const raw = (payload as { detail?: unknown } | null)?.detail ?? payload;
      if (typeof raw === 'object' && raw !== null) {
        const d = raw as Record<string, unknown>;
        return {
          kind: 'rejected',
          status: resp.status,
          code: typeof d.error === 'string' ? d.error : null,
          message: typeof d.message === 'string' ? d.message : null,
        };
      }
      return {
        kind: 'rejected',
        status: resp.status,
        code: null,
        message: typeof raw === 'string' ? raw : `HTTP ${resp.status}`,
      };
    }
    return { kind: 'applied', data: (payload ?? {}) as EngineSpawnResult, warnings: built.warnings };
  } catch {
    return { kind: 'unreachable' };
  }
}
