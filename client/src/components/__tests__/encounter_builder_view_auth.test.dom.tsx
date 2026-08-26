/**
 * Iteration 23 (nit) — EncounterBuilderView's `forbiddenByServer` must be a
 * per-identity latch, not a lifetime one. A 403 from a previous identity
 * (player) must NOT block a freshly GM-signed-in seat that takes over the
 * same tab without a page reload.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EncounterBuilderView } from '../EncounterBuilderView';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.useRealTimers();
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

/** Builds a fetch stub keyed off URL path. Returns the call log for assertions. */
function stubFetchRoutes(
  routes: Record<string, () => Response | Promise<Response>>,
): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: (init ?? {}) as RequestInit });
    // Strip the query string before matching so a ?limit=N suffix doesn't
    // disable the suffix-match for routes like /api/v1/compendium/monsters.
    const pathOnly = String(url).split('?')[0];
    for (const [suffix, responder] of Object.entries(routes)) {
      if (pathOnly.endsWith(suffix)) return await responder();
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ detail: 'No stub for ' + url }),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

const LIST_MONSTERS = {
  monsters: [
    {
      id: 'goblin',
      name: 'Goblin',
      challenge_rating: '1/4',
      hp: 7,
      ac: 15,
      xp: 50,
      creature_type: 'humanoid',
      speed: '30 ft.',
    },
  ],
};

describe('EncounterBuilderView — forbiddenByServer latch (nit)', () => {
  it('hides the balance strip when the route answers 403 for a player seat', async () => {
    store.set('aethertable_token', TOKEN);
    // The prop says "not GM" (effectiveIsGM=false). The strip is hidden by
    // the role gate alone — the 403 latch only matters when a *GM* later
    // takes over the same tab. Sanity-check the baseline: no GM strip yet.
    stubFetchRoutes({
      '/api/v1/lobbies/mine': () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ lobbies: [] }),
        }) as unknown as Response,
      '/api/v1/compendium/monsters': () =>
        ({
          ok: true,
          status: 200,
          json: async () => LIST_MONSTERS,
        }) as unknown as Response,
    });
    const { rerender } = render(<EncounterBuilderView isGM={false} />);
    // Player seat: no strip at all (no role, no 403).
    expect(screen.queryByTestId('balance-difficulty-badge')).toBeNull();
    expect(screen.queryByTestId('balance-error')).toBeNull();
    expect(screen.queryByText(/Balance \(Server Model\)/i)).toBeNull();

    // Now flip to GM via prop — the strip becomes eligible. The re-render
    // does not require a remount; the same instance keeps its state.
    rerender(<EncounterBuilderView isGM={true} />);
    await waitFor(() =>
      expect(screen.queryByText(/Balance \(Server Model\)/i)).toBeTruthy(),
    );
  });

  it('a freshly GM-signed-in seat regains the strip after the role transitions (no 403 latch poisoning)', async () => {
    store.set('aethertable_token', TOKEN);
    // The lobby defaults route answers fast, the balance route is mocked
    // through fetchPartyDefaults only — no roster added, so the balancer is
    // never invoked and no 403 is ever recorded. We exercise the effect path
    // directly by remounting with the prop driving the transition.
    stubFetchRoutes({
      '/api/v1/lobbies/mine': () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ lobbies: [{ starting_level: 3, party_size: 4, created_at: 1 }] }),
        }) as unknown as Response,
      '/api/v1/compendium/monsters': () =>
        ({
          ok: true,
          status: 200,
          json: async () => LIST_MONSTERS,
        }) as unknown as Response,
    });
    const { rerender } = render(<EncounterBuilderView isGM={false} />);
    // Start as player — strip not visible.
    expect(screen.queryByText(/Balance \(Server Model\)/i)).toBeNull();

    // Transition: player → gm. The transition effect clears the latch (it
    // was never set, but the same machinery handles "was set, now reset").
    rerender(<EncounterBuilderView isGM={true} />);
    await waitFor(() =>
      expect(screen.getByText(/Balance \(Server Model\)/i)).toBeTruthy(),
    );
  });

  it('a previously-403\'d instance regains the strip on false→true isGM transition', async () => {
    store.set('aethertable_token', TOKEN);
    let balanceCalls = 0;
    stubFetchRoutes({
      '/api/v1/lobbies/mine': () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ lobbies: [] }),
        }) as unknown as Response,
      '/api/v1/compendium/monsters': () =>
        ({
          ok: true,
          status: 200,
          json: async () => LIST_MONSTERS,
        }) as unknown as Response,
      '/api/v1/engine/encounter/balance': () => {
        balanceCalls += 1;
        // First call answers 403 (player-shaped identity); subsequent calls
        // resolve OK so a GM-signed-in seat sees a real verdict.
        if (balanceCalls === 1) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ detail: 'ENCOUNTER_BALANCE_GM_ONLY' }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ difficulty: 'easy', raw_xp: 50, adjusted_xp: 50, multiplier: 1 }),
        } as unknown as Response;
      },
    });
    // Start as GM (effectiveIsGM=true) so the balancer fires, then the
    // first roster change triggers a 403 → forbiddenByServer is latched.
    const { rerender } = render(<EncounterBuilderView isGM={true} />);
    // Wait for both the strip AND the compendium to mount.
    await waitFor(() =>
      expect(screen.getByText(/Balance \(Server Model\)/i)).toBeTruthy(),
    );
    await waitFor(() => expect(screen.getByText('Goblin')).toBeTruthy());
    // Add a monster → after the debounce window the balance call fires.
    // The compendium row is the role="button" Goblin card (not the roster
    // row that re-renders once Goblin is added). Multiple matches for the
    // name text are expected once a roster entry exists.
    const compendiumCards = screen.getAllByRole('button', { name: /Goblin/i });
    fireEvent.click(compendiumCards[compendiumCards.length - 1]);
    await waitFor(
      () => {
        // The 403 has latched the strip out.
        expect(screen.queryByText(/Balance \(Server Model\)/i)).toBeNull();
        expect(balanceCalls).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 },
    );

    // Now the player gets demoted (isGM=false) and a new GM takes over in
    // the same tab — same component instance, just a prop change. The
    // transition effect must clear the latch so the strip is eligible again.
    rerender(<EncounterBuilderView isGM={false} />);
    rerender(<EncounterBuilderView isGM={true} />);
    await waitFor(
      () => expect(screen.queryByText(/Balance \(Server Model\)/i)).toBeTruthy(),
      { timeout: 3000 },
    );
    // Trigger another roster edit so the freshly-GM balancer actually
    // fires and the next balance call succeeds.
    const compendiumCards2 = screen.getAllByRole('button', { name: /Goblin/i });
    fireEvent.click(compendiumCards2[compendiumCards2.length - 1]);
    await waitFor(
      () => expect(balanceCalls).toBeGreaterThanOrEqual(2),
      { timeout: 3000 },
    );
  });
});