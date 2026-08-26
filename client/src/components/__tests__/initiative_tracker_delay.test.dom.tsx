/**
 * Iteration 16 (Loop 3) — Delay / Resume controls in the InitiativeTracker DOM.
 *
 * Pinned contracts:
 *  - A visible "Delayed" marker renders for every id the engine's
 *    `combat.delayed` array carries, and for nothing else. The tracker trusts
 *    the server projection verbatim — it does NOT re-filter client-side
 *    (hidden combatants were already dropped engine-side).
 *  - Delay / Resume buttons exist ONLY for entities this seat controls:
 *    GMs may delay/resume anyone; a player only their own bound token;
 *    spectators get neither — mirroring how the tracker already gates its
 *    Begin/End combat controls on isGm.
 *  - Firing either control posts through the ids-only wire contract and then
 *    asks the CALLER to refresh the authoritative snapshot: no local mutation
 *    of order/turn_index ever happens here (optimistic-state discipline).
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InitiativeTracker } from '../InitiativeTracker';
import type { Token } from '../TacticalCanvas';

afterEach(cleanup);

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  store.set('aethertable_token', TOKEN);
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

type FetchCall = { url: string; init: RequestInit; body: unknown };

function stubFetch(
  respond: (url: string) => { ok: boolean; status?: number; json: () => Promise<unknown> },
) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        init: (init ?? {}) as RequestInit,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return respond(url);
    }),
  );
  return calls;
}

const THORIN: Token = {
  id: 'thorin_1',
  name: 'Thorin',
  x: 4,
  y: 4,
  hp: 42,
  maxHp: 42,
  ac: 18,
  color: '#3b82f6',
  isPlayer: true,
};
const GOBLIN: Token = { ...THORIN, id: 'goblin_1', name: 'Goblin', hp: 12, maxHp: 12, ac: 14, color: '#f59e0b', isPlayer: false };

const ORDER = [
  { entity_id: 'thorin_1', name: 'Thorin', dexterity: 2, initiative_total: 18 },
  { entity_id: 'goblin_1', name: 'Goblin', dexterity: 3, initiative_total: 15 },
];

interface Opts {
  delayed?: string[];
  isGm?: boolean;
  /** Defaults to "everyone" (GM semantics); pass [] explicitly for nobody. */
  controlledIds?: string[] | 'everyone';
}

const ALL_IDS = ORDER.map((o) => o.entity_id);

function renderTracker(opts: Opts = {}, onNextTurn = () => undefined) {
  const props = {
    tokens: [THORIN, GOBLIN],
    onNextTurn,
    onSelectToken: () => undefined,
    selectedTokenId: null as string | null,
    roundNumber: 3,
    isCollapsed: false,
    onToggleCollapse: () => undefined,
    inCombat: true,
    combatOrder: ORDER,
    activeEntityId: 'thorin_1',
    isGm: opts.isGm ?? false,
    isCombatBusy: false,
    onBeginCombat: () => undefined,
    onEndCombat: () => undefined,
    delayedIds: opts.delayed ?? [],
    combatSessionIdForActions: 'sess-1',
    controlledEntityIds:
      opts.controlledIds === undefined || opts.controlledIds === 'everyone'
        ? ALL_IDS
        : opts.controlledIds,
    onRefreshCombatState: () => undefined,
  };
  return render(<InitiativeTracker {...props} />);
}

describe('Delayed marker rendering', () => {
  it('renders a Delayed marker for each id in the engine delayed list', () => {
    renderTracker({ delayed: ['goblin_1'] });
    expect(screen.getByTestId('delayed-marker-goblin_1')).toBeTruthy();
    expect(screen.queryByTestId('delayed-marker-thorin_1')).toBeNull();
  });

  it('renders markers for multiple parked combatants and none when nobody delayed', () => {
    const { unmount } = renderTracker({ delayed: ['thorin_1', 'goblin_1'] });
    expect(screen.getByTestId('delayed-marker-thorin_1')).toBeTruthy();
    expect(screen.getByTestId('delayed-marker-goblin_1')).toBeTruthy();
    unmount();
    renderTracker({ delayed: [] });
    expect(screen.queryByTestId(/delayed-marker-/)).toBeNull();
  });

  it('never invents markers for entities the projection did not park', () => {
    renderTracker({ delayed: ['someone-else-entirely'] });
    expect(screen.queryByTestId(/delayed-marker-/)).toBeNull();
  });

  it('shows the marker in collapsed rail mode too', () => {
    const props = {
      tokens: [THORIN, GOBLIN],
      onNextTurn: () => undefined,
      onSelectToken: () => undefined,
      selectedTokenId: null as string | null,
      roundNumber: 3,
      isCollapsed: true,
      onToggleCollapse: () => undefined,
      inCombat: true,
      combatOrder: ORDER,
      activeEntityId: 'thorin_1',
      isGm: false,
      isCombatBusy: false,
      onBeginCombat: () => undefined,
      onEndCombat: () => undefined,
      delayedIds: ['thorin_1'],
      controlledEntityIds: [],
      onRefreshCombatState: () => undefined,
    };
    render(<InitiativeTracker {...props} />);
    expect(screen.getByTestId('delayed-marker-thorin_1')).toBeTruthy();
  });
});

describe('Delay / Resume control gating', () => {
  it('offers Delay for an own controlled entity that is not yet delayed', async () => {
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ status: 'DELAY_TAKEN', entity_id: 'thorin_1', delayed: ['thorin_1'], order: [], round: 3 }),
    }));
    let refreshed = 0;
    const { rerender } = render(
      <InitiativeTracker
        tokens={[THORIN, GOBLIN]}
        onNextTurn={() => undefined}
        onSelectToken={() => undefined}
        selectedTokenId={null}
        roundNumber={3}
        isCollapsed={false}
        onToggleCollapse={() => undefined}
        inCombat
        combatOrder={ORDER}
        activeEntityId="thorin_1"
        isGm={false}
        isCombatBusy={false}
        onBeginCombat={() => undefined}
        onEndCombat={() => undefined}
        delayedIds={[]}
        combatSessionIdForActions="sess-1"
        controlledEntityIds={['thorin_1']}
        onRefreshCombatState={() => {
          refreshed += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('delay-action-thorin_1'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/engine/delay')).toBeTruthy(),
    );
    const call = calls.find((c) => c.url === '/api/v1/engine/delay')!;
    expect(call.body).toEqual({ session_id: 'sess-1', entity_id: 'thorin_1' });
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    // Optimistic-state discipline: the tracker never mutates order itself —
    // it asks the caller to re-pull the authoritative snapshot.
    await waitFor(() => expect(refreshed).toBeGreaterThan(0));
    // After the caller's re-pull lands the new snapshot, the marker appears
    // from SNAPSHOT data (not from any local bookkeeping).
    rerender(
      <InitiativeTracker
        tokens={[THORIN, GOBLIN]}
        onNextTurn={() => undefined}
        onSelectToken={() => undefined}
        selectedTokenId={null}
        roundNumber={3}
        isCollapsed={false}
        onToggleCollapse={() => undefined}
        inCombat
        combatOrder={ORDER}
        activeEntityId="thorin_1"
        isGm={false}
        isCombatBusy={false}
        onBeginCombat={() => undefined}
        onEndCombat={() => undefined}
        delayedIds={['thorin_1']}
        combatSessionIdForActions="sess-1"
        controlledEntityIds={['thorin_1']}
        onRefreshCombatState={() => {
          refreshed += 1;
        }}
      />,
    );
    expect(screen.getByTestId('delayed-marker-thorin_1')).toBeTruthy();
  });

  it('swaps Delay for Resume while the entity is parked', async () => {
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ status: 'DELAY_RESUMED', entity_id: 'thorin_1', delayed: [], order: [], round: 3 }),
    }));
    renderTracker({ delayed: ['thorin_1'], controlledIds: ['thorin_1'] });
    expect(screen.queryByTestId('delay-action-thorin_1')).toBeNull();
    fireEvent.click(screen.getByTestId('delay-resume-thorin_1'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/engine/delay/resume')).toBeTruthy(),
    );
    expect(calls.find((c) => c.url === '/api/v1/engine/delay/resume')!.body).toEqual({
      session_id: 'sess-1',
      entity_id: 'thorin_1',
    });
  });

  it('gives the GM controls for every combatant (GMs act on anyone)', () => {
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    renderTracker({ isGm: true });
    expect(screen.getByTestId('delay-action-thorin_1')).toBeTruthy();
    expect(screen.getByTestId('delay-action-goblin_1')).toBeTruthy();
  });

  it('gives players NO controls over combatants they do not control', () => {
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    renderTracker({ controlledIds: ['thorin_1'] });
    expect(screen.getByTestId('delay-action-thorin_1')).toBeTruthy();
    expect(screen.queryByTestId('delay-action-goblin_1')).toBeNull();
    expect(screen.queryByTestId('delay-resume-goblin_1')).toBeNull();
  });

  it('gives spectators no delay or resume controls at all', () => {
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    renderTracker({ controlledIds: [], isGm: false });
    expect(screen.queryByTestId(/delay-action-/)).toBeNull();
    expect(screen.queryByTestId(/delay-resume-/)).toBeNull();
  });

  it('surfaces an engine rejection code verbatim instead of faking success', async () => {
    const calls = stubFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ detail: { error: 'ALREADY_DELAYED', message: 'already parked' } }),
    }));
    renderTracker({ controlledIds: ['thorin_1'] });
    fireEvent.click(screen.getByTestId('delay-action-thorin_1'));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(screen.getByTestId('delay-error').textContent).toContain('ALREADY_DELAYED'),
    );
  });

  it('renders no error line before anything has been attempted', () => {
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    renderTracker({ controlledIds: ['thorin_1'] });
    expect(screen.queryByTestId('delay-error')).toBeNull();
  });

  it('hides all delay affordances outside of combat', () => {
    const props = {
      tokens: [THORIN],
      onNextTurn: () => undefined,
      onSelectToken: () => undefined,
      selectedTokenId: null as string | null,
      roundNumber: 0,
      isCollapsed: false,
      onToggleCollapse: () => undefined,
      inCombat: false,
      combatOrder: [],
      activeEntityId: null as string | null,
      isGm: true,
      isCombatBusy: false,
      onBeginCombat: () => undefined,
      onEndCombat: () => undefined,
      delayedIds: [],
      controlledEntityIds: ['thorin_1'],
      onRefreshCombatState: () => undefined,
    };
    render(<InitiativeTracker {...props} />);
    expect(screen.queryByTestId(/delay-action-/)).toBeNull();
  });
});
