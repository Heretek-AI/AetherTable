/**
 * Unit tests for the X-card rewind convergence flow (iteration 28).
 *
 * Contract under test:
 *  - triggerXCard posts with the stored HMAC token (regression guard for
 *    iterations 5/13) AND, on SAFETY_REWIND_SUCCESS, its body carries the
 *    engine's embedded post-rewind snapshot through parseEngineRewind intact.
 *  - fetchSessionState (the convergence refetch fallback) is authenticated
 *    Bearer-header-only, never puts a token in a URL, and surfaces structured
 *    failures so a failed/unreachable rewind leaves local state untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSessionState, triggerXCard } from '../safety_xcard';
import { computeTokenReconciliation, parseEngineRewind } from '../../ui/safetyXCard';

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

const REWIND_BODY = () => ({
  status: 'SAFETY_INTERVENTION_ACTIVATED',
  target_sequence_id: 9,
  engine_rewind: {
    status: 'SAFETY_REWIND_SUCCESS',
    rewind_report: { reverted_event_count: 2, restored_entities: 1, removed_entities: 0 },
    snapshot: {
      session_id: 'sess-1',
      entities: {
        hero: { id: 'hero', current_hp: 42, position: [4, 4, 0], is_player: true },
      },
    },
  },
});

describe('x-card response → reconciliation payload', () => {
  it('carries the embedded snapshot from a confirmed rewind into the planner', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: true, json: async () => REWIND_BODY() }));
    const result = await triggerXCard({
      player_id: 'thorin',
      topic: 'arachnophobia',
      current_sequence_id: 50,
      engine_session_id: 'sess-1',
    });
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;

    const parsed = parseEngineRewind(result.body);
    expect(parsed!.status).toBe('SAFETY_REWIND_SUCCESS');
    expect(parsed!.report.reverted_event_count).toBe(2);

    // The reconciliation plan built from the CONFIRMED rewind's own body:
    // authoritative post-rewind HP + grid position for the mirrored token.
    const plan = computeTokenReconciliation(
      [{ id: 'hero', hp: 8, x: 6, y: 6 }],
      parsed!.snapshot,
    );
    expect(plan.empty).toBe(false);
    expect(plan.patches).toEqual([{ id: 'hero', hp: 42, x: 4, y: 4 }]);
  });

  it('reports an empty plan when the rewind succeeded but no session was named', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: true,
      json: async () => ({ status: 'SAFETY_INTERVENTION_ACTIVATED' }), // no engine_rewind
    }));
    const result = await triggerXCard({
      player_id: 'thorin',
      topic: 'general',
      current_sequence_id: 1,
      engine_session_id: null,
    });
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(parseEngineRewind(result.body)).toBeNull();
    // Nothing to converge against — tokens must be left untouched.
    expect(computeTokenReconciliation([{ id: 'h', hp: 5, x: 0, y: 0 }], null).empty).toBe(true);
  });
});

describe('fetchSessionState — convergence refetch fallback', () => {
  it('refuses without a session id and without a stored token (no dialing)', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));

    const noSession = await fetchSessionState(null);
    expect(noSession.kind).toBe('ERROR');
    if (noSession.kind === 'ERROR') expect(noSession.failure.kind).toBe('NO_SESSION');

    const signedOut = await fetchSessionState('sess-1');
    expect(signedOut.kind).toBe('ERROR');
    if (signedOut.kind === 'ERROR') expect(signedOut.failure.kind).toBe('NOT_SIGNED_IN');

    expect(calls).toHaveLength(0);
  });

  it('POSTs the session reference with the Bearer header (never a URL token)', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ session_id: 'sess-1', entities: { hero: { current_hp: 30 } } }),
    }));
    const result = await fetchSessionState('sess-1');
    expect(result.kind).toBe('OK');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/engine/session-state');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).not.toContain('token=');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ session_id: 'sess-1' });

    // And the body parses straight into the reconciliation shape.
    if (result.kind === 'OK') {
      const snap = parseEngineRewind({
        engine_rewind: { status: 'SAFETY_REWIND_SUCCESS', snapshot: result.body },
      })!.snapshot!;
      const plan = computeTokenReconciliation([{ id: 'hero', hp: 8, x: 0, y: 0 }], snap);
      expect(plan.patches).toEqual([{ id: 'hero', hp: 30 }]);
    }
  });

  it('maps an HTTP error to HTTP_ERROR without throwing (state stays untouched)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: false, status: 403, json: async () => ({ detail: 'no' }) }));
    const result = await fetchSessionState('sess-1');
    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR' && result.failure.kind === 'HTTP_ERROR') {
      expect(result.failure.status).toBe(403);
    } else {
      throw new Error(`expected HTTP_ERROR, got ${JSON.stringify(result)}`);
    }
  });

  it('maps a network failure to UNREACHABLE instead of crashing', async () => {
    store.set('aethertable_token', TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const result = await fetchSessionState('sess-1');
    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR') expect(result.failure.kind).toBe('UNREACHABLE');
  });
});
