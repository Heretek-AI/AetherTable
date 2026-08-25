/**
 * Authenticated SSE narrative-stream client.
 *
 * Iteration-10 gateway hardening: POST /api/v1/orchestrator/narrative/stream
 * requires an HMAC session token (`token: str = Depends(_require_auth)` in
 * server.py) — any seat may narrate (players narrate too), but the token is
 * the model-spend gate and anonymous calls now 401. The stored token rides
 * the standard `?token=` query parameter exactly like every other
 * authenticated gateway call in this codebase (rules_engine, safety_xcard,
 * lore_store).
 *
 * This module performs the fetch with credentials and hands the caller the
 * raw Response body plus a structured failure reason; UI concerns (chat
 * message state, streaming flags) stay in App.tsx so the module boundary
 * mirrors the rest of api/*.
 */

import { getStoredToken } from './auth_headers';

/** Reason the stream could not be opened. Honest strings, not crashes. */
export type NarrativeStreamFailure =
  | { kind: 'NOT_SIGNED_IN'; detail: string }
  | { kind: 'HTTP_ERROR'; status: number; detail: string }
  | { kind: 'NO_STREAM_BODY' };

export type NarrativeStreamOpen =
  | { kind: 'OK'; body: ReadableStream<Uint8Array>; response: Response }
  | { kind: 'ERROR'; failure: NarrativeStreamFailure };

/**
 * Open the narrated-turn SSE stream with the caller's stored session token.
 * Returns a structured result so callers can render honest states instead of
 * silently stalling a "..." DM bubble forever.
 */
export async function openNarrativeStream(
  payload: {
    user_intent: string;
    engine_execution_payload: unknown;
  },
  token?: string,
): Promise<NarrativeStreamOpen> {
  const sessionToken = token ?? getStoredToken();
  if (!sessionToken) {
    return {
      kind: 'ERROR',
      failure: {
        kind: 'NOT_SIGNED_IN',
        detail:
          'Sign in first — narration requires an authenticated session (the gateway 401s anonymous streams).',
      },
    };
  }

  let resp: Response;
  try {
    resp = await fetch(
      `/api/v1/orchestrator/narrative/stream?token=${encodeURIComponent(sessionToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_intent: payload.user_intent,
          engine_execution_payload: payload.engine_execution_payload,
        }),
      },
    );
  } catch {
    // Network-level failure surfaces as a thrown TypeError upstream of here;
    // rethrow so callers keep their own catch semantics for unreachable hosts.
    throw new Error('NARRATIVE_STREAM_UNREACHABLE');
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body */
    }
    return { kind: 'ERROR', failure: { kind: 'HTTP_ERROR', status: resp.status, detail } };
  }
  if (!resp.body) {
    return { kind: 'ERROR', failure: { kind: 'NO_STREAM_BODY' } };
  }
  return { kind: 'OK', body: resp.body, response: resp };
}
