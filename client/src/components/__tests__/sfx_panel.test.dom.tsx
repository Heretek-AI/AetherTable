/**
 * Iteration 4 (Loop 3) — SfxPanel component contracts, rendered through
 * happy-dom against a stubbed gateway (same fetch/sessionStorage stand-ins as
 * src/api/__tests__/sfx_library.test.ts).
 *
 * Pinned here:
 *  - GATING: an explicitly non-staff seat sees the lock notice and NO controls;
 *    the gateway remains the real authority (403 path tested separately).
 *  - PRESETS: exactly the four preset chips populate from SFX_PRESETS.
 *  - HONEST BUSY STATE: while the wire call is parked, the button reads
 *    "generating… can take 30-90 s" instead of a bare spinner.
 *  - FORBIDDEN: the server's MEDIA_SFX_FORBIDDEN copy is surfaced verbatim as
 *    the GM-only notice.
 *  - LIBRARY/CACHE: a generated prompt lands in the session library with its
 *    own Play button; regenerating it hits the cache (zero extra wire calls).
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SfxPanel } from '../SfxPanel';
import {
  clearSfxLibraryForTests,
  sfxLibrarySize,
} from '../../api/sfx_library';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

class FakeAudioContext {
  decodeAudioData(
    bytes: ArrayBuffer,
    success: (b: unknown) => void,
  ): Promise<unknown> | void {
    // Modern promise form — exercised deliberately so BOTH wrapper paths get
    // coverage across this suite and the node-env suite.
    return Promise.resolve({ channels: 1, length: bytes.byteLength });
  }
}

function stubFetch(respond: () => Response) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => respond());
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn> & { mock: { calls: unknown[] } };
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
  clearSfxLibraryForTests();
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

describe('SfxPanel gating', () => {
  it('shows the GM-only lock notice and no controls to a player seat', () => {
    stubFetch(() => okWav());
    render(<SfxPanel userRole="player" />);
    expect(screen.getByTestId('sfx-panel').textContent).toMatch(/GM-only seat feature/i);
    expect(screen.queryByPlaceholderText(/describe the sound/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();
  });

  it('renders controls for a gm seat', () => {
    stubFetch(() => okWav());
    render(<SfxPanel userRole="gm" />);
    expect(screen.getByPlaceholderText(/describe the sound/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /generate/i })).toBeTruthy();
  });
});

describe('presets + generation flow', () => {
  it('populates exactly the four preset chips', () => {
    stubFetch(() => okWav());
    render(<SfxPanel userRole="admin" />);
    for (const preset of [
      'stone door grinding',
      'torch crackle',
      'dungeon drip',
      'dragon roar',
    ]) {
      expect(screen.getByRole('button', { name: preset })).toBeTruthy();
    }
  });

  it('clicking a preset fills the prompt, then Generate & Populates the library with a Play button', async () => {
    const fetchFn = stubFetch(() => okWav());
    store.set('aethertable_token', TOKEN);
    render(<SfxPanel userRole="gm" />);

    fireEvent.click(screen.getByRole('button', { name: 'dungeon drip' }));
    expect((screen.getByPlaceholderText(/describe the sound/i) as HTMLInputElement).value).toBe(
      'dungeon drip',
    );

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() =>
      expect(screen.getByLabelText('Play dungeon drip')).toBeTruthy(),
    );
    expect(sfxLibrarySize()).toBe(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/media/sfx');
    expect(JSON.parse(String(init.body))).toEqual({ prompt: 'dungeon drip' });

    // Regenerating the same prompt replays from cache — no second wire call.
    fireEvent.click(screen.getByRole('button', { name: 'dungeon drip' }));
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /generate/i }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(fetchFn.mock.calls).toHaveLength(1);
  });

  it('holds the honest 30-90 s generating state while the wire call is parked', async () => {
    stubFetch(() => okWav());
    store.set('aethertable_token', TOKEN);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return okWav();
      }),
    );
    render(<SfxPanel userRole="gm" />);
    fireEvent.change(screen.getByPlaceholderText(/describe the sound/i), {
      target: { value: 'stone door grinding' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    expect(screen.getByText(/generating… can take 30-90 s/i)).toBeTruthy();
    release();
    await waitFor(() => expect(screen.getByLabelText('Play stone door grinding')).toBeTruthy());
  });

  it('surfaces the server 403 MEDIA_SFX_FORBIDDEN copy verbatim as the GM-only notice', async () => {
    stubFetch(() =>
      ({
        ok: false,
        status: 403,
        json: async () => ({
          detail:
            'MEDIA_SFX_FORBIDDEN: sound effects play to the whole table; ' +
            'only GM or admin seats may trigger them.',
        }),
      }) as unknown as Response,
    );
    store.set('aethertable_token', TOKEN);
    render(<SfxPanel />);
    // No role plumbed → controls render optimistically; the gateway decides.
    fireEvent.change(screen.getByPlaceholderText(/describe the sound/i), {
      target: { value: 'dragon roar' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/^MEDIA_SFX_FORBIDDEN/);
    expect(alert.textContent).toMatch(/only GM or admin seats may trigger them/);
    // Nothing entered the library — the refusal is honest.
    expect(screen.getByText(/nothing generated yet/i)).toBeTruthy();
    expect(sfxLibrarySize()).toBe(0);
  });
});
