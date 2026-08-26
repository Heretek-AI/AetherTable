/**
 * Iteration-7 (Loop 3): server-side STT routing.
 *
 * The gateway now owns POST /api/v1/media/transcribe (multipart wav → {text},
 * any authenticated seat), so a table that does not want 40-80 MB of ONNX
 * weights downloaded into every player tab can transcribe server-side
 * instead. These tests pin:
 *
 *   - resolveSttEngine: VITE_STT_ENGINE selection with honest fallback to the
 *     legacy VITE_ENABLE_BROWSER_STT flag so existing deployments keep their
 *     current behaviour byte-for-byte when the new var is unset,
 *   - the wire shape of the upload (FormData: file blob named *.wav + model),
 *   - every failure variant surfacing as a DISTINCT reason (401 / 413 / 422 /
 *   - 429 / unreachable) rather than one generic shrug,
 *   - default-off: nothing is posted and nothing pretends to transcribe.
 *
 * No network: fetch is injected; Blob/FormData come from Node's globals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SERVER_TRANSCRIBE_PATH,
  SERVER_STT_MODEL_FIELD,
  ServerWhisperTranscriber,
  resolveSttEngine,
} from '../server_stt';
import { float32ToWavPcm16Blob } from '../speech_transcription';

/** Two seconds of quiet noise-shaped audio (16 kHz mono). */
const SEGMENT = new Float32Array(32_000).map((_, i) => Math.sin(i / 20) * 0.3);

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** Install a fake poster on the transcriber and record what it sent. */
function installPoster(
  transcriber: ServerWhisperTranscriber,
  responder: (call: number, url: string) => Response | Promise<Response>,
): Array<RecordedCall> {
  const calls: Array<RecordedCall> = [];
  let n = 0;
  transcriber.setPoster((url, init) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(responder(n++, url));
  });
  return calls;
}

/** getStoredToken() reads sessionStorage; provide a signed-in session. */
let tokenStore: Map<string, string> | null = null;
beforeEach(() => {
  tokenStore = new Map([['aethertable_token', 'test-token']]);
  (globalThis as unknown as Record<string, unknown>).sessionStorage = {
    getItem: (key: string) => tokenStore?.get(key) ?? null,
    setItem: (key: string, value: string) => void tokenStore?.set(key, value),
    removeItem: (key: string) => void tokenStore?.delete(key),
    clear: () => tokenStore?.clear(),
  };
});
afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).sessionStorage;
  tokenStore = null;
});

describe('resolveSttEngine', () => {
  it('selects the explicit engines from VITE_STT_ENGINE', () => {
    expect(resolveSttEngine('browser')).toBe('browser');
    expect(resolveSttEngine('SERVER')).toBe('server');
    expect(resolveSttEngine('off')).toBe('off');
    expect(resolveSttEngine(' none ')).toBe('off');
  });

  it('falls back to the legacy browser flag when the new var is unset', () => {
    // Current behaviour preserved exactly: unset everything ⇒ off.
    expect(resolveSttEngine(undefined, undefined)).toBe('off');
    expect(resolveSttEngine('', undefined)).toBe('off');
    // Legacy opt-in keeps browser Whisper alive without touching VITE_STT_ENGINE.
    expect(resolveSttEngine(undefined, 'true')).toBe('browser');
    expect(resolveSttEngine(undefined, true)).toBe('browser');
    expect(resolveSttEngine(undefined, 'false')).toBe('off');
    // An explicit 'off' beats a truthy legacy flag.
    expect(resolveSttEngine('off', 'true')).toBe('off');
  });

  it('treats unrecognised engine values as unset rather than guessing', () => {
    expect(resolveSttEngine('whisper', undefined)).toBe('off');
    expect(resolveSttEngine('whisper', 'true')).toBe('browser');
    expect(resolveSttEngine(42, undefined)).toBe('off');
  });

  it('never resolves to server unless explicitly asked', () => {
    // Shipping audio off-device silently would be an honest-consent failure.
    expect(resolveSttEngine(undefined, 'true')).not.toBe('server');
    expect(resolveSttEngine('garbage', 'true')).not.toBe('server');
  });
});

describe('ServerWhisperTranscriber', () => {
  it('posts a multipart wav upload with file + model fields to the gateway route', async () => {
    const transcriber = new ServerWhisperTranscriber();
    const calls = installPoster(transcriber, () =>
      jsonResponse(200, { text: 'I cast Fireball at the warlord' }),
    );

    const result = await transcriber.transcribe(SEGMENT);

    expect(result).toEqual({ ok: true, text: 'I cast Fireball at the warlord' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(SERVER_TRANSCRIBE_PATH);
    expect(init.method).toBe('POST');

    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get(SERVER_STT_MODEL_FIELD)).toBe('whisper-1');

    const file = body.get('file');
    expect(file).toBeInstanceOf(Blob);
    const wav = file as Blob;
    expect(wav.type).toBe('audio/wav');

    // The uploaded bytes must be the canonical RIFF....WAVE wav encoding of
    // the captured segment — the gateway validates BOTH extension and magic.
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(bytes.length).toBe(44 + SEGMENT.length * 2);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');

    // Auth travels in headers; Content-Type must stay unset so the browser
    // writes the multipart boundary itself.
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Authorization']);
  });

  it('surfaces a distinct reason for each HTTP rejection class', async () => {
    const cases: Array<[number, RegExp]> = [
      [401, /not authenticated/i],
      [413, /too large/i],
      [422, /wav/i],
      [429, /rate limit|too many/i],
      [500, /500/],
    ];
    for (const [status, pattern] of cases) {
      const transcriber = new ServerWhisperTranscriber({ sampleRate: 16_000 });
      installPoster(transcriber, () => jsonResponse(status, { detail: 'nope' }));
      const result = await transcriber.transcribe(SEGMENT);
      expect(result.ok, `status ${status}`).toBe(false);
      expect(result.ok ? '' : result.reason, `status ${status}`).toMatch(pattern);
    }
  });

  it('reports distinct reasons for each error class', async () => {
    const reasons: string[] = [];
    for (const fail of [
      (): Promise<Response> => Promise.reject(new TypeError('network down')),
      (): Promise<Response> => Promise.resolve(jsonResponse(200, { nope: true })),
    ]) {
      const transcriber = new ServerWhisperTranscriber();
      installPoster(transcriber, fail);
      const result = await transcriber.transcribe(SEGMENT);
      expect(result.ok).toBe(false);
      reasons.push(result.ok ? '' : result.reason);
    }
    // Unreachable vs unreadable-success must not be confusable.
    expect(reasons[0]).toMatch(/unreachable/i);
    expect(reasons[0]).toMatch(/network down/);
    expect(reasons[1]).toMatch(/unreadable/i);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('includes the gateway error detail when one exists', async () => {
    const transcriber = new ServerWhisperTranscriber();
    installPoster(transcriber, () =>
      jsonResponse(401, { detail: 'INVALID_TOKEN: session expired' }),
    );
    const result = await transcriber.transcribe(SEGMENT);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('INVALID_TOKEN');
  });

  it('is inert by default: no post, honest disabled reason', async () => {
    const transcriber = new ServerWhisperTranscriber({ enabled: false });
    const calls = installPoster(transcriber, () => jsonResponse(200, { text: 'x' }));
    const result = await transcriber.transcribe(SEGMENT);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/disabled/i);
    expect(calls).toHaveLength(0);
  });
});

describe('default-off backward compatibility', () => {
  it('keeps the legacy resolver semantics untouched', async () => {
    // The pure float32→wav helper is unchanged and still usable directly.
    const blob = float32ToWavPcm16Blob(new Float32Array([0.5, -0.5]), 16_000);
    expect(blob.size).toBe(44 + 4);
    // Engine resolution with both env vars absent stays off (was: 'none').
    expect(resolveSttEngine(undefined, undefined)).toBe('off');
    expect(resolveSttEngine(undefined, false)).toBe('off');
  });
});
