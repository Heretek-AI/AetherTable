/**
 * Local VAD spotlight meter (Loop 3 iteration 31) — the minimal "who's
 * speaking" indicator for the narrative UI.
 *
 * HONEST SCOPE: this meter runs ENTIRELY on THIS browser's own microphone,
 * fed by the Silero VAD callbacks that NarrativeChat's recording toggle
 * already wires to voice_capture.ts. The toggle IS the user gesture, which is
 * the same autoplay gate every AudioContext in this repo uses — this module
 * creates no AudioContext and never touches the mic itself. A browser can only
 * hear its own mic: REMOTE seats' voices are never detected here, and this
 * module never fabricates them. A server-aggregated spotlight is a future
 * iteration; the room-wide balance today comes from sync/speech_ledger.ts.
 *
 * MATH: real VAD burst durations are folded into a simple exponential moving
 * average of speaking seconds (emaStep), then decayed toward zero over a
 * half-life (decayLevelSeconds) so the ring settles after silence. The
 * constants are exported so the tests pin them exactly.
 *
 * `hasMediaDevices()` is the feature gate the UI uses so CI / happy-dom
 * environments (no getUserMedia) render a truthful off-state instead of
 * pretending the mic exists.
 */

export type VadMeterStatus = 'unsupported' | 'denied' | 'idle' | 'live';

/** EMA smoothing applied when a VAD burst lands (seconds-weighted). */
export const DEFAULT_VAD_METER_ALPHA = 0.2;
/** Silence beyond this fresh the meter half-way toward zero. */
export const DEFAULT_VAD_METER_HALF_LIFE_MS = 45_000;
/** Recent-speech seconds that read as a "full" ring on the strip (1.0 glow). */
export const VAD_METER_FULL_RING_SECONDS = 10;

/** Feature-detect: environments without getUserMedia get the off-state. */
export function hasMediaDevices(): boolean {
  try {
    return Boolean(
      typeof navigator !== 'undefined' &&
        navigator?.mediaDevices != null &&
        typeof navigator.mediaDevices.getUserMedia === 'function',
    );
  } catch {
    return false;
  }
}

/** next = current·(1-α) + sampleSeconds·α — the EMA fold for one burst. */
export function emaStep(current: number, sampleSeconds: number, alpha: number): number {
  return current * (1 - alpha) + sampleSeconds * alpha;
}

/** Exponential recency decay: level·0.5^(dtMs/halfLifeMs). */
export function decayLevelSeconds(
  level: number,
  nowMs: number,
  lastMs: number,
  halfLifeMs: number = DEFAULT_VAD_METER_HALF_LIFE_MS,
): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 0;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastMs)) return level;
  const dt = Math.max(0, nowMs - lastMs);
  if (dt === 0) return level;
  return level * Math.pow(0.5, dt / halfLifeMs);
}

/**
 * Pure UI state machine consumed by LocalVadMeterStrip:
 *   - unsupported dominates everything (no getUserMedia at all);
 *   - live while a capture session is running;
 *   - denied when the mic start failed (permission refused / hardware dead) but
 *     the capability exists — the UI offers a Retry;
 *   - idle otherwise (muted).
 */
export function deriveVadMeterStatus(
  supported: boolean,
  isRecording: boolean,
  micStartFailed: boolean,
): VadMeterStatus {
  if (!supported) return 'unsupported';
  if (isRecording) return 'live';
  if (micStartFailed) return 'denied';
  return 'idle';
}

export interface VadMeterConfig {
  /** EMA smoothing folded onto each closed burst (default 0.2). */
  alpha?: number;
  /** Decay half-life in ms; silence this long halves the level. */
  decayHalfLifeMs?: number;
}

/**
 * Per-seat speaking-seconds meter fed by VAD event timestamps. `begin`/`end`
 * fold real burst durations into the EMA; `tick` decays the level over time
 * and is driven by a small interval in the UI. `cancel` drops an open burst so
 * an un-ended callback can never accrue phantom seconds.
 */
export class LocalVadMeter {
  private alpha: number;
  private halfLifeMs: number;
  private levelSeconds = 0;
  private burstStartMs: number | null = null;
  private lastTickMs: number | null = null;

  constructor(cfg: VadMeterConfig = {}) {
    this.alpha = cfg.alpha ?? DEFAULT_VAD_METER_ALPHA;
    this.halfLifeMs = cfg.decayHalfLifeMs ?? DEFAULT_VAD_METER_HALF_LIFE_MS;
  }

  /** Silero VAD said speech began. Ignored while a burst is already open. */
  public begin(nowMs: number): void {
    if (this.burstStartMs !== null || !Number.isFinite(nowMs)) return;
    this.burstStartMs = nowMs;
  }

  /**
   * Silero VAD said speech ended. Returns true when a valid burst was folded
   * in; an unmatched end records nothing rather than fabricating time.
   */
  public end(nowMs: number): boolean {
    const start = this.burstStartMs;
    if (start === null || !Number.isFinite(nowMs) || nowMs <= start) return false;
    this.decayTo(nowMs);
    const seconds = (nowMs - start) / 1000;
    this.burstStartMs = null;
    this.levelSeconds = emaStep(this.levelSeconds, seconds, this.alpha);
    return true;
  }

  /** Drops an OPEN burst with none of it counted (mic released mid-sentence). */
  public cancel(): void {
    this.burstStartMs = null;
  }

  /** Applies the silence-decay up to `nowMs` and returns the level. */
  public tick(nowMs: number): number {
    this.decayTo(nowMs);
    return this.levelSeconds;
  }

  /** EMA of recent speaking seconds (units: seconds; 0 when nobody spoke). */
  public getLevelSeconds(): number {
    return this.levelSeconds;
  }

  public isSpeaking(): boolean {
    return this.burstStartMs !== null;
  }

  public reset(): void {
    this.levelSeconds = 0;
    this.burstStartMs = null;
    this.lastTickMs = null;
  }

  private decayTo(nowMs: number): void {
    if (!Number.isFinite(nowMs)) return;
    if (this.lastTickMs === null) {
      this.lastTickMs = nowMs;
      return;
    }
    this.levelSeconds = decayLevelSeconds(this.levelSeconds, nowMs, this.lastTickMs, this.halfLifeMs);
    this.lastTickMs = nowMs;
  }
}