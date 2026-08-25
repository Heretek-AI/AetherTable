/**
 * Amplification controls for the Yjs CRDT relay (audit A3 finding #4).
 *
 * WHY THIS EXISTS
 * Both relay guards (scripts/ysync_atmosphere_guard.mjs,
 * scripts/ysync_speech_guard.mjs) answer an unauthorized write with a
 * CORRECTIVE broadcast: they delete/restore inside a transaction, which emits
 * an update y-websocket fans out to every connection, and the persistence
 * layer used to fs.writeFileSync the WHOLE document synchronously on every
 * update. An attacker looping unauthorized writes therefore amplifies one
 * cheap frame into N broadcasts plus one whole-doc disk write per frame —
 * unbounded CPU, fan-out, and disk churn from a single peer.
 *
 * WHAT IS ENFORCED HERE (two independent controls)
 *
 *   1. createCorrectiveRateLimiter — a per-connection token bucket over
 *      corrective-broadcast events. Each eviction event consumes one token;
 *      once the bucket is empty the offending CONNECTION is disconnected
 *      instead of being allowed to keep triggering repairs. The bucket refills
 *      continuously so a legitimate peer that hits a transient bad state
 *      recovers without a reconnect.
 *
 *   2. createDebouncedPersister — dirty-flag + debounce persistence. Bursts of
 *      updates coalesce into ONE whole-document write after `delayMs` instead
 *      of one synchronous write per update; flushNow() covers shutdown paths
 *      that must not lose the tail.
 *
 * RESIDUAL threat model (documented honestly):
 *   - The current poisoned frame is still evicted (and broadcast) BEFORE the
 *     disconnect fires — correctness is never traded for rate limiting. The
 *     cap bounds AMPLIFICATION PER ATTACKER, not total traffic: each distinct
 *     connection gets its own budget, and a peer that reconnects gets a fresh
 *     bucket (the HMAC gate still applies at upgrade).
 *   - The debounced persister widens the crash-loss window from 0 to at most
 *     delayMs of committed CRDT state. Room docs are reconstructable session
 *     state (tokens/atmosphere/speech), so a 1s tail is the accepted trade for
 *     removing attacker-controlled disk write amplification.
 */

/** Default corrective-broadcast budget: 5 events per rolling minute window. */
export const DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW = 5;
export const DEFAULT_RATE_WINDOW_MS = 60_000;

/** Default persistence debounce: 1 second of coalescing. */
export const DEFAULT_PERSIST_DEBOUNCE_MS = 1_000;

/**
 * Per-key token-bucket limiter over corrective-broadcast events.
 *
 * @param {{
 *   maxEventsPerWindow?: number,
 *   windowMs?: number,
 *   now?: () => number,
 * }} [options]
 *   `maxEventsPerWindow` is both the burst capacity AND the refill amount per
 *   `windowMs` (tokens refill continuously at maxEventsPerWindow/windowMs).
 *   `now` is injectable for deterministic tests.
 * @returns {{
 *   consume(key: unknown): { allowed: boolean, tokensRemaining: number },
 *   tokensOf(key: unknown): number,
 *   forget(key: unknown): void,
 * }}
 */
export function createCorrectiveRateLimiter(options = {}) {
  const capacity = Math.max(
    1,
    options.maxEventsPerWindow ?? DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW,
  );
  const windowMs = Math.max(1, options.windowMs ?? DEFAULT_RATE_WINDOW_MS);
  const refillPerMs = capacity / windowMs;
  const now = options.now ?? (() => Date.now());

  /** key -> { tokens, updatedAt } */
  const buckets = new Map();

  function refill(bucket) {
    const t = now();
    if (t > bucket.updatedAt) {
      bucket.tokens = Math.min(capacity, bucket.tokens + (t - bucket.updatedAt) * refillPerMs);
      bucket.updatedAt = t;
    }
  }

  return {
    consume(key) {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: capacity, updatedAt: now() };
        buckets.set(key, bucket);
      }
      refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, tokensRemaining: bucket.tokens };
      }
      return { allowed: false, tokensRemaining: 0 };
    },
    /** Read-only current token count (refilled up to now, not persisted). */
    tokensOf(key) {
      const bucket = buckets.get(key);
      if (!bucket) return capacity;
      const t = now();
      if (t <= bucket.updatedAt) return bucket.tokens;
      return Math.min(capacity, bucket.tokens + (t - bucket.updatedAt) * refillPerMs);
    },
    forget(key) {
      buckets.delete(key);
    },
  };
}

/**
 * Wire corrective-broadcast events to disconnection: every event is counted,
 * and once a connection exhausts its budget it is disconnected so it cannot
 * trigger further amplification. The CURRENT event's repair still happens —
 * callers run eviction first and call this afterwards.
 *
 * @param {{ limiter: ReturnType<typeof createCorrectiveRateLimiter>,
 *            disconnect: (conn: unknown) => void,
 *            onExhausted?: (conn: unknown) => void }} options
 * @returns {(conn: unknown) => { disconnected: boolean }}
 */
export function createCorrectiveEventGate(options) {
  const { limiter, disconnect } = options;
  if (typeof disconnect !== 'function') {
    throw new TypeError('createCorrectiveEventGate requires a disconnect(conn) callback');
  }
  return (conn) => {
    const verdict = limiter.consume(conn);
    if (verdict.allowed) return { disconnected: false };
    try {
      disconnect(conn);
    } catch {
      /* a dead socket must not break the guard's transaction path */
    }
    options.onExhausted?.(conn);
    return { disconnected: true };
  };
}

/**
 * Dirty-flag + debounce wrapper around a synchronous whole-document flush.
 *
 * @param {() => void} flush the synchronous persist operation
 * @param {{
 *   delayMs?: number,
 *   scheduler?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 * }} [options] `scheduler` is injectable for deterministic tests
 * @returns {{
 *   markDirty(): void,
 *   flushNow(): void,
 *   pending(): boolean,
 *   dispose(): void,
 * }}
 */
export function createDebouncedPersister(flush, options = {}) {
  if (typeof flush !== 'function') throw new TypeError('flush must be a function');
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_PERSIST_DEBOUNCE_MS);
  const scheduler = options.scheduler ?? { setTimeout, clearTimeout };
  let timer = null;

  return {
    /** Coalesce this update into the next scheduled flush. */
    markDirty() {
      if (timer !== null) return; // already scheduled — burst coalesces
      timer = scheduler.setTimeout(() => {
        timer = null;
        flush();
      }, delayMs);
    },
    /** Flush immediately (shutdown / last-peer-left paths). Cancels any timer. */
    flushNow() {
      if (timer !== null) {
        scheduler.clearTimeout(timer);
        timer = null;
      }
      flush();
    },
    /** Whether a debounced flush is currently scheduled. */
    pending() {
      return timer !== null;
    },
    /** Cancel a scheduled flush WITHOUT writing (tests / teardown). */
    dispose() {
      if (timer !== null) {
        scheduler.clearTimeout(timer);
        timer = null;
      }
    },
  };
}
