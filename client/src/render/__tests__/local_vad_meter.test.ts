/**
 * Unit tests for src/render/local_vad_meter.ts (Loop 3 iteration 31) — the
 * local-only VAD spotlight meter.
 *
 * Honest scope: this meter runs ENTIRELY on this browser's own mic; it never
 * sees remote seats' audio and never fakes it. `hasMediaDevices()` is the
 * feature gate used by the UI so CI / happy-dom environments (no getUserMedia)
 * render a truthful off-state instead of silently ignoring a missing mic.
 *
 * Math pinned here:
 *  - emaStep: current*(1-α) + sampleSeconds*α — an exponential moving average
 *    of speaking seconds.
 *  - decayLevelSeconds: exponential recency decay level * 0.5^(dtMs/halfLifeMs)
 *    so "recent speech" dominates and the ring settles after silence.
 *  - begin/end fold real VAD burst durations into the EMA; an unmatched end
 *    records nothing (no fabricated speech); cancel drops an open burst.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VAD_METER_ALPHA,
  DEFAULT_VAD_METER_HALF_LIFE_MS,
  LocalVadMeter,
  decayLevelSeconds,
  deriveVadMeterStatus,
  emaStep,
  hasMediaDevices,
} from '../local_vad_meter';

describe('feature detection', () => {
  const realNavigator = globalThis.navigator;

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, 'navigator', {
      value: realNavigator,
      configurable: true,
    });
  });

  it('returns false where there is no getUserMedia (node/happy-dom default)', () => {
    vi.stubGlobal('navigator', undefined);
    expect(hasMediaDevices()).toBe(false);
  });

  it('returns true when a real getUserMedia exists', () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => Promise.resolve() },
    });
    expect(hasMediaDevices()).toBe(true);
  });

  it('returns false when mediaDevices exists but getUserMedia does not', () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    expect(hasMediaDevices()).toBe(false);
  });

  it('never throws on a partially undefined browser surface', () => {
    expect(() => hasMediaDevices()).not.toThrow();
  });
});

describe('EMA math', () => {
  it('folds a burst length into the average at the configured alpha', () => {
    // A 10 s burst with α=0.2: 0*(0.8)+10*0.2 = 2 s of "recent speech".
    expect(emaStep(0, 10, DEFAULT_VAD_METER_ALPHA)).toBeCloseTo(2, 10);
  });

  it('decays an idle sample (sampleSeconds=0) toward zero', () => {
    expect(emaStep(2, 0, 0.2)).toBeCloseTo(1.6, 10);
  });

  it('exponentially decays the level by the elapsed fraction of the half-life', () => {
    expect(decayLevelSeconds(8, 2_000, 1_000, 1_000)).toBeCloseTo(4, 10); // one half-life → half
    expect(decayLevelSeconds(8, 3_000, 1_000, 1_000)).toBeCloseTo(2, 10); // two half-lives → quarter
    // No elapsed time → identity.
    expect(decayLevelSeconds(8, 1_000, 1_000, 1_000)).toBeCloseTo(8, 10);
  });

  it('uses the default half-life when none is provided', () => {
    expect(decayLevelSeconds(4, 2_000, 1_000, DEFAULT_VAD_METER_HALF_LIFE_MS)).toBeCloseTo(
      4 * Math.pow(0.5, 1000 / DEFAULT_VAD_METER_HALF_LIFE_MS),
      10,
    );
  });
});

describe('LocalVadMeter state machine', () => {
  let meter: LocalVadMeter;
  beforeEach(() => {
    meter = new LocalVadMeter({ alpha: 0.2 });
  });

  it('is silent and at zero before any speech', () => {
    expect(meter.isSpeaking()).toBe(false);
    expect(meter.getLevelSeconds()).toBe(0);
  });

  it('folds a closed 10 s burst into the EMA and reports not speaking after end', () => {
    meter.begin(1_000);
    expect(meter.isSpeaking()).toBe(true);
    expect(meter.end(11_000)).toBe(true);
    expect(meter.isSpeaking()).toBe(false);
    // level = 0*(0.8) + 10*0.2
    expect(meter.getLevelSeconds()).toBeCloseTo(2, 10);
  });

  it('ignores a second begin while a burst is already open', () => {
    meter.begin(1_000);
    meter.begin(2_000); // ignored
    expect(meter.end(6_000)).toBe(true); // ends the FIRST burst only
    expect(meter.getLevelSeconds()).toBeCloseTo(5 * 0.2, 10); // 5 s not 9 s
  });

  it('an unmatched end records nothing rather than fabricating speech', () => {
    expect(meter.end(5_000)).toBe(false);
    expect(meter.getLevelSeconds()).toBe(0);
    // End with no elapsed time also records nothing.
    meter.begin(1_000);
    expect(meter.end(1_000)).toBe(false);
    expect(meter.getLevelSeconds()).toBe(0);
  });

  it('cancel drops an open burst so it never accrues phantom seconds', () => {
    meter.begin(1_000);
    meter.cancel();
    expect(meter.isSpeaking()).toBe(false);
    expect(meter.end(60_000)).toBe(false);
    expect(meter.getLevelSeconds()).toBe(0);
  });

  it('tick decays the level toward zero as silence elapses', () => {
    meter.begin(0);
    meter.end(10_000); // level = 2
    meter.tick(10_000 + DEFAULT_VAD_METER_HALF_LIFE_MS); // one half-life later
    expect(meter.getLevelSeconds()).toBeCloseTo(1, 10);
    meter.tick(10_000 + 2 * DEFAULT_VAD_METER_HALF_LIFE_MS); // two half-lives later
    expect(meter.getLevelSeconds()).toBeCloseTo(0.5, 10);
  });

  it('resets to zero and drops any open burst', () => {
    meter.begin(0);
    meter.end(10_000); // level = 2
    meter.reset();
    expect(meter.getLevelSeconds()).toBe(0);
    expect(meter.isSpeaking()).toBe(false);
  });
});

describe('deriveVadMeterStatus (UI state machine)', () => {
  it('unsupported dominates every other input (CI: no getUserMedia)', () => {
    expect(deriveVadMeterStatus(false, true, false)).toBe('unsupported');
    expect(deriveVadMeterStatus(false, false, false)).toBe('unsupported');
  });

  it('a failed mic start while supported reads as denied (with retry)', () => {
    expect(deriveVadMeterStatus(true, false, true)).toBe('denied');
  });

  it('live while recording, idle while muted', () => {
    expect(deriveVadMeterStatus(true, true, false)).toBe('live');
    expect(deriveVadMeterStatus(true, false, false)).toBe('idle');
  });
});