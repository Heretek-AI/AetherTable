/**
 * Campaign persistence API client.
 *
 * Save/load snapshots against the orchestrator's Postgres-backed store.
 * Every helper resolves null when the server or auth token is unavailable
 * so callers can surface a friendly offline message instead of throwing.
 */

import { authHeaders, getStoredToken } from './auth_headers';

export interface CampaignSaveMeta {
  save_id: string;
  save_name: string;
  round_number: number;
  updated_at: string;
}

export interface CampaignSnapshot {
  tokens: unknown[];
  customWalls: { x: number; y: number }[];
  messages: unknown[];
  roundNumber: number;
  currentTurnIndex: number;
  spotlightWeights: Record<string, number>;
}

const getToken = getStoredToken;

// Identity rides the Authorization header (never the URL — query-string tokens
// leak into access logs); the gateway also accepts ?token= for back-compat.
async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    console.warn('[CampaignStore] Server unavailable.');
    return null;
  }
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(path, { headers: authHeaders() });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    console.warn('[CampaignStore] Server unavailable.');
    return null;
  }
}

export async function saveCampaign(
  name: string,
  snapshot: CampaignSnapshot
): Promise<CampaignSaveMeta | null> {
  if (!getToken()) return null;
  return post<CampaignSaveMeta>('/api/v1/campaign/save', {
    name,
    snapshot,
    round_number: snapshot.roundNumber,
  });
}

export async function listSaves(): Promise<CampaignSaveMeta[]> {
  if (!getToken()) return [];
  const data = await get<{ saves: CampaignSaveMeta[] }>('/api/v1/campaign/saves');
  return data?.saves ?? [];
}

/** Result of a server-side GM autosave: the snapshot was captured from the
 * live engine (never client state) and stored as an ordinary campaign save. */
export interface CampaignAutosaveResult {
  save_id: string;
  round: number;
  captured_at: string;
}

/**
 * GM-only autosave: asks the orchestrator to snapshot LIVE engine state for
 * `sessionId` through its existing save path. Unlike saveCampaign, no client
 * snapshot is sent — the server fetches authoritative state itself, so this
 * is safe to fire on a timer or at turn boundaries.
 *
 * Resolves null when unauthenticated, the caller is not a GM (403), or the
 * engine is unreachable (502) — callers surface those states, not throw.
 */
export async function gmAutosave(
  sessionId: string,
  name?: string
): Promise<CampaignAutosaveResult | null> {
  if (!getToken()) return null;
  const body = { session_id: sessionId, ...(name ? { name } : {}) };
  return post<CampaignAutosaveResult>('/api/v1/campaign/autosave', body);
}

export async function loadCampaign(
  saveId: string
): Promise<CampaignSnapshot | null> {
  if (!getToken()) return null;
  const data = await get<{ snapshot: CampaignSnapshot }>(
    `/api/v1/campaign/save/${encodeURIComponent(saveId)}`
  );
  return data?.snapshot ?? null;
}

export async function deleteSave(saveId: string): Promise<boolean> {
  if (!getToken()) return false;
  try {
    const resp = await fetch(`/api/v1/campaign/save/${encodeURIComponent(saveId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
