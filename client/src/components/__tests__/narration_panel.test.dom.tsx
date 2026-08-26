/**
 * Iteration 8 (Loop 3) — NarrationPanel component contracts, rendered through
 * happy-dom against a stubbed gateway (same fetch/sessionStorage stand-ins as
 * src/api/__tests__/narration_store.test.ts).
 *
 * Pinned here:
 *  - COLLAPSIBLE: the section renders collapsed by default; expanding mounts
 *    the composer AND fires the one-time-on-open session-log fetch.
 *  - VOICES: exactly the four kokoro preset chips; the free-text override wins
 *    over the selected preset and rides the wire verbatim.
 *  - HONEST BUSY STATE: while the wire call is parked, the button reads
 *    "synthesizing…" instead of a bare spinner.
 *  - PAYLOAD: Speak POSTs {text, voice, session_id} to /api/v1/media/narrate.
 *  - RESULT: a 200 stages an <audio controls> element over the object URL and
 *    a cached replay is labelled "cached".
 *  - ERRORS: FORBIDDEN (NARRATION_NOT_A_PARTICIPANT) and RATE_LIMITED surface
 *    their verbatim gateway copy in the alert role.
 *  - LOG LIST: rows render with snippet + Replay button; empty log says so;
 *    list failures (403 NARRATION_LIST_FORBIDDEN) render instead of [].
 *  - PREFILL: a handed-in message text loads into the box when empty.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NarrationPanel } from '../NarrationPanel';
import {
  clearNarrationCacheForTests,
  narrationCacheSize,
} from '../../api/narration_store';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

function stubFetch(respond: () => Response | Promise<Response>) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => respond());
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn> & { mock: { calls: unknown[] } };
}

function okWav(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      new TextEncoder().encode('RIFFfakewav').buffer as ArrayBuffer,
  } as unknown as Response;
}

function logOk(rows: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ session_id: 'sess-42', count: rows.length, narrations: rows }),
  } as unknown as Response;
}

/** Route by method+path: narrations GET → log responder, else narrate POST. */
function stubRoutes(opts: { onList?: () => Response; onNarrate?: () => Response | Promise<Response> }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/media/narrations')) return opts.onList ? opts.onList() : logOk([]);
    return opts.onNarrate ? await opts.onNarrate() : okWav();
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

beforeEach(() => {
  store.clear();
  clearNarrationCacheForTests();
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
  clearNarrationCacheForTests();
});

describe('collapse + mount behavior', () => {
  it('renders collapsed by default with no composer visible', () => {
    const { calls } = stubRoutes({});
    render(<NarrationPanel sessionId="sess-42" />);
    expect(screen.getByTestId('narration-panel')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /speak$/i })).toBeNull();
    expect(screen.queryByLabelText('Narration script')).toBeNull();
    expect(calls).toHaveLength(0); // collapsed ⇒ no log fetch either
  });

  it('expanding mounts the composer and fetches the session narration log once', async () => {
    const { calls } = stubRoutes({
      onList: () =>
        logOk([
          {
            narration_id: 'nar_00000001',
            user_id: 'u-gm',
            voice: 'af_sky',
            text_snippet: 'The tavern falls silent.',
            created_at: 1756100000,
          },
        ]),
    });
    store.set('aethertable_token', TOKEN);
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    await waitFor(() => expect(screen.getByTestId('narration-log-list')).toBeTruthy());
    expect(screen.getByText(/The tavern falls silent\./)).toBeTruthy();
    const listCalls = calls.filter((c) => c.url.includes('/media/narrations'));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].url).toBe('/api/v1/media/narrations?session_id=sess-42');
  });
});

describe('voices + speak flow', () => {
  it('offers exactly the four kokoro preset voices', () => {
    stubRoutes({});
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    for (const v of ['af_sky', 'am_echo', 'am_michael', 'bf_emma']) {
      expect(screen.getByRole('button', { name: v })).toBeTruthy();
    }
  });

  it('Speak posts text+voice+session_id and stages an audio player over the object URL', async () => {
    const { calls } = stubRoutes({});
    store.set('aethertable_token', TOKEN);
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    fireEvent.change(screen.getByLabelText('Narration script'), {
      target: { value: 'The tavern falls silent.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bf_emma' }));
    fireEvent.click(screen.getByTestId('speak-button'));
    await waitFor(() => expect(screen.getByTestId('narration-audio')).toBeTruthy());
    const post = calls.find((c) => c.url === '/api/v1/media/narrate');
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post!.init?.body))).toEqual({
      text: 'The tavern falls silent.',
      voice: 'bf_emma',
      session_id: 'sess-42',
    });
    expect(
      (screen.getByTestId('narration-audio') as HTMLAudioElement).getAttribute('src'),
    ).toMatch(/^blob:/);
    // Fresh synthesis pulled the log again (mount fetch + refresh after OK).
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/media/narrations')).length).toBe(2));
    expect(narrationCacheSize()).toBe(1);
  });

  it('the free-text override beats the selected preset on the wire', async () => {
    const { calls } = stubRoutes({});
    store.set('aethertable_token', TOKEN);
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    fireEvent.click(screen.getByRole('button', { name: 'am_michael' }));
    fireEvent.change(screen.getByLabelText('Custom voice id'), {
      target: { value: 'zf_xenon' },
    });
    fireEvent.change(screen.getByLabelText('Narration script'), {
      target: { value: 'Roll for perception.' },
    });
    fireEvent.click(screen.getByTestId('speak-button'));
    await waitFor(() => expect(screen.getByTestId('narration-audio')).toBeTruthy());
    const post = calls.find((c) => c.url === '/api/v1/media/narrate');
    expect(JSON.parse(String(post!.init?.body))).toMatchObject({ voice: 'zf_xenon' });
  });

  it('holds the honest synthesizing state while the wire call is parked', async () => {
    store.set('aethertable_token', TOKEN);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/media/narrations')) return logOk([]);
        await gate;
        return okWav();
      }),
    );
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    fireEvent.change(screen.getByLabelText('Narration script'), {
      target: { value: 'A slow synthesis.' },
    });
    fireEvent.click(screen.getByTestId('speak-button'));
    expect(screen.getByText(/synthesizing…/i)).toBeTruthy();
    release();
    await waitFor(() => expect(screen.getByTestId('narration-audio')).toBeTruthy());
  });

  it('re-speaking identical text+voice replays from cache without a second wire call', async () => {
    const { calls } = stubRoutes({});
    store.set('aethertable_token', TOKEN);
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    fireEvent.change(screen.getByLabelText('Narration script'), {
      target: { value: 'Echo test.' },
    });
    fireEvent.click(screen.getByTestId('speak-button'));
    await waitFor(() => expect(screen.getByTestId('narration-audio')).toBeTruthy());
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes('/media/narrations')).length).toBe(2),
    );
    fireEvent.click(screen.getByTestId('speak-button'));
    await waitFor(() => expect(screen.getByText('cached replay')).toBeTruthy());
    expect(calls.filter((c) => c.url === '/api/v1/media/narrate')).toHaveLength(1);
  });
});

describe('honest failure surfaces', () => {
  it('renders the verbatim NARRATION_NOT_A_PARTICIPANT copy on 403', async () => {
    stubRoutes({
      onNarrate: () =>
        ({
          ok: false,
          status: 403,
          json: async () => ({
            detail:
              'NARRATION_NOT_A_PARTICIPANT: only session participants (via a lobby bound to that session) or GMs may narrate into session sess-42.',
          }),
        }) as unknown as Response,
    });
    store.set('aethertable_token', TOKEN);
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    fireEvent.change(screen.getByLabelText('Narration script'), {
      target: { value: 'Not my table.' },
    });
    fireEvent.click(screen.getByTestId('speak-button'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/^NARRATION_NOT_A_PARTICIPANT/);
    expect(screen.queryByTestId('narration-audio')).toBeNull();
    expect(narrationCacheSize()).toBe(0);
  });

  it('renders an actionable rate-limit notice on 429', async () => {
    stubRoutes({
      onNarrate: () =>
        ({
          ok: false,
          status: 429,
          json: async () => ({ detail: 'Rate limit exceeded: narration bucket' }),
        }) as unknown as Response,
    });
    store.set('aethertable_token', TOKEN);
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    fireEvent.change(screen.getByLabelText('Narration script'), {
      target: { value: 'Too chatty.' },
    });
    fireEvent.click(screen.getByTestId('speak-button'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/20 syntheses per minute/i);
    expect(alert.textContent).toMatch(/narration bucket/i);
  });

  it('signed-out seats get the sign-in notice with zero network traffic', async () => {
    const { calls } = stubRoutes({});
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    fireEvent.change(screen.getByLabelText('Narration script'), {
      target: { value: 'Who am I?' },
    });
    fireEvent.click(screen.getByTestId('speak-button'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/sign-in required/i);
    expect(calls.filter((c) => c.url === '/api/v1/media/narrate')).toHaveLength(0);
  });
});

describe('session narration log rendering', () => {
  it('renders each row with its snippet and a Replay button that re-speaks it', async () => {
    const { calls } = stubRoutes({
      onList: () =>
        logOk([
          {
            narration_id: 'nar_00000007',
            user_id: 'u-gm',
            voice: 'bf_emma',
            text_snippet: 'Doors slam somewhere below.',
            created_at: 1756100100,
          },
        ]),
    });
    store.set('aethertable_token', TOKEN);
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    await waitFor(() => expect(screen.getByLabelText('Replay nar_00000007')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Replay nar_00000007'));
    await waitFor(() => expect(screen.getByTestId('narration-audio')).toBeTruthy());
    // Replay re-synthesizes what the LOG kept (snippet), same voice, same session.
    const post = calls.find((c) => c.url === '/api/v1/media/narrate');
    expect(JSON.parse(String(post!.init?.body))).toEqual({
      text: 'Doors slam somewhere below.',
      voice: 'bf_emma',
      session_id: 'sess-42',
    });
  });

  it('says when nothing has been narrated yet', async () => {
    stubRoutes({ onList: () => logOk([]) });
    store.set('aethertable_token', TOKEN);
    render(<NarrationPanel sessionId="sess-42" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    await waitFor(() => expect(screen.getByText(/no narrations logged yet/i)).toBeTruthy());
  });

  it('renders the list failure instead of an empty list on 403', async () => {
    stubRoutes({
      onList: () =>
        ({
          ok: false,
          status: 403,
          json: async () => ({
            detail:
              'NARRATION_LIST_FORBIDDEN: only session participants (via a lobby bound to that session) or GMs may read the narration log of session other.',
          }),
        }) as unknown as Response,
    });
    store.set('aethertable_token', TOKEN);
    render(<NarrationPanel sessionId="other" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    await waitFor(() => expect(screen.getByText(/NARRATION_LIST_FORBIDDEN/)).toBeTruthy());
    expect(screen.queryByTestId('narration-log-list')).toBeNull();
  });

  it('skips the log fetch entirely when no engine session exists yet', () => {
    const { calls } = stubRoutes({});
    render(<NarrationPanel sessionId={null} />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    expect(screen.getByText(/no engine session yet/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe('prefill', () => {
  it('loads handed-in message text into the empty script box only', () => {
    stubRoutes({});
    render(<NarrationPanel sessionId="sess-42" prefillText="I said this in chat." />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    expect((screen.getByLabelText('Narration script') as HTMLTextAreaElement).value).toBe(
      'I said this in chat.',
    );
  });

  it('never clobbers a script the user already typed', () => {
    stubRoutes({});
    render(<NarrationPanel sessionId="sess-42" prefillText="newer selection" />);
    fireEvent.click(screen.getByRole('button', { name: /speak aloud/i }));
    const box = screen.getByLabelText('Narration script') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'my own words' } });
    expect(box.value).toBe('my own words');
  });
});
