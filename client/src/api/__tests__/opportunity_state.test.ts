/**
 * Iteration 76 — opportunity-attack wire surface, red-first:
 *
 *   - extractPendingOpportunityAttacks parses the additive disclosure fields
 *     the engine's POST /sessions/{id}/move response carries since commit
 *     76787ff (`opportunity_attacks_detail[]` plural, `opportunity_attack`
 *     singular back-compat), each entry shaped
 *     {provoked_by, reaction_type, pending_opportunity, available}.
 *   - formatOpportunityAttackLine renders "X provoked an opportunity attack
 *     from Y" from ONLY the ids the response carried.
 *   - engineOpportunityAttack posts the documented resolution shape
 *     ({session_id, attacker_id, target_id}) to /api/v1/engine/opportunity-attack
 *     and refuses signed-out callers BEFORE any network call. The gateway does
 *     NOT proxy that route yet — an unreachable proxy surfaces honestly as a
 *     rejection/unreachable outcome, never as a fabricated success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractPendingOpportunityAttacks,
  formatOpportunityAttackLine,
  engineOpportunityAttack,
} from '../opportunity_state';

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

describe('extractPendingOpportunityAttacks', () => {
  it('parses every entry of the plural detail field with its pending route', () => {
    const body = {
      status: 'MOVED',
      outcome: { from: [0, 0, 0], to: [30, 0, 0] },
      opportunity_attacks_detail: [
        {
          provoked_by: '11111111-1111-4111-8111-111111111111',
          reaction_type: 'opportunity_attack',
          pending_opportunity: '/action/opportunity-attack',
          available: true,
        },
        {
          provoked_by: '22222222-2222-4222-8222-222222222222',
          mover_id: '33333333-3333-4333-8333-333333333333',
          reaction_type: 'opportunity_attack',
          pending_opportunity: '/action/opportunity-attack',
          available: true,
        },
      ],
    };
    const oas = extractPendingOpportunityAttacks(body);
    expect(oas).toHaveLength(2);
    expect(oas[0].provokedBy).toBe('11111111-1111-4111-8111-111111111111');
    expect(oas[0].pendingEndpoint).toBe('/action/opportunity-attack');
    expect(oas[0].available).toBe(true);
    expect(oas[1].moverId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('falls back to the singular field when the plural list is absent (back-compat)', () => {
    const body = {
      opportunity_attack: {
        provoked_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        mover_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        reaction_type: 'opportunity_attack',
      },
    };
    const oas = extractPendingOpportunityAttacks(body);
    expect(oas).toHaveLength(1);
    expect(oas[0].provokedBy).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(oas[0].moverId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('drops entries without a provoking entity and returns [] for non-carried fields', () => {
    expect(extractPendingOpportunityAttacks({ status: 'MOVED' })).toEqual([]);
    expect(
      extractPendingOpportunityAttacks({
        opportunity_attacks_detail: [{ reaction_type: 'opportunity_attack', available: true }],
      }),
    ).toEqual([]);
    // The engine OMITS these fields when nothing was provoked — absence is
    // silence, not an empty provocation.
    expect(extractPendingOpportunityAttacks(null)).toEqual([]);
    expect(extractPendingOpportunityAttacks(undefined)).toEqual([]);
    expect(extractPendingOpportunityAttacks('MOVED')).toEqual([]);
  });
});

describe('formatOpportunityAttackLine', () => {
  it('names both sides via the resolver and never invents a missing one', () => {
    const line = formatOpportunityAttackLine(
      { provokedBy: 'goblin-1', moverId: 'hero-9', pendingEndpoint: '/action/opportunity-attack' },
      (id) => (id === 'goblin-1' ? 'Snik' : id === 'hero-9' ? 'Tordek' : undefined),
    );
    expect(line).toBe('⚔ Snik provoked an opportunity attack against Tordek');

    // Unknown mover: still renders, but only names what the response said.
    const partial = formatOpportunityAttackLine(
      { provokedBy: 'goblin-1' },
      (id) => (id === 'goblin-1' ? 'Snik' : undefined),
    );
    expect(partial).toBe('⚔ Snik provoked an opportunity attack');
  });

  it('returns null for entries carrying nothing usable', () => {
    expect(formatOpportunityAttackLine(null, () => 'x')).toBeNull();
    expect(formatOpportunityAttackLine({}, () => 'x')).toBeNull();
  });
});

describe('engineOpportunityAttack payload', () => {
  it('posts the ids-only contract to the gateway proxy path with Bearer auth', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ status: 'OPPORTUNITY_ATTACK_TAKEN' }),
    }));
    const result = await engineOpportunityAttack({
      sessionId: 'sess-1',
      attackerId: 'gob-1',
      targetId: 'hero-9',
    });
    expect(result.kind).toBe('applied');
    const call = calls[0];
    expect(call.url).toBe('/api/v1/engine/opportunity-attack');
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      session_id: 'sess-1',
      attacker_id: 'gob-1',
      target_id: 'hero-9',
    });
  });

  it('refuses signed-out callers before any network call', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const result = await engineOpportunityAttack({
      sessionId: 'sess-1',
      attackerId: 'a',
      targetId: 'b',
    });
    expect(result).toEqual({
      kind: 'rejected',
      status: 401,
      code: 'NOT_AUTHENTICATED',
      message: 'Sign in to act through the authoritative engine.',
    });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a gateway 404/405 honestly as a rejection (proxy support pending)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({ detail: 'Not Found' }),
    }));
    const result = await engineOpportunityAttack({
      sessionId: 'sess-1',
      attackerId: 'a',
      targetId: 'b',
    });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.status).toBe(404);
      expect(result.message).toContain('Not Found');
    }
  });

  it('maps transport failure to unreachable rather than a fake success', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    const result = await engineOpportunityAttack({
      sessionId: 's',
      attackerId: 'a',
      targetId: 'b',
    });
    expect(result.kind).toBe('unreachable');
  });
});
