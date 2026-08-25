/**
 * Iteration 68 — dedicated Streamer View (GOALS.md Pillar 9).
 *
 * Two contracts are pinned here:
 *
 *  1. MODE STATE (streamer_view_state.ts): entering/exiting the dedicated
 *     broadcast surface is GM-only to enter, same-seat to exit, and the state
 *     machine is a pure two-value toggle.
 *
 *  2. FILTERING CONTRACT (StreamerView.tsx): given the SAME props the normal
 *     seated view receives — including a token list that still contains
 *     GM-hidden tokens (`isVisible: false`) and a chat log that still contains
 *     GM-whisper lines — the streamer surface renders ONLY what the existing
 *     App-shell projection already filtered. The component itself adds no new
 *     filter and, critically, never renders a surface it was not handed data
 *     for (no GM channel tabs, no DM-note panels, no hidden-token names).
 *
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { render, screen } from '@testing-library/react';
import {
  canEnterStreamerView,
  enterStreamerView,
  exitStreamerView,
  toggleStreamerView,
} from '../../api/streamer_view_state';
import { StreamerView } from '../StreamerView';

// Vitest globals are off in this suite, so RTL's auto-cleanup hook is not
// registered — unmount explicitly between tests.
afterEach(cleanup);
import type { Token } from '../TacticalCanvas';
import type { ChatMessage } from '../NarrativeChat';

const TOKENS: Token[] = [
  {
    id: 'thorin_1',
    name: 'Thorin Oakenshield',
    x: 4,
    y: 4,
    hp: 42,
    maxHp: 42,
    ac: 18,
    color: '#3b82f6',
    isPlayer: true,
  },
  {
    id: 'shadow_doppelganger',
    name: 'Shadow Doppelganger',
    x: 12,
    y: 9,
    hp: 30,
    maxHp: 30,
    ac: 15,
    color: '#111827',
    isPlayer: false,
    isVisible: false,
  },
];

const MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    sender: 'Encounter DM (AI)',
    role: 'dm',
    content: 'The portcullis crashes down.',
    timestamp: '12:00 PM',
  },
  {
    id: 'm2',
    sender: 'GM',
    role: 'player',
    content: '[WHISPER TO GM] The doppelganger copies Thorin tonight.',
    timestamp: '12:01 PM',
  },
  {
    id: 'm3',
    sender: 'Lyra Moonshadow',
    role: 'player',
    content: 'I cast detect magic.',
    timestamp: '12:02 PM',
  },
];

describe('streamer view mode state', () => {
  it('starts off and only the GM seat may enter', () => {
    expect(enterStreamerView('off')).toBe('live');
    expect(canEnterStreamerView('gm')).toBe(true);
    expect(canEnterStreamerView('player')).toBe(false);
    expect(canEnterStreamerView('spectator')).toBe(false);
  });

  it('exits back to off and toggles both ways', () => {
    expect(exitStreamerView('live')).toBe('off');
    expect(exitStreamerView('off')).toBe('off');
    expect(toggleStreamerView('off')).toBe('live');
    expect(toggleStreamerView('live')).toBe('off');
  });
});

describe('StreamerView filtering contract', () => {
  const baseProps = {
    projectedTokens: [TOKENS[0]],
    projectedMessages: MESSAGES.filter((m) => m.id !== 'm2'),
    onExit: () => {},
  };

  it('renders the LIVE indicator and party-visible content', () => {
    render(<StreamerView {...baseProps} />);
    expect(screen.getByTestId('streamer-live-indicator')).toBeTruthy();
    // Party-visible board subject is present…
    expect(screen.getByText('Thorin Oakenshield')).toBeTruthy();
    // …and public chat lines flow through.
    expect(screen.getByText(/I cast detect magic/)).toBeTruthy();
  });

  it('never renders GM-whisper content even if handed an unfiltered log', () => {
    render(<StreamerView {...baseProps} projectedMessages={MESSAGES} />);
    // The whisper line must not appear ANYWHERE in the broadcast surface.
    expect(screen.queryByText(/doppelganger copies Thorin/)).toBeNull();
    expect(screen.queryByText(/\[WHISPER TO GM\]/)).toBeNull();
  });

  it('never renders a GM-channel tab or DM-notes panel surface', () => {
    render(<StreamerView {...baseProps} projectedMessages={MESSAGES} />);
    // No private channel affordance exists at all in this surface.
    expect(screen.queryByText(/GM Whisper/i)).toBeNull();
    expect(screen.queryByText(/DM Notes/i)).toBeNull();
    expect(screen.queryByTestId('gm-only-panel')).toBeNull();
  });

  it('renders nothing for a hidden token even if leaked through props', () => {
    render(
      <StreamerView {...baseProps} projectedTokens={TOKENS} />
    );
    expect(screen.queryByText('Shadow Doppelganger')).toBeNull();
  });

  it('reports how many items were excluded instead of faking silence', () => {
    render(
      <StreamerView
        {...baseProps}
        projectedTokens={TOKENS}
        projectedMessages={MESSAGES}
      />
    );
    // Honest exclusion readouts (counts, not the secret names/lines).
    expect(
      screen.getByTestId('excluded-token-count').textContent
    ).toBe('1');
    expect(
      screen.getByTestId('excluded-chat-count').textContent
    ).toBe('1');
  });

  it('offers a single-click exit hatch', async () => {
    let exits = 0;
    render(<StreamerView {...baseProps} onExit={() => (exits += 1)} />);
    screen.getByTestId('streamer-exit').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true })
    );
    await Promise.resolve();
    expect(exits).toBe(1);
  });
});
