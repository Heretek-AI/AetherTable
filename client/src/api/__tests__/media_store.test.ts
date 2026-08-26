/**
 * Unit tests for src/api/media_store.ts — the browser-facing client for the
 * gateway's diffusion route POST /api/v1/media/image (iteration 3, Loop 3).
 *
 * Contract under test:
 *  - Payload shape matches MediaImageRequest exactly ({prompt, size, steps})
 *    and identity rides the Authorization Bearer header (never a URL token —
 *    same F14 rule as every other store).
 *  - Session-scoped cache keyed by prompt+size: a repeat request for the same
 *    prompt at the same size must NOT re-hit the wire, because each accepted
 *    call occupies the shared GPU and meters in the tight `media` bucket
 *    (10/min — see python/vtt_orchestrator/ratelimit.py). A different size is
 *    a different key and does re-fetch.
 *  - Every failure variant surfaces honestly and distinctly:
 *      NOT_SIGNED_IN (no fetch attempted),
 *      RATE_LIMITED   (HTTP 429 from the media bucket),
 *      REJECTED       (other non-2xx + upstream detail forwarded verbatim),
 *      UNREACHABLE    (fetch threw / malformed success payload).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEDIA_IMAGE_PATH,
  clearMediaCache,
  describeMediaFailure,
  generateTokenArt,
  type MediaResult,
} from '../media_store';

const TOKEN = 'sig.payload.token';
const B64 = 'aV9hbV9hX3BuZw==';
const DATA_URL = `data:image/png;base64,${B64}`;
const store = new Map<string, string>();

// Latest stub's captured calls; pushed by stubFetch, reset in beforeEach.
const calls: FetchCall[] = [];

type FetchCall = { url: string; init: RequestInit };

interface StubResponseSpec {
  ok?: boolean;
  status?: number;
  body?: unknown;
  /** Make fetch itself throw instead of returning a response. */
  throws?: unknown;
}

function stubFetch(spec: () => StubResponseSpec) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: (init ?? {}) as RequestInit });
    const s = spec();
    if (s.throws !== undefined) throw s.throws;
    return {
      ok: s.ok ?? true,
      status: s.status ?? 200,
      json: async () => s.body,
      text: async () => JSON.stringify(s.body ?? null),
    };
  });
  vi.stubGlobal('fetch', fn);
}

beforeEach(() => {
  clearMediaCache();
  calls.length = 0;
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

function expectOk(r: MediaResult): asserts r is Extract<MediaResult, { OK: true }> {
  if (!r.OK) throw new Error(`expected OK, got failure ${JSON.stringify(r.failure)}`);
}

describe('media/image client', () => {
  it('sends the documented payload shape with a Bearer header and builds the data URL', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: true, body: { image_b64: B64 } }));

    const r = await generateTokenArt('a torchlit tavern', '256x256');
    expectOk(r);
    expect(r.dataUrl).toBe(DATA_URL);
    expect(r.cached).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(MEDIA_IMAGE_PATH);

    const headers = new Headers(calls[0].init.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('Content-Type')).toBe('application/json');

    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toEqual({ prompt: 'a torchlit tavern', size: '256x256', steps: 4 });
  });

  it('defaults to 512x512 when no size is given', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: true, body: { image_b64: B64 } }));
    await generateTokenArt('dragon');
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.size).toBe('512x512');
  });

  it('serves a repeat prompt+size from the session cache without a second fetch', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: true, body: { image_b64: B64 } }));

    const first = await generateTokenArt('crystal golem');
    const second = await generateTokenArt('crystal golem');
    expectOk(first);
    expectOk(second);
    expect(second.dataUrl).toBe(first.dataUrl);
    expect(second.cached).toBe(true);
    // One GPU spend, not two.
    expect(calls).toHaveLength(1);
  });

  it('treats a different size as a different cache key', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: true, body: { image_b64: B64 } }));
    await generateTokenArt('crystal golem', '512x512');
    await generateTokenArt('crystal golem', '256x256');
    expect(calls).toHaveLength(2);
  });

  it('refuses NOT_SIGNED_IN without touching the network', async () => {
    stubFetch(() => ({ ok: true, body: {} }));
    const r = await generateTokenArt('no seat');
    expect(r).toEqual({
      OK: false,
      failure: { kind: 'NOT_SIGNED_IN' },
    });
    expect(calls).toHaveLength(0);
  });

  it('maps HTTP 429 onto RATE_LIMITED with the bucket-honest message', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: false, status: 429, body: { detail: 'rate limited' } }));
    const r = await generateTokenArt('busy forge');
    expect(r).toMatchObject({ OK: false, failure: { kind: 'RATE_LIMITED' } });
    if (!r.OK) expect(describeMediaFailure(r.failure)).toMatch(/rate-limited \(10\/min\)/);
  });

  it('describes every failure variant with an honest, actionable string', () => {
    expect(describeMediaFailure({ kind: 'NOT_SIGNED_IN' })).toMatch(/sign in/i);
    expect(describeMediaFailure({ kind: 'RATE_LIMITED' })).toMatch(/rate-limited/i);
    expect(
      describeMediaFailure({ kind: 'REJECTED', status: 400, detail: 'bad prompt' })
    ).toContain('bad prompt');
    expect(describeMediaFailure({ kind: 'UNREACHABLE' })).toMatch(/unreachable|network/i);
  });

  it('forwards other refusals as REJECTED with status + upstream detail verbatim', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 422,
      body: { detail: 'prompt too long' },
    }));
    const r = await generateTokenArt('x'.repeat(501));
    expect(r).toMatchObject({
      OK: false,
      failure: { kind: 'REJECTED', status: 422 },
    });
    if (!r.OK && r.failure.kind === 'REJECTED') {
      expect(r.failure.detail).toContain('prompt too long');
    }
  });

  it('falls back to raw body text when a refusal has no JSON detail field', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 500,
      body: { detail: null },
    }));
    const r = await generateTokenArt('anything');
    expect(r).toMatchObject({ OK: false, failure: { kind: 'REJECTED', status: 500 } });
  });

  it('surfaces network failures as UNREACHABLE', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ throws: new TypeError('Failed to fetch') }));
    const r = await generateTokenArt('unreachable realm');
    expect(r).toMatchObject({ OK: false, failure: { kind: 'UNREACHABLE' } });
  });

  it('treats a malformed success payload as UNREACHABLE rather than inventing an image', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: true, body: { unexpected: true } }));
    const r = await generateTokenArt('empty forge');
    expect(r).toMatchObject({ OK: false, failure: { kind: 'UNREACHABLE' } });
  });

  it('does not poison the cache with failures', async () => {
    store.set('aethertable_token', TOKEN);
    let down = true;
    stubFetch(() =>
      down ? { throws: new TypeError('down') } : { ok: true, body: { image_b64: B64 } }
    );
    const failed = await generateTokenArt('phoenix');
    expect(failed.OK).toBe(false);
    down = false;
    const retried = await generateTokenArt('phoenix');
    expectOk(retried);
    expect(retried.cached).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
