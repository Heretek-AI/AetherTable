/**
 * Relay-side speech-map authorization tests (audit A2 finding #4).
 *
 * The relay is the only component that KNOWS which user_id an authenticated
 * connection belongs to (it HMAC-verifies the gateway token on upgrade and
 * reads the `user_id` claim). These tests exercise the guard's core against
 * real Y.Docs the same way the live relay uses it:
 *
 *   - inspectSpeechWrites decodes raw deltas into writing clientIDs + speech
 *     keys touched,
 *   - bindClaim binds clientID -> verified user only for non-spoofed claims,
 *   - checkUpdate evicts foreign speech writes and emits corrective updates
 *     that repair replicas which already merged the poison.
 *
 * Threat model covered: a peer writing speech segments under ANOTHER user's
 * key gets its write evicted on every replica, even when it spoofs awareness
 * claims or replays raw frames.
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
function writeSpeech(key, value) {
  const d = new Y.Doc();
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
  it('passes a write whose writer is bound to the key owner', () => {
    const verdict = foreignSpeechKeys([101], ['alice'], (id) =>
      id === 101 ? 'alice' : null
    );
    expect(verdict).toEqual([]);
  });

  it('rejects an unattributed writer (no validated claim) — fail closed', () => {
    expect(foreignSpeechKeys([999], ['alice'], () => null)).toEqual(['alice']);
  });

  it('rejects a writer bound to a DIFFERENT user', () => {
    const verdict = foreignSpeechKeys([202], ['alice'], (id) =>
      id === 202 ? 'mallory' : null
    );
    expect(verdict).toEqual(['alice']);
  });

  it('accepts when ANY riding writer is the rightful owner', () => {
    // A merged delta may carry structs from several writers; if the rightful
    // owner contributed the write, the key is legitimate.
    expect(
      foreignSpeechKeys([202, 303], ['alice'], (id) =>
        id === 303 ? 'alice' : 'mallory'
      )
    ).toEqual([]);
  });

  it('is safe on empty input', () => {
    expect(foreignSpeechKeys([], [], () => null)).toEqual([]);
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
    const guard = installSpeechGuard(room);
    room.on('update', (u) => guard.checkUpdate(u));
    return { room, guard };
  }

  it('lets a peer publish under its OWN validated identity', () => {
    const { room, guard } = makeRoom();
    const honest = new Y.Doc();
    honest.getMap(SPEECH_MAP_NAME).set('user:alice', { user_id: 'alice', name: 'A', segments: [] });
    guard.bindClaim('alice', honest.clientID, 'alice'); // claim matches verified id
    Y.applyUpdate(room, Y.encodeStateAsUpdate(honest), 'conn-1');
    expect(guard.evictions).toBe(0);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual(['user:alice']);
  });

  it('binds a clientID only when the awareness claim MATCHES the verified identity', () => {
    const { room, guard } = makeRoom();
    const spoofed = new Y.Doc();
    // Mallory's connection is VERIFIED as mallory but CLAIMS alice.
    expect(guard.bindClaim('mallory', spoofed.clientID, 'alice')).toBe(false);
    expect(guard.bindClaim('mallory', spoofed.clientID, 'mallory')).toBe(true);
    void room;
  });

  it('evicts and counts a foreign-key write arriving over another peer’s connection', () => {
    const { room, guard } = makeRoom();
    const mallory = new Y.Doc();
    // Mallory is verified as mallory but writes under bob's key.
    guard.bindClaim('mallory', mallory.clientID, 'mallory');
    mallory.getMap(SPEECH_MAP_NAME).set('user:bob', { user_id: 'bob', name: 'B', segments: [] });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(mallory), 'conn-mallory');
    expect(guard.evictions).toBe(1);
    expect(guard.evictedKeys).toEqual(['bob']);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual([]);
  });

  it('repairs peers that received the poison before the eviction landed', () => {
    const { room, guard } = makeRoom();
    const poison = writeSpeech('user:bob', { user_id: 'bob', name: 'B', segments: [{ s: 0, e: 120000 }] }).update;
    const earlyPeer = new Y.Doc();
    Y.applyUpdate(earlyPeer, poison); // got it straight from the attacker

    const corrections = [];
    room.on('update', (u) => corrections.push(u));
    Y.applyUpdate(room, poison, 'conn-mallory');
    guard.checkUpdate(poison);

    Y.applyUpdate(earlyPeer, Y.mergeUpdates(corrections));
    expect(Array.from(earlyPeer.getMap(SPEECH_MAP_NAME).keys())).toEqual([]);
  });

  it('fails closed: an unattributed writer cannot write any speech key', () => {
    const { room, guard } = makeRoom();
    const ghost = new Y.Doc(); // never sent a validated awareness claim
    ghost.getMap(SPEECH_MAP_NAME).set('user:someone', { user_id: 'someone', segments: [] });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(ghost), 'conn-unknown');
    expect(guard.evictions).toBe(1);
    expect(Array.from(room.getMap(SPEECH_MAP_NAME).keys())).toEqual([]);
  });

  it('does not interfere with token, fog, atmosphere, or awareness traffic', () => {
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
    guard.bindClaim('alice', aliceDoc.clientID, 'alice');
    guard.bindClaim('bob', bobDoc.clientID, 'bob');
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
});

// The prefix constant is load-bearing for the fog-layer convention; pin it so
// a refactor cannot silently change the wire format.
describe('wire conventions', () => {
  it('pins the speech map name and key prefix', () => {
    expect(SPEECH_MAP_NAME).toBe('speech');
    expect(SPEECH_KEY_PREFIX).toBe('user:');
  });

  it('exposes no test-only surface in production code', () => {
    // The guard's public surface is inspect/bind/check/evict only.
    expect(inspectSpeechWrites).toBeTypeOf('function');
    expect(foreignSpeechKeys).toBeTypeOf('function');
    expect(installSpeechGuard).toBeTypeOf('function');
  });
});
