/**
 * Safety X-card client (real backend surface).
 *
 * Iteration-5 gateway hardening: POST /api/v1/safety/x-card now requires an
 * HMAC session token (`token: str = Depends(_require_auth)` in server.py) and
 * 401s anonymous callers. The token rides the standard `Authorization: Bearer`
 * header — every other authenticated HTTP gateway call in this codebase uses
 * the same helper (api/auth_headers.ts), and tokens never ride the query
 * string on HTTP flows because URLs leak into proxy/access logs (WebSocket
 * clients are the documented exception).
 *
 * The response body shape is unchanged: the engine's
 * `safety_rewind`/`XCardRequest` flow returns 200 with an `engine_rewind`
 * block (see parseEngineRewind in ui/safetyXCard.ts). This module just
 * performs the fetch with credentials and surfaces the body verbatim; UI
 * parsing stays in ui/safetyXCard.ts so the module boundary mirrors the
 * rest of api/*.
 */

import { authHeaders, getStoredToken } from './auth_headers';

export interface XCardRequestBody {
  player_id: string;
  topic: string;
  current_sequence_id: number;
  engine_session_id: string | null;
}

/** Reason an authoritative post-rewind read could not be performed. */
export type SessionStateFailure =
  | { kind: 'NO_SESSION' }
  | { kind: 'NOT_SIGNED_IN' }
  | { kind: 'HTTP_ERROR'; status: number }
  | { kind: 'UNREACHABLE' };

/**
 * GET-style refetch of the authoritative session state through the gateway's
 * read proxy (POST /api/v1/engine/session-state). This is the convergence
 * fallback for the X-card rewind: when the x-card response itself carries no
 * `engine_rewind.snapshot` (older engine build), the client pulls the same
 * role-projected post-rewind state with one authenticated round trip instead
 * of drifting until the next poll.
 *
 * Returns the raw body verbatim — projection/shape parsing stays in
 * ui/safetyXCard.ts, mirroring every other api/* module boundary. Never
 * throws: failures come back as a structured kind so callers render honest
 * states and leave local tokens untouched.
 */
export async function fetchSessionState(
  sessionId: string | null | undefined,
): Promise<{ kind: 'OK'; body: unknown } | { kind: 'ERROR'; failure: SessionStateFailure }> {
  if (!sessionId) return { kind: 'ERROR', failure: { kind: 'NO_SESSION' } };
  const token = getStoredToken();
  if (!token) return { kind: 'ERROR', failure: { kind: 'NOT_SIGNED_IN' } };
  try {
    const resp = await fetch('/api/v1/engine/session-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!resp.ok) {
      return { kind: 'ERROR', failure: { kind: 'HTTP_ERROR', status: resp.status } };
    }
    return { kind: 'OK', body: await resp.json() };
  } catch (e) {
    console.warn('Session-state proxy unreachable:', e);
    return { kind: 'ERROR', failure: { kind: 'UNREACHABLE' } };
  }
}

/** Reason the caller could not record the x-card. Honest strings, not crashes. */
export type XCardFailure =
  | { kind: 'NOT_SIGNED_IN'; detail: string }
  | { kind: 'HTTP_ERROR'; status: number; detail: string }
  | { kind: 'UNREACHABLE' };

/**
 * POST an x-card intervention to the gateway with the caller's stored
 * session token in the Authorization header. Returns the parsed body on
 * success or a structured failure so callers can render honest UI states.
 */
export async function triggerXCard(
  body: XCardRequestBody,
  token?: string,
): Promise<{ kind: 'OK'; body: unknown } | { kind: 'ERROR'; failure: XCardFailure }> {
  const sessionToken = token ?? getStoredToken();
  if (!sessionToken) {
    return {
      kind: 'ERROR',
      failure: {
        kind: 'NOT_SIGNED_IN',
        detail:
          'Sign in first — the x-card endpoint requires an authenticated HMAC session token (gateway returns 401 otherwise).',
      },
    };
  }

  try {
    const resp = await fetch('/api/v1/safety/x-card', {
      method: 'POST',
      // The caller's (possibly explicitly-passed) token rides the Bearer
      // header; authHeaders() alone would ignore the override argument.
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const err = (await resp.json()) as { detail?: unknown };
        if (typeof err.detail === 'string') detail = err.detail;
        else if (err.detail != null) detail = JSON.stringify(err.detail);
      } catch {
        /* keep status fallback */
      }
      return { kind: 'ERROR', failure: { kind: 'HTTP_ERROR', status: resp.status, detail } };
    }
    const parsed = (await resp.json()) as unknown;
    return { kind: 'OK', body: parsed };
  } catch (e) {
    console.warn('X-card endpoint unreachable:', e);
    return { kind: 'ERROR', failure: { kind: 'UNREACHABLE' } };
  }
}