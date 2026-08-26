/**
 * Server-side STT adapter (Loop 3, iteration 7).
 *
 * History, stated honestly: iteration-39 shipped browser Whisper because the
 * gateway had NO transcription route. It does now — POST /api/v1/media/
 * transcribe accepts a multipart wav upload from any authenticated seat and
 * returns { text } (python/vtt_orchestrator/server.py `media_transcribe`).
 *
 * This adapter is the client half of that route. Design constraints:
 *
 *   - Opt-in via a NEW env var, VITE_STT_ENGINE = 'browser' | 'server' | 'off'.
 *     Unset falls back to the legacy VITE_ENABLE_BROWSER_STT flag so existing
 *     deployments keep their current behaviour byte-for-byte; the engine is
 *     NEVER silently switched to 'server', because that would start shipping
 *     microphone audio off-device without an explicit deployment decision.
 *   - Wire format: the captured 16 kHz mono Float32 VAD burst is encoded with
 *     the existing float32ToWavPcm16Blob helper (the gateway validates BOTH
 *     the .wav extension and the RIFF....WAVE magic bytes) and posted as
 *     multipart FormData with `file` + `model` fields and authHeaders().
 *   - Honest failure modes: every rejection class maps to its own surfaced
 *     reason — 401 not-authenticated, 413 too large, 422 not-a-wav, 429 rate
 *     limited, network unreachable, unreadable success body. None of them
 *     fabricate text.
 *
 * The result type matches BrowserWhisperTranscriber.transcribe exactly so
 * NarrativeChat can treat both engines interchangeably against the same
 * voice-draft reducer.
 */
import { authHeaders } from './auth_headers';
import { float32ToWavPcm16Blob } from './speech_transcription';

/** Env var selecting which STT engine this build uses. */
export const STT_ENGINE_FLAG = 'VITE_STT_ENGINE';

/** Legacy opt-in flag for in-browser Whisper (iteration-39). */
export const LEGACY_BROWSER_STT_FLAG = 'VITE_ENABLE_BROWSER_STT';

export type SttEngineChoice =
  /** transformers.js Whisper running fully in this browser tab. */
  | 'browser'
  /** POST each VAD segment to the gateway's /media/transcribe route. */
  | 'server'
  /** No engine: UI must surface "transcription unavailable" honestly. */
  | 'off';

/** Gateway route that turns one wav upload into text. */
export const SERVER_TRANSCRIBE_PATH = '/api/v1/media/transcribe';

/** FormData field carrying the wav blob (the gateway's UploadFile param). */
export const SERVER_STT_FILE_FIELD = 'file';

/**
 * FormData field naming the upstream model for the media gateway. The
 * orchestrator ignores unknown multipart fields today, but sending it keeps
 * the request self-describing for future server-side model routing.
 */
export const SERVER_STT_MODEL_FIELD = 'model';
export const SERVER_STT_MODEL_ID = 'whisper-1';

/** vad-web resamples to 16 kHz mono before onSpeechEnd fires. */
export const VOICE_SAMPLE_RATE = 16_000;

function truthyFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Resolve the STT engine from the raw env values. An explicit VITE_STT_ENGINE
 * spelling always wins; anything else (unset, empty, unrecognised) falls back
 * to the legacy browser flag so no deployment changes behaviour by upgrading.
 */
export function resolveSttEngine(rawEngine: unknown, legacyBrowserFlag?: unknown): SttEngineChoice {
  if (typeof rawEngine === 'string') {
    const v = rawEngine.trim().toLowerCase();
    if (v === 'browser') return 'browser';
    if (v === 'server') return 'server';
    if (v === 'off' || v === 'none') return 'off';
  }
  return truthyFlag(legacyBrowserFlag) ? 'browser' : 'off';
}

/** Same shape as BrowserWhisperTranscriber's TranscribeResult. */
export type ServerTranscribeResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

type PostFn = (url: string, init: RequestInit) => Promise<Response>;

export interface ServerSttOptions {
  /** false keeps every fetch cold (default-off backward compat). */
  enabled?: boolean;
  sampleRate?: number;
  modelId?: string;
  /** DI seam for tests; defaults to global fetch. */
  post?: PostFn;
  /** DI seam for the WAV encoder; defaults to the shared helper. */
  encodeWav?: (samples: Float32Array, sampleRate: number) => Blob;
}

async function defaultPost(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

interface GatewayErrorBody {
  detail?: unknown;
}

/**
 * Extract the gateway's human-readable error detail without ever throwing:
 * a malformed body degrades to null rather than masking the status class.
 */
async function readErrorDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as GatewayErrorBody;
    const detail = body?.detail;
    return typeof detail === 'string' && detail.trim() ? detail.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Transcribes one captured VAD burst by uploading it as a wav to the
 * gateway. Never throws — every failure returns { ok:false, reason } so the
 * voice-draft bubble can surface the real cause verbatim.
 */
export class ServerWhisperTranscriber {
  public readonly kind = 'server' as const;

  private readonly enabled: boolean;
  private readonly sampleRate: number;
  private readonly modelId: string;
  private post: PostFn;
  private readonly encodeWav: (samples: Float32Array, sampleRate: number) => Blob;

  constructor(options: ServerSttOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.sampleRate = options.sampleRate ?? VOICE_SAMPLE_RATE;
    this.modelId = options.modelId ?? SERVER_STT_MODEL_ID;
    this.post = options.post ?? defaultPost;
    this.encodeWav =
      options.encodeWav ??
      ((samples: Float32Array, rate: number) => float32ToWavPcm16Blob(samples, rate));
  }

  /** Test seam: swap the transport after construction. */
  public setPoster(post: PostFn): void {
    this.post = post;
  }

  public async transcribe(audio: Float32Array): Promise<ServerTranscribeResult> {
    if (!this.enabled) {
      return {
        ok: false,
        reason: `server transcription disabled (${STT_ENGINE_FLAG} not set to 'server')`,
      };
    }

    // Multipart body: the wav bytes plus the model hint. Content-Type stays
    // unset so the browser writes the boundary itself; auth rides in headers
    // (authHeaders() spreads to {} when signed out, and the gateway answers
    // 401 — surfaced below — rather than the client guessing).
    const form = new FormData();
    form.append(SERVER_STT_FILE_FIELD, this.encodeWav(audio, this.sampleRate), 'segment.wav');
    form.append(SERVER_STT_MODEL_FIELD, this.modelId);

    let response: Response;
    try {
      response = await this.post(SERVER_TRANSCRIBE_PATH, {
        method: 'POST',
        headers: { ...authHeaders() },
        body: form,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `transcription server unreachable (${message})` };
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      const suffix = detail ? `: ${detail}` : '';
      switch (response.status) {
        case 401:
        case 403:
          return {
            ok: false,
            reason: `transcription rejected: session not authenticated (401)${suffix}`,
          };
        case 413:
          return {
            ok: false,
            reason: `transcription rejected: audio too large for the gateway (413)${suffix}`,
          };
        case 422:
          return {
            ok: false,
            reason: `transcription rejected: upload was not a usable wav recording (422)${suffix}`,
          };
        case 429:
          return {
            ok: false,
            reason: `transcription rejected: rate limited, retry shortly (429)${suffix}`,
          };
        default:
          return {
            ok: false,
            reason: `transcription failed: gateway returned ${response.status}${suffix}`,
          };
      }
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, reason: 'transcription failed: gateway returned an unreadable response' };
    }
    const text =
      typeof payload === 'object' && payload !== null && 'text' in payload
        ? (payload as { text: unknown }).text
        : undefined;
    if (typeof text !== 'string') {
      return { ok: false, reason: 'transcription failed: gateway returned an unreadable response' };
    }
    // Only whitespace is trimmed here; silence-artifact policy stays in
    // shapeTranscript (speech_transcription.ts), the single arbiter of what
    // is bubble-worthy.
    return { ok: true, text: text.trim() };
  }
}
