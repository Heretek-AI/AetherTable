/**
 * Unit tests for the identity contract of src/api/rules_engine.ts.
 *
 * Audit remediation regression guard (F14): every browser-originated HTTP
 * /api/v1/engine/* call must carry the caller's stored session token in the
 * Authorization: Bearer header — NEVER in the URL, which proxy/access logs
 * record verbatim. A signed-out caller must NEVER hit the gateway anonymously:
 * dice helpers fall back to null (local dice) and mutating ones surface an
 * explicit NOT_AUTHENTICATED rejection. WebSocket clients are exempt (they
 * keep ?token= because browsers cannot set headers on the WS handshake).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  engineAttack,
  engineCastSpell,
  engineCheck,
  engineDash,
  engineDisengage,
  engineDodge,
  engineGenerateMap,
  engineGrapple,
  engineHeal,
  engineHelp,
  engineOffhandAttack,
  engineRest,
  engineSessionEntities,
  engineSessionRoster,
  engineShove,
  engineStabilize,
} from '../rules_engine';

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

  it('creates an attributed session, then attacks through it (Bearer header on both)', async () => {
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
      expect((call.init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN}`,
      );
      expect(call.url).not.toContain('token=');
      expect(call.init.method).toBe('POST');
    }
    expect(calls[0].url).toBe('/api/v1/engine/session');
    expect(calls[1].url).toBe('/api/v1/engine/attack');
  });

  it('sends the Bearer header (never a URL token) to the check proxy', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ roll: 14, modifier: 3, total: 17, dc: 12, outcome: 'SUCCESS' }),
    }));
    await expect(engineCheck({ modifier: 3, dc: 12 })).resolves.toMatchObject({
      total: 17,
    });
    expect(calls[0].url).toBe('/api/v1/engine/check');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
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

  it('sends the Bearer header (never a URL token) to the map generation proxy', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ width: 16, height: 12, tiles: [[1]] }),
    }));
    const outcome = await engineGenerateMap({ width: 16, height: 12, seed: 42 });
    expect(outcome.kind).toBe('applied');
    expect(calls[0].url).toBe('/api/v1/engine/map/generate');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
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

  it('carries the Bearer header on EVERY mutating helper and no URL token anywhere (F14 sweep)', async () => {
    store.set('aethertable_token', TOKEN);
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: (init ?? {}) as RequestInit });
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }),
    );
    // cache-buster: ensureEngineSession memoizes its id across tests
    await engineHeal({ sessionId: 's1', entityId: 'e1', amount: 5 });
    await engineRest({ sessionId: 's1', kind: 'short' });
    await engineGrapple({ sessionId: 's1', attackerId: 'a', defenderId: 'b', defenderSkill: 'athletics' });
    await engineShove({ sessionId: 's1', attackerId: 'a', defenderId: 'b', shoveEffect: 'prone' });
    await engineDodge({ sessionId: 's1', entityId: 'e1' });
    await engineDash({ sessionId: 's1', entityId: 'e1' });
    await engineDisengage({ sessionId: 's1', entityId: 'e1' });
    await engineStabilize({ sessionId: 's1', healerId: 'h', targetId: 't' });
    await engineOffhandAttack({ sessionId: 's1', attackerId: 'a', targetId: 'b' });
    await engineHelp({ sessionId: 's1', helperId: 'h', targetEntityId: 't' });
    await engineCastSpell({
      sessionId: 's1',
      casterId: 'c',
      spell: {
        spell_id: 'magic_missile',
        name: 'Magic Missile',
        level: 1,
        school: 'evocation',
        casting_time: '1 action',
        range_feet: 120,
        area_of_effect_shape: null,
        area_of_effect_size_feet: null,
        verbal_component: true,
        somatic_component: true,
        material_component_desc: null,
        material_component_costly: false,
        concentration: false,
        ritual: false,
        duration_concentration: false,
        duration: 'Instantaneous',
      } as never,
      castLevel: 1,
    });
    await engineSessionRoster('s1');
    await engineSessionEntities('s1');
    expect(calls.length).toBeGreaterThanOrEqual(13);
    for (const call of calls) {
      expect(call.url.startsWith('/api/v1/')).toBe(true);
      // The load-bearing assertion: NO HTTP request may put the raw token in
      // the URL (proxy/access-log leak) — identity rides the header only.
      expect(call.url).not.toContain('token=');
      expect((call.init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN}`,
      );
    }
  });
});
