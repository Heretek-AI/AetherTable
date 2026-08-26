/**
 * Lobby & character persistence API client (real backend surface).
 *
 * Every helper resolves null/[] when unauthenticated or offline so the UI can
 * fall back to demo behavior instead of throwing.
 */

import { authHeaders, getStoredToken } from './auth_headers';

/**
 * Member record as returned by the lobby detail endpoint (iteration-33+).
 *
 * Remaining backend gap: no latency/ping metric per seat.
 */
export interface LobbyMember {
  user_id: string;
  display_name: string;
  role: string;
  /** True once the member has readied up (POST /lobbies/{id}/ready). */
  ready: boolean;
  /** The member's bound character sheet id, or null before they pick one. */
  selected_character_id: string | null;
}

/** A seat the launch gate refused for: listed by id AND display name. */
export interface UnreadyMember {
  user_id: string;
  display_name: string;
}

export interface Lobby {
  lobby_id: string;
  invite_code: string;
  name: string;
  host_user_id: string;
  engine_session_id: string | null;
  members: LobbyMember[];
}

const getToken = getStoredToken;

async function req<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    // Identity rides the Authorization header (never the URL — query-string
    // tokens leak into access logs); the gateway also accepts ?token= for
    // back-compat with older clients.
    const resp = await fetch(path, {
      ...init,
      headers: { ...authHeaders(), ...(init?.headers ?? {}) },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Optional table selections the gateway accepts on lobby create (iteration
 * 71+). All three are validated server-side — rule_version must be one of the
 * SRD literals, starting_level 1..20, party_size 2..8 (422 otherwise) — so
 * callers must only send values they mean.
 */
export interface LobbyCreateOptions {
  rule_version?: 'srd_5_1' | 'srd_5_2';
  starting_level?: number;
  party_size?: number;
}

/**
 * Create payload: either a bare table name (the legacy `{ name }` contract,
 * still accepted by every gateway that serves this endpoint) or a full object
 * carrying the optional selections alongside it.
 */
export type LobbyCreateInput = string | ({ name: string } & LobbyCreateOptions);

export async function createLobby(input: LobbyCreateInput): Promise<Lobby | null> {
  if (!getToken()) return null;
  const body = typeof input === 'string' ? { name: input } : input;
  return req<Lobby>('/api/v1/lobbies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function joinLobby(lobbyId: string, inviteCode: string): Promise<Lobby | null> {
  if (!getToken()) return null;
  return req<Lobby>(`/api/v1/lobbies/${lobbyId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: inviteCode }),
  });
}

export async function fetchLobby(lobbyId: string): Promise<Lobby | null> {
  if (!getToken()) return null;
  return req<Lobby>(`/api/v1/lobbies/${lobbyId}`);
}

/**
 * Toggle the CALLING member's ready flag. Returns the refreshed roster so the
 * UI can render live synchrony from one response, or null when signed out,
 * offline, or refused (403 non-member / 404 unknown lobby).
 */
export async function setMemberReady(lobbyId: string, ready: boolean): Promise<Lobby | null> {
  if (!getToken()) return null;
  return req<Lobby>(`/api/v1/lobbies/${lobbyId}/ready`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ready }),
  });
}

/**
 * Bind one of the caller's OWN characters to their lobby seat. The gateway
 * refuses a foreign (but real) sheet with 403 and an unknown id with 404 —
 * both surface here as null rather than an exception.
 */
export async function setMemberCharacter(
  lobbyId: string,
  characterId: string
): Promise<Lobby | null> {
  if (!getToken()) return null;
  return req<Lobby>(`/api/v1/lobbies/${lobbyId}/character`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character_id: characterId }),
  });
}

/**
 * Filter a character list down to sheets owned by `userId`. The lobby seat's
 * character selector must offer ONLY the signed-in user's own characters — the
 * gateway rejects any other bind with 403, and offering foreign sheets in the
 * dropdown would just manufacture that refusal for every click.
 */
export function ownedCharacters(
  roster: StoredCharacter[],
  userId: string | null | undefined
): StoredCharacter[] {
  if (!userId) return [];
  return roster.filter((c) => !!c && c.owner_user_id === userId);
}

/**
 * Structured launch result. Unlike the other helpers this does NOT collapse
 * every failure to null: a 409 MEMBERS_NOT_READY is world state (who is not
 * ready), not an error, and the UI must show those names honestly.
 */
export type LaunchResult =
  | { outcome: 'LAUNCHED'; sessionId: string }
  | { outcome: 'MEMBERS_NOT_READY'; message: string; unreadyMembers: UnreadyMember[] }
  | { outcome: 'NOT_ALLOWED'; detail: string }
  /** Signed out, offline, or an unmapped failure (null means "no signal"). */
  | { outcome: 'ERROR' }
  | null;

function normalizeUnready(raw: unknown): UnreadyMember[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => ({
      user_id: String(m.user_id ?? ''),
      display_name: String(m.display_name ?? m.user_id ?? ''),
    }))
    .filter((m) => m.user_id !== '');
}

export async function launchLobby(
  lobbyId: string,
  opts?: { force?: boolean }
): Promise<LaunchResult> {
  if (!getToken()) return null;
  try {
    // An absent body keeps force=false server-side; only an explicit override
    // sends {"force": true}.
    const init: RequestInit = { method: 'POST', headers: authHeaders() };
    if (opts?.force) {
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
      init.body = JSON.stringify({ force: true });
    }
    const resp = await fetch(`/api/v1/lobbies/${lobbyId}/launch`, init);
    if (resp.ok) {
      const data = (await resp.json()) as { session_id?: string };
      return data?.session_id
        ? { outcome: 'LAUNCHED', sessionId: data.session_id }
        : { outcome: 'ERROR' };
    }
    const payload = await resp.json().catch(() => null);
    // FastAPI wraps HTTPException(detail=dict) verbatim in {"detail": {...}}.
    const detail = (payload as { detail?: unknown } | null)?.detail;
    if (
      resp.status === 409 &&
      detail &&
      typeof detail === 'object' &&
      (detail as { error?: string }).error === 'MEMBERS_NOT_READY'
    ) {
      return {
        outcome: 'MEMBERS_NOT_READY',
        message:
          typeof (detail as { message?: unknown }).message === 'string'
            ? (detail as { message: string }).message
            : 'Some members are not ready.',
        unreadyMembers: normalizeUnready((detail as { unready_members?: unknown }).unready_members),
      };
    }
    if (resp.status === 403) {
      return {
        outcome: 'NOT_ALLOWED',
        detail:
          typeof detail === 'string'
            ? detail
            : 'Only the host can launch this table.',
      };
    }
    return { outcome: 'ERROR' };
  } catch {
    return null;
  }
}

// --- Characters ---------------------------------------------------------------

export interface StoredCharacter {
  character_id: string;
  owner_user_id: string;
  name: string;
  character_class: string;
  level: number;
}

/** Uppercase ability score map as persisted by the builder's saveCharacter payload. */
export type AbilityScoreMap = Partial<Record<'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA', number>>;

/**
 * Full record as returned by GET /api/v1/characters/{id}. The list endpoint
 * strips the `data` blob, so callers wanting abilities/hp/ac must fetch by id.
 */
export interface FullStoredCharacter extends StoredCharacter {
  data?: {
    race?: string;
    abilities?: AbilityScoreMap;
    hp?: number;
    max_hp?: number;
    ac?: number;
    speed?: number;
    [key: string]: unknown;
  };
}

export async function saveCharacter(sheet: Record<string, unknown>): Promise<StoredCharacter | null> {
  if (!getToken()) return null;
  return req<StoredCharacter>('/api/v1/characters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sheet),
  });
}

export async function listCharacters(): Promise<StoredCharacter[]> {
  if (!getToken()) return [];
  const data = await req<{ characters: StoredCharacter[] }>('/api/v1/characters');
  return data?.characters ?? [];
}

/** Fetch one character's full record, including the persisted sheet `data` blob. */
export async function getCharacter(characterId: string): Promise<FullStoredCharacter | null> {
  if (!getToken()) return null;
  return req<FullStoredCharacter>(`/api/v1/characters/${encodeURIComponent(characterId)}`);
}

/**
 * Resolve a deployed token back to its stored character record (matched by
 * name), hydrating the full sheet data. Returns null when unauthenticated,
 * offline, or when no owned character carries that name.
 */
export async function findCharacterForToken(tokenName: string): Promise<FullStoredCharacter | null> {
  const roster = await listCharacters();
  if (roster.length === 0) return null;
  const meta =
    roster.find((c) => c.name === tokenName) ??
    roster.find((c) => c.name.toLowerCase() === tokenName.toLowerCase());
  if (!meta) return null;
  return getCharacter(meta.character_id);
}

/**
 * Outcome surface for DELETE /api/v1/characters/{id}. Mirrors the
 * discriminated-union style used by api/encounter_balance_store.ts so the
 * view can render every gateway branch verbatim instead of fabricating a
 * one-sentence "could not delete" disjunction:
 *  - `ok`               gateway returned 200 with `{"status": "DELETED"}`
 *  - `not_signed_in`    no session token; nothing was sent on the wire
 *  - `forbidden`        403 — caller authenticated but does not own the id
 *  - `not_found`        404 — id is unknown to this owner (the gateway
 *                       intentionally collapses "not yours" into "not found"
 *                       so a foreign probe cannot probe ownership via 403/404)
 *  - `rejected`         any other 4xx (422 schema validation, etc.) — the
 *                       gateway's verbatim detail is rendered to the user
 *  - `unreachable`      fetch threw (offline) or 5xx — no verdict was produced
 */
export type DeleteCharacterOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_signed_in'; detail: string }
  | { outcome: 'forbidden'; status: number; detail: string }
  | { outcome: 'not_found'; status: number; detail: string }
  | { outcome: 'rejected'; status: number; detail: string }
  | { outcome: 'unreachable'; detail: string };

/**
 * Extract the gateway's verbatim error string from a FastAPI
 * HTTPException-wrapped body. Same shape used by encounter_balance_store
 * (`VERBATIM_MESSAGE`) and lore_store: a plain string lands verbatim; a
 * validation array yields its first `.msg`; an object envelope yields
 * `message` / `error`; everything else returns null so the caller falls
 * back to the HTTP-status summary.
 */
function extractErrorDetail(payload: unknown): string | null {
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
}

/**
 * Permanently delete one of the caller's OWN characters. Mirrors the gateway's
 * DELETE /api/v1/characters/{id} ownership contract: a valid token that does
 * not own the id is collapsed into 404 "not found for this owner" server-side
 * (so foreign probes cannot enumerate via 403/404 distinction). Every branch
 * surfaces its own discriminated outcome; nothing throws and nothing is
 * collapsed into a bare boolean.
 */
export async function deleteCharacter(characterId: string): Promise<DeleteCharacterOutcome> {
  if (!getToken()) {
    return {
      outcome: 'not_signed_in',
      detail: 'Sign in first — character deletion requires an authenticated seat.',
    };
  }

  let resp: Response;
  try {
    resp = await fetch(
      `/api/v1/characters/${encodeURIComponent(characterId)}`,
      { method: 'DELETE', headers: authHeaders() }
    );
  } catch (e) {
    console.warn('Delete-character endpoint unreachable:', e);
    return { outcome: 'unreachable', detail: 'Could not reach the gateway.' };
  }

  if (!resp.ok) {
    const payload = await resp.json().catch(() => null);
    const verbatim = extractErrorDetail(payload);
    const fallback = `HTTP ${resp.status}`;
    if (resp.status === 401) {
      // Expired / cleared token — collapse to not_signed_in so the view can
      // route to the same honest "sign in" copy as the pre-flight refusal.
      return { outcome: 'not_signed_in', detail: verbatim ?? fallback };
    }
    if (resp.status === 403) {
      return { outcome: 'forbidden', status: 403, detail: verbatim ?? fallback };
    }
    if (resp.status === 404) {
      return { outcome: 'not_found', status: 404, detail: verbatim ?? fallback };
    }
    if (resp.status >= 500) {
      return { outcome: 'unreachable', detail: verbatim ?? fallback };
    }
    return { outcome: 'rejected', status: resp.status, detail: verbatim ?? fallback };
  }

  // 200 — only "DELETED" counts; anything else (e.g. an unexpected envelope)
  // is reported as a rejection so callers don't silently invent a deletion.
  let payload: { status?: unknown } | null = null;
  try {
    payload = (await resp.json()) as { status?: unknown };
  } catch {
    payload = null;
  }
  if (payload?.status === 'DELETED') {
    return { outcome: 'ok' };
  }
  return {
    outcome: 'rejected',
    status: resp.status,
    detail:
      payload?.status == null
        ? 'Gateway did not confirm DELETED.'
        : `Gateway status: ${String(payload.status)}.`,
  };
}

export async function deployCharacter(
  characterId: string,
  sessionId: string,
  x = 5,
  y = 5
): Promise<{ entity_id: string; owner_player_id: string } | null> {
  if (!getToken()) return null;
  return req(`/api/v1/characters/${characterId}/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, x, y }),
  });
}

export async function listMyLobbies(): Promise<Lobby[]> {
  if (!getToken()) return [];
  const data = await req<{ lobbies: Lobby[] }>('/api/v1/lobbies/mine');
  return data?.lobbies ?? [];
}
