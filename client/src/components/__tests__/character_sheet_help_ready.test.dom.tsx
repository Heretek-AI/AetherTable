/**
 * Iteration 79 — Help / Ready / Release gating in the CharacterSheet DOM.
 *
 * Pinned contracts:
 *  - the Help button exists ONLY when the projected roster places a living
 *    hostile within HELP_REACH_FEET (5 world units = 5 ft) of the active
 *    token; no projected position means NO button, never a guessed one;
 *  - the Ready panel always offers the four structured trigger options and
 *    requires freeform trigger text before Ready can fire when "Custom
 *    trigger…" is picked;
 *  - firing Ready posts through engineReadyAction's ids-plus-description
 *    contract (trigger folded into prose, never trigger_hint);
 *  - the Release button exists ONLY while a readied declaration is held, and
 *    a missing gateway proxy surfaces as an honest rejection, never a fake
 *    success.
 *
 * The maneuvers/Readied panel renders only for a token bound to the signed-in
 * player's own stored character, so every test stubs that binding too.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CharacterSheet } from '../CharacterSheet';
import type { Token } from '../TacticalCanvas';

// Vitest globals are off in this suite — unmount explicitly between tests.
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
      calls.push({ url, init: (init ?? {}) as RequestInit, body: init?.body ? JSON.parse(String(init.body)) : null });
      return respond(url);
    }),
  );
  return calls;
}

/** Character-binding stubs so ownsBoundCharacter resolves true. */
const CHARACTER_STUBS = (calls: FetchCall[]): Record<string, { ok: boolean; json: () => Promise<unknown> }> => ({
  '/api/v1/characters': {
    ok: true,
    json: async () => ({
      characters: [
        { character_id: 'c1', name: 'Thorin Oakenshield', level: 5, character_class: 'fighter' },
      ],
    }),
  },
  '/api/v1/characters/c1': {
    ok: true,
    json: async () => ({
      character_id: 'c1',
      name: 'Thorin Oakenshield',
      level: 5,
      character_class: 'fighter',
      data: {
        abilities: { Strength: 16, Dexterity: 12, Constitution: 14, Intelligence: 10, Wisdom: 10, Charisma: 10 },
        speed: 30,
        attacks: [],
        spells: [],
        inventory: [],
      },
    }),
  },
});

function stubTable(opts?: { enemyPosition?: number[]; readiedDescription?: string }) {
  const calls = stubFetch((url) => {
    if (url === '/api/v1/engine/session-state') {
      return {
        ok: true,
        json: async () => ({
          entities: {
            thorin_1: {
              id: 'thorin_1',
              name: 'Thorin',
              is_player: true,
              is_visible: true,
              current_hp: 42,
              position: [4, 4],
              ...(opts?.readiedDescription
                ? { readied_action: { description: opts.readiedDescription } }
                : {}),
            },
            goblin: {
              id: 'goblin',
              name: 'Goblin',
              is_player: false,
              is_visible: true,
              position: opts?.enemyPosition ?? [5, 4],
            },
          },
        }),
      };
    }
    return (
      CHARACTER_STUBS(calls)[url] ?? { ok: false, status: 404, json: async () => ({ detail: 'Not Found' }) }
    );
  });
  return calls;
}

const ME: Token = {
  id: 'thorin_1',
  name: 'Thorin Oakenshield',
  x: 4,
  y: 4,
  hp: 42,
  maxHp: 42,
  ac: 18,
  color: '#3b82f6',
  isPlayer: true,
};

const baseProps = {
  activeToken: ME,
  onExecuteAttack: () => undefined,
  onCastSpell: () => undefined,
  onRollCheck: () => undefined,
  isCollapsed: false,
  onToggleCollapse: () => undefined,
  engineSessionId: 'sess-1',
};

describe('CharacterSheet Help/Ready gating (iteration 79)', () => {
  it('renders the Help button only for an in-reach living hostile', async () => {
    stubTable({ enemyPosition: [5, 4] }); // 1 unit away -> inside 5 ft reach
    render(<CharacterSheet {...baseProps} />);
    await waitFor(() =>
      expect(screen.queryByTestId('sheet-help-action')).not.toBeNull(),
    );
    expect(screen.getByTestId('sheet-help-action').textContent).toContain('Goblin');
  });

  it('omits the Help button when every hostile sits beyond reach', async () => {
    stubTable({ enemyPosition: [40, 40] }); // far outside 5 ft
    render(<CharacterSheet {...baseProps} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain('Combat Maneuvers'),
    );
    await new Promise((r) => setTimeout(r, 50)); // let any late state settle
    expect(screen.queryByTestId('sheet-help-action')).toBeNull();
  });

  it('offers all four structured triggers and folds them into the posted description', async () => {
    const calls = stubTable({ enemyPosition: [5, 4] });
    render(<CharacterSheet {...baseProps} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain('Combat Maneuvers'),
    );
    for (const id of ['enemy_enters_reach', 'enemy_attacks', 'turn_start', 'freeform']) {
      expect(screen.queryByTestId(`sheet-ready-trigger-${id}`)).not.toBeNull();
    }
    fireEvent.change(screen.getByLabelText('Readied action description'), {
      target: { value: 'I attack the goblin' },
    });
    fireEvent.click(screen.getByTestId('sheet-ready-trigger-enemy_attacks'));
    fireEvent.click(screen.getByRole('button', { name: 'Ready' }));
    await waitFor(() => {
      expect(calls.find((c) => c.url === '/api/v1/engine/ready')).toBeTruthy();
    });
    const readyCall = calls.find((c) => c.url === '/api/v1/engine/ready')!;
    const sent = readyCall.body as Record<string, unknown>;
    expect(sent).toEqual({
      session_id: 'sess-1',
      entity_id: 'thorin_1',
      description: 'I attack the goblin (trigger: when an enemy attacks an ally)',
    });
    // The engine's deny_unknown_fields would reject trigger_hint outright.
    expect(Object.keys(sent)).not.toContain('trigger_hint');
  });

  it('blocks Ready until freeform trigger text exists', async () => {
    stubTable({ enemyPosition: [5, 4] });
    render(<CharacterSheet {...baseProps} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain('Combat Maneuvers'),
    );
    fireEvent.change(screen.getByLabelText('Readied action description'), {
      target: { value: 'I attack the goblin' },
    });
    fireEvent.click(screen.getByTestId('sheet-ready-trigger-freeform'));
    const readyBtn = screen.getByRole('button', { name: 'Ready' }) as HTMLButtonElement;
    expect(readyBtn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Custom trigger text'), {
      target: { value: 'the door opens' },
    });
    expect(readyBtn.disabled).toBe(false);
  });

  it('shows Release ONLY while a readied declaration is held, and posts ids-only', async () => {
    const calls = stubTable({ enemyPosition: [5, 4], readiedDescription: 'I attack the goblin' });
    render(<CharacterSheet {...baseProps} />);
    await waitFor(() =>
      expect(screen.queryByTestId('sheet-readied-description')).not.toBeNull(),
    );
    expect(screen.queryByTestId('sheet-release-ready')).not.toBeNull();

    fireEvent.click(screen.getByTestId('sheet-release-ready'));
    await waitFor(() => {
      expect(calls.find((c) => c.url === '/api/v1/engine/ready/release')).toBeTruthy();
    });
    const rel = calls.find((c) => c.url === '/api/v1/engine/ready/release')!;
    expect(rel.init.method).toBe('POST');
    expect(rel.body).toEqual({ session_id: 'sess-1', entity_id: 'thorin_1' });
    expect((rel.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('hides Release when nothing is readied', async () => {
    stubTable({ enemyPosition: [5, 4] }); // no readied_action on the projection
    render(<CharacterSheet {...baseProps} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain('Nothing readied'),
    );
    expect(screen.queryByTestId('sheet-release-ready')).toBeNull();
  });

  it('quotes the missing gateway proxy honestly when release 404s', async () => {
    stubTable({ enemyPosition: [5, 4], readiedDescription: 'held' });
    render(<CharacterSheet {...baseProps} />);
    await waitFor(() =>
      expect(screen.queryByTestId('sheet-release-ready')).not.toBeNull(),
    );
    fireEvent.click(screen.getByTestId('sheet-release-ready'));
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        'Rejected by the engine — Not Found',
      );
    });
  });
});
