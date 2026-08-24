/**
 * Unit tests for the identity contract of src/api/safety_xcard.ts.
 *
 * Iteration-5 gateway hardening made POST /api/v1/safety/x-card require an
 * HMAC session token (`token: str = Depends(_require_auth)` in server.py).
 * The wrapper MUST append ?token= exactly like api/rules_engine.ts and
 * api/lore_store.ts do — header-only auth would still 401.
 *
 * The wrapper surfaces NOT_SIGNED_IN / HTTP_ERROR / UNREACHABLE so the UI
 * can render honest states instead of a generic "Intervention recorded
 * locally" copy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { triggerXCard } from '../safety_xcard';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

type FetchCall = { url: string; init: RequestInit };

function stubFetch(
  respond: () => { ok: boolean; status?: number; json: () => Promise<unknown> },
) {
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

describe('safety X-card identity contract', () => {
  it('refuses the call when the caller is signed out (NOT_SIGNED_IN)', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const result = await triggerXCard({
      player_id: 'thorin',
      topic: 'general',
      current_sequence_id: 0,
      engine_session_id: null,
    });
    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR' && result.failure.kind === 'NOT_SIGNED_IN') {
      expect(result.failure.detail).toMatch(/sign in first/i);
    } else {
      throw new Error(`expected NOT_SIGNED_IN, got ${JSON.stringify(result)}`);
    }
    expect(calls).toHaveLength(0);
  });

  it('appends ?token= and posts the x-card body verbatim', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'SAFETY_REWIND_SUCCESS',
        engine_rewind: {
          status: 'SAFETY_REWIND_SUCCESS',
          rewind_report: { reverted_event_count: 3, restored_entities: 2, removed_entities: 0 },
        },
      }),
    }));
    const result = await triggerXCard({
      player_id: 'thorin',
      topic: 'arachnophobia',
      current_sequence_id: 50,
      engine_session_id: 'sess-abc',
    });
    expect(result.kind).toBe('OK');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/api/v1/safety/x-card?token=${encodeURIComponent(TOKEN)}`);
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      player_id: 'thorin',
      topic: 'arachnophobia',
      current_sequence_id: 50,
      engine_session_id: 'sess-abc',
    });
  });

  it('treats an anonymous 401 from the gateway as HTTP_ERROR', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Missing session token' }),
    }));
    const result = await triggerXCard({
      player_id: 'thorin',
      topic: 'general',
      current_sequence_id: 0,
      engine_session_id: null,
    });
    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR' && result.failure.kind === 'HTTP_ERROR') {
      expect(result.failure.status).toBe(401);
      expect(result.failure.detail).toMatch(/missing session token/i);
    } else {
      throw new Error(`expected HTTP_ERROR, got ${JSON.stringify(result)}`);
    }
    expect(calls).toHaveLength(1);
  });

  it('falls back to UNREACHABLE on a network failure instead of throwing', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const result = await triggerXCard({
      player_id: 'thorin',
      topic: 'general',
      current_sequence_id: 0,
      engine_session_id: null,
    });
    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR') {
      expect(result.failure.kind).toBe('UNREACHABLE');
    } else {
      throw new Error(`expected ERROR/UNREACHABLE, got ${JSON.stringify(result)}`);
    }
  });
});