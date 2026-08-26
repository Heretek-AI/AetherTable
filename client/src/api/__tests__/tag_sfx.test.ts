/**
 * Unit tests for src/api/tag_sfx.ts — the 3D-positioned "Tag SFX" lane
 * (Loop 3 iteration 31).
 *
 * Contracts pinned here:
 *  - TAGGING REUSES the POST /api/v1/media/sfx gateway client (`generateSfx`
 *    from sfx_library.ts), so Bearer auth, decoded-AudioBuffer caching,
 *    in-flight coalescing and "failures are never cached" are inherited
 *    guarantees — this suite pins that the PLAYBACK side (the spatial player)
 *    is only ever invoked for a successfully-decoded cue, and that the
 *    request coordinates reach the player verbatim.
 *  - GATE: `isTagSfxAllowed(role, spectatorMode)` — staff (gm/admin) seats and
 *    anonymous solo sessions may tag; player and spectator seats never do
 *    (spectators are denied even if a stale role claims staff).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TAG_SFX_PROMPT,
  clearTagSfxForTests,
  isTagSfxAllowed,
  playTagSfx,
  type TagSfxPlayer,
} from '../tag_sfx';
import { clearSfxLibraryForTests, sfxLibrarySize } from '../sfx_library';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

/** Minimal AudioContext double — only decodeAudioData is exercised here. */
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
      // Real AudioBuffers expose numberOfChannels; the tag lane reads it to
      // report the mono-vs-stereo fact honestly on each PLAYED result.
      setTimeout(() => success({ numberOfChannels: 1, length: bytes.byteLength }), 0);
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
  clearTagSfxForTests();
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

describe('tag SFX: auth / payload / positional routing', () => {
  it('refuses without a session token, never touching the network or the player', async () => {
    const calls = stubFetch(() => okWav());
    const player = vi.fn<TagSfxPlayer>();
    const result = await playTagSfx(
      { prompt: TAG_SFX_PROMPT, x: 7, y: 3, elevationFeet: 0 },
      player,
    );
    expect(result).toMatchObject({ outcome: 'NOT_SIGNED_IN' });
    expect(calls).toHaveLength(0);
    expect(player).not.toHaveBeenCalled();
  });

  it('POSTs the tag prompt with a Bearer header and routes the decoded buffer to the position', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const player = vi.fn<TagSfxPlayer>(() => true);
    const result = await playTagSfx(
      { prompt: TAG_SFX_PROMPT, x: 3, y: 8, elevationFeet: 15 },
      player,
    );
    expect(result).toMatchObject({ outcome: 'PLAYED', cached: false, channels: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/media/sfx');
    expect(calls[0].init?.method).toBe('POST');
    // Identity rides the Authorization header, never the query string.
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ prompt: TAG_SFX_PROMPT });
    // The decoded cue + the token's board coordinates reach the player verbatim.
    expect(player).toHaveBeenCalledTimes(1);
    const [buffer, x, y, elevation] = player.mock.calls[0];
    expect(buffer).toBeTruthy();
    expect(x).toBe(3);
    expect(y).toBe(8);
    expect(elevation).toBe(15);
  });

  it('an anonymous solo seat may tag (matched by the gm/admin gate standing in for staff)', async () => {
    // No role plumbed and no token: still a NOT_SIGNED_IN network refusal —
    // the token gate is separate from the ROLE gate which is canvas-side.
    expect(isTagSfxAllowed(undefined, false)).toBe(true);
  });
});

describe('tag SFX: cache / in-flight honesty inherited from generateSfx', () => {
  it('replays a cached prompt instantly and re-positions the spatial player', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const player = vi.fn<TagSfxPlayer>(() => true);
    const first = await playTagSfx({ prompt: TAG_SFX_PROMPT, x: 0, y: 0 }, player);
    expect(first).toMatchObject({ outcome: 'PLAYED', cached: false });

    const second = await playTagSfx({ prompt: TAG_SFX_PROMPT, x: 11, y: 9 }, player);
    expect(second).toMatchObject({ outcome: 'PLAYED', cached: true });
    expect(calls).toHaveLength(1); // one wire call, two spatial plays
    const [buffer, x, y] = player.mock.calls[1];
    expect(buffer).toBeTruthy();
    expect(x).toBe(11);
    expect(y).toBe(9);
  });

  it('shares one wire call between identical concurrent tags (in-flight coalescing)', async () => {
    store.set('aethertable_token', TOKEN);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = stubFetch(async () => {
      await gate;
      return okWav();
    });
    const player = vi.fn<TagSfxPlayer>(() => true);
    const pending = Promise.all([
      playTagSfx({ prompt: TAG_SFX_PROMPT, x: 1, y: 1 }, player),
      playTagSfx({ prompt: TAG_SFX_PROMPT, x: 1, y: 1 }, player),
    ]);
    setTimeout(release, 0);
    const [a, b] = await pending;
    // Both await the SAME in-flight generation (one wire call); the shared
    // promise resolves once with `cached: false`, and both players fire for
    // their own spatial position.
    expect(a).toMatchObject({ outcome: 'PLAYED' });
    expect(b).toMatchObject({ outcome: 'PLAYED' });
    expect(calls).toHaveLength(1);
    expect(player).toHaveBeenCalledTimes(2);
  });
});

describe('tag SFX: honest failures never reach the player or the cache', () => {
  it.each([
    ['FORBIDDEN', 403, 'MEDIA_SFX_FORBIDDEN: sound effects play to the whole table; only GM or admin seats may trigger them.'],
    ['RATE_LIMITED', 429, 'Upstream synthesis bucket drained; retry shortly.'],
    ['REJECTED', 422, 'prompt: String should have at most 300 characters'],
  ] as const)(
    'maps HTTP %i to %s, does not call the player, and caches nothing',
    async (outcome, status, detail) => {
      store.set('aethertable_token', TOKEN);
      stubFetch(() => err(status, detail));
      const player = vi.fn<TagSfxPlayer>();
      const result = await playTagSfx({ prompt: TAG_SFX_PROMPT, x: 5, y: 5 }, player);
      expect(result).toMatchObject({ outcome, detail });
      expect(player).not.toHaveBeenCalled();
      expect(sfxLibrarySize()).toBe(0);
    },
  );

  it('is honest about decode failure: REJECTED, player untouched, cache empty', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => okWav());
    FakeAudioContext.failDecode = true;
    const player = vi.fn<TagSfxPlayer>();
    const result = await playTagSfx({ prompt: TAG_SFX_PROMPT, x: 5, y: 5 }, player);
    expect(result).toMatchObject({ outcome: 'REJECTED' });
    if (result.outcome === 'REJECTED') {
      expect(result.detail).toMatch(/could not be decoded/i);
    }
    expect(player).not.toHaveBeenCalled();
    expect(sfxLibrarySize()).toBe(0);
  });

  it('reports NOT_PLAYED when the spatial engine refuses the buffer (no silent fake)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => okWav());
    const result = await playTagSfx(
      { prompt: TAG_SFX_PROMPT, x: 2, y: 2 },
      () => false, // player refused (e.g. muted / context not running)
    );
    expect(result).toMatchObject({ outcome: 'NOT_PLAYED', reason: 'BUSY' });
  });
});

describe('tag SFX: GM-only gate', () => {
  it('allows staff and anonymous-solo seats; blocks player and spectator seats', () => {
    expect(isTagSfxAllowed('gm', false)).toBe(true);
    expect(isTagSfxAllowed('admin', false)).toBe(true);
    expect(isTagSfxAllowed(undefined, false)).toBe(true); // anonymous solo table
    expect(isTagSfxAllowed('player', false)).toBe(false);
    expect(isTagSfxAllowed('spectator', false)).toBe(false);
  });

  it('always denies a spectator seat, even under a stale staff role', () => {
    expect(isTagSfxAllowed('gm', true)).toBe(false);
    expect(isTagSfxAllowed('player', true)).toBe(false);
  });
});