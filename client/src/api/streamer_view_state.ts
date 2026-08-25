/**
 * Pure mode-state machine for the dedicated Streamer View (GOALS.md Pillar 9).
 *
 * Iteration 56-era audit finding: the StreamerHUDModal REPORTS what the
 * spectator projection excludes, but there was no actual full-screen broadcast
 * surface — a streamer capturing the window had to manually hide docks, panels
 * and GM chrome. This module owns the on/off mode state for that surface so the
 * transitions are unit-testable without mounting React.
 *
 * ENTRY POLICY: only a GM seat may ENTER streamer view (the toggle lives in the
 * GM Table Tools menu). EXIT is same-seat: whoever flipped the mode on can flip
 * it off (Escape key or the on-screen exit control) — the local browser owns
 * its own view state either way.
 */

/** Seats recognized across the app shell (mirrors App.userRole). */
export type SeatRole = 'gm' | 'player' | 'spectator';

/** The two states the dedicated broadcast surface can be in. */
export type StreamerViewMode = 'off' | 'live';

/**
 * True when this seat is allowed to switch INTO streamer view. GM-only by
 * policy: it is a broadcast-control surface, and the GM is the table authority
 * deciding what leaves the room.
 */
export const canEnterStreamerView = (role: SeatRole): boolean => role === 'gm';

/** Turn the dedicated streamer surface on (idempotent). */
export const enterStreamerView = (mode: StreamerViewMode): StreamerViewMode => 'live';

/** Leave the dedicated streamer surface (idempotent). */
export const exitStreamerView = (mode: StreamerViewMode): StreamerViewMode => 'off';

/** Flip between live broadcast view and the normal seated view. */
export const toggleStreamerView = (mode: StreamerViewMode): StreamerViewMode =>
  mode === 'live' ? 'off' : 'live';
