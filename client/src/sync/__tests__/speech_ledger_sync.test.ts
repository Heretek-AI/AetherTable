/**
 * Convergence tests for the speech ledger inside real Y.Docs.
 *
 * These exercise the actual CRDT path (not mocks): two independent
 * YjsCrdtClient instances are wired as peers over a manual update pipe, each
 * publishes ONLY its own user's VAD segments under its own `user:<id>` key,
 * and both must end up computing IDENTICAL spotlight weights from the merged
 * ledger. That is the Pillar-11 guarantee the old hardcoded
 * { Thorin: 0.55, Lyra: 0.45 } snapshot field could never make.
 *
 * Runs in the plain node environment — yjs itself needs no DOM.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as Y from 'yjs';

// y-websocket/y-indexdb pull browser globals at import time; stub the minimum
// so importing the module under test stays side-effect free in node.
// IndexedDB is unavailable in node; hand lib0 a request object whose
// handlers are assigned but never fire, so no promise ever rejects.
const neverRequest = {
  onupgradeneeded: null as unknown,
  onerror: null as unknown,
  onsuccess: null as unknown,
};
const idbStub = {
  open: () => ({ ...neverRequest }),
  deleteDatabase: () => ({ ...neverRequest }),
};
vi.stubGlobal('indexedDB', idbStub);
vi.stubGlobal('IDBKeyRange', {});
vi.stubGlobal('WebSocket', class { constructor() { throw new Error('no WS in tests'); } });

import { YjsCrdtClient } from '../yjs_doc_client';
import {
  computeSpotlightWeights,
  DEFAULT_WINDOW_MS,
  SPOTLIGHT_WEIGHT_WINDOW_FACTOR,
  type SpotlightView,
} from '../speech_ledger';

/**
 * Pair two clients through an in-memory bidirectional update relay,
 * replicating exactly what the ysync broker does: forward every doc update
 * to the other side and apply it causally. No network, no timers.
 */
function pairClients(a: YjsCrdtClient, b: YjsCrdtClient): void {
  const docA = (a as unknown as { doc: Y.Doc }).doc;
  const docB = (b as unknown as { doc: Y.Doc }).doc;
  docA.on('update', (update: Uint8Array) => Y.applyUpdate(docB, update, 'a'));
  docB.on('update', (update: Uint8Array) => Y.applyUpdate(docA, update, 'b'));
}

describe('YjsCrdtClient speech ledger convergence', () => {
  const clients: YjsCrdtClient[] = [];

  afterEach(() => {
    while (clients.length) clients.pop()?.destroy();
    vi.restoreAllMocks();
  });

  const makeClient = (): YjsCrdtClient => {
    // Empty serverUrl string keeps the WebsocketProvider construction on its
    // failure path without ever opening sockets.
    const client = new YjsCrdtClient('', 'test-room');
    clients.push(client);
    return client;
  };

  it('converges both replicas on identical weights from per-owner writes', () => {
    const gm = makeClient();
    const p1 = makeClient();
    pairClients(gm, p1);

    const NOW = 1_000_000;
    gm.setLocalUser({ user_id: 'gm', name: 'Arch-Mage' });
    p1.setLocalUser({ user_id: 'p1', name: 'Thorin' });

    // Each replica writes ONLY its own key (fog-layer convention).
    gm.publishSpeech('gm', 'Arch-Mage', [{ s: NOW - 60_000, e: NOW - 30_000 }]);
    p1.publishSpeech('p1', 'Thorin', [{ s: NOW - 10_000, e: NOW - 5_000 }]);

    const viewGm = gm.getSpotlightView(NOW);
    const viewP1 = p1.getSpotlightView(NOW);

    expect(viewGm.scope).toBe('room');
    expect(viewGm).toEqual(viewP1); // identical converged view
    expect(viewGm.shares.map((w) => w.userId)).toEqual(['gm', 'p1']);
    expect(viewGm.shares[0].share + viewGm.shares[1].share).toBeCloseTo(1, 9);
  });

  it('merges concurrent same-peer writes to ONE key LWW without duplicating time', () => {
    const phone = makeClient();
    const laptop = makeClient(); // same human, second device
    pairClients(phone, laptop);
    // Both devices are legitimately bound to the same human identity.
    phone.setLocalUser({ user_id: 'p1', name: 'Thorin' });
    laptop.setLocalUser({ user_id: 'p1', name: 'Thorin' });

    const NOW = 2_000_000;
    // Both devices write the SAME user key; Y.Map resolves LWW per key, and
    // the winner's segment list is counted exactly once.
    phone.publishSpeech('p1', 'Thorin', [{ s: NOW - 10_000, e: NOW - 9_000 }]);
    laptop.publishSpeech('p1', 'Thorin', [{ s: NOW - 5_000, e: NOW - 4_000 }]);

    const ledger = phone.getSpeechLedger();
    expect(ledger.filter((e) => e.user_id === 'p1')).toHaveLength(1);
    expect(ledger.find((e) => e.user_id === 'p1')!.segments.length).toBeLessThanOrEqual(1);
  });

  it('fires observers immediately and on remote publications, converging views', () => {
    const a = makeClient();
    const b = makeClient();
    pairClients(a, b);

    const seenB: SpotlightView[] = [];
    b.observeSpotlight((v) => seenB.push(v));

    // Wall-clock anchored: getSpotlightView() defaults to Date.now(), so the
    // published burst must sit inside its sliding window.
    const NOW = Date.now();
    a.setLocalUser({ user_id: 'gm', name: 'GM' });
    a.publishSpeech('gm', 'GM', [{ s: NOW - 20_000, e: NOW - 10_000 }]);

    // Immediate fire happened at subscribe time (empty), then the merged
    // remote write produced one non-empty view on B.
    expect(seenB[0].shares).toEqual([]);
    const latest = seenB[seenB.length - 1];
    expect(latest.shares.map((w) => w.userId)).toEqual(['gm']);
    expect(latest.shares[0].share).toBe(1);
  });

  it('keeps the ledger honest against tampered room data', () => {
    const c = makeClient();
    const doc = (c as unknown as { doc: Y.Doc }).doc;
    doc.getMap('speech').set('user:forged', { user_id: '', name: 'x', segments: 'junk' });
    doc.getMap('speech').set('user:weird', { user_id: 'u9', name: '', segments: [{ s: 'a' }, { s: 1, e: 2 }] });

    const NOW = 100;
    const view = c.getSpotlightView(NOW);
    // Blank-user entry rejected; blank display name degrades to the id; junk
    // segments sanitized down to the one valid range.
    expect(view.shares).toHaveLength(1);
    expect(view.shares[0].userId).toBe('u9');
    expect(view.shares[0].name).toBe('u9');
  });

  it('caps a hostile peer at the weight ceiling so it cannot own normalization', () => {
    const victim = makeClient();
    const poisoner = makeClient();
    pairClients(victim, poisoner);

    const NOW = Date.now();
    poisoner.setLocalUser({ user_id: 'mallory', name: 'Mallory' });
    victim.setLocalUser({ user_id: 'honest', name: 'Honest' });

    // Mallory publishes a wall of clamped bursts spread across the window —
    // the most damage a single key can legally carry after sanitizeSegments —
    // while the honest peer spoke only ~100 fresh seconds.
    const flood = Array.from({ length: 5 }, (_, i) => ({
      s: NOW - (i + 1) * 120_000 + 1_000,
      e: NOW - (i + 1) * 120_000 + 120_000,
    }));
    poisoner.publishSpeech('mallory', 'Mallory', flood);
    victim.publishSpeech('honest', 'Honest', [{ s: NOW - 105_000, e: NOW - 5_000 }]);

    const view = victim.getSpotlightView(NOW);
    const honest = view.shares.find((w) => w.userId === 'honest');
    const evil = view.shares.find((w) => w.userId === 'mallory');
    expect(honest).toBeDefined();
    expect(evil).toBeDefined();
    // The flooder is pinned at the ceiling (default half-life still leaves
    // the packed bursts above it) while the honest peer's ~100 fresh seconds
    // land just below — the point is the CEILING, not a rank flip: without
    // it, Mallory's raw flood would be far larger.
    expect(evil!.weightedSeconds).toBe(150); // exactly windowMs × factor / 1000
    expect(evil!.weightedSeconds).toBeGreaterThanOrEqual(honest!.weightedSeconds);
    // But the honest speaker's weight equals their un-capped decayed time:
    const uncapped = computeSpotlightWeights(
      [{ user_id: 'honest', name: 'Honest', segments: [{ s: NOW - 105_000, e: NOW - 5_000 }] }],
      { nowMs: NOW },
    );
    expect(honest!.weightedSeconds).toBe(uncapped[0].weightedSeconds);
    // And the flooder's weighted seconds cannot exceed the documented ceiling.
    expect(evil!.weightedSeconds).toBeLessThanOrEqual(
      (DEFAULT_WINDOW_MS * SPOTLIGHT_WEIGHT_WINDOW_FACTOR) / 1000
    );
  });
});

describe('YjsCrdtClient publishSpeech identity binding (audit A2 #4)', () => {
  const clients: YjsCrdtClient[] = [];

  afterEach(() => {
    while (clients.length) clients.pop()?.destroy();
    vi.restoreAllMocks();
  });

  const makeClient = (): YjsCrdtClient => {
    const client = new YjsCrdtClient('', 'test-room');
    clients.push(client);
    return client;
  };

  it('rejects writes under a key that does not match the bound identity', () => {
    const c = makeClient();
    c.setLocalUser({ user_id: 'alice', name: 'Alice' });
    expect(() => c.publishSpeech('bob', 'Bob', [{ s: 1, e: 2 }])).toThrow(/bound identity/);
    // Nothing landed in the ledger under the foreign key.
    expect(c.getSpeechLedger()).toHaveLength(0);
  });

  it('accepts writes only under its own bound key', () => {
    const c = makeClient();
    c.setLocalUser({ user_id: 'alice', name: 'Alice' });
    c.publishSpeech('alice', 'Alice', [{ s: Date.now() - 5_000, e: Date.now() - 1_000 }]);
    expect(c.getSpeechLedger()).toHaveLength(1);
    expect(c.getSpeechLedger()[0].user_id).toBe('alice');
  });

  it('never lets a caller publish under an empty or unbound identity', () => {
    const c = makeClient(); // setLocalUser never called → no identity bound
    expect(() => c.publishSpeech('anyone', 'X', [])).toThrow(/bound identity/);
    c.setLocalUser({ user_id: 'alice', name: 'Alice' });
    // Bound now, but the userId argument must still MATCH it exactly.
    expect(() => c.publishSpeech('', 'X', [])).toThrow(/bound identity/);
    expect(c.getSpeechLedger()).toHaveLength(0);
  });

  it('refuses to publish when the bound identity CHANGES mid-session to something else', () => {
    const c = makeClient();
    c.setLocalUser({ user_id: 'alice', name: 'Alice' });
    c.setLocalUser({ user_id: 'carol', name: 'Carol' }); // re-login as Carol
    // Alice's stale key is no longer ours; publishing as her must fail.
    expect(() => c.publishSpeech('alice', 'Alice', [])).toThrow(/bound identity/);
    c.publishSpeech('carol', 'Carol', []);
    expect(c.getSpeechLedger().map((e) => e.user_id)).toEqual(['carol']);
  });

  it('does not mutate shared state on a rejected cross-user write (no partial entry)', () => {
    const a = makeClient();
    const b = makeClient();
    pairClients(a, b);
    a.setLocalUser({ user_id: 'a', name: 'A' });
    b.setLocalUser({ user_id: 'b', name: 'B' });

    b.publishSpeech('b', 'B', [{ s: Date.now() - 5_000, e: Date.now() - 1_000 }]);
    // A malicious call from B's replica targeting A's key is rejected before
    // any CRDT write happens, so nothing propagates to A.
    expect(() => b.publishSpeech('a', 'A-impersonated', [{ s: 1, e: 999_999 }])).toThrow();
    expect(a.getSpeechLedger().map((e) => e.user_id)).toEqual(['b']);
  });
});
