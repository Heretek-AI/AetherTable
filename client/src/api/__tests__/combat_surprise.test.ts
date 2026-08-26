/**
 * Iteration 34 (Loop 3) — SRD Surprise wire contract.
 *
 * Pinned contracts:
 *  - POST /api/v1/engine/combat/surprise carries the ids-only triple
 *    {session_id, entity_id, surprised} — exactly the engine's
 *    SurpriseAdjudicationReq (round economy, the first-round window and the
 *    surprised set itself are all engine-owned; the client never guesses who
 *    is ambushed).
 *  - Every call rides the stored token as Authorization: Bearer; signed-out
 *    callers get NOT_AUTHENTICATED without touching the network.
 *  - Engine rejections surface VERBATIM as machine codes — SURPRISE_WINDOW_CLOSED,
 *    NOT_IN_COMBAT, ENTITY_DELAYED, ENTITY_NOT_FOUND, FORBIDDEN_ROLE — never
 *    rewritten into friendlier fiction.
 *  - surprisedIdsFromSnapshot reads the engine's `combat.surprised` array out
 *    of a RAW projected session-state body defensively (App feeds it the full
 *    snapshot; the bare route response also carries a top-level `surprised`):
 *    whatever the projection did not expose simply means "nobody surprised",
 *    never a guessed list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSurprised,
  setSurprised,
  surprisedIdsFromSnapshot,
} from '../combat_surprise';

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

describe('setSurprised wire contract', () => {
  it('posts the exact SurpriseAdjudicationReq body with the Bearer header', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'SURPRISE_GRANTED',
        sequence_id: 9,
        changed: true,
        entity_id: 'goblin_1',
        round: 1,
        surprised: ['goblin_1'],
      }),
    }));
    const outcome = await setSurprised({ sessionId: 'sess-1', entityId: 'goblin_1' });
    expect(outcome.kind).toBe('applied');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/engine/combat/surprise');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      session_id: 'sess-1',
      entity_id: 'goblin_1',
      surprised: true,
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('passes the engine success payload through verbatim', async () => {
    store.set('aethertable_token', TOKEN);
    const body = {
      status: 'SURPRISE_GRANTED',
      sequence_id: 9,
      changed: true,
      entity_id: 'goblin_1',
      round: 1,
      surprised: ['goblin_1'],
    };
    stubFetch(() => ({ ok: true, json: async () => body }));
    const outcome = await setSurprised({ sessionId: 'sess-1', entityId: 'goblin_1' });
    expect(outcome).toEqual({ kind: 'applied', data: body });
  });

  it('surfaces SURPRISE_WINDOW_CLOSED verbatim (422)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 422,
      json: async () => ({
        detail: { error: 'SURPRISE_WINDOW_CLOSED', message: 'surprise adjudication rejected by the engine' },
      }),
    }));
    const outcome = await setSurprised({ sessionId: 'sess-1', entityId: 'goblin_1' });
    expect(outcome).toMatchObject({
      kind: 'rejected',
      status: 422,
      code: 'SURPRISE_WINDOW_CLOSED',
      message: 'surprise adjudication rejected by the engine',
    });
  });

  it.each([
    ['FORBIDDEN_ROLE', 403],
    ['ENTITY_NOT_FOUND', 404],
    ['NOT_IN_COMBAT', 409],
    ['ENTITY_DELAYED', 409],
  ] as const)('surfaces %s verbatim (%i)', async (code, status) => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status,
      json: async () => ({ detail: { error: code, message: `${code} happened` } }),
    }));
    const outcome = await setSurprised({ sessionId: 'sess-1', entityId: 'goblin_1' });
    expect(outcome).toMatchObject({ kind: 'rejected', status, code });
  });

  it('refuses to hit the gateway when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const outcome = await setSurprised({ sessionId: 'sess-1', entityId: 'goblin_1' });
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'NOT_AUTHENTICATED' });
    expect(calls).toHaveLength(0);
  });

  it('reports an unreachable engine without inventing an outcome', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 503,
      json: async () => ({ detail: 'unavailable' }),
    }));
    const outcome = await setSurprised({ sessionId: 'sess-1', entityId: 'goblin_1' });
    expect(outcome).toMatchObject({ kind: 'unreachable' });
  });
});

describe('clearSurprised wire contract', () => {
  it('posts surprised:false to the same surprise path', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'SURPRISE_REVOKED',
        sequence_id: 10,
        changed: true,
        entity_id: 'goblin_1',
        round: 1,
        surprised: [],
      }),
    }));
    const outcome = await clearSurprised({ sessionId: 'sess-1', entityId: 'goblin_1' });
    expect(outcome.kind).toBe('applied');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/engine/combat/surprise');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      session_id: 'sess-1',
      entity_id: 'goblin_1',
      surprised: false,
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('surfaces FORBIDDEN_ROLE verbatim (403) for a non-GM adjudication', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 403,
      json: async () => ({
        detail: { error: 'FORBIDDEN_ROLE', message: 'only GMs may grant or revoke surprise' },
      }),
    }));
    const outcome = await clearSurprised({ sessionId: 'sess-1', entityId: 'goblin_1' });
    expect(outcome).toMatchObject({ kind: 'rejected', status: 403, code: 'FORBIDDEN_ROLE' });
  });

  it('refuses to hit the gateway when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const outcome = await clearSurprised({ sessionId: 'sess-1', entityId: 'goblin_1' });
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'NOT_AUTHENTICATED' });
    expect(calls).toHaveLength(0);
  });
});

describe('surprisedIdsFromSnapshot (defensive projection read)', () => {
  it('reads combat.surprised out of a raw session-state body — the exact shape App feeds the tracker', () => {
    // Full projected snapshot as parsed in App.tsx refreshCombatState: entities
    // plus combat{in_combat, order, delayed, surprised}. Server already
    // role-filtered hidden ids; the client trusts the array verbatim.
    expect(
      surprisedIdsFromSnapshot({
        entities: {},
        combat: { in_combat: true, order: [], delayed: [], surprised: ['a', 'b'] },
      }),
    ).toEqual(['a', 'b']);
  });

  it('also accepts a bare combat object (the surprise-route response shape)', () => {
    expect(
      surprisedIdsFromSnapshot({
        status: 'SURPRISE_GRANTED',
        changed: true,
        surprised: ['x'],
      }),
    ).toEqual(['x']);
  });

  it('reads the same set the engine reports alongside delayed/disorder facts', () => {
    expect(
      surprisedIdsFromSnapshot({
        entities: {},
        combat: { in_combat: true, round: 1, order: [], delayed: ['d'], surprised: ['s1', 's2'] },
      }),
    ).toEqual(['s1', 's2']);
  });

  it('drops non-string entries instead of coercing them into fake ids', () => {
    expect(surprisedIdsFromSnapshot({ surprised: ['ok', 7, null, {}] })).toEqual(['ok']);
  });

  it('returns empty for absent/malformed payloads — never a guessed list', () => {
    expect(surprisedIdsFromSnapshot(undefined)).toEqual([]);
    expect(surprisedIdsFromSnapshot(null)).toEqual([]);
    expect(surprisedIdsFromSnapshot({})).toEqual([]);
    expect(surprisedIdsFromSnapshot({ surprised: 'nope' })).toEqual([]);
    expect(surprisedIdsFromSnapshot({ combat: { surprised: 'nope' } })).toEqual([]);
    expect(surprisedIdsFromSnapshot([1, 2, 3])).toEqual([]);
  });
});