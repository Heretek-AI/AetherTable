/**
 * Iteration 13 — client for POST /api/v1/engine/encounter/balance
 * (python/vtt_orchestrator/server.py, backed by the shared DMG model in
 * vtt_orchestrator/compendium/encounter_balance.py).
 *
 * Wire contract (iteration 12 landed the route):
 *   request  { party_level: 1..20, party_size: 1..8,
 *              monsters: [{monster_id, quantity}] }   (min 1 line)
 *   response { raw_xp, adjusted_xp, multiplier,
 *              difficulty: 'easy'|'medium'|'hard'|'deadly'|'trivial',
 *              per_monster: [{monster_id, name, xp, quantity}] }
 *
 * HONEST ERROR SURFACE — every failure mode is its own variant so the UI can
 * say exactly what happened and nothing more:
 *   - 'not_signed_in'   no session token in this browser; refused BEFORE any
 *                       network call (the gateway would 401 anyway).
 *   - 'forbidden'       authenticated but not gm/admin — the route raises
 *                       403 ENCOUNTER_BALANCE_GM_ONLY because difficulty data
 *                       leaks encounter design to players. Callers treat this
 *                       as "show nothing", not as an error banner.
 *   - 'unknown_monster' 404 whose detail literally names the id(s)
 *                       ("UNKNOWN_MONSTER_ID:<id>") — surfaced verbatim, we
 *                       never guess stats for a monster the compendium lacks.
 *   - 'rejected'        any other 4xx, message quoted verbatim.
 *   - 'unreachable'     transport failure or 5xx — no verdict was produced.
 *
 * This module NEVER computes balance locally. A client-side copy of the DMG
 * tables already exists in encounter_store.ts for instant display; the
 * authoritative verdict comes from the server's single shared table so the two
 * can be compared rather than silently diverging.
 */

import { authHeaders, getStoredToken } from './auth_headers';

/** One roster line exactly as the wire wants it. */
export interface BalanceRosterLine {
  monster_id: string;
  quantity: number;
}

/** Per-monster projection the response carries (name resolved server-side). */
export interface BalancedMonster {
  monster_id: string;
  name: string;
  xp: number;
  quantity: number;
}

export type DifficultyTier = 'trivial' | 'easy' | 'medium' | 'hard' | 'deadly';

/** Verbatim body of a successful POST /api/v1/engine/encounter/balance. */
export interface EncounterBalanceResult {
  raw_xp?: number;
  adjusted_xp?: number;
  multiplier?: number;
  difficulty?: DifficultyTier;
  per_monster?: BalancedMonster[];
}

export type EncounterBalanceOutcome =
  | { kind: 'ok'; data: EncounterBalanceResult }
  | { kind: 'empty_roster'; message: string }
  | { kind: 'not_signed_in'; message: string }
  | { kind: 'forbidden'; status: number; message: string | null }
  | { kind: 'unknown_monster'; status: number; monsterIds: string[]; message: string | null }
  | { kind: 'rejected'; status: number; message: string | null }
  | { kind: 'unreachable' };

/**
 * Pull every monster id named by the gateway's 404 detail(s). FastAPI wraps
 * HTTPException payloads as {detail: "..."}; the route formats the refusal as
 * UNKNOWN_MONSTER_ID:<id>. A validation-style array body (422) yields [].
 */
export function unknownMonsterIdsFrom(payload: unknown): string[] {
  const detail = (payload as { detail?: unknown } | null)?.detail ?? payload;
  const ids: string[] = [];
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      const match = value.match(/UNKNOWN_MONSTER_ID:([^,\s"]+)/);
      if (match) ids.push(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(scan);
    }
  };
  scan(detail);
  return ids;
}

const VERBATIM_MESSAGE = (payload: unknown): string | null => {
  const raw = (payload as { detail?: unknown } | null)?.detail ?? payload;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const first = raw[0] as Record<string, unknown> | undefined;
    return typeof first?.msg === 'string' ? first.msg : null;
  }
  if (raw && typeof raw === 'object') {
    const d = raw as Record<string, unknown>;
    if (typeof d.message === 'string') return d.message;
    if (typeof d.error === 'string') return d.error;
  }
  return null;
};

/**
 * Ask the authoritative server-side DMG model for one balance verdict.
 * Bearer auth rides the Authorization header (same convention as every other
 * engine call); tokens never ride the query string.
 *
 * Bounds are clamped here too — the schema enforces party_level 1..=20 /
 * party_size 1..=8 server-side (422 otherwise), so a garbage slider value
 * becomes a well-formed request instead of a manufactured rejection.
 */
export async function balanceEncounter(
  partyLevel: number,
  partySize: number,
  roster: BalanceRosterLine[],
): Promise<EncounterBalanceOutcome> {
  const lines = roster
    .map((line) => ({
      monster_id: String(line.monster_id ?? '').trim(),
      quantity: Math.max(0, Math.floor(Number(line.quantity) || 0)),
    }))
    .filter((line) => line.monster_id.length > 0 && line.quantity > 0);

  if (lines.length === 0) {
    // Client-side short-circuit: there is no such thing as a zero-monster
    // fight (the schema rejects an empty roster with 422). Skipping the call
    // keeps dragging a quantity down to zero from spamming the endpoint.
    return { kind: 'empty_roster', message: 'No monsters in the roster.' };
  }

  const token = getStoredToken();
  if (!token) {
    return {
      kind: 'not_signed_in',
      message: 'Sign in as the GM to compute encounter balance.',
    };
  }

  let resp: Response;
  try {
    resp = await fetch('/api/v1/engine/encounter/balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        party_level: Math.min(20, Math.max(1, Math.round(Number(partyLevel) || 1))),
        party_size: Math.min(8, Math.max(1, Math.round(Number(partySize) || 1))),
        monsters: lines,
      }),
    });
  } catch {
    return { kind: 'unreachable' };
  }

  const payload: unknown = await resp.json().catch(() => null);

  if (!resp.ok) {
    if (resp.status >= 500) return { kind: 'unreachable' };
    if (resp.status === 401) {
      // Stale/expired token — same honest shape as the pre-flight refusal.
      return { kind: 'not_signed_in', message: VERBATIM_MESSAGE(payload) ?? 'Sign in required.' };
    }
    if (resp.status === 403) {
      return { kind: 'forbidden', status: 403, message: VERBATIM_MESSAGE(payload) };
    }
    if (resp.status === 404) {
      const ids = unknownMonsterIdsFrom(payload);
      if (ids.length > 0) {
        return { kind: 'unknown_monster', status: 404, monsterIds: ids, message: VERBATIM_MESSAGE(payload) };
      }
    }
    return { kind: 'rejected', status: resp.status, message: VERBATIM_MESSAGE(payload) };
  }

  return { kind: 'ok', data: (payload ?? {}) as EncounterBalanceResult };
}

/* --- Party defaults from the campaign wizard -------------------------------
 *
 * GET /api/v1/lobbies/mine returns the caller's tables including the wizard's
 * validated selections (starting_level 1..20, party_size 2..8 — see
 * storage._lobby_public). When the caller has at least one table we seed the
 * builder's sliders from the MOST RECENT one; when the endpoint is
 * unreachable / unauthenticated / answers nothing usable we fall back to
 * 4 players at level 1 and SAY SO rather than pretending the wizard ran.
 */

export interface PartyDefaults {
  level: number;
  size: number;
  /** True when seeded from a real lobby record; false when defaulted 4/1. */
  fromLobby: boolean;
}

export const FALLBACK_PARTY_DEFAULTS: PartyDefaults = { level: 1, size: 4, fromLobby: false };

interface LobbySummary {
  starting_level?: number;
  party_size?: number;
  created_at?: number | string;
}

export async function fetchPartyDefaults(): Promise<PartyDefaults> {
  try {
    const resp = await fetch('/api/v1/lobbies/mine', { headers: { ...authHeaders() } });
    if (!resp.ok) return FALLBACK_PARTY_DEFAULTS;
    const data = (await resp.json()) as { lobbies?: LobbySummary[] };
    const lobbies = Array.isArray(data?.lobbies) ? data.lobbies : [];
    const latest = lobbies[0];
    if (!latest) return FALLBACK_PARTY_DEFAULTS;
    const level = Number(latest.starting_level);
    const size = Number(latest.party_size);
    return {
      level: Number.isFinite(level) && level >= 1 && level <= 20 ? Math.round(level) : FALLBACK_PARTY_DEFAULTS.level,
      size: Number.isFinite(size) && size >= 2 && size <= 8 ? Math.round(size) : FALLBACK_PARTY_DEFAULTS.size,
      fromLobby: true,
    };
  } catch {
    return FALLBACK_PARTY_DEFAULTS;
  }
}

/* --- Debounce scheduler -----------------------------------------------------
 *
 * The builder recomputes balance whenever the roster changes — including every
 * tick of a +/- quantity button held down or a slider drag. Firing the
 * endpoint on each keystroke would hammer it with requests whose answers are
 * obsolete before they arrive. This tiny scheduler coalesces a burst of
 * schedule() calls into ONE invoke() of the LAST parameters, after the burst
 * goes quiet (classic trailing-edge debounce). It is dependency-free and
 * unit-testable with fake timers; the component wires it to balanceEncounter.
 */
export interface DebouncedBalancer<P> {
  /** Record the newest parameters and restart the quiet-period timer. */
  schedule(params: P): void;
  /** Drop any pending invocation (roster cleared, view unmounting…). */
  cancel(): void;
}

export function createDebouncedBalancer<P>(options: {
  delayMs: number;
  invoke: (params: P) => void;
}): DebouncedBalancer<P> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: P | null = null;
  const hasPending = (): boolean => timer !== null;

  return {
    schedule(params: P): void {
      pending = params;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const toRun = pending;
        pending = null;
        if (toRun !== null) options.invoke(toRun);
      }, options.delayMs);
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

export const BALANCE_DEBOUNCE_MS = 800;
