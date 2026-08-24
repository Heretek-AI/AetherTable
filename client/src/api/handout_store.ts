/**
 * Handout persistence API client (real backend surface).
 *
 * Mirrors lobby_store conventions: every helper resolves null/[] when
 * unauthenticated or offline so the UI can fall back to demo behavior
 * instead of throwing.
 *
 * Role visibility is enforced server-side: a player/spectator token sees
 * only handouts revealed to 'all' or 'party'; gm_only rows are filtered out
 * of listings and direct GETs return 404 (no existence oracle).
 */

import { authHeaders, getStoredToken } from './auth_headers';

/** Who may see a handout. 'party' hides it from spectators; 'gm_only' from everyone but GM/admin. */
export type RevealedTo = 'all' | 'party' | 'gm_only';

export interface Handout {
  handout_id: string;
  campaign_id: string | null;
  lobby_id: string | null;
  title: string;
  content_md: string;
  revealed_to: RevealedTo;
  created_by: string;
  created_at: number | string;
}

export interface HandoutCreateInput {
  title: string;
  content_md?: string;
  revealed_to?: RevealedTo;
  campaign_id?: string | null;
  lobby_id?: string | null;
}

export interface HandoutUpdateInput {
  title?: string;
  content_md?: string;
  revealed_to?: RevealedTo;
  campaign_id?: string | null;
  lobby_id?: string | null;
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

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function createHandout(input: HandoutCreateInput): Promise<Handout | null> {
  if (!getToken()) return null;
  return req<Handout>('/api/v1/handouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revealed_to: 'all',
      ...input,
    }),
  });
}

/**
 * List handouts, optionally scoped to one campaign. Rows the caller's role
 * cannot see are already absent from the response — no client-side filtering
 * needed (and none possible: the server omits them entirely).
 */
export async function listHandouts(campaignId?: string): Promise<Handout[]> {
  if (!getToken()) return [];
  const data = await req<{ total: number; handouts: Handout[] }>(
    withQuery('/api/v1/handouts', { campaign_id: campaignId })
  );
  return data?.handouts ?? [];
}

/** Fetch one handout in full; null when missing, foreign, or role-hidden (all 404). */
export async function fetchHandout(handoutId: string): Promise<Handout | null> {
  if (!getToken()) return null;
  return req<Handout>(`/api/v1/handouts/${encodeURIComponent(handoutId)}`);
}

/** Partial update; only supplied fields change. Null on failure or lack of permission. */
export async function updateHandout(
  handoutId: string,
  patch: HandoutUpdateInput
): Promise<Handout | null> {
  if (!getToken()) return null;
  return req<Handout>(`/api/v1/handouts/${encodeURIComponent(handoutId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** Delete a handout you authored (or any, as GM). Returns false on failure. */
export async function deleteHandout(handoutId: string): Promise<boolean> {
  if (!getToken()) return false;
  const resp = await req<{ status: string }>(
    `/api/v1/handouts/${encodeURIComponent(handoutId)}`,
    { method: 'DELETE' }
  );
  return resp?.status === 'deleted';
}
