/**
 * AmbiencePanel component contracts, rendered through happy-dom against a
 * stubbed gateway (same fetch/sessionStorage stand-ins as
 * src/api/__tests__/sfx_panel.test.dom.tsx).
 *
 * Pinned here:
 *  - GATING: an explicitly non-staff seat sees the lock notice and NO cards;
 *    the gateway remains the real authority (403 path tested separately).
 *  - CATALOG: preset cards render label + description + loop_seconds, and the
 *    listing's `cached` metadata shows up as a badge.
 *  - PLAY/STOP: clicking a card fetches then loops; a playing bed shows its
 *    indicator and Stop stops it (no second wire call on replay — cache).
 *  - FORBIDDEN: the server's MEDIA_AMBIENCE_FORBIDDEN copy surfaces verbatim.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AmbiencePanel } from '../AmbiencePanel';
import {
  ambienceLibrarySize,
  clearAmbienceForTests,
} from '../../api/ambience_store';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

class FakeAudioContext {
  destination = { connect: () => undefined };
  decodeAudioData(
    bytes: ArrayBuffer,
    success: (b: unknown) => void,
  ): Promise<unknown> | void {
    return Promise.resolve({ channels: 2, length: bytes.byteLength });
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createGain(): unknown {
    return { gain: { value: 1 }, connect: () => undefined };
  }
  createBufferSource(): unknown {
    return {
      buffer: null,
      loop: false,
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      disconnect: () => undefined,
    };
  }
}

function stubFetch(respond?: (url: string) => Response) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) =>
    respond ? respond(url) : defaultRoute(url),
  );
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn> & { mock: { calls: unknown[] } };
}

/** Default routing: JSON catalog for GET, raw wav for POST {slug}. */
function defaultRoute(url: string): Response {
  if (url.endsWith('/api/v1/media/ambience')) {
    return { ok: true, status: 200, json: async () => LIST_PAYLOAD } as unknown as Response;
  }
  return okWav();
}

function okList(): Response {
  return { ok: true, status: 200, json: async () => LIST_PAYLOAD } as unknown as Response;
}

const LIST_PAYLOAD = {
  presets: [
    {
      slug: 'tavern-murmur',
      label: 'Tavern Murmur',
      description: 'Low crowd chatter, clinking tankards, a hearth crackling close.',
      prompt: 'warm tavern interior ambience',
      loop_seconds: 90,
      cached: true,
    },
    {
      slug: 'dungeon-drips',
      label: 'Dungeon Drips',
      description: 'Stone corridors, distant water, the occasional echo.',
      prompt: 'dripping dungeon cavern ambience',
      loop_seconds: 120,
      cached: false,
    },
  ],
};

function okWav(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode('RIFFfakewav').buffer as ArrayBuffer,
  } as unknown as Response;
}

beforeEach(() => {
  store.clear();
  clearAmbienceForTests();
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
  (globalThis as unknown as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('AmbiencePanel gating', () => {
  it('shows the GM-only lock notice, no preset cards, and never fetches the catalog', () => {
    const fetchFn = stubFetch();
    render(<AmbiencePanel userRole="player" />);
    expect(screen.getByTestId('ambience-panel').textContent).toMatch(/GM-only seat feature/i);
    expect(screen.queryByRole('button', { name: /tavern murmur/i })).toBeNull();
    // A gated seat does not even browse the catalog.
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it('renders preset cards for a gm seat', async () => {
    stubFetch();
    store.set('aethertable_token', TOKEN);
    render(<AmbiencePanel userRole="gm" />);
    expect(await screen.findByRole('button', { name: /tavern murmur/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /dungeon drips/i })).toBeTruthy();
    // Card copy comes straight from the catalog: description + loop length.
    expect(screen.getByText(/hearth crackling close/i)).toBeTruthy();
    expect(screen.getByText(/90 s loop/i)).toBeTruthy();
    expect(screen.getByText(/120 s loop/i)).toBeTruthy();
  });

  it('shows the server-cached badge only for presets the gateway reports cached', async () => {
    stubFetch();
    store.set('aethertable_token', TOKEN);
    render(<AmbiencePanel userRole="gm" />);
    await screen.findByRole('button', { name: /tavern murmur/i });
    expect(screen.getAllByText(/cached/i).length).toBe(1); // tavern only
  });
});

describe('play / stop flow', () => {
  it('clicking a card POSTs once, starts the loop indicator, and replaying costs no second wire call', async () => {
    const fetchFn = stubFetch();
    store.set('aethertable_token', TOKEN);
    render(<AmbiencePanel userRole="gm" />);
    fireEvent.click(await screen.findByRole('button', { name: /tavern murmur/i }));

    await waitFor(() => expect(screen.getByLabelText(/playing tavern murmur/i)).toBeTruthy());
    expect(ambienceLibrarySize()).toBe(1);
    // calls[0] is the catalog GET; the POST carries the slug route.
    const post = fetchFn.mock.calls.find(([u]) =>
      String(u).endsWith('/api/v1/media/ambience/tavern-murmur'),
    ) as unknown[] | undefined;
    expect(post).toBeTruthy();
    expect((post as unknown[])[1]).toMatchObject({ method: 'POST' });
    expect(fetchFn.mock.calls).toHaveLength(2); // catalog GET + one POST

    // Replay from cache: instant, zero extra wire traffic.
    fireEvent.click(screen.getByRole('button', { name: /dungeon drips/i }));
    await waitFor(() =>
      expect(screen.getByLabelText(/playing dungeon drips/i)).toBeTruthy(),
    );
    expect(fetchFn.mock.calls).toHaveLength(3); // catalog GET + one POST per distinct slug

    fireEvent.click(screen.getByRole('button', { name: /stop ambience/i }));
    await waitFor(() => expect(screen.queryByLabelText(/playing/i)).toBeNull());
  });

  it('surfaces the server 403 MEDIA_AMBIENCE_FORBIDDEN copy verbatim', async () => {
    const forbidden = {
      ok: false,
      status: 403,
      json: async () => ({
        detail:
          'MEDIA_AMBIENCE_FORBIDDEN: ambient soundscapes play to the whole table; ' +
          'only GM or admin seats may trigger them.',
      }),
    } as unknown as Response;
    // The catalog GET still succeeds (any seat may list); only the POST is refused.
    stubFetch((url) => (url.endsWith('/api/v1/media/ambience') ? okList() : forbidden));
    store.set('aethertable_token', TOKEN);
    render(<AmbiencePanel userRole="gm" />);
    fireEvent.click(await screen.findByRole('button', { name: /dungeon drips/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/^MEDIA_AMBIENCE_FORBIDDEN/);
    expect(alert.textContent).toMatch(/only GM or admin seats may trigger them/);
    expect(ambienceLibrarySize()).toBe(0);
  });

  it('shows the busy state while generation is parked and clears it after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stubFetch((url) => {
      if (url.endsWith('/api/v1/media/ambience')) return okList();
      void gate;
      return okWav();
    });
    store.set('aethertable_token', TOKEN);
    render(<AmbiencePanel userRole="gm" />);
    const card = await screen.findByRole('button', { name: /tavern murmur/i });
    fireEvent.click(card);
    expect(screen.getByText(/fetching/i)).toBeTruthy();
    release();
    await waitFor(() => expect(screen.getByLabelText(/playing tavern murmur/i)).toBeTruthy());
    expect(screen.queryByText(/fetching/i)).toBeNull();
  });
});
