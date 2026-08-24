/**
 * Unit tests for the identity contract of src/api/rules_engine.ts.
 *
 * Audit remediation regression guard: every browser-originated
 * /api/v1/engine/* call must carry the caller's stored session token
 * (?token= like heal/rest), and a signed-out caller must NEVER hit the
 * gateway anonymously — dice helpers fall back to null (local dice) and
 * mutating ones surface an explicit NOT_AUTHENTICATED rejection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { engineAttack, engineCheck, engineGenerateMap } from '../rules_engine';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

type FetchCall = { url: string; init: RequestInit };

function stubFetch(respond: () => { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: (init ?? {}) as RequestInit });
    return respond();
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

beforeEach(() => {
  store.clear();
  // Minimal sessionStorage stand-in (the vitest env is node).
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

describe('engine proxy identity contract', () => {
  it('never dials the gateway when signed out (local-dice fallback)', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    await expect(engineCheck({ modifier: 3, dc: 12 })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('creates an attributed session, then attacks through it (?token= on both)', async () => {
    store.set('aethertable_token', TOKEN);
    const calls: FetchCall[] = [];
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: (init ?? {}) as RequestInit });
        n += 1;
        return n === 1
          ? { ok: true, json: async () => ({ session_id: 'sess-1' }) }
          : {
              ok: true,
              json: async () => ({ natural_roll: 12, is_hit: true, total_damage: 5 }),
            };
      }),
    );
    await expect(
      engineAttack({ attackerId: 'thorin', targetId: 'orc' }),
    ).resolves.toMatchObject({ is_hit: true });
    expect(calls).toHaveLength(2); // session create + attack, both attributed
    for (const call of calls) {
      expect(call.url).toContain(`token=${encodeURIComponent(TOKEN)}`);
      expect(call.init.method).toBe('POST');
    }
    expect(calls[0].url).toContain('/api/v1/engine/session?');
    expect(calls[1].url).toContain('/api/v1/engine/attack?');
  });

  it('appends ?token= to the check proxy call', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ roll: 14, modifier: 3, total: 17, dc: 12, outcome: 'SUCCESS' }),
    }));
    await expect(engineCheck({ modifier: 3, dc: 12 })).resolves.toMatchObject({
      total: 17,
    });
    expect(calls[0].url).toBe(`/api/v1/engine/check?token=${encodeURIComponent(TOKEN)}`);
  });

  it('refuses map generation outright when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const outcome = await engineGenerateMap({ width: 16, height: 12 });
    expect(outcome).toEqual({
      kind: 'rejected',
      status: 401,
      code: 'NOT_AUTHENTICATED',
      message: 'Sign in to generate maps through the authoritative engine.',
    });
    expect(calls).toHaveLength(0);
  });

  it('appends ?token= to the map generation proxy call', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ width: 16, height: 12, tiles: [[1]] }),
    }));
    const outcome = await engineGenerateMap({ width: 16, height: 12, seed: 42 });
    expect(outcome.kind).toBe('applied');
    expect(calls[0].url).toBe(`/api/v1/engine/map/generate?token=${encodeURIComponent(TOKEN)}`);
  });

  it('treats an anonymous 401 from the gateway as a rejection, not a crash', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Missing session token' }),
    }));
    const outcome = await engineGenerateMap({ width: 16, height: 12 });
    expect(outcome).toMatchObject({ kind: 'rejected', status: 401 });
    expect(calls).toHaveLength(1);
  });
});
