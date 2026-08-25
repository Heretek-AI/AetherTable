/**
 * Unit tests for src/sync/speech_ledger.ts.
 *
 * Pillar-11 honesty contract under test:
 *  - every counted second originates in a real VAD segment; empty ledgers
 *    yield EMPTY weights, never seeded demo speakers,
 *  - the sliding window + recency decay math is exact and deterministic,
 *  - malformed/tampered ledger data cannot poison or double-count shares,
 *  - the local accumulator only records matched start/end pairs.
 */
import { describe, expect, it } from 'vitest';
import {
  clipSegmentsToWindow,
  computeSpotlightWeights,
  decayedSeconds,
  LocalSpeechLedger,
  MAX_SEGMENT_MS,
  sanitizeSegments,
} from '../speech_ledger';

const NOW = 1_000_000;

describe('sanitizeSegments', () => {
  it('keeps well-formed segments', () => {
    expect(sanitizeSegments([{ s: 100, e: 400 }])).toEqual([{ s: 100, e: 400 }]);
  });

  it('rejects inverted, zero-length, and non-finite ranges', () => {
    expect(sanitizeSegments([{ s: 500, e: 500 }])).toEqual([]);
    expect(sanitizeSegments([{ s: 600, e: 100 }])).toEqual([]);
    expect(sanitizeSegments([{ s: NaN, e: 900 }])).toEqual([]);
    expect(sanitizeSegments([{ s: 100, e: Infinity }])).toEqual([]);
    expect(sanitizeSegments([null, 'x', 42, {}])).toEqual([]);
    expect(sanitizeSegments('not an array')).toEqual([]);
  });

  it('clamps runaway durations to MAX_SEGMENT_MS', () => {
    const [seg] = sanitizeSegments([{ s: 1000, e: 1000 + 10 * MAX_SEGMENT_MS }]);
    expect(seg.e - seg.s).toBe(MAX_SEGMENT_MS);
  });
});

describe('clipSegmentsToWindow', () => {
  const WINDOW = 60_000;

  it('drops segments entirely outside the window', () => {
    const segs = [
      { s: NOW - 2 * WINDOW, e: NOW - WINDOW - 1 }, // fully stale
      { s: NOW - 30_000, e: NOW - 29_000 }, // inside
    ];
    expect(clipSegmentsToWindow(segs, NOW, WINDOW)).toEqual([
      { s: NOW - 30_000, e: NOW - 29_000 },
    ]);
  });

  it('cuts straddling segments at the trailing edge instead of discarding them', () => {
    const [seg] = clipSegmentsToWindow(
      [{ s: NOW - WINDOW - 20_000, e: NOW - WINDOW + 5_000 }],
      NOW,
      WINDOW,
    );
    expect(seg).toEqual({ s: NOW - WINDOW, e: NOW - WINDOW + 5_000 });
  });

  it('clips a segment reaching into the future at nowMs', () => {
    const [seg] = clipSegmentsToWindow(
      [{ s: NOW - 10_000, e: NOW + 999_999 }],
      NOW,
      WINDOW,
    );
    expect(seg.e).toBe(NOW);
  });
});

describe('decayedSeconds', () => {
  it('counts fresh speech at full value', () => {
    // Segment centered 2.5s ago, half-life 3min → decay factor ≈ e^-(ln2 * 2.5/180).
    const secs = decayedSeconds([{ s: NOW - 3000, e: NOW - 2000 }], NOW, 180_000);
    expect(secs).toBeCloseTo(Math.pow(0.5, 2500 / 180_000), 9);
  });

  it('halves weight exactly one half-life old', () => {
    const HALF = 60_000;
    const age = HALF;
    const secs = decayedSeconds([{ s: NOW - age - 500, e: NOW - age + 500 }], NOW, HALF);
    expect(secs).toBeCloseTo(0.5, 9);
  });

  it('decays older speech to near zero', () => {
    const HALF = 60_000;
    const secs = decayedSeconds([{ s: NOW - 10 * HALF - 500, e: NOW - 10 * HALF + 500 }], NOW, HALF);
    expect(secs).toBeLessThan(0.002);
  });

  it('sums across multiple segments', () => {
    const segs = [
      { s: NOW - 2000, e: NOW - 1000 },
      { s: NOW - 4000, e: NOW - 3000 },
      { s: NOW - 8000, e: NOW - 7000 },
    ];
    const total = decayedSeconds(segs, NOW, 180_000);
    // Each 1s burst decays slightly; the sum stays under 3s and matches the
    // per-segment hand computation.
    expect(total).toBeLessThanOrEqual(3);
    expect(total).toBeCloseTo(
      segs.reduce(
        (sum, seg) => sum + decayedSeconds([seg], NOW, 180_000),
        0,
      ),
      9,
    );
  });

  it('returns 0 for empty input or a non-positive half-life', () => {
    expect(decayedSeconds([], NOW)).toBe(0);
    expect(decayedSeconds([{ s: NOW - 10, e: NOW - 5 }], NOW, 0)).toBe(0);
    expect(decayedSeconds([{ s: NOW - 10, e: NOW - 5 }], NOW, -1)).toBe(0);
  });
});

describe('computeSpotlightWeights', () => {
  it('returns EMPTY weights when nobody has spoken — no demo stand-ins', () => {
    expect(computeSpotlightWeights([], { nowMs: NOW })).toEqual([]);
    expect(computeSpotlightWeights([{ user_id: 'u1', name: 'Thorin', segments: [] }], { nowMs: NOW })).toEqual([]);
    // Stale-only speech falls out of the window → still empty.
    expect(
      computeSpotlightWeights(
        [{ user_id: 'u1', name: 'Thorin', segments: [{ s: NOW - 999_000, e: NOW - 900_000 }] }],
        { nowMs: NOW },
      ),
    ).toEqual([]);
  });

  it('normalizes real segment time into shares summing to 1', () => {
    const weights = computeSpotlightWeights(
      [
        { user_id: 'a', name: 'Ada', segments: [{ s: NOW - 90_000, e: NOW - 30_000 }] }, // 60s
        { user_id: 'b', name: 'Bo', segments: [{ s: NOW - 45_000, e: NOW - 15_000 }] }, // 30s
      ],
      { nowMs: NOW, halfLifeMs: 3 * 60_000 },
    );
    expect(weights.map((w) => w.userId)).toEqual(['a', 'b']);
    expect(weights[0].share + weights[1].share).toBeCloseTo(1, 9);
    // Ada spoke twice as long, both recently: share ≈ 2/3.
    expect(weights[0].share).toBeGreaterThan(0.63);
    expect(weights[0].share).toBeLessThan(0.70);
  });

  it('recency beats volume: an older burst can lose to a shorter fresh one', () => {
    const weights = computeSpotlightWeights(
      [
        { user_id: 'loud_old', name: 'Loud Old', segments: [{ s: NOW - 8 * 60_000, e: NOW - 7 * 60_000 }] }, // 60s, ancient → ~0.25 decayed
        { user_id: 'quiet_now', name: 'Quiet Now', segments: [{ s: NOW - 4_000, e: NOW - 1_000 }] }, // 3s, fresh → ~3 decayed
      ],
      { nowMs: NOW, windowMs: 10 * 60_000, halfLifeMs: 30_000 },
    );
    expect(weights[0].userId).toBe('quiet_now');
  });

  it('is deterministic across replicas: same ledger, same order', () => {
    const entries = [
      { user_id: 'z', name: 'Zed', segments: [{ s: NOW - 10_000, e: NOW - 5_000 }] },
      { user_id: 'y', name: 'Yan', segments: [{ s: NOW - 12_000, e: NOW - 5_000 }] },
      { user_id: 'x', name: 'Xu', segments: [{ s: NOW - 12_000, e: NOW - 4_000 }] },
    ];
    const runA = computeSpotlightWeights(entries, { nowMs: NOW });
    const runB = computeSpotlightWeights([...entries].reverse(), { nowMs: NOW });
    expect(runA).toEqual(runB);
    // Longest weighted time first; exact ties break by userId ascending.
    expect(runA.map((w) => w.weightedSeconds)).toEqual(
      [...runA.map((w) => w.weightedSeconds)].sort((a, b) => b - a),
    );
  });

  it('breaks exact ties deterministically by userId ascending', () => {
    const weights = computeSpotlightWeights(
      [
        { user_id: 'b', name: 'Bee', segments: [{ s: NOW - 6_000, e: NOW - 3_000 }] },
        { user_id: 'a', name: 'Aay', segments: [{ s: NOW - 9_000, e: NOW - 6_000 }] },
      ],
      { nowMs: NOW },
    );
    expect(weights.map((w) => w.userId)).toEqual(['b', 'a']);
  });

  it('ignores duplicate user entries instead of double-counting their time', () => {
    const segs = [{ s: NOW - 10_000, e: NOW - 5_000 }];
    const withDup = computeSpotlightWeights(
      [
        { user_id: 'a', name: 'Ada', segments: segs },
        { user_id: 'a', name: 'Ada Clone', segments: segs },
      ],
      { nowMs: NOW },
    );
    const solo = computeSpotlightWeights([{ user_id: 'a', name: 'Ada', segments: segs }], { nowMs: NOW });
    expect(withDup).toEqual(solo);
    expect(withDup).toHaveLength(1);
    expect(withDup[0].share).toBe(1);
  });

  it('survives tampered ledger payloads without crashing or inventing peers', () => {
    const weights = computeSpotlightWeights(
      [
        null as unknown as { user_id: string },
        { user_id: '', name: '', segments: [{ s: NOW - 100, e: NOW - 50 }] },
        { user_id: 'ok', name: '', segments: [{ s: 'nope' }, { s: NOW - 100, e: NOW - 50 }] },
      ] as never,
      { nowMs: NOW },
    );
    expect(weights).toHaveLength(1);
    // Blank display names degrade to the userId, not fabricated personas.
    expect(weights[0].name).toBe('ok');
  });

  it('refuses to compute from a non-finite clock', () => {
    expect(computeSpotlightWeights([{ user_id: 'a', name: 'A', segments: [{ s: 0, e: 5 }] }], { nowMs: NaN })).toEqual([]);
  });
});

describe('LocalSpeechLedger', () => {
  it('records nothing until VAD actually reports speech', () => {
    const ledger = new LocalSpeechLedger();
    expect(ledger.snapshot(NOW)).toEqual([]);
    expect(ledger.isSpeaking()).toBe(false);
  });

  it('closes a burst into exactly one segment of real duration', () => {
    const ledger = new LocalSpeechLedger();
    ledger.noteSpeechStart(NOW - 5_000);
    expect(ledger.isSpeaking()).toBe(true);
    expect(ledger.noteSpeechEnd(NOW - 2_000)).toBe(true);
    expect(ledger.snapshot(NOW)).toEqual([{ s: NOW - 5_000, e: NOW - 2_000 }]);
    expect(ledger.isSpeaking()).toBe(false);
  });

  it('ignores unmatched end events and double starts', () => {
    const ledger = new LocalSpeechLedger();
    expect(ledger.noteSpeechEnd(NOW)).toBe(false); // no open burst
    ledger.noteSpeechStart(NOW - 100);
    ledger.noteSpeechStart(NOW - 50); // second start ignored
    expect(ledger.noteSpeechEnd(NOW)).toBe(true);
    expect(ledger.snapshot(NOW)).toHaveLength(1);
  });

  it('discards nonsense end timestamps rather than fabricating duration', () => {
    const ledger = new LocalSpeechLedger();
    ledger.noteSpeechStart(NOW);
    expect(ledger.noteSpeechEnd(NOW - 999)).toBe(false); // ends before it began
    expect(ledger.noteSpeechEnd(NaN)).toBe(false);
    expect(ledger.snapshot(NOW)).toEqual([]);
  });

  it('includes the live tail of an open burst in snapshots', () => {
    const ledger = new LocalSpeechLedger();
    ledger.noteSpeechStart(NOW - 4_000);
    expect(ledger.snapshot(NOW)).toEqual([{ s: NOW - 4_000, e: NOW }]);
  });

  it('cancels an open burst without counting any of it', () => {
    const ledger = new LocalSpeechLedger();
    ledger.noteSpeechStart(NOW - 4_000);
    ledger.cancelOpenBurst();
    expect(ledger.isSpeaking()).toBe(false);
    expect(ledger.snapshot(NOW)).toEqual([]);
    // A later real burst still works after a cancel.
    ledger.noteSpeechStart(NOW - 1_000);
    ledger.noteSpeechEnd(NOW - 500);
    expect(ledger.snapshot(NOW)).toEqual([{ s: NOW - 1_000, e: NOW - 500 }]);
  });

  it('cancel is a no-op with no open burst', () => {
    const ledger = new LocalSpeechLedger();
    ledger.noteSpeechStart(NOW - 100);
    ledger.noteSpeechEnd(NOW - 50);
    ledger.cancelOpenBurst();
    expect(ledger.snapshot(NOW)).toHaveLength(1);
  });

  it('prunes aged-out segments from internal storage', () => {
    const ledger = new LocalSpeechLedger();
    ledger.noteSpeechStart(NOW - 500_000);
    ledger.noteSpeechEnd(NOW - 400_000);
    ledger.prune(NOW, 60_000);
    expect(ledger.snapshot(NOW, 60_000)).toEqual([]);
    // And reset clears everything, including an open burst.
    ledger.reset();
    expect(ledger.isSpeaking()).toBe(false);
  });

  it('weights derived from accumulated bursts match hand-computed decayed totals', () => {
    const ledger = new LocalSpeechLedger();
    ledger.noteSpeechStart(NOW - 10_000);
    ledger.noteSpeechEnd(NOW - 8_000);
    ledger.noteSpeechStart(NOW - 4_000);
    ledger.noteSpeechEnd(NOW - 1_000);
    const view = computeSpotlightWeights(
      [{ user_id: 'me', name: 'Me', segments: ledger.snapshot(NOW) }],
      { nowMs: NOW },
    );
    expect(view).toHaveLength(1);
    expect(view[0].share).toBe(1);
    const expected =
      decayedSeconds([{ s: NOW - 10_000, e: NOW - 8_000 }], NOW) +
      decayedSeconds([{ s: NOW - 4_000, e: NOW - 1_000 }], NOW);
    expect(view[0].weightedSeconds).toBeCloseTo(expected, 9);
  });
});
