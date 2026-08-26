/**
 * Unit tests for the iteration-79 Help / Ready / Release surface.
 *
 * Contract under test:
 *  - POST /api/v1/engine/help EXISTS as a gateway proxy (iteration 54) and is
 *    dialed with the ids-only triple {session_id, helper_id,
 *    target_entity_id}; reach/action economy stay engine-owned.
 *  - POST /api/v1/engine/ready EXISTS (iterations 54-56) and takes
 *    {session_id, entity_id, description}. The gateway ALSO declares an
 *    optional `trigger_hint` — but its handler forwards that key verbatim to
 *    an engine whose ReadyActionReq is `deny_unknown_fields` with a `trigger`
 *    field, so ANY request carrying trigger_hint is rejected 422 upstream.
 *    The client therefore folds the structured trigger into the DESCRIPTION
 *    (which the engine stores verbatim) and must NEVER send trigger_hint.
 *  - POST /api/v1/sessions/{id}/action/ready/release exists ENGINE-side
 *    (spends the Reaction, clears the declaration) but has NO gateway proxy
 *    yet — same honest pending-gateway treatment as iteration 76's
 *    opportunity-attack surface: dial the documented future proxy path
 *    (/api/v1/engine/ready/release) and surface the resulting 404/405 as a
 *    plain rejection, never a fabricated success.
 *
 * Every mutating call carries the stored token as Authorization: Bearer and
 * signed-out callers get NOT_AUTHENTICATED without touching the network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  READY_TRIGGER_OPTIONS,
  composeReadyDescription,
  entitiesWithinReach,
  engineReadyAction,
  engineReleaseReadyAction,
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

describe('composeReadyDescription (structured trigger -> stored description)', () => {
  it('offers exactly the three mechanical shorthands plus freeform', () => {
    expect(READY_TRIGGER_OPTIONS.map((t) => t.id)).toEqual([
      'enemy_enters_reach',
      'enemy_attacks',
      'turn_start',
      'freeform',
    ]);
  });

  it('appends each shorthand\'s canonical phrase to the description', () => {
    expect(composeReadyDescription('I attack the goblin', 'enemy_enters_reach')).toBe(
      'I attack the goblin (trigger: when an enemy enters my reach)',
    );
    expect(composeReadyDescription('I attack the goblin', 'enemy_attacks')).toBe(
      'I attack the goblin (trigger: when an enemy attacks an ally)',
    );
    expect(composeReadyDescription('I shove it back', 'turn_start')).toBe(
      'I shove it back (trigger: at the start of my next turn)',
    );
  });

  it('freeform appends the player-written trigger text', () => {
    expect(composeReadyDescription('I drink the potion', 'freeform', 'the door opens')).toBe(
      'I drink the potion (trigger: the door opens)',
    );
  });

  it('freeform without trigger text leaves the description untouched', () => {
    expect(composeReadyDescription('I attack the goblin', 'freeform')).toBe('I attack the goblin');
    expect(composeReadyDescription('I attack the goblin', 'freeform', '   ')).toBe(
      'I attack the goblin',
    );
  });

  it('never emits a trigger_hint-shaped suffix for shorthands (no engine shorthand leaks)', () => {
    const out = composeReadyDescription('x', 'enemy_enters_reach');
    expect(out).not.toContain('enemy_enters_reach');
  });
});

describe('entitiesWithinReach (Help/Ready reach gating)', () => {
  const targets = [
    { id: 'near', position: [10, 10] },
    { id: 'far', position: [30, 40] },
    { id: 'nopos', position: undefined },
  ];

  it('returns only entities whose projected position sits within the reach radius', () => {
    expect(entitiesWithinReach(targets as never, [12, 11], 5)).toEqual(['near']);
  });

  it('uses straight-line feet distance (engine world units ARE feet)', () => {
    // sqrt(3^2 + 4^2) = 5 exactly -> included; 5.1 away -> excluded.
    expect(entitiesWithinReach([{ id: 'a', position: [3, 4] }] as never, [0, 0], 5)).toEqual(['a']);
    expect(entitiesWithinReach([{ id: 'b', position: [4, 3.1] }] as never, [0, 0], 5)).toEqual([]);
  });

  it('excludes entities whose position the projection did not expose', () => {
    expect(entitiesWithinReach(targets as never, [10, 10], 5)).not.toContain('nopos');
  });

  it('returns nothing when the actor itself has no known position', () => {
    expect(entitiesWithinReach(targets as never, undefined, 5)).toEqual([]);
  });
});

describe('engineReadyAction wire contract', () => {
  it('sends the ids-plus-description payload with the Bearer header and NO trigger_hint', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'READY_ACTION_SET',
        readied_action: { description: 'held', set_on_round: 2 },
        event_sequence: 9,
      }),
    }));
    const outcome = await engineReadyAction({
      sessionId: 'sess-1',
      entityId: 'thorin',
      description: 'I attack the goblin (trigger: when an enemy enters my reach)',
    });
    expect(outcome.kind).toBe('applied');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/engine/ready');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      session_id: 'sess-1',
      entity_id: 'thorin',
      description: 'I attack the goblin (trigger: when an enemy enters my reach)',
    });
    // The gateway's trigger_hint passthrough is rejected by the engine's
    // deny_unknown_fields — the wire payload must never carry it.
    expect(Object.keys(body)).not.toContain('trigger_hint');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses to hit the gateway when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const outcome = await engineReadyAction({
      sessionId: 'sess-1',
      entityId: 'thorin',
      description: 'hold',
    });
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'NOT_AUTHENTICATED' });
    expect(calls).toHaveLength(0);
  });

  it('surfaces engine rejections verbatim (ACTION_ECONOMY_EXHAUSTED)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ detail: { error: 'ACTION_ECONOMY_EXHAUSTED', message: 'no Action left' } }),
    }));
    const outcome = await engineReadyAction({
      sessionId: 'sess-1',
      entityId: 'thorin',
      description: 'hold',
    });
    expect(outcome).toMatchObject({
      kind: 'rejected',
      status: 409,
      code: 'ACTION_ECONOMY_EXHAUSTED',
      message: 'no Action left',
    });
  });
});

describe('engineReleaseReadyAction (pending gateway, iteration-76 treatment)', () => {
  it('dials the documented future proxy path with the ids-only payload', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'READY_ACTION_RELEASED',
        entity_id: 'thorin',
        released_action: { description: 'held' },
        reaction_spent: true,
        event_sequence: 12,
      }),
    }));
    const outcome = await engineReleaseReadyAction({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome.kind).toBe('applied');
    expect(calls[0].url).toBe('/api/v1/engine/ready/release');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      session_id: 'sess-1',
      entity_id: 'thorin',
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('honestly reports the missing gateway proxy as a rejection, never a success', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: false, status: 404, json: async () => ({ detail: 'Not Found' }) }));
    const outcome = await engineReleaseReadyAction({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome).toMatchObject({ kind: 'rejected', status: 404 });
  });

  it('refuses to hit the gateway when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const outcome = await engineReleaseReadyAction({ sessionId: 'sess-1', entityId: 'thorin' });
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'NOT_AUTHENTICATED' });
    expect(calls).toHaveLength(0);
  });
});
