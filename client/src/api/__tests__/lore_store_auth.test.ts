/**
 * Unit tests for the identity + tier contract of src/api/lore_store.ts.
 *
 * Iteration-5 gateway hardening pinned two policies:
 *  - POST /api/v1/lore/assert requires an HMAC session token, resolved by the
 *    gateway's `_require_auth` (Bearer header first, query back-compat).
 *    Iteration-13 (F14) sends the Authorization: Bearer header — the URL is
 *    logged verbatim by proxies, so tokens must never ride in it.
 *  - Server-side epistemic ladder: every assertion ENTERS at SUBJECTIVE_RUMOR.
 *    A non-GM caller posting PROPOSED_FACT receives 403 LORE_TIER_FORBIDDEN
 *    (an honest refusal, never a silent downgrade). The client must default
 *    to SUBJECTIVE_RUMOR so a player submission is honest on the first try
 *    and surfaces the GM-required message when a higher tier is requested.
 *
 * These tests stub fetch exactly the way src/api/__tests__/rules_engine_auth.test.ts
 * does — sessionStorage stand-in, vi.stubGlobal('fetch', ...).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertLore, type AssertLoreResult } from '../lore_store';

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

function isParadox(r: AssertLoreResult | null): r is { outcome: 'REJECTED_PARADOX'; reason: string; latencyMs: number } {
  return !!r && r.outcome === 'REJECTED_PARADOX';
}

describe('lore assert identity contract', () => {
  it('refuses the call when the caller is signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const result = await assertLore('house_vane', 'sworn_enemy_of', 'house_silverpeak');
    expect(result).toMatchObject({ outcome: 'ERROR' });
    expect((result as { outcome: string; detail: string }).detail).toMatch(/sign in first/i);
    expect(calls).toHaveLength(0);
  });

  it('sends the Bearer header (never a URL token) and defaults epistemic_tier to SUBJECTIVE_RUMOR', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'STAGED',
        epistemic_tier: 'SUBJECTIVE_RUMOR',
        assigned_weight: 0.2,
        latency_ms: 4,
      }),
    }));
    const result = await assertLore('house_vane', 'sworn_enemy_of', 'house_silverpeak');
    expect(result).toMatchObject({ outcome: 'STAGED', epistemicTier: 'SUBJECTIVE_RUMOR' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/lore/assert');
    // F14: identity rides the Authorization header, never the query string.
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      subject_node_id: 'house_vane',
      predicate_relation: 'sworn_enemy_of',
      object_node_id: 'house_silverpeak',
      epistemic_tier: 'SUBJECTIVE_RUMOR',
    });
  });

  it('passes through an explicit tier only when the caller asks for it', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'COMMITTED',
        epistemic_tier: 'PROPOSED_FACT',
        assigned_weight: 0.7,
        latency_ms: 5,
      }),
    }));
    await assertLore('a', 'allied_with', 'b', undefined, { tier: 'PROPOSED_FACT' });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.epistemic_tier).toBe('PROPOSED_FACT');
  });

  it('surfaces a 403 LORE_TIER_FORBIDDEN as its own outcome (not generic ERROR)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 403,
      json: async () => ({
        detail:
          'LORE_TIER_FORBIDDEN: only GM tokens may promote lore above ' +
          'SUBJECTIVE_RUMOR; requested PROPOSED_FACT. Your assertion was NOT committed ' +
          '— resubmit without an epistemic_tier to enter it as a rumor.',
      }),
    }));
    const result = await assertLore('a', 'p', 'b', undefined, { tier: 'PROPOSED_FACT' });
    expect(result).toMatchObject({
      outcome: 'LORE_TIER_FORBIDDEN',
      requestedTier: 'PROPOSED_FACT',
    });
    if (result.outcome === 'LORE_TIER_FORBIDDEN') {
      // The detail must surface the server's own message so the UI can
      // render an honest "GM promotion required" banner with verbatim copy.
      expect(result.detail).toMatch(/^LORE_TIER_FORBIDDEN/);
    } else {
      throw new Error(`expected LORE_TIER_FORBIDDEN, got ${result.outcome}`);
    }
  });

  it('surfaces REJECTED_PARADOX verbatim (paradox reason is world state, not an error)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'REJECTED_PARADOX',
        reason: 'Assertion contradicts established canon: house_vane is allied_with house_silverpeak.',
        latency_ms: 12,
      }),
    }));
    const result = await assertLore('house_vane', 'sworn_enemy_of', 'house_silverpeak');
    if (!isParadox(result)) {
      throw new Error(`expected REJECTED_PARADOX, got ${String(result && (result as { outcome: string }).outcome)}`);
    }
    expect(result.reason).toMatch(/contradicts established canon/i);
    expect(result.latencyMs).toBe(12);
  });

  it('treats a generic 401 as ERROR (bad token, not a tier issue)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Invalid or expired session token' }),
    }));
    const result = await assertLore('a', 'p', 'b');
    expect(result).toMatchObject({ outcome: 'ERROR' });
  });
});