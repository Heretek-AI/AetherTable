/**
 * Iteration 70 — Guided Campaign Setup Wizard (GOALS.md Pillar 2), rendered
 * contracts through happy-dom:
 *
 *  1. STEP TRANSITIONS: Identity → Ruleset → Party → Review, gated on a
 *     non-blank name at Identity, Back never skips past Identity, and the
 *     Review step reflects every selection made along the way.
 *  2. WIRE HONESTY: Create fires POST /api/v1/lobbies with EXACTLY
 *     `{ name }` — no invented rule-version/party-size/level fields — and the
 *     success panel shows the SERVER-generated invite code, not a local one.
 *  3. FAILURE HONESTY: a gateway refusal keeps the wizard open, surfaces the
 *     error, and never calls onComplete.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CampaignWizardModal, type CampaignWizardConfig } from '../CampaignWizardModal';

// Vitest globals are off in this suite — unmount explicitly between tests.
afterEach(cleanup);

const LOBBY = {
  lobby_id: 'lob_70',
  invite_code: 'DRAGON7',
  name: 'The Fall of Baron Vane',
  host_user_id: 'user_gm',
  engine_session_id: null,
  members: [],
};

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  // Async so every caller gets a real Promise (`fetch(url).then(...)`).
  const mock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Standard routing: real starter catalog + a configurable lobby endpoint. */
function installHappyPath(opts?: { lobbyStatus?: number }) {
  return installFetch((url, init) => {
    if (url === '/api/v1/adventures/starter') return jsonRes({ adventures: [] });
    if (url === '/api/v1/lobbies' && init?.method === 'POST') {
      return jsonRes(LOBBY, opts?.lobbyStatus ?? 200);
    }
    return jsonRes({ detail: 'not found' }, 404);
  });
}

beforeEach(() => {
  // createLobby refuses to fire without a session token — sign the test in.
  window.sessionStorage.setItem('aethertable_token', 'test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

function typeCampaignName(name: string) {
  fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: name } });
}

/** The two rule-version radios, queried by input name (labels wrap them). */
function ruleVersionRadios(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll('input[type="radio"][name="rule_version"]')
  ) as HTMLInputElement[];
}

describe('wizard step transitions', () => {
  function nextButton() {
    return screen.getByRole('button', { name: /^Next:/ });
  }

  it('walks Identity → Ruleset → Party → Review and back again', () => {
    const onComplete = vi.fn();
    installHappyPath();
    render(<CampaignWizardModal isOpen onClose={() => {}} onComplete={onComplete} />);

    // Step 1 gate: no name typed yet, so forward motion is refused.
    expect((nextButton() as HTMLButtonElement).disabled).toBe(true);
    typeCampaignName('The Fall of Baron Vane');
    expect((nextButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(nextButton());

    // Step 2: ruleset picker is present with both SRD options.
    expect(screen.getByText('Rules version')).toBeTruthy();
    expect(ruleVersionRadios().length).toBe(2);
    fireEvent.click(ruleVersionRadios()[1]); // SRD 5.1
    fireEvent.click(nextButton());

    // Step 3: party slots + starting level.
    expect(screen.getByText(/Party size \(player seats\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Level 3' }));
    fireEvent.click(nextButton());

    // Step 4: review reflects EVERY selection made above.
    expect(screen.getByText('The Fall of Baron Vane')).toBeTruthy();
    expect(screen.getByText('SRD 5.1')).toBeTruthy();

    // Back steps through without losing state…
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText(/Party size \(player seats\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Rules version')).toBeTruthy();
    const stillSelected = ruleVersionRadios();
    expect(stillSelected[1].checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    // …and Identity still holds the typed name.
    expect((screen.getByLabelText('Campaign name') as HTMLInputElement).value).toBe(
      'The Fall of Baron Vane'
    );
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reopens clean: a fresh mount starts at Identity with blank fields', () => {
    const onComplete = vi.fn();
    installHappyPath();
    const { rerender } = render(
      <CampaignWizardModal isOpen={false} onClose={() => {}} onComplete={onComplete} />
    );
    rerender(<CampaignWizardModal isOpen onClose={() => {}} onComplete={onComplete} />);
    expect((nextButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Campaign name') as HTMLInputElement).value).toBe('');
  });
});

describe('create payload & completion', () => {
  it('posts EXACTLY { name } and completes with the server invite code', async () => {
    let capturedBody: string | undefined;
    const fetchMock = installFetch((url, init) => {
      if (url === '/api/v1/adventures/starter') return jsonRes({ adventures: [] });
      if (url === '/api/v1/lobbies' && init?.method === 'POST') {
        capturedBody = String(init.body);
        return jsonRes(LOBBY);
      }
      return jsonRes({ detail: 'not found' }, 404);
    });

    const configs: CampaignWizardConfig[] = [];
    const lobbies: Array<{ invite_code: string }> = [];
    render(
      <CampaignWizardModal
        isOpen
        onClose={() => {}}
        onComplete={(lobby, config) => {
          lobbies.push(lobby);
          configs.push(config);
        }}
      />
    );

    typeCampaignName('  The Fall of Baron Vane  ');
    fireEvent.click(screen.getByRole('button', { name: /^Next:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Next:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Next:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Lobby' }));

    await waitFor(() =>
      expect(screen.getByText('Invite code (from the server)')).toBeTruthy()
    );
    // The displayed code IS the server's, never a locally generated stand-in.
    expect(screen.getByText('DRAGON7')).toBeTruthy();
    expect(capturedBody).toBe(JSON.stringify({ name: 'The Fall of Baron Vane' }));

    fireEvent.click(screen.getByRole('button', { name: 'Enter Lobby' }));
    await waitFor(() => expect(configs.length).toBe(1));
    expect(lobbies[0].invite_code).toBe('DRAGON7');
    expect(configs[0].name).toBe('The Fall of Baron Vane');
    // Name was trimmed before it reached the wire AND the carried config.
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/v1/lobbies')).toBe(true);
  });

  it('keeps the wizard open with an honest error when creation fails', async () => {
    installHappyPath({ lobbyStatus: 500 });
    const onComplete = vi.fn();
    render(<CampaignWizardModal isOpen onClose={() => {}} onComplete={onComplete} />);

    typeCampaignName('Doomvault');
    fireEvent.click(screen.getByRole('button', { name: /^Next:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Next:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Next:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Lobby' }));

    await waitFor(() =>
      expect(screen.getByText(/Lobby creation failed/)).toBeTruthy()
    );
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.queryByText('Invite code (from the server)')).toBeNull();
  });
});
