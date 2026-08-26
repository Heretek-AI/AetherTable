/**
 * Iteration 13 — wire surface for POST /api/v1/engine/encounter/balance,
 * red-first:
 *
 *   - balanceEncounter posts the exact payload the gateway schema enforces
 *     ({party_level, party_size, monsters:[{monster_id, quantity}]}) with
 *     Bearer auth, and refuses signed-out callers BEFORE any network call.
 *   - Every error variant is its own outcome: 403 → forbidden (GM-only route),
 *     404 UNKNOWN_MONSTER_ID:<id> → unknown_monster NAMING the id verbatim
 *     (the route formats it that way — server.py engine_encounter_balance),
 *     transport/5xx → unreachable, other 4xx → rejected with the message.
 *   - createDebouncedBalancer coalesces a burst of schedule() calls into ONE
 *     invoke carrying the LAST parameters (so dragging a quantity spinner
 *     doesn't hammer the endpoint), and cancel() drops a pending invocation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BALANCE_DEBOUNCE_MS,
  balanceEncounter,
  createDebouncedBalancer,
  FALLBACK_PARTY_DEFAULTS,
  fetchPartyDefaults,
  unknownMonsterIdsFrom,
} from '../encounter_balance_store';

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('balanceEncounter — payload shape', () => {
  it('posts the snake_case contract to /api/v1/engine/encounter/balance with Bearer auth', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        raw_xp: 900,
        adjusted_xp: 1800,
        multiplier: 2.0,
        difficulty: 'hard',
        per_monster: [{ monster_id: 'goblin', name: 'Goblin', xp: 200, quantity: 3 }],
      }),
    }));
    const result = await balanceEncounter(5, 4, [
      { monster_id: 'goblin', quantity: 3 },
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.data.difficulty).toBe('hard');
      expect(result.data.adjusted_xp).toBe(1800);
      expect(result.data.per_monster?.[0]?.name).toBe('Goblin');
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/engine/encounter/balance');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      party_level: 5,
      party_size: 4,
      monsters: [{ monster_id: 'goblin', quantity: 3 }],
    });
  });

  it('clamps out-of-band party values into what the schema accepts instead of manufacturing a 422', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ({ difficulty: 'easy' }) }));
    await balanceEncounter(99, -2, [{ monster_id: 'rat', quantity: 1 }]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      party_level: 20,
      party_size: 1,
      monsters: [{ monster_id: 'rat', quantity: 1 }],
    });
  });

  it('drops zero/negative-quantity and blank-id lines rather than sending them', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ({ difficulty: 'easy' }) }));
    await balanceEncounter(1, 4, [
      { monster_id: 'goblin', quantity: 0 },
      { monster_id: '', quantity: 5 },
      { monster_id: 'orc', quantity: NaN },
      { monster_id: 'kobold', quantity: 2 },
    ]);
    expect(JSON.parse(String(calls[0].init.body)).monsters).toEqual([
      { monster_id: 'kobold', quantity: 2 },
    ]);
  });
});

describe('balanceEncounter — error variants', () => {
  it('refuses signed-out callers before any network call (NOT_SIGNED_IN)', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const result = await balanceEncounter(3, 4, [{ monster_id: 'goblin', quantity: 1 }]);
    expect(result).toEqual({
      kind: 'not_signed_in',
      message: 'Sign in as the GM to compute encounter balance.',
    });
    expect(calls).toHaveLength(0);
  });

  it('maps 403 ENCOUNTER_BALANCE_GM_ONLY to forbidden with the detail verbatim', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 403,
      json: async () => ({ detail: 'ENCOUNTER_BALANCE_GM_ONLY' }),
    }));
    const result = await balanceEncounter(3, 4, [{ monster_id: 'goblin', quantity: 1 }]);
    expect(result.kind).toBe('forbidden');
    if (result.kind === 'forbidden') {
      expect(result.status).toBe(403);
      expect(result.message).toBe('ENCOUNTER_BALANCE_GM_ONLY');
    }
  });

  it('maps the 404 UNKNOWN_MONSTER_ID detail to unknown_monster naming the id', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({ detail: 'UNKNOWN_MONSTER_ID:shadow_drake' }),
    }));
    const result = await balanceEncounter(3, 4, [{ monster_id: 'shadow_drake', quantity: 1 }]);
    expect(result.kind).toBe('unknown_monster');
    if (result.kind === 'unknown_monster') {
      expect(result.status).toBe(404);
      expect(result.monsterIds).toEqual(['shadow_drake']);
      // Verbatim quote preserved for the UI to render untouched.
      expect(result.message).toContain('UNKNOWN_MONSTER_ID:shadow_drake');
    }
  });

  it('treats an empty-roster request as a client-side short-circuit (no call)', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const result = await balanceEncounter(3, 4, []);
    expect(result.kind).toBe('empty_roster');
    expect(calls).toHaveLength(0);
  });

  it('surfaces other 4xx as rejected with the server message quoted', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 422,
      json: async () => ({ detail: [{ msg: 'party_size must be between 1 and 8' }] }),
    }));
    const result = await balanceEncounter(3, 4, [{ monster_id: 'goblin', quantity: 1 }]);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.status).toBe(422);
      expect(result.message).toBe('party_size must be between 1 and 8');
    }
  });

  it('maps transport failure and 5xx to unreachable rather than a fake verdict', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    expect(
      (await balanceEncounter(3, 4, [{ monster_id: 'goblin', quantity: 1 }])).kind,
    ).toBe('unreachable');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => null })),
    );
    expect(
      (await balanceEncounter(3, 4, [{ monster_id: 'goblin', quantity: 1 }])).kind,
    ).toBe('unreachable');
  });
});

describe('unknownMonsterIdsFrom — detail parsing', () => {
  it('extracts ids from every wrapper FastAPI might put around the refusal', () => {
    expect(unknownMonsterIdsFrom({ detail: 'UNKNOWN_MONSTER_ID:shadow_drake' })).toEqual(['shadow_drake']);
    // The route interpolates the KeyError arg raw; ids with odd characters
    // still survive up to the first delimiter we control.
    expect(unknownMonsterIdsFrom({ detail: 'UNKNOWN_MONSTER_ID:goblin' })).toEqual(['goblin']);
    // Non-matching payloads yield [] so callers fall through to plain rejection.
    expect(unknownMonsterIdsFrom({ detail: 'Not Found' })).toEqual([]);
    expect(unknownMonsterIdsFrom(null)).toEqual([]);
  });
});

describe('fetchPartyDefaults — wizard config seeding', () => {
  it('seeds level/size from the most recent lobby record', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        lobbies: [
          { starting_level: 3, party_size: 5 },
          { starting_level: 1, party_size: 2 },
        ],
      }),
    }));
    expect(await fetchPartyDefaults()).toEqual({ level: 3, size: 5, fromLobby: true });
  });

  it('falls back to 4 players at level 1 when nothing is reachable or usable', async () => {
    // Signed out → no lobby list.
    expect(await fetchPartyDefaults()).toEqual(FALLBACK_PARTY_DEFAULTS);

    // Endpoint answers junk → still the honest default.
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: false, status: 500, json: async () => null }));
    expect(await fetchPartyDefaults()).toEqual(FALLBACK_PARTY_DEFAULTS);

    stubFetch(() => ({ ok: true, json: async () => ({ lobbies: [] }) }));
    expect(await fetchPartyDefaults()).toEqual(FALLBACK_PARTY_DEFAULTS);
  });
});

describe('createDebouncedBalancer — burst coalescing', () => {
  it('fires exactly once after the quiet period with the LAST scheduled parameters', () => {
    vi.useFakeTimers();
    const invoke = vi.fn();
    const balancer = createDebouncedBalancer<{ rosterKey: string }>({
      delayMs: BALANCE_DEBOUNCE_MS,
      invoke,
    });

    // Simulate dragging a quantity: many changes in quick succession.
    balancer.schedule({ rosterKey: 'v1' });
    vi.advanceTimersByTime(300);
    balancer.schedule({ rosterKey: 'v2' });
    vi.advanceTimersByTime(300);
    balancer.schedule({ rosterKey: 'v3' });
    expect(invoke).not.toHaveBeenCalled();

    vi.advanceTimersByTime(BALANCE_DEBOUNCE_MS - 1);
    expect(invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({ rosterKey: 'v3' });
  });

  it('restarts the timer on every schedule so a continuous drag never fires mid-drag', () => {
    vi.useFakeTimers();
    const invoke = vi.fn();
    const balancer = createDebouncedBalancer<number>({ delayMs: 800, invoke });

    for (let tick = 0; tick < 8; tick++) {
      balancer.schedule(tick);
      vi.advanceTimersByTime(700); // always inside the window before the next change
    }
    expect(invoke).not.toHaveBeenCalled();

    vi.advanceTimersByTime(800);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(7);
  });

  it('cancel() drops a pending invocation entirely', () => {
    vi.useFakeTimers();
    const invoke = vi.fn();
    const balancer = createDebouncedBalancer<string>({ delayMs: 800, invoke });

    balancer.schedule('pending');
    balancer.cancel();
    vi.advanceTimersByTime(5000);
    expect(invoke).not.toHaveBeenCalled();

    // And the balancer keeps working after a cancel.
    balancer.schedule('after');
    vi.advanceTimersByTime(800);
    expect(invoke).toHaveBeenCalledWith('after');
  });
});
