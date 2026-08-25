/**
 * Unit tests for the identity contract of src/api/narrative_stream.ts.
 *
 * Iteration-10 gateway hardening made POST
 * /api/v1/orchestrator/narrative/stream require an HMAC session token
 * (`token: str = Depends(_require_auth)` in server.py). Iteration-13 (F14)
 * sends it as the Authorization: Bearer header — like api/rules_engine.ts and
 * api/safety_xcard.ts — because tokens in URLs leak into proxy/access logs.
 * A signed-out caller must NEVER hit the gateway anonymously, and an HTTP
 * rejection must surface honestly instead of stalling the "..." DM bubble.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openNarrativeStream } from '../narrative_stream';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

type FetchCall = { url: string; init: RequestInit };

function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: (init ?? {}) as RequestInit });
    return respond();
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function sseResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"token":"The orc ", "done":false}\n\n'));
      controller.enqueue(encoder.encode('data: {"token":"", "done":true}\n\n'));
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
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

describe('narrative stream identity contract', () => {
  const payload = { user_intent: 'I strike the goblin', engine_execution_payload: {} };

  it('refuses to dial the gateway when signed out (NOT_SIGNED_IN)', async () => {
    const calls = stubFetch(() => sseResponse());
    const result = await openNarrativeStream(payload);
    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR') {
      expect(result.failure.kind).toBe('NOT_SIGNED_IN');
      if (result.failure.kind === 'NOT_SIGNED_IN') {
        expect(result.failure.detail).toMatch(/sign in first/i);
      }
    }
    expect(calls).toHaveLength(0);
  });

  it('sends the Bearer header (never a URL token) and posts the turn payload verbatim', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => sseResponse());
    const body = { action_name: 'Greataxe', is_hit: true, total_damage: 11 };
    const result = await openNarrativeStream({
      user_intent: 'I strike the goblin',
      engine_execution_payload: body,
    });
    expect(result.kind).toBe('OK');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/orchestrator/narrative/stream');
    // F14: identity rides the Authorization header, never the query string.
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      user_intent: 'I strike the goblin',
      engine_execution_payload: body,
    });
  });

  it('surfaces an anonymous 401 as HTTP_ERROR with the gateway detail', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ detail: 'Missing session token' }),
      }) as unknown as Response,
    );
    const result = await openNarrativeStream(payload);
    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR' && result.failure.kind === 'HTTP_ERROR') {
      expect(result.failure.status).toBe(401);
      expect(result.failure.detail).toMatch(/missing session token/i);
    } else {
      throw new Error(`expected HTTP_ERROR, got ${JSON.stringify(result)}`);
    }
  });

  it('reports NO_STREAM_BODY when the response carries no readable body', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: true, status: 200, body: null }) as unknown as Response);
    const result = await openNarrativeStream(payload);
    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR' && result.failure.kind !== 'HTTP_ERROR') {
      expect(result.failure.kind).toBe('NO_STREAM_BODY');
    } else if (result.kind === 'OK' || result.failure.kind === 'HTTP_ERROR') {
      throw new Error(`expected NO_STREAM_BODY, got ${JSON.stringify(result)}`);
    }
  });

  it('rejects on network failure so callers keep their catch semantics', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    await expect(openNarrativeStream(payload)).rejects.toThrow(/unreachable/i);
  });

  it('accepts an explicit token argument over stored state (still header-only)', async () => {
    const calls = stubFetch(() => sseResponse());
    const result = await openNarrativeStream(payload, 'explicit.sig.token');
    expect(result.kind).toBe('OK');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer explicit.sig.token',
    );
    expect(calls[0].url).toBe('/api/v1/orchestrator/narrative/stream');
  });
});
