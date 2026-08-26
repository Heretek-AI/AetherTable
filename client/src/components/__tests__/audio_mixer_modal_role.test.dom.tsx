/**
 * Iteration 23 (F12) — verify AudioMixerModal threads `userRole` through to
 * AmbiencePanel + SfxPanel. Non-staff seats render ONLY the lock notice and
 * issue zero catalog-fetch / generation requests; staff seats render the
 * normal surfaces.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AudioMixerModal } from '../AudioMixerModal';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

class FakeAudioContext {
  destination = { connect: () => undefined };
  decodeAudioData(bytes: ArrayBuffer, success: (b: unknown) => void): Promise<unknown> | void {
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

function defaultRoute(url: string): Response {
  if (url.endsWith('/api/v1/media/ambience')) return okList();
  return okWav();
}

function okList(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      presets: [
        {
          slug: 'tavern-murmur',
          label: 'Tavern Murmur',
          description: 'Low crowd chatter.',
          prompt: 'warm tavern',
          loop_seconds: 90,
          cached: true,
        },
      ],
    }),
  } as unknown as Response;
}

function okWav(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode('RIFFfakewav').buffer as ArrayBuffer,
  } as unknown as Response;
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
  (globalThis as unknown as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('AudioMixerModal — F12 staff gating plumbing', () => {
  it('renders Ambience + SFX lock notices and zero catalog-fetch for a non-staff seat', () => {
    store.set('aethertable_token', TOKEN);
    const fetchFn = stubFetch();
    render(
      <AudioMixerModal
        isOpen
        onClose={() => undefined}
        tokens={[]}
        selectedTokenId={null}
        userRole="player"
      />,
    );
    // Both surfaces must show the GM-only lock notice.
    expect(screen.getByTestId('ambience-panel').textContent).toMatch(/GM-only seat feature/i);
    expect(screen.getByTestId('sfx-panel').textContent).toMatch(/GM-only seat feature/i);
    // No preset cards, no prompt input.
    expect(screen.queryByRole('button', { name: /tavern murmur/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/describe the sound/i)).toBeNull();
    // The whole point of F12: a non-staff seat produces ZERO catalog-fetch
    // and generation requests. The catalog GET and any SFX POST must both
    // be absent from the call log.
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it('renders Ambience + SFX lock notices for a spectator seat and still no fetch', () => {
    const fetchFn = stubFetch();
    render(
      <AudioMixerModal
        isOpen
        onClose={() => undefined}
        tokens={[]}
        selectedTokenId={null}
        userRole="spectator"
      />,
    );
    expect(screen.getByTestId('ambience-panel').textContent).toMatch(/GM-only seat feature/i);
    expect(screen.getByTestId('sfx-panel').textContent).toMatch(/GM-only seat feature/i);
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it('renders the GM surfaces for a gm seat and fetches the catalog once', async () => {
    store.set('aethertable_token', TOKEN);
    const fetchFn = stubFetch();
    render(
      <AudioMixerModal
        isOpen
        onClose={() => undefined}
        tokens={[]}
        selectedTokenId={null}
        userRole="gm"
      />,
    );
    // Catalog GET is allowed for staff seats.
    expect(await screen.findByRole('button', { name: /tavern murmur/i })).toBeTruthy();
    const catalogCall = fetchFn.mock.calls.find(([u]) =>
      String(u).endsWith('/api/v1/media/ambience'),
    );
    expect(catalogCall).toBeTruthy();
    // SFX prompt + Generate button render too.
    expect(screen.getByPlaceholderText(/describe the sound/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /generate/i })).toBeTruthy();
  });
});