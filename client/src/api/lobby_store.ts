/**
 * Lobby & character persistence API client (real backend surface).
 *
 * Every helper resolves null/[] when unauthenticated or offline so the UI can
 * fall back to demo behavior instead of throwing.
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

const getToken = (): string | null => sessionStorage.getItem('aethertable_token');

async function req<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const resp = await fetch(path, init);
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

function withToken(path: string): string {
  const token = getToken();
  return token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path;
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
  return req<Lobby>(withToken(`/api/v1/lobbies/${lobbyId}`));
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
  const data = await req<{ characters: StoredCharacter[] }>(withToken('/api/v1/characters'));
  return data?.characters ?? [];
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
  const data = await req<{ lobbies: Lobby[] }>(withToken('/api/v1/lobbies/mine'));
  return data?.lobbies ?? [];
}
