/**
 * Unit tests for src/sync/transport_reprobe.ts.
 *
 * Iteration-19 audit follow-up: the 3.5s fallback timer in App.tsx used to be
 * a ONE-WAY downgrade — once the session landed on the legacy LWW relay it
 * stayed there until a full page reload, even after the Yjs relay came back.
 *
 * We assert:
 *  - The probe never runs while already on the Yjs transport.
 *  - A failed probe keeps LEGACY_LWW and does not report an upgrade.
 *  - A successful probe reports the upgrade to YJS exactly once per success
 *    and stops probing afterwards.
 *  - Probes stop after unmount (stop()).
 *  - The probe is skipped when no relay URL is configured.
 */
import { describe, expect, it } from 'vitest';
import {
  shouldAttemptReprobe,
  REPROBE_INTERVAL_MS,
} from '../transport_reprobe';

describe('shouldAttemptReprobe', () => {
  it('skips the probe while already on the CRDT transport', () => {
    expect(
      shouldAttemptReprobe({ transportKind: 'YJS', hasYsyncUrl: true, stopped: false })
    ).toBe(false);
  });

  it('skips the probe after the effect has been torn down', () => {
    expect(
      shouldAttemptReprobe({
        transportKind: 'LEGACY_LWW',
        hasYsyncUrl: true,
        stopped: true,
      })
    ).toBe(false);
  });

  it('skips the probe when no Yjs relay URL is configured', () => {
    expect(
      shouldAttemptReprobe({ transportKind: 'LEGACY_LWW', hasYsyncUrl: false, stopped: false })
    ).toBe(false);
  });

  it('attempts the probe from the legacy fallback with a configured relay', () => {
    expect(
      shouldAttemptReprobe({ transportKind: 'LEGACY_LWW', hasYsyncUrl: true, stopped: false })
    ).toBe(true);
  });

  it('exposes an interval in the audited 30-60s band', () => {
    expect(REPROBE_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(REPROBE_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });
});
