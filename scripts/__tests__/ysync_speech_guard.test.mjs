/**
 * Relay-side speech-map authorization tests (audit A2 finding #4; hardened
 * for audit A3 finding #3).
 *
 * The relay is the only component that KNOWS which user_id an authenticated
 * connection belongs to (it HMAC-verifies the gateway token on upgrade and
 * reads the `user_id` claim). These tests exercise the guard's core against
 * real Y.Docs the same way the live relay uses it:
 *
 *   - inspectSpeechWrites decodes raw deltas into speech keys touched,
 *   - foreignSpeechKeys gates each touched key on the DELIVERING
 *     CONNECTION's HMAC-verified user_id — struct clientIDs are
 *     attacker-chosen and are NOT an authorization input (audit A3 #3),
 *   - checkUpdate evicts foreign speech writes and emits corrective updates
 *     that repair replicas which already merged them.
 *
 * Threat model covered: a peer writing speech segments under ANOTHER user's
 * key gets its write evicted on every replica, even when its structs claim
 * the victim's clientID or replay raw frames.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SPEECH_MAP_NAME,
  SPEECH_KEY_PREFIX,
  inspectSpeechWrites,
  foreignSpeechKeys,
  evictForeignSpeechEntries,
  installSpeechGuard,
} from '../ysync_speech_guard.mjs';

/** Build an encoded update writing one speech key from a throwaway doc. */
function writeSpeech(key, value, clientId) {
  const d = new Y.Doc();
  if (clientId !== undefined) d.clientID = clientId;
  const map = d.getMap(SPEECH_MAP_NAME);
  if (value === undefined) map.delete(key);
  else map.set(key, value);
  return { update: Y.encodeStateAsUpdate(d), clientId: d.clientID };
}

describe('inspectSpeechWrites', () => {
  it('returns the writer clientID and claimed owner of a speech write', () => {
    const { update, clientId } = writeSpeech('user:alice', { user_id: 'alice' });
    const info = inspectSpeechWrites(update);
    expect(info.writers).toEqual([clientId]);
    expect(info.owners).toEqual(['alice']);
  });

  it('ignores non-speech maps and non-user-prefixed keys', () => {
    const tokens = new Y.Doc();
    tokens.getMap('tokens').set('t1', { x: 1 });
    const misc = new Y.Doc();
    misc.getMap(SPEECH_MAP_NAME).set('current', { x: 1 });
    const fog = new Y.Doc();
    fog.getMap('fog').set('user:alice', new Uint8Array([1]));
    for (const d of [tokens, misc, fog]) {
      const info = inspectSpeechWrites(Y.encodeStateAsUpdate(d));
      expect(info.owners).toEqual([]);
      expect(info.writers.length).toBeGreaterThan(0); // still attributed
    }
  });

  it('survives malformed or truncated updates without throwing', () => {
    expect(() => inspectSpeechWrites(new Uint8Array([0x00]))).not.toThrow();
    expect(() => inspectSpeechWrites(new Uint8Array(0))).not.toThrow();
    expect(inspectSpeechWrites(new Uint8Array(0))).toEqual({ writers: [], owners: [] });
  });

  it('collects every writer when several clients ride one merged delta', () => {
    const a = writeSpeech('user:alice', {});
    const b = writeSpeech('user:bob', {});
    const merged = Y.mergeUpdates([a.update, b.update]);
    const info = inspectSpeechWrites(merged);
    expect(info.owners.sort()).toEqual(['alice', 'bob']);
    expect(info.writers.sort()).toEqual([a.clientId, b.clientId].sort());
  });
});

describe('foreignSpeechKeys (pure decision)', () => {
  it('passes a write whose delivering connection IS the key owner', () => {
    expect(foreignSpeechKeys(['alice'], 'alice')).toEqual([]);
  });

  it('rejects every touched owner when the sender cannot be resolved — fail closed', () => {
    expect(foreignSpeechKeys(['alice'], null)).toEqual(['alice']);
    expect(foreignSpeechKeys(['alice'], undefined)).toEqual(['alice']);
  });

  it('rejects a sender verified as a DIFFERENT user', () => {
    expect(foreignSpeechKeys(['alice'], 'mallory')).toEqual(['alice']);
  });

  it('does NOT consult struct clientIDs at all (audit A3 finding #3)', () => {
    // The decision takes exactly two inputs: touched owners and the verified
    // sending identity. This is the regression pin for the spoofable-clientID
    // hole.
    expect(foreignSpeechKeys.length).toBe(2); // (touchedOwners, senderUserId)
    expect(foreignSpeechKeys(['alice'], 'mallory')).toEqual(['alice']);
  });

  it('is safe on empty input', () => {
    expect(foreignSpeechKeys([], null)).toEqual([]);
    expect(foreignSpeechKeys([], 'alice')).toEqual([]);
  });
});

describe('evictForeignSpeechEntries (post-commit repair)', () => {
  it('deletes foreign speech keys from the room doc and reports them', () => {
    const room = new Y.Doc();
    room.getMap(SPEECH_MAP_NAME).set(`user:alice`, { user_id: 'alice', segments: [] });
    room.getMap(SPEECH_MAP_NAME).set(`user:mallory`, { user_id: 'mallory', segments: [] });
    room.getMap('tokens').set('t1', { x: 1 }); // untouched

    const evicted = evictForeignSpeechEntries(room, ['mallory']);
    expect(evicted).toBe(1);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual(['user:alice']);
    expect(Array.from(room.getMap('tokens').keys())).toEqual(['t1']);
  });

  it('emits a corrective update that repairs replicas that already synced the poison', () => {
    const poison = writeSpeech('user:mallory', { user_id: 'mallory', segments: [{ s: 0, e: 120000 }] }).update;
    // A replica swallowed the poisoned frame before the relay could act.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, poison);
    expect(Array.from(replica.getMap(SPEECH_MAP_NAME).keys())).toEqual(['user:mallory']);

    const room = new Y.Doc();
    Y.applyUpdate(room, poison);
    const corrections = [];
    room.on('update', (u) => corrections.push(u));
    evictForeignSpeechEntries(room, ['mallory']);

    Y.applyUpdate(replica, Y.mergeUpdates(corrections));
    expect(Array.from(replica.getMap(SPEECH_MAP_NAME).keys())).toEqual([]);
  });

  it('keeps the eviction durable: replaying the identical poisoned frame does nothing', () => {
    const poison = writeSpeech('user:mallory', { v: 2 }).update;
    const room = new Y.Doc();
    Y.applyUpdate(room, poison);
    evictForeignSpeechEntries(room, ['mallory']);
    // Attacker replays the exact same raw frame.
    Y.applyUpdate(room, poison);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual([]);
  });
});

describe('installSpeechGuard (relay wiring)', () => {
  function makeRoom() {
    const room = new Y.Doc();
    // Origin -> HMAC-verified user_id, mirroring the live relay's connIdentity
    // registry in scripts/ysync-server.mjs (populated from the token at
    // upgrade time).
    const usersByOrigin = new Map([
      ['conn-alice', 'alice'],
      ['conn-bob', 'bob'],
      ['conn-mallory', 'mallory'],
    ]);
    const guard = installSpeechGuard(room, {
      userOfConnection: (origin) => usersByOrigin.get(origin) ?? null,
    });
    // Mirrors the live relay wiring: only remote updates (non-null origin)
    // are checked.
    room.on('update', (u, origin) => {
      if (origin == null) return;
      guard.checkUpdate(u, origin);
    });
    return { room, guard };
  }

  it('lets a peer publish under its OWN verified identity (fresh clientID, no binding step)', () => {
    const { room, guard } = makeRoom();
    const honest = new Y.Doc();
    honest.getMap(SPEECH_MAP_NAME).set('user:alice', { user_id: 'alice', name: 'A', segments: [] });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(honest), 'conn-alice');
    expect(guard.evictions).toBe(0);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual(['user:alice']);
  });

  it('evicts and counts a foreign-key write arriving over another peer’s connection', () => {
    const { room, guard } = makeRoom();
    const mallory = new Y.Doc();
    // Mallory is verified as mallory but writes under bob's key.
    mallory.getMap(SPEECH_MAP_NAME).set('user:bob', { user_id: 'bob', name: 'B', segments: [] });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(mallory), 'conn-mallory');
    expect(guard.evictions).toBe(1);
    expect(guard.evictedKeys).toEqual(['bob']);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual([]);
  });

  it('F-A3#3: evicts a delta whose structs claim the VICTIM\'s clientID over the attacker\'s connection', () => {
    const { room, guard } = makeRoom();
    // Alice publishes once over her own connection so any clientID-label
    // scheme would have this id bound as 'alice'.
    const aliceDoc = new Y.Doc({ gc: false });
    aliceDoc.clientID = 424242;
    aliceDoc.getMap(SPEECH_MAP_NAME).set('user:alice', { user_id: 'alice', segments: [] });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(aliceDoc), 'conn-alice');
    expect(guard.evictions).toBe(0);

    // Mallory forges ALICE'S identity: same clientID, and a clock high enough
    // to WIN last-writer-wins on the shared item.
    const d = new Y.Doc();
    d.clientID = aliceDoc.clientID;
    const noise = d.getMap('noise');
    for (let i = 0; i <= 50; i++) noise.set(`n${i}`, i);
    d.getMap(SPEECH_MAP_NAME).set('user:alice', {
      user_id: 'alice',
      segments: [{ s: 0, e: 9_999_000 }],
    });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(d), 'conn-mallory');

    // The forged frame is structurally genuine: its structs really do claim
    // alice's clientID and really do touch HER ledger key. Eviction is
    // synchronous inside applyUpdate, so the inflated value is never
    // observable AFTER the call — this decoding step is what proves the
    // attack frame itself (not just a rejected no-op) was processed.
    const decodedFrame = inspectSpeechWrites(Y.encodeStateAsUpdate(d));
    expect(decodedFrame.writers).toContain(aliceDoc.clientID);
    expect(decodedFrame.owners).toEqual(['alice']);

    expect(guard.evictions).toBe(1);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual([]);
  });

  it('F-A3#3: a verified user may use ANY clientID with no prior binding (no false positives)', () => {
    const { room, guard } = makeRoom();
    // Bob's second device picked some fresh random clientID — nothing bound
    // anywhere — and still publishes his own ledger successfully.
    const fresh = writeSpeech(
      'user:bob',
      { user_id: 'bob', name: 'B2', segments: [] },
      987654321,
    );
    Y.applyUpdate(room, fresh.update, 'conn-bob');
    expect(guard.evictions).toBe(0);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual(['user:bob']);
  });

  it('repairs peers that received the poison before the eviction landed', () => {
    const { room, guard } = makeRoom();
    const poison = writeSpeech('user:bob', { user_id: 'bob', name: 'B', segments: [{ s: 0, e: 120000 }] }).update;
    const earlyPeer = new Y.Doc();
    Y.applyUpdate(earlyPeer, poison); // got it straight from the attacker

    const corrections = [];
    room.on('update', (u) => corrections.push(u));
    Y.applyUpdate(room, poison, 'conn-mallory');

    Y.applyUpdate(earlyPeer, Y.mergeUpdates(corrections));
    expect(Array.from(earlyPeer.getMap(SPEECH_MAP_NAME).keys())).toEqual([]);
  });

  it('fails closed: an unresolvable connection cannot write any speech key', () => {
    const { room, guard } = makeRoom();
    const ghost = new Y.Doc(); // no registered identity for this origin
    ghost.getMap(SPEECH_MAP_NAME).set('user:someone', { user_id: 'someone', segments: [] });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(ghost), 'conn-unknown');
    expect(guard.evictions).toBe(1);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual([]);
  });

  it('does not interfere with token, fog, or atmosphere traffic', () => {
    const { room, guard } = makeRoom();
    const other = new Y.Doc();
    other.getMap('tokens').set('t1', { x: 1 });
    other.getMap('fog').set('user:bob', new Uint8Array([7]));
    other.getMap('atmosphere').set('current', { id: 'tavern' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(other), 'conn-bob');
    expect(guard.evictions).toBe(0);
    expect(Array.from(room.getMap('tokens').keys())).toEqual(['t1']);
    expect(Array.from(room.getMap('fog').keys())).toEqual(['user:bob']);
  });

  it('handles several users publishing their own keys concurrently in one room', () => {
    const { room, guard } = makeRoom();
    const aliceDoc = new Y.Doc();
    const bobDoc = new Y.Doc();
    aliceDoc.getMap(SPEECH_MAP_NAME).set('user:alice', { user_id: 'alice', segments: [] });
    bobDoc.getMap(SPEECH_MAP_NAME).set('user:bob', { user_id: 'bob', segments: [] });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(aliceDoc), 'conn-alice');
    Y.applyUpdate(room, Y.encodeStateAsUpdate(bobDoc), 'conn-bob');
    expect(guard.evictions).toBe(0);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys()).sort()).toEqual([
      'user:alice',
      'user:bob',
    ]);
  });

  it('reports every eviction to the amplifier accounting hook (audit A3 #4)', () => {
    const room = new Y.Doc();
    const reported = [];
    const users = new Map([
      ['conn-alice', 'alice'],
      ['conn-mallory', 'mallory'],
    ]);
    const guard = installSpeechGuard(room, {
      userOfConnection: (origin) => users.get(origin) ?? null,
      onUnauthorizedWrite: (origin) => reported.push(origin),
    });
    room.on('update', (u, origin) => {
      if (origin == null) return;
      guard.checkUpdate(u, origin);
    });
    const a = writeSpeech('user:bob', { v: 1 }, 11).update;
    const b = writeSpeech('user:bob', { v: 2 }, 12).update;
    Y.applyUpdate(room, a, 'conn-mallory');
    Y.applyUpdate(room, b, 'conn-mallory');
    expect(reported).toEqual(['conn-mallory', 'conn-mallory']);
    // Legitimate own-key traffic never trips the hook.
    const ok = writeSpeech('user:alice', { v: 3 }, 13).update;
    Y.applyUpdate(room, ok, 'conn-alice');
    expect(reported).toEqual(['conn-mallory', 'conn-mallory']);
  });
});

// The prefix constant is load-bearing for the fog-layer convention; pin it so
// a refactor cannot silently change the wire format.
describe('wire conventions', () => {
  it('pins the speech map name and key prefix', () => {
    expect(SPEECH_MAP_NAME).toBe('speech');
    expect(SPEECH_KEY_PREFIX).toBe('user:');
  });

  it('exposes no test-only surface in production code', () => {
    // The guard's public surface is inspect/decision/check/evict only.
    expect(inspectSpeechWrites).toBeTypeOf('function');
    expect(foreignSpeechKeys).toBeTypeOf('function');
    expect(installSpeechGuard).toBeTypeOf('function');
  });
});
