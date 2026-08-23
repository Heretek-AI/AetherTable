/**
 * Campaign persistence API client.
 *
 * Save/load snapshots against the orchestrator's Postgres-backed store.
 * Every helper resolves null when the server or auth token is unavailable
 * so callers can surface a friendly offline message instead of throwing.
 */

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

const getToken = (): string | null => sessionStorage.getItem('aethertable_token');

async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const resp = await fetch(path);
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
  const token = getToken();
  if (!token) return null;
  return post<CampaignSaveMeta>('/api/v1/campaign/save', {
    token,
    name,
    snapshot,
    round_number: snapshot.roundNumber,
  });
}

export async function listSaves(): Promise<CampaignSaveMeta[]> {
  const token = getToken();
  if (!token) return [];
  const data = await get<{ saves: CampaignSaveMeta[] }>(
    `/api/v1/campaign/saves?token=${encodeURIComponent(token)}`
  );
  return data?.saves ?? [];
}

export async function loadCampaign(
  saveId: string
): Promise<CampaignSnapshot | null> {
  const token = getToken();
  if (!token) return null;
  const data = await get<{ snapshot: CampaignSnapshot }>(
    `/api/v1/campaign/save/${saveId}?token=${encodeURIComponent(token)}`
  );
  return data?.snapshot ?? null;
}

export async function deleteSave(saveId: string): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  try {
    const resp = await fetch(
      `/api/v1/campaign/save/${saveId}?token=${encodeURIComponent(token)}`,
      { method: 'DELETE' }
    );
    return resp.ok;
  } catch {
    return false;
  }
}
