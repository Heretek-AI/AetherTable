/**
 * Iteration 14 (Loop 3) — "My Characters" gallery contracts.
 *
 * Pinned behaviors:
 *  - card shaping projects the gateway's stored-character meta into the card
 *    shape, hydrates HP from the detail record's `data` blob when present,
 *    and renders an explicit dash (never a fabricated 0) when it is not;
 *  - unusable rows (no id / no name / non-object) are DROPPED, never rendered
 *    as ghost cards whose actions could not address anything;
 *  - the deploy gate mirrors the gateway contract: POST
 *    /api/v1/characters/{id}/deploy requires a live engine session_id, so no
 *    session means DISABLED with an honest reason — and any whitespace-only
 *    or non-string session id counts as none;
 *  - deleteCharacter (api/lobby_store) posts DELETE to the gateway route with
 *    the Bearer header, confirms ONLY on {"status":"DELETED"}, and collapses
 *    signed-out / HTTP failure / network error into plain `false` so the UI
 *    surfaces one honest refusal instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeHp,
  evaluateDeployGate,
  shapeGalleryCard,
  shapeGalleryCards,
} from '../character_gallery';
import { deleteCharacter } from '../lobby_store';
import type { FullStoredCharacter, StoredCharacter } from '../lobby_store';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

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

const META: StoredCharacter = {
  character_id: 'chr_abc123',
  owner_user_id: 'usr_1',
  name: 'Brenna Ironvow',
  character_class: 'fighter',
  level: 5,
};

const DETAIL: FullStoredCharacter = {
  ...META,
  data: { race: 'Human', abilities: { STR: 16 }, hp: 42, max_hp: 48, ac: 18, speed: 30 },
};

describe('shapeGalleryCard', () => {
  it('projects name/class/level from the list meta', () => {
    const card = shapeGalleryCard(META);
    expect(card).toEqual({
      id: 'chr_abc123',
      name: 'Brenna Ironvow',
      classLabel: 'fighter',
      level: 5,
      hp: null,
    });
  });

  it('hydrates hp only when BOTH current and max are finite numbers', () => {
    expect(shapeGalleryCard(META, DETAIL)?.hp).toEqual({ current: 42, max: 48 });
    // Partial hydration is not hydration — one missing figure stays null.
    expect(
      shapeGalleryCard(META, { ...META, data: { hp: 42 } })?.hp
    ).toBeNull();
    expect(
      shapeGalleryCard(META, { ...META, data: { hp: Number.NaN, max_hp: 48 } })?.hp
    ).toBeNull();
  });

  it('substitutes honest defaults for junk class/level instead of crashing', () => {
    const card = shapeGalleryCard({
      character_id: 'chr_x',
      owner_user_id: 'usr_1',
      name: 'Mystery',
      character_class: '',
      level: undefined as unknown as number,
    });
    expect(card?.classLabel).toBe('adventurer');
    expect(card?.level).toBe(1);
  });

  it('drops rows that cannot be addressed (id/name) or are not objects', () => {
    expect(shapeGalleryCard({ ...META, character_id: '' })).toBeNull();
    expect(shapeGalleryCard({ ...META, name: '   ' })).toBeNull();
    expect(shapeGalleryCard(null as unknown as StoredCharacter)).toBeNull();
    expect(shapeGalleryCard(42 as unknown as StoredCharacter)).toBeNull();
  });
});

describe('shapeGalleryCards', () => {
  it('shapes a whole roster in order, matching details by id', () => {
    const b = { ...META, character_id: 'chr_b', name: 'Second Sheet' };
    const cards = shapeGalleryCards([META, b], { chr_b: DETAIL });
    expect(cards.map((c) => c.id)).toEqual(['chr_abc123', 'chr_b']);
    // Only chr_b was hydrated.
    expect(cards[0].hp).toBeNull();
    expect(cards[1].hp).toEqual({ current: 42, max: 48 });
  });

  it('skips null/junk roster entries without dropping the rest', () => {
    const cards = shapeGalleryCards([
      null,
      META,
      undefined,
      { character_id: '', name: 'ghost' } as StoredCharacter,
    ]);
    expect(cards.map((c) => c.name)).toEqual(['Brenna Ironvow']);
  });
});

describe('describeHp', () => {
  it('formats a hydrated pair floored and never negative on max', () => {
    expect(describeHp({ current: 42.7, max: 48 })).toBe('42 / 48');
    expect(describeHp({ current: 0, max: 0 })).toBe('0 / 0');
  });

  it('keeps "detail not fetched" distinct from a real zero', () => {
    expect(describeHp(null)).toBe('—');
  });
});

describe('evaluateDeployGate (deploy disabled without an active session)', () => {
  it('allows deployment when a real session id is active', () => {
    expect(evaluateDeployGate('sess-1234')).toEqual({ allowed: true });
  });

  it('disables with an honest reason for null / empty / whitespace ids', () => {
    for (const absent of [null, undefined, '', '   ']) {
      const gate = evaluateDeployGate(absent);
      expect(gate.allowed).toBe(false);
      if (!gate.allowed) {
        expect(gate.reason).toMatch(/session/i);
        expect(gate.reason.length).toBeGreaterThan(10);
      }
    }
  });

  it('refuses non-string junk rather than coercing it into a session id', () => {
    expect(evaluateDeployGate(42 as unknown as string).allowed).toBe(false);
  });
});

describe('deleteCharacter wire contract', () => {
  function stubFetch(respond: () => { ok: boolean; status?: number; json?: () => Promise<unknown> }) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: (init ?? {}) as RequestInit });
        const r = respond();
        return {
          ok: r.ok,
          status: r.status ?? (r.ok ? 200 : 500),
          json: r.json ?? (async () => ({})),
        };
      })
    );
    return calls;
  }

  it('sends DELETE with the Bearer header and confirms on {"status":"DELETED"}', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ({ status: 'DELETED' }) }));

    await expect(deleteCharacter('chr_abc123')).resolves.toBe(true);
    expect(calls[0].url).toBe('/api/v1/characters/chr_abc123');
    expect(calls[0].init.method).toBe('DELETE');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`
    );
  });

  it('collapses a gateway refusal (404 foreign-or-missing sheet) into false', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: false, status: 404 }));
    await expect(deleteCharacter('chr_missing')).resolves.toBe(false);
  });

  it('collapses a malformed success body into false (no unverified confirmation)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    await expect(deleteCharacter('chr_x')).resolves.toBe(false);
  });

  it('is false when signed out — no request is made at all', async () => {
    const calls = stubFetch(() => ({ ok: true }));
    await expect(deleteCharacter('chr_x')).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('survives a network failure as false instead of throwing', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      })
    );
    await expect(deleteCharacter('chr_x')).resolves.toBe(false);
  });
});
