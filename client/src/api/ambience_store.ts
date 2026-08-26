/**
 * Ambience-preset client for GET/POST /api/v1/media/ambience (iteration 17).
 *
 * Gateway contract (python/vtt_orchestrator/server.py,
 * list_ambience_presets / generate_ambience):
 *  - GET  /api/v1/media/ambience — any authenticated seat; JSON
 *    `{ presets: [{slug,label,description,prompt,loop_seconds,cached}] }`
 *    (AmbienceListResponse) with Cache-Control no-store.
 *  - POST /api/v1/media/ambience/{slug} — GM/admin ONLY (ambient beds reach
 *    every seat, so triggering one is a staff decision, same posture as
 *    /media/sfx). Success is RAW audio/wav bytes — NOT JSON — so the body must
 *    be read with `resp.arrayBuffer()` and decoded through an AudioContext.
 *  - Auth: HMAC session token required (`Depends(_require_auth)`), sent as
 *    `Authorization: Bearer <token>`; tokens never ride in URLs.
 *  - Honest errors: player/spectator → `403 MEDIA_AMBIENCE_FORBIDDEN`;
 *    unknown slug → `404 UNKNOWN_AMBIENCE_PRESET`; upstream media-gateway
 *    failure → `502 MEDIA_GATEWAY_UNAVAILABLE` or a forwarded status+detail.
 *
 * Result unions mirror those facts instead of collapsing into a generic error:
 * NOT_SIGNED_IN / FORBIDDEN / UNKNOWN_PRESET / REJECTED / UNREACHABLE are each
 * rendered distinctly by the AmbiencePanel.
 *
 * CACHING (client side): generation is slow and metered upstream, so every
 * successfully decoded slug is memoized in a session Map (slug → AudioBuffer).
 * A replay resolves from cache with ZERO wire calls, identical concurrent
 * requests share one in-flight promise, and FAILURES ARE NEVER CACHED — a
 * rejected slug retries the wire on the next attempt.
 */

import { getStoredToken } from './auth_headers';

/** One curated soundscape exactly as AmbiencePresetOut serializes it. */
export interface AmbiencePreset {
  slug: string;
  label: string;
  description: string;
  prompt: string;
  loop_seconds: number;
  /** True when THIS gateway process already holds the generated wav in its LRU. */
  cached: boolean;
}

export type AmbienceListResult =
  | { outcome: 'OK'; presets: AmbiencePreset[] }
  /** No session token in storage — nothing was sent. */
  | { outcome: 'NOT_SIGNED_IN'; detail: string }
  | { outcome: 'REJECTED'; detail: string }
  /** fetch threw — backend unreachable offline. */
  | { outcome: 'UNREACHABLE'; detail: string };

export type AmbiencePlayResult =
  | { outcome: 'OK'; slug: string; buffer: AudioBuffer; cached: boolean }
  /** No session token in storage — nothing was sent. */
  | { outcome: 'NOT_SIGNED_IN'; detail: string }
  /**
   * 403 MEDIA_AMBIENCE_FORBIDDEN (or a 401 for an expired token). The panel
   * renders this verbatim as the GM-only notice.
   */
  | { outcome: 'FORBIDDEN'; detail: string }
  /** 404 UNKNOWN_AMBIENCE_PRESET — stale catalog entry, most likely. */
  | { outcome: 'UNKNOWN_PRESET'; detail: string }
  /** Any other refusal: 502 gateway-unavailable, forwarded upstream 4xx/5xx. */
  | { outcome: 'REJECTED'; detail: string }
  /** fetch threw — backend unreachable offline. */
  | { outcome: 'UNREACHABLE'; detail: string };

/** Session-scoped memoization of decoded beds. Cleared on reload like every other store. */
const library = new Map<string, AudioBuffer>();

/** Identical concurrent requests share one wire call instead of doubling spend. */
const inFlight = new Map<string, Promise<AmbiencePlayResult>>();

/**
 * Lazily-created AudioContext used for BOTH `decodeAudioData` and loop
 * playback (BufferSourceNode → GainNode → destination). Created on first use,
 * which is always after a user gesture in the panel.
 */
let audioCtx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  try {
    const g = globalThis as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  } catch {
    return null;
  }
  return audioCtx;
}

/** Wraps decodeAudioData across modern promise AND legacy callback forms. */
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
      if (maybe && typeof (maybe as Promise<AudioBuffer>).then === 'function') {
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

async function readErrorDetail(resp: Response): Promise<string> {
  try {
    const err = (await resp.json()) as { detail?: unknown };
    if (typeof err.detail === 'string') return err.detail;
    if (err.detail != null) return JSON.stringify(err.detail);
  } catch {
    /* fall through to the HTTP-status fallback */
  }
  return `HTTP ${resp.status}`;
}

/** Cache lookup — lets the UI replay a preset without touching the wire. */
export function getCachedAmbience(slug: string): AudioBuffer | null {
  return library.get(slug.trim()) ?? null;
}

/** Number of distinct decoded slugs held this session (mixer display/tests). */
export function ambienceLibrarySize(): number {
  return library.size;
}

/** Test/diagnostic reset — production code never clears the session cache. */
export function clearAmbienceForTests(): void {
  library.clear();
  inFlight.clear();
  stopAmbienceLoop();
  audioCtx = null;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * Fetch the curated catalog. Never throws; resolves to a discriminated
 * outcome. Read-only listing is open to any authenticated seat server-side,
 * so this carries no staff gate of its own.
 */
export async function listAmbiencePresets(): Promise<AmbienceListResult> {
  const token = getStoredToken();
  if (!token) {
    return {
      outcome: 'NOT_SIGNED_IN',
      detail: 'Sign in first — the ambience catalog requires an authenticated seat.',
    };
  }

  let resp: Response;
  try {
    resp = await fetch('/api/v1/media/ambience', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (e) {
    console.warn('Ambience catalog endpoint unreachable:', e);
    return { outcome: 'UNREACHABLE', detail: 'Could not reach the gateway.' };
  }

  if (!resp.ok) {
    return { outcome: 'REJECTED', detail: await readErrorDetail(resp) };
  }

  try {
    const payload = (await resp.json()) as { presets?: unknown };
    const raw = Array.isArray(payload.presets) ? payload.presets : [];
    // Shape-honest parse: drop anything that fails the contract rather than
    // rendering half a card off a malformed row.
    const presets: AmbiencePreset[] = [];
    for (const item of raw) {
      const p = item as Partial<AmbiencePreset> | null;
      if (
        p &&
        typeof p.slug === 'string' &&
        typeof p.label === 'string' &&
        typeof p.description === 'string' &&
        typeof p.prompt === 'string' &&
        typeof p.loop_seconds === 'number' &&
        typeof p.cached === 'boolean'
      ) {
        presets.push({
          slug: p.slug,
          label: p.label,
          description: p.description,
          prompt: p.prompt,
          loop_seconds: p.loop_seconds,
          cached: p.cached,
        });
      }
    }
    return { outcome: 'OK', presets };
  } catch (e) {
    console.warn('Ambience catalog response was not valid JSON:', e);
    return { outcome: 'REJECTED', detail: 'Catalog response could not be parsed as JSON.' };
  }
}

// ---------------------------------------------------------------------------
// Generation / fetch + cache
// ---------------------------------------------------------------------------

/**
 * Generate (or replay) one curated soundscape's wav. Never throws; resolves to
 * a discriminated outcome. NOTE: fetching is only half of "play" — callers
 * start the audible bed via {@link startAmbienceLoop}.
 */
export async function playAmbience(rawSlug: string): Promise<AmbiencePlayResult> {
  const slug = rawSlug.trim();

  // Cache replay first: a slug we already hold costs zero generations and
  // zero bytes, regardless of who is signed in now.
  const hit = library.get(slug);
  if (hit) {
    return { outcome: 'OK', slug, buffer: hit, cached: true };
  }

  // Fast pre-check mirroring the server's own _require_auth so a signed-out
  // seat gets an immediate honest answer instead of a guaranteed 401 trip.
  if (!getStoredToken()) {
    return {
      outcome: 'NOT_SIGNED_IN',
      detail: 'Sign in first — ambient soundscapes require an authenticated seat.',
    };
  }

  const existing = inFlight.get(slug);
  if (existing) return existing;

  const job = doFetchAmbience(slug).finally(() => inFlight.delete(slug));
  inFlight.set(slug, job);
  return job;
}

async function doFetchAmbience(slug: string): Promise<AmbiencePlayResult> {
  const token = getStoredToken();
  if (!token) {
    // Token evaporated between the pre-check and here (sign-out mid-flight).
    return { outcome: 'NOT_SIGNED_IN', detail: 'Session ended before the request was sent.' };
  }

  let resp: Response;
  try {
    resp = await fetch(`/api/v1/media/ambience/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (e) {
    console.warn('Ambience generation endpoint unreachable:', e);
    return { outcome: 'UNREACHABLE', detail: 'Could not reach the gateway.' };
  }

  if (!resp.ok) {
    const detail = await readErrorDetail(resp);
    if (resp.status === 401) {
      return { outcome: 'NOT_SIGNED_IN', detail };
    }
    if (resp.status === 403) {
      // Verbatim MEDIA_AMBIENCE_FORBIDDEN copy — the panel renders this as the
      // GM-only notice rather than burying it in a generic failure banner.
      return { outcome: 'FORBIDDEN', detail };
    }
    if (resp.status === 404) {
      return { outcome: 'UNKNOWN_PRESET', detail };
    }
    return { outcome: 'REJECTED', detail };
  }

  let wav: ArrayBuffer;
  try {
    wav = await resp.arrayBuffer();
  } catch (e) {
    console.warn('Ambience response body unreadable:', e);
    return { outcome: 'REJECTED', detail: 'Response body could not be read as audio bytes.' };
  }

  const ctx = getContext();
  if (!ctx) {
    return {
      outcome: 'REJECTED',
      detail: 'Web Audio is unavailable in this browser — the soundscape arrived but cannot be decoded.',
    };
  }

  let buffer: AudioBuffer;
  try {
    buffer = await decodeWav(ctx, wav.slice(0));
  } catch (e) {
    // Honesty: the fetch succeeded but the payload is not playable audio.
    console.warn('Ambience decode failed:', e);
    return {
      outcome: 'REJECTED',
      detail:
        'The gateway returned audio that could not be decoded as WAV. Nothing was cached.',
    };
  }

  library.set(slug, buffer);
  return { outcome: 'OK', slug, buffer, cached: false };
}

// ---------------------------------------------------------------------------
// Loop playback (Web Audio BufferSource + Gain — the repo's own pattern)
// ---------------------------------------------------------------------------

interface ActiveLoop {
  slug: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

let activeLoop: ActiveLoop | null = null;

/**
 * Starts (or switches) the looping bed for a CACHED slug through Web Audio:
 * BufferSourceNode(loop=true) → GainNode → destination. Starting a second bed
 * stops the first so exactly one ambience plays at a time. Returns false when
 * the slug was never decoded or the browser refuses playback — no silent fake.
 */
export function startAmbienceLoop(slug: string, volume = 1): boolean {
  const key = slug.trim();
  const buffer = library.get(key);
  if (!buffer) return false;
  const ctx = getContext();
  if (!ctx) return false;
  try {
    stopAmbienceLoop(); // exactly one bed at a time
    // Autoplay-policy best effort: a suspended context resumes only inside a
    // user gesture. Never let a resume hiccup abort the bed itself.
    try {
      const resumed = ctx.resume();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(() => undefined);
    } catch {
      /* keep starting the loop regardless */
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();

    activeLoop = { slug: key, source, gain };
    return true;
  } catch (e) {
    console.warn('Ambience loop playback refused:', e);
    activeLoop = null;
    return false;
  }
}

/** Stops the current bed, if any. Returns whether anything was actually playing. */
export function stopAmbienceLoop(): boolean {
  const loop = activeLoop;
  if (!loop) return false;
  activeLoop = null;
  try {
    loop.source.stop();
  } catch {
    /* already stopped — stopping twice is not an error worth throwing over */
  }
  try {
    loop.source.disconnect();
    loop.gain.disconnect();
  } catch {
    /* node teardown is best-effort */
  }
  return true;
}

/** Which slug is looping right now, or null when silent (panel indicator). */
export function currentAmbienceSlug(): string | null {
  return activeLoop?.slug ?? null;
}

/** True when `slug` (or anything, if omitted) is looping right now. */
export function isAmbienceLoopPlaying(slug?: string): boolean {
  if (!activeLoop) return false;
  if (slug === undefined) return true;
  return activeLoop.slug === slug.trim();
}
