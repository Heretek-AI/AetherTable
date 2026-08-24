/**
 * Lore / epistemic-graph API client (real backend surface).
 *
 * Mirrors handout_store conventions: helpers resolve [] or null when
 * offline/unauthenticated so the UI can render honest empty states instead of
 * throwing.
 *
 * Endpoint notes (python/vtt_orchestrator/server.py):
 * - GET  /api/v1/npc/        public persona metadata (id/name/role only).
 * - POST /api/v1/lore/assert requires an HMAC session token, and unlike most
 *   routes in this gateway the token arrives as a REQUIRED QUERY PARAM
 *   (`token: str = Query(...)`), not the Authorization header. We therefore
 *   send `?token=` here; header auth alone would 422.
 *
 * Tier policy (server-enforced, never overridden client-side): every
 * assertion ENTERS at SUBJECTIVE_RUMOR; the gateway's auth model rejects any
 * higher tier with 403 LORE_TIER_FORBIDDEN when the caller is not a GM, and
 * even GM callers may only promote ONE step per call. The default tier here
 * therefore MUST be SUBJECTIVE_RUMOR — a player posting PROPOSED_FACT by
 * accident would hit 403 just for trying to commit canon.
 *
 * submit_assertion returns 200 for BOTH outcomes:
 *   { status: "REJECTED_PARADOX", reason, latency_ms }
 *   { status: "COMMITTED" | "STAGED", epistemic_tier, assigned_weight, latency_ms }
 * And 403 carries LORE_TIER_FORBIDDEN, which this client surfaces verbatim so
 * the LorePanel can render an honest "GM promotion required" state instead of
 * collapsing it into a generic rejection.
 *
 * So this client must NOT collapse responses to null like the other stores
 * do — paradox rejections and tier-forbidden 403s are real, meaningful
 * results surfaced verbatim to the UI via the AssertLoreResult union.
 */

import { getStoredToken } from './auth_headers';

export interface NpcPersona {
  id: string;
  name: string;
  role: string;
}

/** Epistemic tiers recognized by LoreAssertionPayload (schemas/models.py). */
export type EpistemicTier = 'SUBJECTIVE_RUMOR' | 'PROPOSED_FACT' | 'VALIDATED_CANON';

export interface LoreAssertOptions {
  /** Author recorded on the assertion node; defaults to 'ui_player'. */
  proposingEntityId?: string;
  /** Free-text justification; defaults to a sentence built from the triple. */
  contextSentence?: string;
  tier?: EpistemicTier;
  confidence?: number;
}

export type AssertLoreResult =
  | { outcome: 'REJECTED_PARADOX'; reason: string; latencyMs: number }
  | {
      outcome: 'COMMITTED' | 'STAGED';
      epistemicTier: EpistemicTier;
      assignedWeight: number;
      latencyMs: number;
    }
  /**
   * Server rejected the requested tier (non-GM trying to promote, or GM
   * trying to skip the staged-fact step). The gateway's detail string starts
   * with LORE_TIER_FORBIDDEN — see assert_lore in server.py. The UI uses
   * `code` to render an honest "GM promotion required" state instead of a
   * generic failure banner.
   */
  | { outcome: 'LORE_TIER_FORBIDDEN'; detail: string; requestedTier: EpistemicTier }
  /** Gateway rejected the request itself (bad token → 401, bad payload → 422). */
  | { outcome: 'ERROR'; detail: string }
  /** Network failure / backend unreachable. */
  | { outcome: 'UNREACHABLE' };

async function req<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const resp = await fetch(path, init);
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** Public listing — no token needed server-side, so none is sent. */
export async function listPersonas(): Promise<NpcPersona[]> {
  const data = await req<{ npcs: NpcPersona[] }>('/api/v1/npc/');
  return data?.npcs ?? [];
}

/**
 * Submit one subject→predicate→object triple to the epistemic graph.
 * Returns the server's verdict verbatim; never throws.
 */
export async function assertLore(
  subject: string,
  predicate: string,
  object: string,
  token?: string,
  opts?: LoreAssertOptions
): Promise<AssertLoreResult> {
  const sessionToken = token ?? getStoredToken();
  if (!sessionToken) {
    return { outcome: 'ERROR', detail: 'Sign in first — lore canon writes require an authenticated session.' };
  }

  // Server policy (assert_lore in server.py, iteration-5 hardening): every
  // assertion ENTERS at SUBJECTIVE_RUMOR; promoting above that requires a GM
  // token AND only one step per call. Defaulting to PROPOSED_FACT would 403
  // every player submission — we stage at rumor and let the GM UI promote.
  const tier = opts?.tier ?? 'SUBJECTIVE_RUMOR';
  const body = {
    proposing_entity_id: opts?.proposingEntityId ?? 'ui_player',
    subject_node_id: subject,
    predicate_relation: predicate,
    object_node_id: object,
    confidence_score: opts?.confidence ?? 0.7,
    epistemic_tier: tier,
    context_sentence:
      opts?.contextSentence ?? `${subject} ${predicate.replace(/_/g, ' ')} ${object}.`,
  };

  try {
    // Token rides the query string because that is where THIS endpoint reads it.
    const resp = await fetch(`/api/v1/lore/assert?token=${encodeURIComponent(sessionToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const err = (await resp.json()) as { detail?: unknown };
        if (typeof err.detail === 'string') detail = err.detail;
        else if (err.detail != null) detail = JSON.stringify(err.detail);
      } catch {
        /* keep HTTP-status fallback */
      }
      // LORE_TIER_FORBIDDEN is its own outcome so the LorePanel can render
      // an honest "GM promotion required" banner instead of a generic error.
      if (resp.status === 403 && typeof detail === 'string' && detail.startsWith('LORE_TIER_FORBIDDEN')) {
        return { outcome: 'LORE_TIER_FORBIDDEN', detail, requestedTier: tier };
      }
      return { outcome: 'ERROR', detail };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const status = data.status;

    if (status === 'REJECTED_PARADOX') {
      return {
        outcome: 'REJECTED_PARADOX',
        reason: String(data.reason ?? 'No reason provided by the graph.'),
        latencyMs: Number(data.latency_ms ?? 0),
      };
    }
    if (status === 'COMMITTED' || status === 'STAGED') {
      return {
        outcome: status,
        epistemicTier: (data.epistemic_tier as EpistemicTier) ?? tier,
        assignedWeight: Number(data.assigned_weight ?? 0),
        latencyMs: Number(data.latency_ms ?? 0),
      };
    }
    return { outcome: 'ERROR', detail: `Unexpected response status: ${JSON.stringify(status)}` };
  } catch (e) {
    console.warn('Lore assert endpoint unreachable:', e);
    return { outcome: 'UNREACHABLE' };
  }
}
