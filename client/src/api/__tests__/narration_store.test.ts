/**
 * Unit tests for src/api/narration_store.ts — the POST /api/v1/media/narrate +
 * GET /api/v1/media/narrations client (Loop 3 iteration 8).
 *
 * Contracts pinned here (gateway: python/vtt_orchestrator/server.py
 * media_narrate / list_media_narrations):
 *  - Auth/payload shape: HMAC token rides `Authorization: Bearer` (never a URL
 *    param), JSON body `{ text, voice?, session_id? }` — `voice` and
 *    `session_id` OMITTED when unset so the server's MEDIA_TTS_VOICE default
 *    and no-attribution path stay reachable; text matches the default
 *    str(1..2000) cap.
 *  - Success is RAW audio/wav bytes read via arrayBuffer(), staged as an
 *    object URL for a plain-Audio element (no Web Audio decode here).
 *  - Cache: a second request for the same text+voice replays from the session
 *    Map WITHOUT refetching; identical concurrent requests share one wire
 *    call; a different voice is a DIFFERENT cache entry.
 *  - Honest error surface: 403 NARRATION_NOT_A_PARTICIPANT → FORBIDDEN,
 *    429 → RATE_LIMITED, 422/5xx → REJECTED, throw → UNREACHABLE, signed-out →
 *    NOT_SIGNED_IN with zero network traffic (both endpoints).
 *  - List typing: rows are surfaced verbatim with createdAtRaw left as the
 *    dual number|string the two storage backends actually produce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NARRATION_TEXT_MAX_CHARS,
  VOICE_PRESETS,
  clearNarrationCacheForTests,
  getCachedNarration,
  listNarrations,
  narrateText,
  narrationCacheSize,
  type NarrateResult,
} from '../narration_store';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

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
  clearNarrationCacheForTests();
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearNarrationCacheForTests();
});

describe('narrate payload + auth contract', () => {
  it('refuses without a session token and never touches the network', async () => {
    const calls = stubFetch(() => okWav());
    const result = await narrateText('The dragon stirs.');
    expect(result.outcome).toBe('NOT_SIGNED_IN');
    expect(calls).toHaveLength(0);
    expect(narrationCacheSize()).toBe(0);
  });

  it('POSTs JSON {text} to /api/v1/media/narrate with the Bearer header, omitting unset optionals', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const result = await narrateText('Roll initiative!');
    expect(result.outcome).toBe('OK');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/media/narrate');
    expect(calls[0].init?.method).toBe('POST');
    // Identity rides the Authorization header, never the query string
    // (proxies log URLs verbatim — same rule as lore/sfx).
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    // voice/session_id absent ⇒ server-side defaults + unattributed log row.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'Roll initiative!' });
  });

  it('forwards voice and session_id when given, trimmed', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    await narrateText('The gates groan. ', { voice: ' bf_emma ', sessionId: 'sess-42' });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      text: 'The gates groan.',
      voice: 'bf_emma',
      session_id: 'sess-42',
    });
  });

  it('rejects an out-of-contract empty script locally (MediaNarrateRequest min_length=1)', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const result = await narrateText('   ');
    expect(result.outcome).toBe('REJECTED');
    expect(calls).toHaveLength(0);
  });

  it(`rejects an over-cap script locally (${NARRATION_TEXT_MAX_CHARS} chars)`, async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const result = await narrateText('x'.repeat(NARRATION_TEXT_MAX_CHARS + 1));
    expect(result).toMatchObject({ outcome: 'REJECTED' });
    if (result.outcome === 'REJECTED') {
      expect(result.detail).toMatch(/2000 characters/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('cache behavior (text+voice keyed)', () => {
  it('replays a spoken script from cache without refetching', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    const first: NarrateResult = await narrateText('You hear footsteps above.');
    expect(first).toMatchObject({ outcome: 'OK', cached: false });
    if (first.outcome === 'OK') expect(first.audioUrl).toMatch(/^blob:/);
    const second = await narrateText(' You hear footsteps above. ');
    expect(second).toMatchObject({ outcome: 'OK', cached: true });
    if (second.outcome === 'OK' && first.outcome === 'OK') {
      expect(second.audioUrl).toBe(first.audioUrl); // same object URL replayed
    }
    expect(calls).toHaveLength(1); // one wire call, two results
    expect(getCachedNarration('You hear footsteps above.', '')).not.toBeNull();
    expect(narrationCacheSize()).toBe(1);
  });

  it('treats a different voice as a different cache entry', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => okWav());
    await narrateText('Same words, new throat.', { voice: 'af_sky' });
    await narrateText('Same words, new throat.', { voice: 'bf_emma' });
    expect(calls).toHaveLength(2);
    expect(narrationCacheSize()).toBe(2);
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
      narrateText('A long, slow narration.'),
      narrateText('A long, slow narration.'),
    ]);
    // Release only after both calls are parked on the shared gate.
    setTimeout(release, 0);
    const [a, b] = await pending;
    expect(a).toMatchObject({ outcome: 'OK' });
    // Both callers resolve off the SAME shared job — neither pays a second
    // wire call, and the shared promise reports one fresh synthesis.
    expect(b).toMatchObject({ outcome: 'OK' });
    expect(calls).toHaveLength(1);
  });
});

describe('honest error surfaces', () => {
  it.each([
    [
      'FORBIDDEN',
      403,
      'NARRATION_NOT_A_PARTICIPANT: only session participants (via a lobby bound to that session) or GMs may narrate into session sess-42.',
    ],
    ['RATE_LIMITED', 429, 'Upstream synthesis bucket drained; retry shortly.'],
    ['REJECTED', 422, 'text exceeds MEDIA_NARRATION_MAX_CHARS (2000 characters)'],
  ] as const)('maps HTTP %i to %s with the verbatim gateway detail', async (outcome, status, detail) => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => err(status, detail));
    const result = await narrateText('The dragon stirs.', { sessionId: 'sess-42' });
    expect(result).toMatchObject({ outcome, detail });
    expect(narrationCacheSize()).toBe(0);
  });

  it('resolves UNREACHABLE when fetch throws', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await narrateText('The dragon stirs.');
    expect(result.outcome).toBe('UNREACHABLE');
  });

  it('is honest about an unreadable 200 body: REJECTED and caches nothing', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() =>
      ({
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          throw new TypeError('stream aborted');
        },
      }) as unknown as Response,
    );
    const result = await narrateText('The dragon stirs.');
    expect(result).toMatchObject({ outcome: 'REJECTED' });
    expect(narrationCacheSize()).toBe(0);
    expect(getCachedNarration('The dragon stirs.', '')).toBeNull();
  });
});

describe('listNarrations', () => {
  it('refuses signed-out reads with zero network traffic', async () => {
    const calls = stubFetch(() =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ session_id: 's', count: 0, narrations: [] }),
      }) as unknown as Response,
    );
    const result = await listNarrations('sess-42');
    expect(result.outcome).toBe('NOT_SIGNED_IN');
    expect(calls).toHaveLength(0);
  });

  it('GETs the log with the Bearer header and an encoded session_id query', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'sess 42',
          count: 1,
          narrations: [
            {
              narration_id: 'nar_00000001',
              user_id: 'u-gm',
              voice: 'af_sky',
              text_snippet: 'The tavern falls silent.',
              created_at: 1756100000.5,
            },
          ],
        }),
      }) as unknown as Response,
    );
    const result = await listNarrations('sess 42');
    expect(result.outcome).toBe('OK');
    expect(calls[0].url).toBe('/api/v1/media/narrations?session_id=sess%2042');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    if (result.outcome !== 'OK') throw new Error(`expected OK, got ${result.outcome}`);
    expect(result.response.count).toBe(1);
    expect(result.response.narrations[0]).toEqual({
      narration_id: 'nar_00000001',
      user_id: 'u-gm',
      voice: 'af_sky',
      text_snippet: 'The tavern falls silent.',
      createdAtRaw: null, // wire key is created_at; the alias stays unset here
    });
  });

  it('maps 403 NARRATION_LIST_FORBIDDEN to FORBIDDEN with the verbatim detail', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() =>
      err(
        403,
        'NARRATION_LIST_FORBIDDEN: only session participants (via a lobby bound to that session) or GMs may read the narration log of session other-sess.',
      ),
    );
    const result = await listNarrations('other-sess');
    expect(result).toMatchObject({
      outcome: 'FORBIDDEN',
      detail: expect.stringMatching(/^NARRATION_LIST_FORBIDDEN/),
    });
  });

  it('maps 401/429/5xx to NOT_SIGNED_IN/RATE_LIMITED/REJECTED respectively', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => err(500, 'boom'));
    expect(await listNarrations('s')).toMatchObject({ outcome: 'REJECTED', detail: 'boom' });
  });

  it('resolves UNREACHABLE when fetch throws', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect((await listNarrations('s')).outcome).toBe('UNREACHABLE');
  });
});

describe('voice presets', () => {
  it('exposes exactly the four panel preset voices', () => {
    expect([...VOICE_PRESETS]).toEqual(['af_sky', 'am_echo', 'am_michael', 'bf_emma']);
  });
});
