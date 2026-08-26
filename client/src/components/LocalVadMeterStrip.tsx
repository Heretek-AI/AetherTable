/**
 * LocalVadMeterStrip (Loop 3 iteration 31) — the compact "who's speaking" dot
 * ring mounted in the narrative telemetry row.
 *
 * Fully CONTROLLED by props: it performs no getUserMedia call and creates no
 * AudioContext, so it renders identically in happy-dom/CI and the browser. The
 * state arrives already-derived (deriveVadMeterStatus in
 * render/local_vad_meter.ts); this component only paints truthfully:
 *   - unsupported → no mic capability at all (CI/happy-dom): off-state copy,
 *     no dot.
 *   - denied      → off-state copy + a Retry that calls onRetry (re-asks the
 *     browser for the mic).
 *   - idle        → muted dot ring (tap the mic button to listen).
 *   - live        → dot ring whose glow scales with the EMA speaking-seconds
 *     level, with a pulsing ring while a VAD burst is open.
 *
 * HONEST SCOPE: the "local mic" badge + tooltip say it plainly — a browser can
 * only hear ITS OWN mic. Remote seats' voices are not detected by this strip,
 * and it never fabricates a server-side spotlight (that aggregation is a
 * future iteration).
 */
import React from 'react';
import { VAD_METER_FULL_RING_SECONDS, type VadMeterStatus } from '../render/local_vad_meter';

interface LocalVadMeterStripProps {
  /** The local seat's display name rendered next to the dot ring. */
  seatName?: string;
  /** Pre-derived state (see render/local_vad_meter.deriveVadMeterStatus). */
  status?: VadMeterStatus;
  /** EMA of recent speaking seconds (drives the ring's glow 0..full). */
  levelSeconds?: number;
  /** True while a VAD speech burst is open on this seat's mic. */
  isSpeaking?: boolean;
  /** Denied-state retry: re-invokes the mic capture path (a user gesture). */
  onRetry?: () => void;
}

const STATUS_COPY: Record<VadMeterStatus, string> = {
  unsupported: 'mic unsupported on this device',
  denied: 'mic denied — tap to retry',
  idle: 'mic muted · tap mic to listen',
  live: 'local mic · listening',
};

export const LocalVadMeterStrip: React.FC<LocalVadMeterStripProps> = ({
  seatName = 'You',
  status = 'idle',
  levelSeconds = 0,
  isSpeaking = false,
  onRetry,
}) => {
  const live = status === 'live';
  const dotVisible = status === 'live' || status === 'idle';
  const clampedLevel = Math.max(
    0,
    Math.min(1, Number.isFinite(levelSeconds) ? levelSeconds / VAD_METER_FULL_RING_SECONDS : 0),
  );
  const label = live && isSpeaking ? 'local mic · speaking' : STATUS_COPY[status];

  return (
    <div
      data-testid="local-vad-meter"
      className="flex items-center gap-1.5 text-[10px] text-[var(--rp-parchment-300)]"
      title={
        'Local mic only — this device hears only its own microphone, not remote ' +
        "seats' voices. A server-aggregated spotlight is a future iteration."
      }
    >
      <span
        className="vtt-badge"
        style={{ fontSize: '9px', padding: '0.05rem 0.4rem', textTransform: 'uppercase' }}
      >
        local mic
      </span>
      <span className="whitespace-nowrap">{seatName}</span>

      {dotVisible && (
        <span className="relative inline-flex items-center justify-center" aria-hidden="true">
          <span
            data-testid="vad-meter-dot"
            data-status={status}
            data-level={clampedLevel.toFixed(3)}
            className="rounded-full"
            style={{
              width: 9 + clampedLevel * 5,
              height: 9 + clampedLevel * 5,
              backgroundColor: live
                ? isSpeaking
                  ? 'var(--state-success)'
                  : 'color-mix(in srgb, var(--state-success) 45%, transparent)'
                : 'transparent',
              border: `1px solid ${live ? 'var(--state-success)' : 'var(--rp-parchment-300)'}`,
              boxShadow: live
                ? `0 0 ${4 + clampedLevel * 9}px color-mix(in srgb, var(--state-success) ${
                    45 + clampedLevel * 55
                  }%, transparent)`
                : 'none',
            }}
          />
          {live && isSpeaking && (
            <span
              data-testid="vad-meter-speaking"
              className="absolute inset-0 rounded-full animate-ping"
              style={{ border: '1px solid var(--state-success)' }}
            />
          )}
        </span>
      )}

      <span data-testid="local-vad-meter-label" role="status" aria-live="polite">
        {label}
      </span>

      {status === 'denied' && (
        <button
          type="button"
          data-testid="vad-meter-retry"
          onClick={onRetry}
          title="Retry microphone access"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded vtt-btn vtt-btn-secondary"
          style={{ fontSize: '9px' }}
        >
          Retry
        </button>
      )}
    </div>
  );
};

export default LocalVadMeterStrip;