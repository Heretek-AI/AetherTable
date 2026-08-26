/**
 * Iteration 16 (Loop 3) — SRD-optional Delay wire contract.
 *
 * Pinned contracts:
 *  - POST /api/v1/engine/delay and POST /api/v1/engine/delay/resume carry the
 *    ids-only pair {session_id, entity_id} — exactly the engine's
 *    SimpleActionReq (deny_unknown_fields). Round economy, turn re-seating and
 *    the delayed list itself are all engine-owned: the client sends NO combat
 *    math and mutates NO order locally.
 *  - Every call rides the stored token as Authorization: Bearer; signed-out
 *    callers get NOT_AUTHENTICATED without touching the network.
 *  - Engine rejections surface VERBATIM as machine codes — ALREADY_DELAYED,
 *    NOT_DELAYED, NOT_IN_COMBAT, ENTITY_CANNOT_ACT, ENTITY_NOT_FOUND,
 *    ENTITY_NOT_OWNED — never rewritten into friendlier fiction.
 *  - delayedIdsFromSnapshot reads the engine's `combat.delayed` array out of a
 *    RAW projected session-state body defensively: whatever the projection did
 *    not expose simply means "nobody parked", never a guessed list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  delayedIdsFromSnapshot,
  delayEntity,
  resumeEntity,
} from '../combat_delay';

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

describe('delayEntity wire contract', () => {
  it('posts the exact SimpleActionReq body with the Bearer header', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'DELAY_TAKEN',
        entity_id: 'thorin',
        delayed: ['thorin'],
        round: 3,
        turn_index: 1,
        order: [{ entity_id: 'goblin' }, { entity_id: 'thorin' }],
        event_sequence: 41,
      }),
    }));
    const outcome = await delayEntity({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome.kind).toBe('applied');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/engine/delay');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      session_id: 'sess-1',
      entity_id: 'thorin',
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('passes the engine success payload through verbatim', async () => {
    store.set('aethertable_token', TOKEN);
    const body = {
      status: 'DELAY_TAKEN',
      entity_id: 'thorin',
      delayed: ['thorin'],
      round: 3,
      order: [],
      event_sequence: 7,
    };
    stubFetch(() => ({ ok: true, json: async () => body }));
    const outcome = await delayEntity({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome).toEqual({ kind: 'applied', data: body });
  });

  it('surfaces ALREADY_DELAYED verbatim (409)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({
        detail: { error: 'ALREADY_DELAYED', message: 'already parked out of turn order' },
      }),
    }));
    const outcome = await delayEntity({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome).toMatchObject({
      kind: 'rejected',
      status: 409,
      code: 'ALREADY_DELAYED',
      message: 'already parked out of turn order',
    });
  });

  it.each([
    ['NOT_IN_COMBAT', 409],
    ['ENTITY_CANNOT_ACT', 409],
    ['ENTITY_NOT_FOUND', 404],
    ['ENTITY_NOT_OWNED', 403],
  ] as const)('surfaces %s verbatim (%i)', async (code, status) => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status,
      json: async () => ({ detail: { error: code, message: `${code} happened` } }),
    }));
    const outcome = await delayEntity({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome).toMatchObject({ kind: 'rejected', status, code });
  });

  it('refuses to hit the gateway when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const outcome = await delayEntity({ sessionId: 'sess-1', entityId: 'thorin' });
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
    const outcome = await delayEntity({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome).toMatchObject({ kind: 'unreachable' });
  });
});

describe('resumeEntity wire contract', () => {
  it('posts the exact SimpleActionReq body to the resume path', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'DELAY_RESUMED',
        entity_id: 'thorin',
        delayed: [],
        round: 3,
        turn_index: 1,
        order: [],
        event_sequence: 42,
      }),
    }));
    const outcome = await resumeEntity({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome.kind).toBe('applied');
    expect(calls[0].url).toBe('/api/v1/engine/delay/resume');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      session_id: 'sess-1',
      entity_id: 'thorin',
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('surfaces NOT_DELAYED verbatim (409)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({
        detail: { error: 'NOT_DELAYED', message: 'this combatant is not delaying' },
      }),
    }));
    const outcome = await resumeEntity({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome).toMatchObject({
      kind: 'rejected',
      status: 409,
      code: 'NOT_DELAYED',
    });
  });

  it('refuses to hit the gateway when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const outcome = await resumeEntity({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'NOT_AUTHENTICATED' });
    expect(calls).toHaveLength(0);
  });
});

describe('delayedIdsFromSnapshot (defensive projection read)', () => {
  it('reads combat.delayed out of a raw session-state body', () => {
    expect(
      delayedIdsFromSnapshot({
        entities: {},
        combat: { in_combat: true, order: [], delayed: ['a', 'b'] },
      }),
    ).toEqual(['a', 'b']);
  });

  it('also accepts a bare combat object (the delay-route response shape)', () => {
    expect(delayedIdsFromSnapshot({ status: 'DELAY_TAKEN', delayed: ['x'] })).toEqual(['x']);
  });

  it('drops non-string entries instead of coercing them into fake ids', () => {
    expect(delayedIdsFromSnapshot({ delayed: ['ok', 7, null, {}] })).toEqual(['ok']);
  });

  it('returns empty for absent/malformed payloads — never a guessed list', () => {
    expect(delayedIdsFromSnapshot(undefined)).toEqual([]);
    expect(delayedIdsFromSnapshot(null)).toEqual([]);
    expect(delayedIdsFromSnapshot({})).toEqual([]);
    expect(delayedIdsFromSnapshot({ delayed: 'nope' })).toEqual([]);
    expect(delayedIdsFromSnapshot([1, 2, 3])).toEqual([]);
  });
});
