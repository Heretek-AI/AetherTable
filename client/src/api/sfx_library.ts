/**
 * Generated-SFX client for POST /api/v1/media/sfx (real backend surface).
 *
 * Gateway contract (python/vtt_orchestrator/server.py, media_sfx):
 *  - POST JSON `{ prompt }` where MediaSfxRequest constrains
 *    `prompt: str(1..300)`; a violating payload is rejected with FastAPI 422.
 *  - Success responds with RAW `audio/wav` bytes (`Response(content=..., media_type="audio/wav")`)
 *    — NOT JSON — so the body must be read with `resp.arrayBuffer()`.
 *  - Auth: HMAC session token required (`Depends(_require_auth)`), resolved
 *    Bearer-header-first. We send `Authorization: Bearer <token>`; tokens never
 *    ride in URLs (proxies log them verbatim).
 *  - GM/admin ONLY: non-staff seats receive
 *    `403 MEDIA_SFX_FORBIDDEN: sound effects play to the whole table; only GM
 *    or admin seats may trigger them.` SFX is table-wide, so triggering it is
 *    a staff decision exactly like lore promotion.
 *  - Upstream media-gateway failures are forwarded verbatim by
 *    `_media_error_to_http`: `MEDIA_GATEWAY_UNAVAILABLE` → 502, and upstream
 *    rejections keep their own status (a metered/rate-limited host arrives as
 *    429; a content-refusal keeps whatever 4xx the host sent).
 *
 * Result union mirrors those facts honestly instead of collapsing them into a
 * generic error: NOT_SIGNED_IN / FORBIDDEN / RATE_LIMITED / REJECTED /
 * UNREACHABLE are distinct outcomes the SfxPanel renders distinctly.
 *
 * CACHING: synthesis is slow (30-90 s per cue) and metered upstream, so every
 * successfully decoded prompt is memoized in a session Map (prompt → decoded
 * AudioBuffer + raw WAV bytes). A repeat request replays from cache WITHOUT a
 * network call, and an identical concurrent request shares one in-flight
 * promise rather than double-spending a generation slot.
 *
 * PLAYBACK PATH (honest limits): `globalSpatialAudio` imports cleanly, but its
 * one-shot methods (`playSpatialImpact`, …) synthesize oscillator cues per call
 * — none of them accept a decoded AudioBuffer, and this lane may not extend
 * spatial_audio.ts. Playback therefore falls back to a plain HTMLAudioElement
 * fed an object URL over the raw WAV bytes: flat stereo at the listener's
 * master element volume, NO HRTF azimuth/distance/occlusion. That is a
 * deliberate, documented downgrade — generated cues are ambience, not
 * positional events.
 */

import { getStoredToken } from './auth_headers';

/** One-click prompts offered as chips in the SfxPanel. */
export const SFX_PRESETS: readonly string[] = [
  'stone door grinding',
  'torch crackle',
  'dungeon drip',
  'dragon roar',
] as const;

/** What the gateway enforces; mirrored client-side only as a fast pre-check. */
export const SFX_PROMPT_MAX_CHARS = 300;

export interface SfxLibraryEntry {
  prompt: string;
  /** Decoded PCM graph node source (Web Audio). */
  buffer: AudioBuffer;
  /** Raw WAV bytes retained so playback can use the plain-Audio fallback. */
  wav: ArrayBuffer;
}

export type SfxResult =
  | { outcome: 'OK'; prompt: string; buffer: AudioBuffer; cached: boolean }
  /** No session token in storage — nothing was sent. */
  | { outcome: 'NOT_SIGNED_IN'; detail: string }
  /**
   * 403 from the gateway (MEDIA_SFX_FORBIDDEN) or an expired token arriving
   * back as 401. The UI renders a GM-only notice for this outcome.
   */
  | { outcome: 'FORBIDDEN'; detail: string }
  /** 429 — the upstream synthesis bucket is drained; try later. */
  | { outcome: 'RATE_LIMITED'; detail: string }
  /** Any other refusal: 422 payload rejection, 5xx gateway/upstream failure. */
  | { outcome: 'REJECTED'; detail: string }
  /** fetch threw — backend unreachable offline. */
  | { outcome: 'UNREACHABLE'; detail: string };

/** Session-scoped memoization. Cleared on reload like every other store. */
const library = new Map<string, SfxLibraryEntry>();

/** Identical concurrent requests share one generation instead of doubling spend. */
const inFlight = new Map<string, Promise<SfxResult>>();

/**
 * Lazily-created AudioContext used ONLY for `decodeAudioData`. Created on the
 * first successful fetch (which is always after a user gesture in the panel),
 * so autoplay policy does not strand it suspended — and decoding does not need
 * a running context anyway.
 */
let decodeCtx: AudioContext | null = null;

function normalizePrompt(prompt: string): string {
  return prompt.trim();
}

function getDecodeContext(): AudioContext | null {
  if (decodeCtx) return decodeCtx;
  try {
    const g = globalThis as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) return null;
    decodeCtx = new Ctor();
  } catch {
    return null;
  }
  return decodeCtx;
}

/**
 * Wraps `decodeAudioData`, tolerating BOTH the modern promise-returning form
 * AND the legacy callback form (some Safari builds) without double-resolving.
 */
function decodeWav(ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    try {
      const maybe = ctx.decodeAudioData(
        bytes,
        (buf) => done(() => resolve(buf)),
        (err) => done(() => reject(err instanceof Error ? err : new Error(String(err)))),
      ) as unknown;
      if (
        maybe &&
        typeof (maybe as Promise<AudioBuffer>).then === 'function'
      ) {
        (maybe as Promise<AudioBuffer>).then(
          (buf) => done(() => resolve(buf)),
          (err) => done(() => reject(err instanceof Error ? err : new Error(String(err)))),
        );
      }
    } catch (err) {
      done(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

/** Cache lookup — lets the UI replay a library item without touching the wire. */
export function getCachedSfx(prompt: string): SfxLibraryEntry | null {
  return library.get(normalizePrompt(prompt)) ?? null;
}

/** Number of distinct decoded prompts held this session (mixer display/tests). */
export function sfxLibrarySize(): number {
  return library.size;
}

/** Test/diagnostic reset — production code never clears the session cache. */
export function clearSfxLibraryForTests(): void {
  library.clear();
  inFlight.clear();
  decodeCtx = null;
}

/**
 * Generate (or replay) one sound effect for the table. Never throws; resolves
 * to a discriminated outcome the caller must render honestly.
 */
export async function generateSfx(rawPrompt: string): Promise<SfxResult> {
  const prompt = normalizePrompt(rawPrompt);

  // Cache replay first: a prompt we already hold costs zero generations and
  // zero bytes, regardless of who is signed in now.
  const hit = library.get(prompt);
  if (hit) {
    return { outcome: 'OK', prompt, buffer: hit.buffer, cached: true };
  }

  // Fast pre-check mirroring the server's own _require_auth so a signed-out
  // seat gets an immediate honest answer instead of a guaranteed 401 round-trip.
  if (!getStoredToken()) {
    return {
      outcome: 'NOT_SIGNED_IN',
      detail: 'Sign in first — generated sound effects require an authenticated GM/admin seat.',
    };
  }

  if (prompt.length < 1 || prompt.length > SFX_PROMPT_MAX_CHARS) {
    return {
      outcome: 'REJECTED',
      detail: `Prompt must be 1-${SFX_PROMPT_MAX_CHARS} characters (gateway MediaSfxRequest constraint).`,
    };
  }

  const existing = inFlight.get(prompt);
  if (existing) return existing;

  const job = doGenerate(prompt).finally(() => inFlight.delete(prompt));
  inFlight.set(prompt, job);
  return job;
}

async function doGenerate(prompt: string): Promise<SfxResult> {
  const token = getStoredToken();
  if (!token) {
    // Token evaporated between the pre-check and here (sign-out mid-flight).
    return { outcome: 'NOT_SIGNED_IN', detail: 'Session ended before the request was sent.' };
  }

  let resp: Response;
  try {
    resp = await fetch('/api/v1/media/sfx', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt }),
    });
  } catch (e) {
    console.warn('SFX generation endpoint unreachable:', e);
    return { outcome: 'UNREACHABLE', detail: 'Could not reach the gateway.' };
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const err = (await resp.json()) as { detail?: unknown };
      if (typeof err.detail === 'string') detail = err.detail;
      else if (err.detail != null) detail = JSON.stringify(err.detail);
    } catch {
      /* keep the HTTP-status fallback */
    }
    if (resp.status === 401) {
      return { outcome: 'NOT_SIGNED_IN', detail };
    }
    if (resp.status === 403) {
      // Verbatim MEDIA_SFX_FORBIDDEN copy — the SfxPanel renders this as the
      // GM-only notice rather than burying it in a generic failure banner.
      return { outcome: 'FORBIDDEN', detail };
    }
    if (resp.status === 429) {
      return { outcome: 'RATE_LIMITED', detail };
    }
    return { outcome: 'REJECTED', detail };
  }

  let wav: ArrayBuffer;
  try {
    // Raw audio/wav bytes, not JSON (see module docs).
    wav = await resp.arrayBuffer();
  } catch (e) {
    console.warn('SFX response body unreadable:', e);
    return { outcome: 'REJECTED', detail: 'Response body could not be read as audio bytes.' };
  }

  const ctx = getDecodeContext();
  if (!ctx) {
    return {
      outcome: 'REJECTED',
      detail: 'Web Audio is unavailable in this browser — the effect arrived but cannot be decoded.',
    };
  }

  let buffer: AudioBuffer;
  try {
    buffer = await decodeWav(ctx, wav.slice(0));
  } catch (e) {
    // Honesty: the fetch succeeded but the payload is not playable audio.
    // Surface it as its own REJECTED detail instead of pretending success.
    console.warn('SFX decode failed:', e);
    return {
      outcome: 'REJECTED',
      detail:
        'The gateway returned audio that could not be decoded as WAV. ' +
        'Nothing was added to the library.',
    };
  }

  library.set(prompt, { prompt, buffer, wav });
  return { outcome: 'OK', prompt, buffer, cached: false };
}

/**
 * Plays a cached effect through the documented plain-Audio fallback (see
 * module docs for why this is NOT the spatial engine). Returns false when the
 * prompt is not in the library or the browser refuses element playback.
 */
export function playCachedSfx(prompt: string, volume = 1): boolean {
  const entry = library.get(normalizePrompt(prompt));
  if (!entry) return false;
  try {
    const url = URL.createObjectURL(new Blob([entry.wav], { type: 'audio/wav' }));
    const el = new Audio(url);
    el.volume = Math.max(0, Math.min(1, volume));
    const started = el.play();
    if (started && typeof started.catch === 'function') {
      // Autoplay refusals must not bubble as unhandled rejections; the caller
      // already knows playback is best-effort.
      started.catch(() => undefined);
    }
    el.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    return true;
  } catch {
    return false;
  }
}
