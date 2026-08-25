/**
 * Iteration 63 — payload-shape tests for the new wire surface:
 *
 *   - engineAttack / engineCheck forward the SRD inspiration spend intent as
 *     `spend_inspiration` (the iteration-56 field on vtt-server's
 *     AttackActionReq / CheckActionReq / SaveActionReq), and OMIT the field
 *     entirely when not asked so legacy gateways never see an unknown key.
 *   - The check grounding pair (`session_id` + `entity_id`) rides along ONLY
 *     when both are supplied — the stateless contract stays byte-for-byte.
 *   - engineEscapeGrapple posts the iteration-49 route shape
 *     ({session_id, entity_id, grappler_id, skill}) and refuses signed-out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  engineAttack,
  engineCheck,
  engineEscapeGrapple,
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

const bodyOf = (call: FetchCall | undefined): Record<string, unknown> =>
  call ? (JSON.parse(String(call.init.body)) as Record<string, unknown>) : {};

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

describe('inspiration spend payloads', () => {
  it('attack omits spend_inspiration unless asked', async () => {
    store.set('aethertable_token', TOKEN);
    // ensureEngineSession memoizes its id module-wide; the FIRST call here may
    // or may not create a session depending on test order, so find the actual
    // attack call rather than assuming an index.
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: (init ?? {}) as RequestInit });
        return url.endsWith('/engine/attack')
          ? {
              ok: true,
              json: async () => ({
                attack_roll: 10,
                natural_roll: 8,
                target_ac: 12,
                is_hit: false,
                is_critical_hit: false,
                total_damage: 0,
              }),
            }
          : { ok: true, json: async () => ({ session_id: 'sess-9' }) };
      }),
    );
    await engineAttack({ attackerId: 'thorin', targetId: 'orc' });
    const attackBody = bodyOf(calls.find((c) => c.url.endsWith('/engine/attack')));
    expect(attackBody).not.toHaveProperty('spend_inspiration');
    expect(attackBody.session_id).toBe('sess-9');

    // …and lands as a boolean true when asked.
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: (init ?? {}) as RequestInit });
        return url.endsWith('/engine/attack')
          ? {
              ok: true,
              json: async () => ({
                attack_roll: 14,
                natural_roll: 11,
                target_ac: 12,
                is_hit: true,
                is_critical_hit: false,
                total_damage: 6,
              }),
            }
          : { ok: true, json: async () => ({ session_id: 'sess-9' }) };
      }),
    );
    await engineAttack({
      attackerId: 'thorin',
      targetId: 'orc',
      spendInspiration: true,
    });
    expect(bodyOf(calls.find((c) => c.url.endsWith('/engine/attack'))).spend_inspiration).toBe(
      true,
    );
  });

  it('attack drops a falsy spend instead of sending spend_inspiration=false', async () => {
    store.set('aethertable_token', TOKEN);
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: (init ?? {}) as RequestInit });
        return url.endsWith('/engine/attack')
          ? {
              ok: true,
              json: async () => ({
                attack_roll: 5,
                natural_roll: 2,
                target_ac: 20,
                is_hit: false,
                is_critical_hit: false,
                total_damage: 0,
              }),
            }
          : { ok: true, json: async () => ({ session_id: 'sess-9' }) };
      }),
    );
    await engineAttack({ attackerId: 'a', targetId: 'b', spendInspiration: false });
    expect(bodyOf(calls.find((c) => c.url.endsWith('/engine/attack')))).not.toHaveProperty(
      'spend_inspiration',
    );
  });

  it('check sends the grounding pair + spend together, neither alone', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ roll: 15, modifier: 3, total: 18, dc: 12, outcome: 'SUCCESS' }),
    }));
    // Neither grounded nor spending: legacy body exactly as before.
    await engineCheck({ modifier: 3, dc: 12 });
    const legacy = bodyOf(calls[calls.length - 1]);
    expect(legacy).toEqual({ modifier: 3, dc: 12, cost_margin: 3, advantage: false, disadvantage: false });

    // Spend without grounding: the intent cannot be honored statelessly, so no
    // spend key may leave the browser half-wired.
    await engineCheck({ modifier: 3, dc: 12, spendInspiration: true });
    expect(bodyOf(calls[calls.length - 1])).not.toHaveProperty('spend_inspiration');

    // Both: full grounding payload.
    await engineCheck({
      modifier: 3,
      dc: 12,
      sessionId: 'sess-7',
      entityId: 'hero-uuid',
      spendInspiration: true,
    });
    const grounded = bodyOf(calls[calls.length - 1]);
    expect(grounded.spend_inspiration).toBe(true);
    expect(grounded.session_id).toBe('sess-7');
    expect(grounded.entity_id).toBe('hero-uuid');
  });

  it('check with grounding but no spend still pins the entity (help-cash path)', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ roll: 9, modifier: 1, total: 10, dc: 12, outcome: 'FAILURE' }),
    }));
    await engineCheck({ modifier: 1, dc: 12, sessionId: 'sess-7', entityId: 'hero-uuid' });
    const body = bodyOf(calls[0]);
    expect(body.session_id).toBe('sess-7');
    expect(body.entity_id).toBe('hero-uuid');
    expect(body).not.toHaveProperty('spend_inspiration');
  });
});

describe('engineEscapeGrapple', () => {
  it('refuses signed-out callers without dialing the gateway', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const outcome = await engineEscapeGrapple({
      sessionId: 's1',
      entityId: 'e1',
      grapplerId: 'g1',
      skill: 'acrobatics',
    });
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'NOT_AUTHENTICATED' });
    expect(calls).toHaveLength(0);
  });

  it('posts the iteration-49 route shape with the Bearer header', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        entity_id: 'e1',
        grappler_id: 'g1',
        escaped: true,
        skill: 'athletics',
        escaper_natural_roll: 17,
        escape_dc: 13,
        event_sequence: 41,
      }),
    }));
    const outcome = await engineEscapeGrapple({
      sessionId: 's1',
      entityId: 'e1',
      grapplerId: 'g1',
      skill: 'athletics',
    });
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') expect(outcome.data.escaped).toBe(true);
    expect(calls[0].url).toBe('/api/v1/engine/escape-grapple');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(bodyOf(calls[0])).toEqual({
      session_id: 's1',
      entity_id: 'e1',
      grappler_id: 'g1',
      skill: 'athletics',
    });
  });

  it('surfaces the gateway rejection verbatim (no proxy upstream yet)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({ detail: 'Not Found' }),
    }));
    const outcome = await engineEscapeGrapple({
      sessionId: 's1',
      entityId: 'e1',
      grapplerId: 'g1',
      skill: 'acrobatics',
    });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.status).toBe(404);
  });
});
