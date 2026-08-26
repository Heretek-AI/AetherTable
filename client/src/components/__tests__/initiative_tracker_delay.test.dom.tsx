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
 * Iteration 34 adds the mirrored SRD Surprise surface:
 *  - A visible "Surprised" badge renders for every id the engine's
 *    `combat.surprised` array carries, and for nothing else — trusted verbatim.
 *  - Mark/Clear buttons render under the SAME controlledEntityIds gating as
 *    Delay/Resume (spectators none); the ENGINE re-verifies GM authority and the
 *    first-round window, so a non-GM attempt surfaces FORBIDDEN_ROLE and a
 *    round>1 attempt SURPRISE_WINDOW_CLOSED — verbatim, never rewritten.
 *  - Firing either posts SurpriseAdjudicationReq through /api/v1/engine/combat/
 *    surprise and then asks the CALLER to refresh the authoritative snapshot
 *    (no local mutation of the surprised set).
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
  /** Iteration 34 — the engine's projected `combat.surprised` list. */
  surprised?: string[];
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
    surprisedIds: opts.surprised ?? [],
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

describe('Surprised marker rendering (iteration 34)', () => {
  it('renders a Surprised badge for each id in the engine surprised list — verbatim', () => {
    renderTracker({ surprised: ['goblin_1'] });
    expect(screen.getByTestId('surprised-marker-goblin_1')).toBeTruthy();
    expect(screen.queryByTestId('surprised-marker-thorin_1')).toBeNull();
  });

  it('renders badges for multiple surprised combatants and none when nobody is surprised', () => {
    const { unmount } = renderTracker({ surprised: ['thorin_1', 'goblin_1'] });
    expect(screen.getByTestId('surprised-marker-thorin_1')).toBeTruthy();
    expect(screen.getByTestId('surprised-marker-goblin_1')).toBeTruthy();
    unmount();
    renderTracker({ surprised: [] });
    expect(screen.queryByTestId(/surprised-marker-/)).toBeNull();
  });

  it('never invents badges for entities the projection did not mark', () => {
    renderTracker({ surprised: ['someone-else-entirely'] });
    expect(screen.queryByTestId(/surprised-marker-/)).toBeNull();
  });

  it('shows the badge in collapsed rail mode too', () => {
    const props = {
      tokens: [THORIN, GOBLIN],
      onNextTurn: () => undefined,
      onSelectToken: () => undefined,
      selectedTokenId: null as string | null,
      roundNumber: 1,
      isCollapsed: true,
      onToggleCollapse: () => undefined,
      inCombat: true,
      combatOrder: ORDER,
      activeEntityId: 'thorin_1',
      isGm: false,
      isCombatBusy: false,
      onBeginCombat: () => undefined,
      onEndCombat: () => undefined,
      delayedIds: [],
      surprisedIds: ['goblin_1'],
      controlledEntityIds: [],
      onRefreshCombatState: () => undefined,
    };
    render(<InitiativeTracker {...props} />);
    expect(screen.getByTestId('surprised-marker-goblin_1')).toBeTruthy();
  });
});

describe('Surprised mark / clear wire + gating (iteration 34)', () => {
  it('marks a controlled combatant through the engine proxy with the Bearer header', async () => {
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'SURPRISE_GRANTED',
        sequence_id: 9,
        changed: true,
        entity_id: 'thorin_1',
        round: 1,
        surprised: ['thorin_1'],
      }),
    }));
    let refreshed = 0;
    render(
      <InitiativeTracker
        tokens={[THORIN, GOBLIN]}
        onNextTurn={() => undefined}
        onSelectToken={() => undefined}
        selectedTokenId={null}
        roundNumber={1}
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
        surprisedIds={[]}
        combatSessionIdForActions="sess-1"
        controlledEntityIds={['thorin_1']}
        onRefreshCombatState={() => {
          refreshed += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('surprised-mark-thorin_1'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/engine/combat/surprise')).toBeTruthy(),
    );
    const call = calls.find((c) => c.url === '/api/v1/engine/combat/surprise')!;
    expect(call.body).toEqual({ session_id: 'sess-1', entity_id: 'thorin_1', surprised: true });
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    // Optimistic-state discipline: the tracker never mutates the surprised set
    // itself — it asks the caller to re-pull the authoritative snapshot.
    await waitFor(() => expect(refreshed).toBeGreaterThan(0));
  });

  it('clears surprise for a marked combatant through the same engine proxy', async () => {
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'SURPRISE_REVOKED',
        sequence_id: 10,
        changed: true,
        entity_id: 'goblin_1',
        round: 1,
        surprised: [],
      }),
    }));
    renderTracker({ surprised: ['goblin_1'], controlledIds: ['goblin_1'] });
    expect(screen.queryByTestId('surprised-mark-goblin_1')).toBeNull();
    fireEvent.click(screen.getByTestId('surprised-clear-goblin_1'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/engine/combat/surprise')).toBeTruthy(),
    );
    expect(calls.find((c) => c.url === '/api/v1/engine/combat/surprise')!.body).toEqual({
      session_id: 'sess-1',
      entity_id: 'goblin_1',
      surprised: false,
    });
  });

  it('swaps the Mark button for Clear while the entity is surprised', () => {
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    renderTracker({ surprised: ['thorin_1'], controlledIds: ['thorin_1'] });
    expect(screen.queryByTestId('surprised-mark-thorin_1')).toBeNull();
    expect(screen.getByTestId('surprised-clear-thorin_1')).toBeTruthy();
  });

  it('gives the GM mark buttons for every combatant (GMs adjudicate anyone)', () => {
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    renderTracker({ isGm: true });
    expect(screen.getByTestId('surprised-mark-thorin_1')).toBeTruthy();
    expect(screen.getByTestId('surprised-mark-goblin_1')).toBeTruthy();
  });

  it('gives a player a mark button only on their own token — not others — the engine re-verifies GM authority', () => {
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    renderTracker({ controlledIds: ['thorin_1'] });
    expect(screen.getByTestId('surprised-mark-thorin_1')).toBeTruthy();
    expect(screen.queryByTestId('surprised-mark-goblin_1')).toBeNull();
    expect(screen.queryByTestId('surprised-clear-goblin_1')).toBeNull();
  });

  it('gives spectators no surprise mark or clear buttons at all', () => {
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    renderTracker({ controlledIds: [], isGm: false });
    expect(screen.queryByTestId(/surprised-mark-/)).toBeNull();
    expect(screen.queryByTestId(/surprised-clear-/)).toBeNull();
  });

  it('surfaces an engine rejection code verbatim instead of faking success', async () => {
    const calls = stubFetch(() => ({
      ok: false,
      status: 422,
      json: async () => ({
        detail: { error: 'SURPRISE_WINDOW_CLOSED', message: 'surprise adjudication rejected by the engine' },
      }),
    }));
    renderTracker({ controlledIds: ['thorin_1'] });
    fireEvent.click(screen.getByTestId('surprised-mark-thorin_1'));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(screen.getByTestId('surprise-error').textContent).toContain('SURPRISE_WINDOW_CLOSED'),
    );
  });

  it('renders no surprise error line before anything has been attempted', () => {
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    renderTracker({ controlledIds: ['thorin_1'] });
    expect(screen.queryByTestId('surprise-error')).toBeNull();
  });

  it('hides all surprise affordances outside of combat', () => {
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
      surprisedIds: [],
      controlledEntityIds: ['thorin_1'],
      onRefreshCombatState: () => undefined,
    };
    render(<InitiativeTracker {...props} />);
    expect(screen.queryByTestId(/surprised-mark-/)).toBeNull();
  });
});
