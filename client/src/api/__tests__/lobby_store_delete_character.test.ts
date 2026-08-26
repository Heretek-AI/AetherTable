/**
 * Iteration 23 (F11) — discriminated-result contract for deleteCharacter
 * (DELETE /api/v1/characters/{id}).
 *
 * Pinned here:
 *  - Each gateway branch resolves to its own outcome variant; nothing is
 *    collapsed into a bare boolean the way it used to be.
 *  - 200 + {"status": "DELETED"} → {outcome: 'ok'}; a 200 with a malformed
 *    body is {outcome: 'rejected'} (no fabricated confirmation).
 *  - 403 (foreign sheet) → {outcome: 'forbidden', status, detail}; 404 (id
 *    unknown OR not owned — the gateway collapses these intentionally so a
 *    foreign probe can't enumerate ownership via 403/404 distinction) →
 *    {outcome: 'not_found', status, detail}; 401 → {outcome: 'not_signed_in'};
 *    any other 4xx → {outcome: 'rejected', status, detail}; 5xx / fetch
 *    throw → {outcome: 'unreachable', detail}.
 *  - Verbatim gateway `detail` is preserved end-to-end (the MyCharactersView
 *    renders it as-is; never a fabricated one-sentence disjunction).
 *
 * Stubs `fetch` and `sessionStorage` exactly like the other auth tests in
 * this directory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteCharacter, type DeleteCharacterOutcome } from '../lobby_store';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

type FetchCall = { url: string; init: RequestInit };

function stubFetch(
  respond: () => {
    ok: boolean;
    status?: number;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
  },
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: (init ?? {}) as RequestInit });
    const r = respond();
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: r.json ?? (async () => ({})),
      text: r.text ?? (async () => ''),
    };
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
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

describe('deleteCharacter — discriminated outcomes (F11)', () => {
  it('happy path: 200 + {"status":"DELETED"} → ok, Bearer header sent, DELETE method', async () => {
    store.set('aethertable_token', TOKEN);
    const { calls } = stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'DELETED' }),
    }));
    const result = await deleteCharacter('chr_abc123');
    expect(result).toEqual({ outcome: 'ok' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/characters/chr_abc123');
    expect(calls[0].init.method).toBe('DELETE');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('signed-out caller never touches the wire → not_signed_in', async () => {
    const { calls } = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const result = await deleteCharacter('chr_x');
    expect(result.outcome).toBe('not_signed_in');
    if (result.outcome === 'not_signed_in') {
      expect(result.detail).toMatch(/sign in first/i);
    }
    expect(calls).toHaveLength(0);
  });

  it('403 ENCOUNTER_OWNERSHIP_FORBIDDEN (or analogous foreign-sheet refusal) → forbidden with verbatim detail', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 403,
      json: async () => ({ detail: 'CHARACTER_NOT_OWNED: chr_foreign belongs to a different user' }),
    }));
    const result: DeleteCharacterOutcome = await deleteCharacter('chr_foreign');
    expect(result.outcome).toBe('forbidden');
    if (result.outcome === 'forbidden') {
      expect(result.status).toBe(403);
      expect(result.detail).toContain('CHARACTER_NOT_OWNED');
      expect(result.detail).toContain('chr_foreign');
    }
  });

  it('404 (gateway collapses foreign + unknown into "not found for this owner") → not_found with verbatim detail', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({ detail: 'CHARACTER_NOT_FOUND: chr_ghost is not in this account' }),
    }));
    const result = await deleteCharacter('chr_ghost');
    expect(result.outcome).toBe('not_found');
    if (result.outcome === 'not_found') {
      expect(result.status).toBe(404);
      expect(result.detail).toContain('CHARACTER_NOT_FOUND');
      expect(result.detail).toContain('chr_ghost');
    }
  });

  it('401 with an expired-token detail → not_signed_in (collapsed with the pre-flight gate)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Invalid or expired session token' }),
    }));
    const result = await deleteCharacter('chr_x');
    expect(result.outcome).toBe('not_signed_in');
    if (result.outcome === 'not_signed_in') {
      expect(result.detail).toBe('Invalid or expired session token');
    }
  });

  it('422 schema-validation refusal → rejected (status + verbatim detail)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 422,
      json: async () => ({ detail: [{ msg: 'character_id must be a non-empty string' }] }),
    }));
    const result = await deleteCharacter('');
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.status).toBe(422);
      expect(result.detail).toMatch(/character_id must be a non-empty string/);
    }
  });

  it('malformed 200 (no {"status":"DELETED"}) → rejected (no fabricated confirmation)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ something: 'else' }) }));
    const result = await deleteCharacter('chr_x');
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.status).toBe(200);
      expect(result.detail).toMatch(/DELETED/i);
    }
  });

  it('5xx gateway outage → unreachable (no verdict produced)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({ detail: 'gateway down' }) }));
    const result = await deleteCharacter('chr_x');
    expect(result.outcome).toBe('unreachable');
    if (result.outcome === 'unreachable') {
      expect(result.detail).toBe('gateway down');
    }
  });

  it('fetch throws (TypeError network down) → unreachable with the catch fallback', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await deleteCharacter('chr_x');
    expect(result.outcome).toBe('unreachable');
    if (result.outcome === 'unreachable') {
      expect(result.detail).toMatch(/could not reach the gateway/i);
    }
  });

  it('error body without a string detail (FastAPI array of validation msgs) still surfaces a useful message', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 422,
      json: async () => ({ detail: [{ msg: 'character_id malformed' }] }),
    }));
    const result = await deleteCharacter('chr_x');
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.detail).toBe('character_id malformed');
    }
  });
});