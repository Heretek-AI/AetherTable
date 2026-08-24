/**
 * Lobby & character persistence API client (real backend surface).
 *
 * Every helper resolves null/[] when unauthenticated or offline so the UI can
 * fall back to demo behavior instead of throwing.
 */

import { authHeaders, getStoredToken } from './auth_headers';

/**
 * Member record as returned by the lobby detail endpoint.
 * Backend gaps (follow-up candidates): no ready flag, no latency/ping metric,
 * and no bound character per member — only these three fields exist.
 */
export interface LobbyMember {
  user_id: string;
  display_name: string;
  role: string;
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

export async function createLobby(name: string): Promise<Lobby | null> {
  if (!getToken()) return null;
  return req<Lobby>('/api/v1/lobbies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
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

export async function launchLobby(lobbyId: string): Promise<{ session_id: string } | null> {
  if (!getToken()) return null;
  return req<{ session_id: string }>(`/api/v1/lobbies/${lobbyId}/launch`, { method: 'POST' });
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
