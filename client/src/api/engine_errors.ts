/**
 * Shared engine-rejection extraction (iteration 37, Loop 3).
 *
 * Every browsing /api/v1/engine/* proxy answers refusals through FastAPI's
 * HTTPException, so every rejection arrives wrapped as `{detail: <body>}`.
 * The bodies underneath come in several shapes, and a single honesty rule
 * applies to all of them: the machine code and the human sentence are surfaced
 * VERBATIM from whatever the answering layer actually sent — the client never
 * invents a code, and never fills in a sentence the server did not send.
 *
 *   - `{detail: {error: "FORBIDDEN_ROLE", detail: "only GMs may grant or
 *     revoke surprise"}}` — the Rust engine's `reject()` emits
 *     `{"error": code, "detail": sentence}` (crates/vtt-server/src/server.rs);
 *     the gateway forwards it verbatim under FastAPI's detail key. The human
 *     sentence rides the engine's `detail` key, NOT `message`.
 *   - `{detail: {error: "SAFETY_NOT_A_PARTICIPANT", message: "..."}}` — the
 *     gateway's own refusal dicts put the sentence under `message`
 *     (`_boundary_http_error` and friends in python/vtt_orchestrator/server.py).
 *   - `{detail: "Missing session token"}` / `{detail: "UNKNOWN_MONSTER_ID:x"}`
 *     — a bare string: there is no way to distinguish a sentence from a
 *     code-only answer, so the string surfaces as the message verbatim.
 *   - `{detail: [{loc, msg, type}]}` — FastAPI's own 422 validation list;
 *     the first `.msg` is the human explanation.
 *   - `{"error": ..., "detail": ...}` unwrapped at top level — some surfaces
 *     forward the engine body directly, so only peel the `{detail}` envelope
 *     when the body does not already name a code.
 *
 * `engineRejectionDetail` extracts `{code, message}` from any of these.
 * `rejectionFrom` wraps the result into the discriminated `rejected` outcome
 * that every engine-action module and its renderers already understand.
 */

/** The machine code + human sentence a rejection carries, either may be null. */
export interface EngineRejectionDetail {
  /** SCREAMING_SNAKE_CASE code the engine emitted (FORBIDDEN_ROLE, ...), or null. */
  code: string | null;
  /** The server's human explanation verbatim, or null when none was sent. */
  message: string | null;
}

/** One `rejected` branch of an engine-action outcome, with BOTH fields explicit. */
export interface EngineRejected {
  kind: 'rejected';
  status: number;
  code: string | null;
  message: string | null;
}

/** Read {code, message} out of a rejection body already stripped of any envelope. */
function fromRejectionBody(raw: unknown): EngineRejectionDetail {
  if (Array.isArray(raw)) {
    // FastAPI validation 422: [{loc, msg, type}], first entry carries the text.
    const first = raw[0] as Record<string, unknown> | undefined;
    return { code: null, message: typeof first?.msg === 'string' ? first.msg : null };
  }
  if (typeof raw === 'string') {
    // An unbracketed detail is a whole sentence OR a code-only string; both
    // surface as the message verbatim, never coerced into a fake machine code.
    return { code: null, message: raw };
  }
  if (raw && typeof raw === 'object') {
    const d = raw as Record<string, unknown>;
    const message =
      (typeof d.message === 'string' ? d.message : null) ??
      (typeof d.detail === 'string' ? d.detail : null);
    return {
      code:
        typeof d.error === 'string' ? d.error : typeof d.code === 'string' ? d.code : null,
      message,
    };
  }
  return { code: null, message: null };
}

/**
 * Extract the machine code and the human explanation from ANY engine/gateway
 * rejection body actually on the wire. Survives non-JSON payloads (null) by
 * yielding two nulls — callers then render their own `HTTP <status>` fallback.
 */
export function engineRejectionDetail(body: unknown): EngineRejectionDetail {
  const obj =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  // FastAPI wraps every refusal under {detail}, but a body that itself names a
  // code ({error, detail} / {code, message}) is a raw engine answer — peeling
  // its detail key would swallow the code under the sentence. Only unwrap when
  // the top level does not already carry a code.
  const namesCode = obj !== null && (typeof obj.error === 'string' || typeof obj.code === 'string');
  if (namesCode) return fromRejectionBody(body);
  if (obj !== null && obj.detail !== undefined) return fromRejectionBody(obj.detail);
  return fromRejectionBody(body);
}

/** Build a discriminated `rejected` outcome from a status + raw response body. */
export function rejectionFrom(status: number, payload: unknown): EngineRejected {
  return { kind: 'rejected', status, ...engineRejectionDetail(payload) };
}