/**
 * Relay-side table-atmosphere authorization tests (loop-1 iteration 63 defect:
 * "No atmosphere write policy at the relay").
 *
 * The room-wide atmosphere preset lives under ONE Y.Map key ('current') inside
 * every room doc's 'atmosphere' map (client/src/sync/yjs_doc_client.ts,
 * ATMOSPHERE_KEY). GOALS.md Pillar 2 assigns theme selection to the HOST, so
 * only GM/admin-authenticated peers may write it; players and spectators are
 * read-only consumers. Before this guard the relay accepted the write from ANY
 * role (the old yjs_doc_client POLICY NOTE said exactly that).
 *
 * These tests exercise the guard against real Y.Docs the same way the live
 * relay wires it:
 *   - inspectAtmosphereWrites decodes raw deltas into writing clientIDs +
 *     atmosphere keys touched,
 *   - bindClaim binds clientID -> verified role only for non-spoofed claims,
 *   - checkUpdate evicts non-GM atmosphere writes and emits corrective updates
 *     that repair replicas which already merged them.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ATMOSPHERE_KEY,
  ATMOSPHERE_MAP_NAME,
  isAtmosphereWriterRole,
  inspectAtmosphereWrites,
  unauthorizedAtmosphereWrites,
  evictUnauthorizedAtmosphereEntries,
  installAtmosphereGuard,
} from '../ysync_atmosphere_guard.mjs';

/** Build an encoded update writing one atmosphere key from a throwaway doc. */
function writeAtmosphere(key = ATMOSPHERE_KEY, value = { id: 'gothic-horror' }) {
  const d = new Y.Doc();
  d.getMap(ATMOSPHERE_MAP_NAME).set(key, value);
  return { update: Y.encodeStateAsUpdate(d), clientId: d.clientID };
}

describe('inspectAtmosphereWrites', () => {
  it('returns the writer clientID and the atmosphere keys a delta touches', () => {
    const { update, clientId } = writeAtmosphere();
    const info = inspectAtmosphereWrites(update);
    expect(info.writers).toEqual([clientId]);
    expect(info.keys).toEqual([ATMOSPHERE_KEY]);
  });

  it('ignores token, fog, and speech traffic entirely', () => {
    const tokens = new Y.Doc();
    tokens.getMap('tokens').set('t1', { x: 1 });
    const fog = new Y.Doc();
    fog.getMap('fog').set('user:alice', new Uint8Array([1]));
    const speech = new Y.Doc();
    speech.getMap('speech').set('user:alice', { segments: [] });
    for (const d of [tokens, fog, speech]) {
      const info = inspectAtmosphereWrites(Y.encodeStateAsUpdate(d));
      expect(info.keys).toEqual([]);
      expect(info.writers.length).toBeGreaterThan(0); // still attributable
    }
  });

  it('survives malformed or truncated updates without throwing', () => {
    expect(() => inspectAtmosphereWrites(new Uint8Array([0x00]))).not.toThrow();
    expect(inspectAtmosphereWrites(new Uint8Array(0))).toEqual({ writers: [], keys: [] });
  });

  it('collects every writer and key across one merged delta', () => {
    const a = writeAtmosphere(ATMOSPHERE_KEY, { id: 'a' });
    const b = writeAtmosphere('rogue-key', { id: 'b' });
    const merged = Y.mergeUpdates([a.update, b.update]);
    const info = inspectAtmosphereWrites(merged);
    expect(info.keys.sort()).toEqual([ATMOSPHERE_KEY, 'rogue-key'].sort());
    expect(info.writers.sort()).toEqual([a.clientId, b.clientId].sort());
  });
});

describe('unauthorizedAtmosphereWrites (pure decision)', () => {
  it('passes a write whose writer holds a host role', () => {
    expect(unauthorizedAtmosphereWrites([101], [ATMOSPHERE_KEY], () => 'gm')).toEqual([]);
    expect(unauthorizedAtmosphereWrites([102], [ATMOSPHERE_KEY], () => 'admin')).toEqual([]);
  });

  it('flags player and spectator writers', () => {
    expect(unauthorizedAtmosphereWrites([201], [ATMOSPHERE_KEY], () => 'player')).toEqual([
      ATMOSPHERE_KEY,
    ]);
    expect(unauthorizedAtmosphereWrites([202], [ATMOSPHERE_KEY], () => 'spectator')).toEqual([
      ATMOSPHERE_KEY,
    ]);
  });

  it('fails closed on an unattributed writer (no validated awareness claim)', () => {
    expect(unauthorizedAtmosphereWrites([999], [ATMOSPHERE_KEY], () => null)).toEqual([
      ATMOSPHERE_KEY,
    ]);
  });

  it('accepts when ANY riding writer of a merged delta is a host', () => {
    // One delta carrying structs from a player AND the GM who legitimately
    // changed the theme stays legitimate.
    expect(
      unauthorizedAtmosphereWrites([301, 302], [ATMOSPHERE_KEY], (id) =>
        id === 301 ? 'player' : 'gm'
      )
    ).toEqual([]);
  });

  it('is safe on empty input', () => {
    expect(unauthorizedAtmosphereWrites([], [], () => 'gm')).toEqual([]);
  });
});

describe('isAtmosphereWriterRole', () => {
  it('grants hosts and denies everyone else', () => {
    expect(isAtmosphereWriterRole('gm')).toBe(true);
    expect(isAtmosphereWriterRole('admin')).toBe(true);
    expect(isAtmosphereWriterRole('player')).toBe(false);
    expect(isAtmosphereWriterRole('spectator')).toBe(false);
    expect(isAtmosphereWriterRole(null)).toBe(false);
    expect(isAtmosphereWriterRole(undefined)).toBe(false);
  });
});

describe('evictUnauthorizedAtmosphereEntries (post-commit repair)', () => {
  it('deletes unauthorized atmosphere keys from the room doc and reports them', () => {
    const room = new Y.Doc();
    room.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'poisoned' });
    room.getMap('tokens').set('t1', { x: 1 }); // must stay untouched

    const evicted = evictUnauthorizedAtmosphereEntries(room, [ATMOSPHERE_KEY]);
    expect(evicted).toBe(1);
    expect(Array.from(room.getMap(ATMOSPHERE_MAP_NAME).keys())).toEqual([]);
    expect(Array.from(room.getMap('tokens').keys())).toEqual(['t1']);
  });

  it('emits a corrective update repairing replicas that already synced the poison', () => {
    const poison = writeAtmosphere().update;
    const replica = new Y.Doc();
    Y.applyUpdate(replica, poison);
    expect(replica.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toBeDefined();

    const room = new Y.Doc();
    Y.applyUpdate(room, poison);
    const corrections = [];
    room.on('update', (u) => corrections.push(u));
    evictUnauthorizedAtmosphereEntries(room, [ATMOSPHERE_KEY]);

    Y.applyUpdate(replica, Y.mergeUpdates(corrections));
    expect(replica.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toBeUndefined();
  });

  it('is a no-op on an empty eviction list', () => {
    const room = new Y.Doc();
    room.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'legit' });
    expect(evictUnauthorizedAtmosphereEntries(room, [])).toBe(0);
    expect(room.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toBeDefined();
  });
});

describe('installAtmosphereGuard (relay wiring)', () => {
  function makeRoom() {
    const room = new Y.Doc();
    // Origin -> HMAC-verified role, mirroring the live relay's connection
    // registry in scripts/ysync-server.mjs.
    const roleByOrigin = new Map([
      ['conn-gm', 'gm'],
      ['conn-admin', 'admin'],
      ['conn-player', 'player'],
      ['conn-spec', 'spectator'],
      ['conn-ghost', null],
    ]);
    const guard = installAtmosphereGuard(room, {
      roleOfConnection: (origin) => roleByOrigin.get(origin) ?? null,
    });
    // Mirrors the live relay wiring: only remote updates (non-null
    // transaction origin, y-websocket's conn object) are checked. The guard's
    // own corrective transactions have a null origin and must never be
    // re-checked — see checkUpdate's WIRING CONTRACT.
    room.on('update', (u, origin) => {
      if (origin == null) return;
      guard.checkUpdate(u, origin);
    });
    return { room, guard };
  }

  it('lets a GM peer publish the room-wide preset', () => {
    const { room, guard } = makeRoom();
    const gmDoc = new Y.Doc();
    guard.bindClaim('gm-1', 'gm', gmDoc.clientID, 'gm-1');
    gmDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'eldritch-mystery' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(gmDoc), 'conn-gm');
    expect(guard.evictions).toBe(0);
    expect(room.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toMatchObject({
      id: 'eldritch-mystery',
    });
  });

  it('evicts a player attempt to rewrite shared atmosphere state', () => {
    const { room, guard } = makeRoom();
    const playerDoc = new Y.Doc();
    guard.bindClaim('p-1', 'player', playerDoc.clientID, 'p-1');
    playerDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'clown-fiesta' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(playerDoc), 'conn-player');
    expect(guard.evictions).toBe(1);
    expect(guard.evictedKeys).toEqual([ATMOSPHERE_KEY]);
    expect(room.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toBeUndefined();
  });

  it('evicts a spectator write identically to a player write', () => {
    const { room, guard } = makeRoom();
    const specDoc = new Y.Doc();
    guard.bindClaim('s-1', 'spectator', specDoc.clientID, 's-1');
    specDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'spectator-theme' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(specDoc), 'conn-spec');
    expect(guard.evictions).toBe(1);
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });

  it('binds a clientID to the verified role ONLY when the awareness claim matches the verified identity', () => {
    const { room, guard } = makeRoom();
    const spoofed = new Y.Doc();
    // Mallory's connection is VERIFIED as mallory/player but CLAIMS gm-1.
    expect(guard.bindClaim('mallory', 'player', spoofed.clientID, 'gm-1')).toBe(false);
    void room;
  });

  it('repairs peers that received the poisoned frame before eviction landed', () => {
    const { room, guard } = makeRoom();
    const poison = writeAtmosphere().update;
    const earlyPeer = new Y.Doc();
    Y.applyUpdate(earlyPeer, poison);

    const corrections = [];
    room.on('update', (u) => corrections.push(u));
    Y.applyUpdate(room, poison, 'conn-player');
    guard.checkUpdate(poison);

    Y.applyUpdate(earlyPeer, Y.mergeUpdates(corrections));
    expect(earlyPeer.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toBeUndefined();
  });

  it('fails closed: a writer with no validated awareness claim cannot write atmosphere', () => {
    const { room, guard } = makeRoom();
    const ghost = new Y.Doc(); // never sent a validated awareness claim
    ghost.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'ghost-theme' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(ghost), 'conn-unknown');
    expect(guard.evictions).toBe(1);
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });

  it('does not interfere with player speech, token, or fog traffic', () => {
    const { room, guard } = makeRoom();
    const playerDoc = new Y.Doc();
    guard.bindClaim('p-1', 'player', playerDoc.clientID, 'p-1');
    playerDoc.getMap('speech').set('user:p-1', { segments: [] });
    playerDoc.getMap('tokens').set('t1', { x: 5 });
    playerDoc.getMap('fog').set('fog:p-1', new Uint8Array([3]));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(playerDoc), 'conn-player');
    expect(guard.evictions).toBe(0);
    expect(Array.from(room.getMap('speech').keys())).toEqual(['user:p-1']);
    expect(Array.from(room.getMap('tokens').keys())).toEqual(['t1']);
    expect(Array.from(room.getMap('fog').keys())).toEqual(['fog:p-1']);
  });

  it('keeps a GM write durable while a later player overwrite is reverted', () => {
    const { room, guard } = makeRoom();
    const gmDoc = new Y.Doc();
    guard.bindClaim('gm-1', 'gm', gmDoc.clientID, 'gm-1');
    gmDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'high-fantasy' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(gmDoc), 'conn-gm');

    const playerDoc = new Y.Doc();
    guard.bindClaim('p-1', 'player', playerDoc.clientID, 'p-1');
    playerDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'hijacked' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(playerDoc), 'conn-player');

    expect(guard.evictions).toBe(1);
    // Reverted to the last host-authored value, not blanked — eviction must
    // not hand an attacker a denial-of-service on the table's atmosphere.
    expect(room.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toMatchObject({
      id: 'high-fantasy',
    });
  });

  it('reverts a player attempt to DELETE the shared selection', () => {
    const { room, guard } = makeRoom();
    const gmDoc = new Y.Doc();
    guard.bindClaim('gm-1', 'gm', gmDoc.clientID, 'gm-1');
    gmDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'eldritch-mystery' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(gmDoc), 'conn-gm');

    // Deletions ride the delete-set with no struct authorship, so this is
    // authorized via the SENDING CONNECTION's verified role.
    const playerDoc = new Y.Doc();
    guard.bindClaim('p-1', 'player', playerDoc.clientID, 'p-1');
    Y.applyUpdate(playerDoc, Y.encodeStateAsUpdate(gmDoc));
    playerDoc.getMap(ATMOSPHERE_MAP_NAME).delete(ATMOSPHERE_KEY);
    Y.applyUpdate(
      room,
      Y.encodeStateAsUpdate(playerDoc, Y.encodeStateVector(gmDoc)),
      'conn-player'
    );

    expect(guard.evictions).toBe(1);
    expect(room.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toMatchObject({
      id: 'eldritch-mystery',
    });
  });

  it('does not resurrect poison when a hijack has no legitimate predecessor', () => {
    const { room, guard } = makeRoom();
    const ghost = new Y.Doc(); // unattributed first write — nothing to revert to
    ghost.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'ghost-theme' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(ghost), 'conn-unknown');
    expect(guard.evictions).toBe(1);
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });

  it('stops reverting once a host legitimately clears the key', () => {
    const { room, guard } = makeRoom();
    const gmDoc = new Y.Doc();
    guard.bindClaim('gm-1', 'gm', gmDoc.clientID, 'gm-1');
    gmDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'gothic-horror' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(gmDoc), 'conn-gm');
    // Host deliberately clears the selection (the clearing doc must carry the
    // original item first so its update encodes a real tombstone).
    const clearDoc = new Y.Doc();
    guard.bindClaim('gm-1', 'gm', clearDoc.clientID, 'gm-1');
    Y.applyUpdate(clearDoc, Y.encodeStateAsUpdate(gmDoc));
    clearDoc.getMap(ATMOSPHERE_MAP_NAME).delete(ATMOSPHERE_KEY);
    Y.applyUpdate(
      room,
      Y.encodeStateAsUpdate(clearDoc, Y.encodeStateVector(gmDoc)),
      'conn-gm'
    );
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);

    // A later hijack stays cleared instead of restoring the stale preset.
    const playerDoc = new Y.Doc();
    guard.bindClaim('p-1', 'player', playerDoc.clientID, 'p-1');
    playerDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'hijacked' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(playerDoc), 'conn-player');
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });
});

// The map name and key are load-bearing wire contracts shared with
// client/src/sync/yjs_doc_client.ts; pin them so a refactor cannot silently
// desynchronize the two ends.
describe('wire conventions', () => {
  it('pins the atmosphere map name and shared key', () => {
    expect(ATMOSPHERE_MAP_NAME).toBe('atmosphere');
    expect(ATMOSPHERE_KEY).toBe('current');
  });
});
