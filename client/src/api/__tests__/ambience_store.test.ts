/**
 * Unit tests for src/api/ambience_store.ts — the iteration 17 gateway surface
 * GET/POST /api/v1/media/ambience (python/vtt_orchestrator/server.py,
 * list_ambience_presets / generate_ambience).
 *
 * Contracts pinned here:
 *  - LIST: GET with the `Authorization: Bearer` header (never a URL param);
 *    success parses `{ presets: [{slug,label,description,prompt,
 *    loop_seconds,cached}] }` exactly as AmbienceListResponse serializes it.
 *  - PLAY: POST `/api/v1/media/ambience/{slug}` with the Bearer header and NO
 *    request body; success is RAW audio/wav bytes read via arrayBuffer() and
 *    decoded through an AudioContext.
 *  - Honest outcome mapping: 403 MEDIA_AMBIENCE_FORBIDDEN → FORBIDDEN,
 *    404 UNKNOWN_AMBIENCE_PRESET → UNKNOWN_PRESET, 502
 *    MEDIA_GATEWAY_UNAVAILABLE and forwarded upstream statuses → REJECTED,
 *    fetch throw → UNREACHABLE, signed-out → NOT_SIGNED_IN with zero traffic.
 *  - Cache: a replayed slug resolves from the session Map WITHOUT refetching;
 *    identical concurrent requests share one wire call; failures (HTTP errors
 *    AND undecodable payloads) are never cached.
 *  - Loop playback: startAmbienceLoop only starts CACHED buffers, stops any
 *    previous bed first, and stop/is-playing report honestly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ambienceLibrarySize,
  clearAmbienceForTests,
  getCachedAmbience,
  isAmbienceLoopPlaying,
  listAmbiencePresets,
  playAmbience,
  startAmbienceLoop,
  stopAmbienceLoop,
  type AmbienceListResult,
  type AmbiencePlayResult,
} from '../ambience_store';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

/** Full AudioContext double: decodeAudioData plus the loop-playback graph. */
class FakeAudioContext {
  static failDecode = false;
  destination = { connect: () => undefined };
  decodeAudioData(
    bytes: ArrayBuffer,
    success: (b: unknown) => void,
    failure: (e: unknown) => void,
  ): void {
    if (FakeAudioContext.failDecode) {
      setTimeout(() => failure(new Error('not a wav')), 0);
    } else {
      setTimeout(() => success({ channels: 2, length: bytes.byteLength }), 0);
    }
  }
  createGain(): unknown {
    return { gain: { value: 1 }, connect: () => undefined };
  }
  createBufferSource(): unknown {
    return {
      buffer: null,
      loop: false,
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    };
  }
}

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return await respond(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function okJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
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
    ok: false,
    status,
    json: async () => ({ detail }),
  } as unknown as Response;
}

const LIST_PAYLOAD = {
  presets: [
    {
      slug: 'tavern-murmur',
      label: 'Tavern Murmur',
      description: 'Low crowd chatter, clinking tankards, a hearth crackling somewhere close.',
      prompt: 'warm tavern interior ambience',
      loop_seconds: 90,
      cached: true,
    },
    {
      slug: 'dungeon-drips',
      label: 'Dungeon Drips',
      description: 'Stone corridors, distant water, the occasional echo.',
      prompt: 'dripping dungeon cavern ambience',
      loop_seconds: 120,
      cached: false,
    },
  ],
};

beforeEach(() => {
  store.clear();
  FakeAudioContext.failDecode = false;
  clearAmbienceForTests();
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

describe('preset listing (GET /api/v1/media/ambience)', () => {
  it('GETs the catalog with the Bearer header and parses the AmbienceListResponse shape', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okJson(LIST_PAYLOAD));
    const result: AmbienceListResult = await listAmbiencePresets();
    expect(result.outcome).toBe('OK');
    if (result.outcome !== 'OK') throw new Error(`expected OK, got ${result.outcome}`);
    expect(result.presets).toHaveLength(2);
    // Field-for-field: the picker reads label/description/loop_seconds for the
    // cards and `cached` for its badge — anything less is guessing.
    expect(result.presets[0]).toEqual({
      slug: 'tavern-murmur',
      label: 'Tavern Murmur',
      description: 'Low crowd chatter, clinking tankards, a hearth crackling somewhere close.',
      prompt: 'warm tavern interior ambience',
      loop_seconds: 90,
      cached: true,
    });
    expect(calls[0].url).toBe('/api/v1/media/ambience');
    expect(calls[0].init?.method).toBe('GET');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('refuses to list without a session token and never touches the network', async () => {
    const calls = stubFetch(() => okJson(LIST_PAYLOAD));
    const result = await listAmbiencePresets();
    expect(result.outcome).toBe('NOT_SIGNED_IN');
    expect(calls).toHaveLength(0);
  });

  it('maps a gateway rejection to REJECTED with the verbatim detail', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => err(500, 'Internal Server Error'));
    const result = await listAmbiencePresets();
    expect(result).toMatchObject({ outcome: 'REJECTED', detail: 'Internal Server Error' });
  });

  it('resolves UNREACHABLE when fetch throws', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await listAmbiencePresets();
    expect(result.outcome).toBe('UNREACHABLE');
  });
});

describe('generation identity + payload contract (POST /api/v1/media/ambience/{slug})', () => {
  it('POSTs to the slug route with the Bearer header and no JSON body', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const result = await playAmbience('dungeon-drips');
    expect(result.outcome).toBe('OK');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/media/ambience/dungeon-drips');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    // Raw-bytes contract: no `{prompt}` body here — the slug IS the request.
    expect(calls[0].init?.body).toBeUndefined();
  });

  it('refuses without a session token and never touches the network', async () => {
    const calls = stubFetch(() => okWav());
    const result = await playAmbience('campfire');
    expect(result.outcome).toBe('NOT_SIGNED_IN');
    expect(calls).toHaveLength(0);
    expect(ambienceLibrarySize()).toBe(0);
  });
});

describe('honest play outcome surfaces', () => {
  it.each([
    [
      'FORBIDDEN',
      403,
      'MEDIA_AMBIENCE_FORBIDDEN: ambient soundscapes play to the whole table; only GM or admin seats may trigger them.',
    ],
    [
      'UNKNOWN_PRESET',
      404,
      "UNKNOWN_AMBIENCE_PRESET: no soundscape named 'nope'",
    ],
    ['REJECTED', 502, 'MEDIA_GATEWAY_UNAVAILABLE: the media gateway is unreachable.'],
    ['REJECTED', 429, 'Upstream synthesis bucket drained; retry shortly.'],
  ] as const)(
    'maps HTTP %i to %s with the verbatim gateway detail and caches nothing',
    async (outcome, status, detail) => {
      store.set('aethertable_token', TOKEN);
      stubFetch(() => err(status, detail));
      const result: AmbiencePlayResult = await playAmbience('battle-clash');
      expect(result).toMatchObject({ outcome, detail });
      expect(ambienceLibrarySize()).toBe(0);
      expect(getCachedAmbience('battle-clash')).toBeNull();
    },
  );

  it('surfaces the staff-only message so the panel can render it verbatim', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() =>
      err(
        403,
        'MEDIA_AMBIENCE_FORBIDDEN: ambient soundscapes play to the whole table; ' +
          'only GM or admin seats may trigger them.',
      ),
    );
    const result = await playAmbience('thunderstorm');
    if (result.outcome !== 'FORBIDDEN') {
      throw new Error(`expected FORBIDDEN, got ${result.outcome}`);
    }
    expect(result.detail).toMatch(/^MEDIA_AMBIENCE_FORBIDDEN/);
    expect(result.detail).toMatch(/only GM or admin seats may trigger them/i);
  });

  it('resolves UNREACHABLE when fetch throws mid-generation', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await playAmbience('forest-night');
    expect(result.outcome).toBe('UNREACHABLE');
    expect(getCachedAmbience('forest-night')).toBeNull();
  });

  it('is honest about decode failure: 200 with undecodable bytes is REJECTED and caches nothing', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => okWav());
    FakeAudioContext.failDecode = true;
    const result = await playAmbience('campfire');
    expect(result).toMatchObject({ outcome: 'REJECTED' });
    expect(ambienceLibrarySize()).toBe(0);
    expect(getCachedAmbience('campfire')).toBeNull();
  });
});

describe('decoded-buffer cache + in-flight coalescing', () => {
  it('replays a generated slug from cache without refetching', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const first = await playAmbience('tavern-murmur');
    expect(first).toMatchObject({ outcome: 'OK', cached: false });
    const second = await playAmbience(' tavern-murmur '); // trimmed to the same key
    expect(second).toMatchObject({ outcome: 'OK', cached: true });
    expect(calls).toHaveLength(1); // one wire call, two results
    expect(getCachedAmbience('tavern-murmur')).not.toBeNull();
    expect(ambienceLibrarySize()).toBe(1);
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
      playAmbience('thunderstorm'),
      playAmbience('thunderstorm'),
    ]);
    setTimeout(release, 0);
    const [a, b] = await pending;
    expect(a).toMatchObject({ outcome: 'OK' });
    expect(b).toMatchObject({ outcome: 'OK' });
    expect(calls).toHaveLength(1);
  });

  it('never caches a failure: a rejected generation retries the wire and can then succeed', async () => {
    store.set('aethertable_token', TOKEN);
    let attempts = 0;
    const calls = stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? err(502, 'MEDIA_GATEWAY_UNAVAILABLE: down.') : okWav();
    });
    const failed = await playAmbience('campfire');
    expect(failed.outcome).toBe('REJECTED');
    expect(ambienceLibrarySize()).toBe(0);
    const retried = await playAmbience('campfire');
    expect(retried).toMatchObject({ outcome: 'OK', cached: false });
    expect(calls).toHaveLength(2); // the failure did NOT satisfy the replay
    expect(ambienceLibrarySize()).toBe(1);
  });
});

describe('loop playback helpers (Web Audio BufferSource + GainNode)', () => {
  it('starts only cached buffers, reports playing honestly, and stops cleanly', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => okWav());
    await playAmbience('tavern-murmur');

    // Never cached → refuse rather than fake a bed.
    expect(startAmbienceLoop('dungeon-drips')).toBe(false);
    expect(isAmbienceLoopPlaying()).toBe(false);

    expect(startAmbienceLoop('tavern-murmur')).toBe(true);
    expect(isAmbienceLoopPlaying()).toBe(true);
    expect(isAmbienceLoopPlaying('tavern-murmur')).toBe(true);
    expect(isAmbienceLoopPlaying('campfire')).toBe(false);

    expect(stopAmbienceLoop()).toBe(true);
    expect(isAmbienceLoopPlaying()).toBe(false);
    expect(stopAmbienceLoop()).toBe(false); // nothing left to stop
  });

  it('switching beds stops the previous one so exactly one loop runs', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => okWav());
    await playAmbience('tavern-murmur');
    await playAmbience('campfire');

    expect(startAmbienceLoop('tavern-murmur')).toBe(true);
    expect(startAmbienceLoop('campfire')).toBe(true);
    expect(isAmbienceLoopPlaying('tavern-murmur')).toBe(false);
    expect(isAmbienceLoopPlaying('campfire')).toBe(true);
  });

  it('refuses to start a loop for a slug that was never decoded', async () => {
    // No generation at all — the store must not fake a bed from thin air.
    expect(startAmbienceLoop('never-generated')).toBe(false);
    expect(isAmbienceLoopPlaying()).toBe(false);
  });

  it('resolves REJECTED when Web Audio is entirely unavailable in the browser', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => okWav());
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    const result = await playAmbience('tavern-murmur');
    expect(result).toMatchObject({ outcome: 'REJECTED' });
    if (result.outcome === 'REJECTED') {
      expect(result.detail).toMatch(/web audio/i);
    }
    expect(getCachedAmbience('tavern-murmur')).toBeNull();
  });
});
