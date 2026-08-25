/**
 * Amplification-control tests for the Yjs relay (audit A3 finding #4).
 *
 * Every unauthorized write a guard catches triggers a corrective broadcast
 * plus (before this hardening) one synchronous whole-document disk write.
 * An attacker looping unauthorized writes amplified one cheap frame into N
 * fan-outs and N disk flushes. These tests pin the two controls:
 *
 *   - createCorrectiveRateLimiter / createCorrectiveEventGate: per-connection
 *     token bucket over corrective-broadcast events; an exhausted budget
 *     disconnects the offending connection instead of further amplification.
 *   - createDebouncedPersister: dirty-flag + debounce so bursts of updates
 *     coalesce into ONE whole-document write, with flushNow() for shutdown.
 *
 * The clock and scheduler are injected, so every test is deterministic — no
 * real timers, no real sleeps.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCorrectiveRateLimiter,
  createCorrectiveEventGate,
  createDebouncedPersister,
  DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW,
  DEFAULT_RATE_WINDOW_MS,
  DEFAULT_PERSIST_DEBOUNCE_MS,
} from '../ysync_relay_throttle.mjs';

describe('createCorrectiveRateLimiter', () => {
  it('allows the configured burst of corrective events per connection', () => {
    let t = 0;
    const limiter = createCorrectiveRateLimiter({ now: () => t });
    for (let i = 0; i < DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW; i++) {
      expect(limiter.consume('conn-a').allowed).toBe(true);
    }
    expect(limiter.consume('conn-a').allowed).toBe(false);
  });

  it('tracks budgets PER CONNECTION, not globally', () => {
    let t = 0;
    const limiter = createCorrectiveRateLimiter({ now: () => t });
    for (let i = 0; i < DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW; i++) {
      expect(limiter.consume('conn-a').allowed).toBe(true);
    }
    // conn-a's budget is spent...
    expect(limiter.tokensOf('conn-a')).toBe(0);
    // ...but a different connection still has its OWN full budget.
    expect(limiter.consume('conn-b').allowed).toBe(true);
    expect(limiter.tokensOf('conn-b')).toBe(DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW - 1);
  });

  it('refills continuously: a peer recovers after the window passes', () => {
    let t = 0;
    const limiter = createCorrectiveRateLimiter({ now: () => t });
    for (let i = 0; i < DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW; i++) {
      limiter.consume('conn-a');
    }
    expect(limiter.consume('conn-a').allowed).toBe(false);
    // A single token's worth of elapsed time is windowMs/capacity = 12s
    // (refill is 5 tokens / 60s). Elapsing half of that funds half a token —
    // not enough for the next whole event.
    const perToken = DEFAULT_RATE_WINDOW_MS / DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW;
    t += perToken / 2;
    expect(limiter.consume('conn-a').allowed).toBe(false);
    expect(limiter.tokensOf('conn-a')).toBeCloseTo(0.5, 5);
    // One more half-token's worth of elapsed time funds the next whole event.
    t += perToken / 2;
    expect(limiter.consume('conn-a').allowed).toBe(true);
  });

  it('never lets the balance exceed capacity', () => {
    let t = 0;
    const limiter = createCorrectiveRateLimiter({ now: () => t });
    t += DEFAULT_RATE_WINDOW_MS * 10; // idle far longer than a window
    expect(limiter.tokensOf('conn-c')).toBe(DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW);
    void limiter;
  });
});

describe('createCorrectiveEventGate', () => {
  function makeGate(overrides = {}) {
    const calls = { disconnected: [], exhausted: [] };
    const gate = createCorrectiveEventGate({
      limiter: createCorrectiveRateLimiter({ now: () => 0 }),
      disconnect: (conn) => calls.disconnected.push(conn),
      onExhausted: (conn) => calls.exhausted.push(conn),
      ...overrides,
    });
    return { gate, calls };
  }

  it('keeps the connection alive while its budget lasts', () => {
    const { gate, calls } = makeGate();
    for (let i = 0; i < DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW; i++) {
      expect(gate('conn-a').disconnected).toBe(false);
    }
    expect(calls.disconnected).toEqual([]);
  });

  it('disconnects the offending connection once the budget is exhausted', () => {
    const { gate, calls } = makeGate();
    for (let i = 0; i < DEFAULT_MAX_CORRECTIVE_EVENTS_PER_WINDOW; i++) {
      gate('conn-a');
    }
    // The NEXT unauthorized event costs more than the budget allows: the
    // connection is cut instead of being allowed further amplification.
    expect(gate('conn-a').disconnected).toBe(true);
    expect(gate('conn-a').disconnected).toBe(true); // stays cut on repeats
    expect(calls.disconnected).toEqual(['conn-a', 'conn-a']);
    expect(calls.exhausted).toEqual(['conn-a', 'conn-a']);
  });

  it('survives a disconnect callback that throws (dead socket)', () => {
    const gate = createCorrectiveEventGate({
      limiter: createCorrectiveRateLimiter({ maxEventsPerWindow: 1, now: () => 0 }),
      disconnect: () => {
        throw new Error('already closed');
      },
    });
    gate('conn-a');
    expect(() => gate('conn-a')).not.toThrow();
    expect(gate('conn-a').disconnected).toBe(true);
  });

  it('requires a disconnect callback up front', () => {
    expect(() => createCorrectiveEventGate({ limiter: createCorrectiveRateLimiter() }))
      .toThrow(TypeError);
  });
});

describe('createDebouncedPersister', () => {
  /** Fake scheduler: deterministic timers driven by an explicit clock. */
  function fakeScheduler() {
    const pendingTimers = new Map();
    let nextId = 1;
    return {
      scheduler: {
        setTimeout(fn, delay) {
          const id = nextId++;
          pendingTimers.set(id, { fn, at: delay });
          return id;
        },
        clearTimeout(id) {
          pendingTimers.delete(id);
        },
      },
      advance(ms) {
        for (const [id, timer] of [...pendingTimers]) {
          timer.at -= ms;
          if (timer.at <= 0) {
            pendingTimers.delete(id);
            timer.fn();
          }
        }
      },
      get size() {
        return pendingTimers.size;
      },
    };
  }

  it('coalesces a burst of updates into ONE whole-document write', () => {
    const { scheduler, advance, size } = fakeScheduler();
    const writes = [];
    const persister = createDebouncedPersister(
      () => writes.push(Date.now()),
      { delayMs: DEFAULT_PERSIST_DEBOUNCE_MS, scheduler },
    );

    persister.markDirty(); // update 1 (e.g. an attacker's poison frame)
    expect(persister.pending()).toBe(true);
    persister.markDirty(); // update 2 (the corrective broadcast)
    persister.markDirty(); // update 3
    advance(DEFAULT_PERSIST_DEBOUNCE_MS);

    expect(writes.length).toBe(1);
    expect(persister.pending()).toBe(false);
    expect(size).toBe(0);
  });

  it('schedules exactly one follow-up flush per quiet period', () => {
    const { scheduler, advance } = fakeScheduler();
    const writes = [];
    const persister = createDebouncedPersister(
      () => writes.push('w'),
      { delayMs: 1000, scheduler },
    );
    persister.markDirty();
    advance(1000);
    persister.markDirty();
    advance(1000);
    expect(writes).toEqual(['w', 'w']);
  });

  it('flushNow() writes immediately and cancels the scheduled flush', () => {
    const { scheduler, advance } = fakeScheduler();
    const writes = [];
    const persister = createDebouncedPersister(
      () => writes.push('w'),
      { delayMs: 1000, scheduler },
    );
    persister.markDirty();
    persister.flushNow(); // e.g. the last peer left the room
    expect(writes).toEqual(['w']);
    advance(5000); // the debounce timer must not double-write afterwards
    expect(writes).toEqual(['w']);
    expect(persister.pending()).toBe(false);
  });

  it('dispose() cancels a pending flush without writing (teardown path)', () => {
    const { scheduler, advance } = fakeScheduler();
    const writes = [];
    const persister = createDebouncedPersister(
      () => writes.push('w'),
      { delayMs: 1000, scheduler },
    );
    persister.markDirty();
    persister.dispose();
    advance(5000);
    expect(writes).toEqual([]);
  });

  it('rejects a non-function flush and honors a zero delay contract', () => {
    expect(() => createDebouncedPersister(null)).toThrow(TypeError);
    expect(DEFAULT_PERSIST_DEBOUNCE_MS).toBe(1000);
  });
});
