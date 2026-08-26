/**
 * Unit tests for src/api/sfx_library.ts — the POST /api/v1/media/sfx client.
 *
 * Contracts pinned here (gateway: python/vtt_orchestrator/server.py media_sfx):
 *  - Auth/payload shape: HMAC token rides `Authorization: Bearer` (never a URL
 *    param), JSON body `{ prompt }`, matching MediaSfxRequest's str(1..300).
 *  - Success is RAW audio/wav bytes read via arrayBuffer(), decoded through a
 *    lazily-created AudioContext.
 *  - Cache: a second request for the same prompt replays from the session Map
 *    WITHOUT refetching; identical concurrent requests share one wire call.
 *  - Honest error surface: 403 MEDIA_SFX_FORBIDDEN → FORBIDDEN (the GM-only
 *    notice), 429 → RATE_LIMITED, 422/5xx → REJECTED, throw → UNREACHABLE,
 *    signed-out → NOT_SIGNED_IN with zero network traffic.
 *  - Decode honesty: a 200 whose body is not decodable WAV resolves REJECTED
 *    and caches NOTHING rather than pretending the cue exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SFX_PRESETS,
  clearSfxLibraryForTests,
  generateSfx,
  getCachedSfx,
  playCachedSfx,
  sfxLibrarySize,
  type SfxResult,
} from '../sfx_library';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

/** Minimal AudioContext double: only decodeAudioData is exercised here. */
class FakeAudioContext {
  static failDecode = false;
  decodeAudioData(
    bytes: ArrayBuffer,
    success: (b: unknown) => void,
    failure: (e: unknown) => void,
  ): void {
    if (FakeAudioContext.failDecode) {
      setTimeout(() => failure(new Error('not a wav')), 0);
    } else {
      setTimeout(() => success({ channels: 1, length: bytes.byteLength }), 0);
    }
  }
}

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return await respond();
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function okWav(body = new TextEncoder().encode('RIFFfakewav').buffer as ArrayBuffer): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => body,
  } as unknown as Response;
}

function err(status: number, detail: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ detail }),
  } as unknown as Response;
}

beforeEach(() => {
  store.clear();
  FakeAudioContext.failDecode = false;
  clearSfxLibraryForTests();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
  (globalThis as unknown as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('sfx generation identity + payload contract', () => {
  it('refuses without a session token and never touches the network', async () => {
    const calls = stubFetch(() => okWav());
    const result = await generateSfx('dragon roar');
    expect(result.outcome).toBe('NOT_SIGNED_IN');
    expect(calls).toHaveLength(0);
    expect(sfxLibrarySize()).toBe(0);
  });

  it('POSTs JSON {prompt} to /api/v1/media/sfx with the Bearer header', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const result = await generateSfx('torch crackle');
    expect(result.outcome).toBe('OK');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/media/sfx');
    expect(calls[0].init?.method).toBe('POST');
    // Identity rides the Authorization header, never the query string
    // (proxies log URLs verbatim — same rule as lore/assert).
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ prompt: 'torch crackle' });
  });

  it('rejects an out-of-contract empty prompt locally (MediaSfxRequest str(1..300))', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const result = await generateSfx('   ');
    expect(result).toMatchObject({ outcome: 'REJECTED' });
    expect(calls).toHaveLength(0);
  });
});

describe('cache behavior', () => {
  it('replays a generated prompt from cache without refetching', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const first: SfxResult = await generateSfx('dungeon drip');
    expect(first).toMatchObject({ outcome: 'OK', cached: false });
    const second = await generateSfx(' dungeon drip '); // trimmed to the same key
    expect(second).toMatchObject({ outcome: 'OK', cached: true });
    expect(calls).toHaveLength(1); // one wire call, two results
    expect(getCachedSfx('dungeon drip')).not.toBeNull();
    expect(sfxLibrarySize()).toBe(1);
  });

  it('shares one wire call between identical concurrent requests', async () => {
    store.set('aethertable_token', TOKEN);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = stubFetch(async () => {
      await gate;
      return okWav();
    });
    const pending = Promise.all([
      generateSfx('stone door grinding'),
      generateSfx('stone door grinding'),
    ]);
    // Release only after both calls are parked on the shared gate.
    setTimeout(release, 0);
    const [a, b] = await pending;
    expect(a).toMatchObject({ outcome: 'OK' });
    expect(b).toMatchObject({ outcome: 'OK' });
    expect(calls).toHaveLength(1);
  });
});

describe('honest error surfaces', () => {
  it.each([
    [
      'FORBIDDEN',
      403,
      'MEDIA_SFX_FORBIDDEN: sound effects play to the whole table; only GM or admin seats may trigger them.',
    ],
    ['RATE_LIMITED', 429, 'Upstream synthesis bucket drained; retry shortly.'],
    ['REJECTED', 422, 'prompt: String should have at most 300 characters'],
  ] as const)('maps HTTP %i to %s with the verbatim gateway detail', async (outcome, status, detail) => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => err(status, detail));
    const result = await generateSfx('dragon roar');
    expect(result).toMatchObject({ outcome, detail });
    expect(sfxLibrarySize()).toBe(0);
  });

  it('surfaces the GM-only message so the panel can render it verbatim', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() =>
      err(
        403,
        'MEDIA_SFX_FORBIDDEN: sound effects play to the whole table; ' +
          'only GM or admin seats may trigger them.',
      ),
    );
    const result = await generateSfx('stone door grinding');
    if (result.outcome !== 'FORBIDDEN') {
      throw new Error(`expected FORBIDDEN, got ${result.outcome}`);
    }
    expect(result.detail).toMatch(/^MEDIA_SFX_FORBIDDEN/);
    expect(result.detail).toMatch(/only GM or admin seats/i);
  });

  it('resolves UNREACHABLE when fetch throws', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const result = await generateSfx('dragon roar');
    expect(result.outcome).toBe('UNREACHABLE');
  });

  it('is honest about decode failure: 200 with undecodable bytes is REJECTED and caches nothing', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => okWav());
    FakeAudioContext.failDecode = true;
    const result = await generateSfx('torch crackle');
    expect(result).toMatchObject({ outcome: 'REJECTED' });
    if (result.outcome === 'REJECTED') {
      expect(result.detail).toMatch(/could not be decoded/i);
    }
    expect(sfxLibrarySize()).toBe(0);
    expect(getCachedSfx('torch crackle')).toBeNull();
  });
});

describe('presets + fallback playback helper', () => {
  it('exposes exactly the four panel preset chips', () => {
    expect([...SFX_PRESETS]).toEqual([
      'stone door grinding',
      'torch crackle',
      'dungeon drip',
      'dragon roar',
    ]);
  });

  it('refuses to play a prompt that was never generated (no silent fake)', () => {
    expect(playCachedSfx('never generated')).toBe(false);
  });
});
