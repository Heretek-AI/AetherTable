/**
 * Speech-ledger: REAL per-peer talking-time accounting for Pillar-11
 * spotlight balancing.
 *
 * Every speech second counted here comes from actual Silero VAD
 * onSpeechStart/onSpeechEnd timestamps (render/voice_capture.ts). Nothing in
 * this module invents demo speakers or seeded numbers: an empty ledger means
 * nobody has talked yet, and the derived weights are EMPTY until real
 * segments arrive.
 *
 * Pure core (this file):
 *   - accumulate/validate/clip VAD segments per peer,
 *   - fold them into normalized spotlight weights over a decaying window.
 *
 * Sync layer (sync/yjs_doc_client.ts):
 *   - each replica publishes ONLY its own user's segments under a
 *     `user:<userId>` key (same per-owner keying convention as fog layers),
 *     so cross-peer merges are conflict-free and every client converges on
 *     the same ledger before recomputing weights locally.
 */

/** One closed VAD speech burst, epoch-ms inclusive-exclusive [s, e). */
export interface SpeechSegment {
  s: number;
  e: number;
}

/** A peer's published speech record as stored in the shared Y.Doc. */
export interface LedgerEntry {
  user_id: string;
  name: string;
  segments: SpeechSegment[];
}

/** One peer's derived spotlight standing. */
export interface SpeakerWeight {
  userId: string;
  name: string;
  /** Recency-decayed talking seconds inside the window. */
  weightedSeconds: number;
  /** weightedSeconds / table total; shares sum to 1 when anyone spoke. */
  share: number;
}

export type SpotlightScope =
  | 'room'
  | 'local-only';

/** What the UI renders; `shares` is empty until real VAD segments exist. */
export interface SpotlightView {
  scope: SpotlightScope;
  shares: SpeakerWeight[];
}

export interface SpotlightOptions {
  nowMs: number;
  /** Only segments intersecting (nowMs - windowMs, nowMs] count. */
  windowMs?: number;
  /** Exponential-recency half-life: age at which a second counts as half. */
  halfLifeMs?: number;
}

export const DEFAULT_WINDOW_MS = 10 * 60_000;
export const DEFAULT_HALF_LIFE_MS = 3 * 60_000;
/**
 * A single VAD segment longer than this is treated as a stuck sensor (mic
 * left hot, missed onSpeechEnd), not human speech, and is clamped. Bounds the
 * damage one wedged callback can do to the balance view.
 */
export const MAX_SEGMENT_MS = 2 * 60_000;

/**
 * Coerce arbitrary (possibly tampered / partially-written / pre-schema) data
 * into valid segments. Rejects non-finite numbers, inverted or zero-length
 * ranges, and clamps runaway durations to MAX_SEGMENT_MS.
 */
export function sanitizeSegments(
  raw: unknown,
  maxSegmentMs: number = MAX_SEGMENT_MS,
): SpeechSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: SpeechSegment[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const s = typeof rec.s === 'number' ? rec.s : NaN;
    const e = typeof rec.e === 'number' ? rec.e : NaN;
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (e <= s) continue;
    const dur = Math.min(e - s, maxSegmentMs);
    out.push({ s, e: s + dur });
  }
  return out;
}

/**
 * Clip segments to the sliding window and drop anything fully outside it.
 * Segments straddling the window's trailing edge are cut, not discarded, so
 * long-running speech keeps counting for exactly as long as it is recent.
 */
export function clipSegmentsToWindow(
  segments: SpeechSegment[],
  nowMs: number,
  windowMs: number,
  maxSegmentMs: number = MAX_SEGMENT_MS,
): SpeechSegment[] {
  const floor = nowMs - windowMs;
  const out: SpeechSegment[] = [];
  for (const seg of sanitizeSegments(segments, maxSegmentMs)) {
    const s = Math.max(seg.s, floor);
    const e = Math.min(seg.e, nowMs);
    if (e > s) out.push({ s, e });
  }
  return out;
}

/**
 * Sum a peer's window-clipped seconds with exponential recency decay:
 * each instant contributes 0.5^(age / halfLife) of itself. Recent speech
 * dominates; a burst from eight minutes ago barely registers next to one
 * from thirty seconds ago.
 */
export function decayedSeconds(
  segments: SpeechSegment[],
  nowMs: number,
  halfLifeMs: number = DEFAULT_HALF_LIFE_MS,
): number {
  if (halfLifeMs <= 0) return 0;
  let total = 0;
  for (const { s, e } of sanitizeSegments(segments)) {
    // Midpoint age is an exact-enough quadrature point for sub-minute bursts
    // and keeps the function trivially unit-testable.
    const ageMs = Math.max(0, nowMs - (s + e) / 2);
    total += ((e - s) / 1000) * Math.pow(0.5, ageMs / halfLifeMs);
  }
  return total;
}

/**
 * Fold the whole table's ledger into normalized spotlight weights.
 *
 * Deterministic order (descending weightedSeconds, ties broken by userId) so
 * every replica renders the same ranking from the same merged ledger. Empty
 * input, or a table where nobody has spoken inside the window, yields []
 * — callers must render that honestly rather than substituting demo weights.
 */
export function computeSpotlightWeights(
  entries: LedgerEntry[],
  options: SpotlightOptions,
): SpeakerWeight[] {
  const { nowMs, windowMs = DEFAULT_WINDOW_MS, halfLifeMs = DEFAULT_HALF_LIFE_MS } = options;
  if (!Number.isFinite(nowMs)) return [];

  const rows: Array<{ userId: string; name: string; weightedSeconds: number }> = [];
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    if (typeof entry?.user_id !== 'string' || entry.user_id === '') continue;
    if (seen.has(entry.user_id)) continue; // first occurrence wins; no double counting
    seen.add(entry.user_id);
    const clipped = clipSegmentsToWindow(sanitizeSegments(entry.segments), nowMs, windowMs);
    const weightedSeconds = decayedSeconds(clipped, nowMs, halfLifeMs);
    if (!(weightedSeconds > 0)) continue;
    rows.push({
      userId: entry.user_id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.user_id,
      weightedSeconds,
    });
  }

  const total = rows.reduce((sum, r) => sum + r.weightedSeconds, 0);
  if (!(total > 0)) return [];

  return rows
    .map((r) => ({ ...r, share: r.weightedSeconds / total }))
    .sort((a, b) =>
      b.weightedSeconds - a.weightedSeconds ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
}

/**
 * Per-client accumulator fed straight from VoiceCaptureManager's VAD
 * callbacks. Holds THIS browser's segments only — publication to the shared
 * Y.Doc is the caller's job (see YjsCrdtClient.publishSpeech).
 */
export class LocalSpeechLedger {
  private openStart: number | null = null;
  private closed: SpeechSegment[] = [];

  /** Silero VAD said speech began. Ignored while a burst is already open. */
  public noteSpeechStart(nowMs: number): void {
    if (!Number.isFinite(nowMs)) return;
    if (this.openStart !== null) return;
    this.openStart = nowMs;
  }

  /**
   * Silero VAD said speech ended. Returns true when a valid segment was
   * recorded; an unmatched end (no open burst, or clock nonsense) records
   * nothing rather than fabricating duration.
   */
  public noteSpeechEnd(nowMs: number): boolean {
    const start = this.openStart;
    this.openStart = null;
    if (start === null || !Number.isFinite(nowMs) || nowMs <= start) return false;
    const [seg] = sanitizeSegments([{ s: start, e: nowMs }]);
    if (!seg) return false;
    this.closed.push(seg);
    return true;
  }

  /**
   * Drop an OPEN burst without counting any of it — used when capture stops
   * mid-sentence, so an un-ended segment cannot keep growing as a phantom
   * "live tail" after the mic is off.
   */
  public cancelOpenBurst(): void {
    this.openStart = null;
  }

  public isSpeaking(): boolean {
    return this.openStart !== null;
  }

  /**
   * This peer's segments inside the window, INCLUDING the live tail of an
   * open burst so the balance view moves while someone is mid-sentence.
   */
  public snapshot(nowMs: number, windowMs: number = DEFAULT_WINDOW_MS): SpeechSegment[] {
    const all = this.closed.slice();
    if (this.openStart !== null && Number.isFinite(nowMs)) {
      all.push({ s: this.openStart, e: Math.max(this.openStart, nowMs) });
    }
    return clipSegmentsToWindow(all, nowMs, windowMs);
  }

  /** Drop everything older than the window from internal storage. */
  public prune(nowMs: number, windowMs: number = DEFAULT_WINDOW_MS): void {
    const floor = nowMs - windowMs;
    this.closed = this.closed.filter((seg) => seg.e > floor);
  }

  public reset(): void {
    this.closed = [];
    this.openStart = null;
  }
}
