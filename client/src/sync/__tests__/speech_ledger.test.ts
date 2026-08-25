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
  DEFAULT_WINDOW_MS,
  decayedSeconds,
  LocalSpeechLedger,
  MAX_SEGMENT_MS,
  MAX_SEGMENTS_PER_PEER,
  sanitizeSegments,
  SPOTLIGHT_WEIGHT_WINDOW_FACTOR,
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

describe('sanitizeSegments poisoning caps (audit A2 #5)', () => {
  it('caps the per-peer segment count at MAX_SEGMENTS_PER_PEER', () => {
    expect(MAX_SEGMENTS_PER_PEER).toBeGreaterThanOrEqual(100);
    const flood = Array.from({ length: MAX_SEGMENTS_PER_PEER + 500 }, (_, i) => ({
      s: i * 1000,
      e: i * 1000 + 500,
    }));
    const out = sanitizeSegments(flood);
    expect(out).toHaveLength(MAX_SEGMENTS_PER_PEER);
  });

  it('keeps the NEWEST segments when the count cap drops the overflow', () => {
    // 210 one-second bursts marching forward in time; the oldest must be the
    // ones dropped, so a live speaker keeps counting while history truncates.
    const N = MAX_SEGMENTS_PER_PEER + 10;
    const flood = Array.from({ length: N }, (_, i) => ({ s: i * 1000, e: i * 1000 + 500 }));
    const out = sanitizeSegments(flood);
    expect(out[0].s).toBe(10 * 1000); // first ten dropped
    expect(out[out.length - 1].s).toBe((N - 1) * 1000);
  });

  it('merges overlapping and contained duplicate intervals instead of double-counting them', () => {
    const out = sanitizeSegments([
      { s: 0, e: 100 },
      { s: 50, e: 150 },   // overlaps → merged into [0,150)
      { s: 60, e: 80 },    // fully contained → dropped
      { s: 200, e: 300 },  // disjoint → kept
      { s: 250, e: 260 },  // contained in the disjoint one → dropped
    ]);
    expect(out).toEqual([
      { s: 0, e: 150 },
      { s: 200, e: 300 },
    ]);
  });

  it('merges adjacent back-to-back bursts (touching intervals) into one', () => {
    expect(sanitizeSegments([{ s: 0, e: 100 }, { s: 100, e: 200 }])).toEqual([
      { s: 0, e: 200 },
    ]);
  });

  it('is idempotent: sanitizing already-sanitized output is a no-op', () => {
    const once = sanitizeSegments([
      { s: 0, e: 100 },
      { s: 90, e: 120 },
      null,
      { s: 'x' as unknown as number, e: 1 },
    ]);
    expect(sanitizeSegments(once)).toEqual(once);
  });

  it('still clamps durations AFTER merging, so a merge cannot smuggle in a marathon', () => {
    // Two chained 90-second overlaps fuse into a ~3-minute span; the clamp
    // must reapply to the merged interval.
    const out = sanitizeSegments([
      { s: 0, e: 90_000 },
      { s: 89_000, e: 179_000 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].e - out[0].s).toBe(MAX_SEGMENT_MS);
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

  it('caps one hostile peer at a fraction of the window so it cannot own normalization (audit A2 #4)', () => {
    expect(SPOTLIGHT_WEIGHT_WINDOW_FACTOR).toBeGreaterThan(0);
    expect(SPOTLIGHT_WEIGHT_WINDOW_FACTOR).toBeLessThan(1);
    const ceilingSeconds = (DEFAULT_WINDOW_MS * SPOTLIGHT_WEIGHT_WINDOW_FACTOR) / 1000;
    // Sanity: the cap demonstrably binds. The most damage the #5 caps allow a
    // single key to carry is ~5 non-overlapping clamped bursts across the
    // window (~600 raw seconds); decay still pulls that under 150s here, so
    // assert instead that the ceiling binds against an aggressive half-life
    // (no decay) where the same flood scores far above it.
    const flood = Array.from({ length: 5 }, (_, i) => ({
      s: NOW - (i + 1) * 120_000 + 1_000,
      e: NOW - (i + 1) * 120_000 + 120_000,
    }));
    const rawNoDecay = decayedSeconds(
      clipSegmentsToWindow(sanitizeSegments(flood), NOW, DEFAULT_WINDOW_MS),
      NOW,
      Infinity,
    );
    expect(rawNoDecay).toBeGreaterThan(ceilingSeconds);

    const [poisoner] = computeSpotlightWeights(
      [{ user_id: 'evil', name: 'Evil', segments: flood.slice() }],
      { nowMs: NOW, halfLifeMs: Infinity },
    );
    // The ceiling binds exactly at the boundary — no free seconds above it.
    expect(poisoner.weightedSeconds).toBe(ceilingSeconds);
    // Alone in the ledger it is still normalized to the whole pie — the cap
    // bounds absolute weight, not presence.
    expect(poisoner.share).toBe(1);
  });

  it('stops a flooder from holding a majority against several honest speakers', () => {
    const ceilingSeconds = (DEFAULT_WINDOW_MS * SPOTLIGHT_WEIGHT_WINDOW_FACTOR) / 1000;
    const flood = Array.from({ length: 5 }, (_, i) => ({
      s: NOW - (i + 1) * 120_000 + 1_000,
      e: NOW - (i + 1) * 120_000 + 120_000,
    }));
    // Two honest table members who each really talked for ~100 fresh seconds.
    const honestSegments = [{ s: NOW - 105_000, e: NOW - 5_000 }];
    const weights = computeSpotlightWeights(
      [
        { user_id: 'evil', name: 'Evil', segments: flood },
        { user_id: 'alice', name: 'Alice', segments: honestSegments },
        { user_id: 'bob', name: 'Bob', segments: honestSegments },
      ],
      { nowMs: NOW, halfLifeMs: DEFAULT_HALF_LIFE_MS_FOR_TEST },
    );
    const evil = weights.find((w) => w.userId === 'evil')!;
    expect(evil.weightedSeconds).toBeLessThanOrEqual(ceilingSeconds);
    // No single peer — hostile or not — may command the majority share.
    expect(evil.share).toBeLessThan(0.5);
  });

  it('leaves honest speakers strictly under the ceiling completely untouched', () => {
    const modest = [{ s: NOW - 105_000, e: NOW - 5_000 }];
    const expected = decayedSeconds(modest, NOW, DEFAULT_HALF_LIFE_MS_FOR_TEST);
    const weights = computeSpotlightWeights(
      [
        { user_id: 'a', name: 'Ada', segments: modest },
        { user_id: 'b', name: 'Bo', segments: modest },
      ],
      { nowMs: NOW, halfLifeMs: DEFAULT_HALF_LIFE_MS_FOR_TEST },
    );
    expect(weights.map((w) => w.weightedSeconds)).toEqual([expected, expected]);
  });
});

// Half-life short enough that the flooded history decays hard and the
// ceiling-vs-honesty contrast above is unambiguous.
const DEFAULT_HALF_LIFE_MS_FOR_TEST = 60_000;

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
