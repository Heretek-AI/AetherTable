/**
 * Component-contract test for src/components/LocalVadMeterStrip.tsx (Loop 3
 * iteration 31) — the compact "who's speaking" dot ring mounted in the
 * narrative telemetry row.
 *
 * The strip is fully CONTROLLED by props: it performs no getUserMedia call and
 * creates no AudioContext, so it renders identically in happy-dom/CI as in the
 * browser. The states arrive already-derived (see deriveVadMeterStatus in
 * render/local_vad_meter.ts); this suite pins the rendering of each one:
 *   - unsupported  → truthful off-state copy, no dot ring
 *   - denied       → off-state copy + a Retry button that fires onRetry
 *   - idle         → muted dot ring (no speech, no glow)
 *   - live         → dot ring that reflects the EMA speaking-seconds level,
 *                    with a pulsing ring overlay while isSpeaking is true
 *
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LocalVadMeterStrip } from '../LocalVadMeterStrip';

beforeEach(() => {
  cleanup();
});

describe('LocalVadMeterStrip states', () => {
  it('renders a truthful off-state when getUserMedia is unsupported', () => {
    render(<LocalVadMeterStrip seatName="Lyra" status="unsupported" />);
    expect(screen.getByTestId('local-vad-meter')).toBeTruthy();
    expect(screen.getByTestId('local-vad-meter-label').textContent).toMatch(/mic unsupported/i);
    // No speech dot is fabricated in the unsupported state.
    expect(screen.queryByTestId('vad-meter-dot')).toBeNull();
    expect(screen.queryByTestId('vad-meter-retry')).toBeNull();
  });

  it('renders a compact denied off-state with a working Retry button', () => {
    const onRetry = vi.fn();
    render(<LocalVadMeterStrip seatName="Lyra" status="denied" onRetry={onRetry} />);
    expect(screen.getByTestId('local-vad-meter-label').textContent).toMatch(/mic denied/i);
    const retry = screen.getByTestId('vad-meter-retry');
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders a live dot ring whose glow scales with the EMA level', () => {
    render(<LocalVadMeterStrip seatName="Lyra" status="live" levelSeconds={4} />);
    const dot = screen.getByTestId('vad-meter-dot');
    expect(dot.dataset.status).toBe('live');
    // 4s of recent speech against the 10 s "full ring" reference → 40% glow.
    expect(Number(dot.dataset.level)).toBeCloseTo(0.4, 5);
    expect(screen.getByTestId('local-vad-meter-label').textContent).toMatch(/local mic/i);
    // Not currently speaking → the pulsing overlay ring is absent.
    expect(screen.queryByTestId('vad-meter-speaking')).toBeNull();
  });

  it('shows the pulsing speaking ring overlay only while a burst is open', () => {
    const { rerender } = render(
      <LocalVadMeterStrip seatName="Lyra" status="live" levelSeconds={8} isSpeaking />,
    );
    expect(screen.getByTestId('vad-meter-speaking')).toBeTruthy();
    rerender(<LocalVadMeterStrip seatName="Lyra" status="live" levelSeconds={8} isSpeaking={false} />);
    expect(screen.queryByTestId('vad-meter-speaking')).toBeNull();
  });

  it('idle state shows a muted dot and the honest "your mic only" copy', () => {
    render(<LocalVadMeterStrip seatName="Lyra" status="idle" />);
    const dot = screen.getByTestId('vad-meter-dot');
    expect(dot.dataset.status).toBe('idle');
    expect(screen.getByTestId('local-vad-meter-label').textContent).toMatch(/mic muted|not listening/i);
    // The honest limitation is always visible in the strip's own copy.
    expect(screen.getByTestId('local-vad-meter').textContent).toMatch(/local mic/i);
  });
});