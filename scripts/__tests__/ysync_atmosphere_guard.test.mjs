/**
 * Relay-side table-atmosphere authorization tests (loop-1 iteration 63 defect,
 * hardened for audit A3 finding #3).
 *
 * The room-wide atmosphere preset lives under ONE Y.Map key ('current') inside
 * every room doc's 'atmosphere' map (client/src/sync/yjs_doc_client.ts,
 * ATMOSPHERE_KEY). GOALS.md Pillar 2 assigns theme selection to the HOST, so
 * only GM/admin-authenticated peers may write it; players and spectators are
 * read-only consumers.
 *
 * These tests exercise the guard against real Y.Docs the same way the live
 * relay wires it:
 *   - inspectAtmosphereWrites decodes raw deltas into atmosphere keys touched,
 *   - unauthorizedAtmosphereWrites gates every touched key on the DELIVERING
 *     CONNECTION's HMAC-verified role — struct clientIDs are attacker-chosen
 *     and are NOT an authorization input (audit A3 finding #3),
 *   - checkUpdate evicts non-host atmosphere writes and emits corrective
 *     updates that repair replicas which already merged them.
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
function writeAtmosphere(key = ATMOSPHERE_KEY, value = { id: 'gothic-horror' }, clientId) {
  const d = new Y.Doc();
  if (clientId !== undefined) d.clientID = clientId;
  d.getMap(ATMOSPHERE_MAP_NAME).set(key, value);
  return { update: Y.encodeStateAsUpdate(d), clientId: d.clientID };
}

/**
 * Forge an update AS IF written by `victimClientId`, with the local clock
 * advanced past `clockFloor`. This is exactly what audit A3 finding #3
 * describes: clientIDs are attacker-chosen 32-bit values, and a forger must
 * ALSO pick a higher clock than the victim's current item or yjs discards
 * the incoming struct as a duplicate item id instead of letting it win LWW.
 */
function forgeAs(victimClientId, clockFloor, write) {
  const d = new Y.Doc();
  d.clientID = victimClientId;
  const noise = d.getMap('noise');
  for (let i = 0; i <= clockFloor; i++) noise.set(`n${i}`, i);
  write(d);
  return Y.encodeStateAsUpdate(d);
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
  it('passes any touched set when the delivering connection is host-role', () => {
    expect(unauthorizedAtmosphereWrites([ATMOSPHERE_KEY], 'gm')).toEqual([]);
    expect(unauthorizedAtmosphereWrites([ATMOSPHERE_KEY], 'admin')).toEqual([]);
  });

  it('flags every touched key when the delivering connection is player or spectator', () => {
    expect(unauthorizedAtmosphereWrites([ATMOSPHERE_KEY], 'player')).toEqual([
      ATMOSPHERE_KEY,
    ]);
    expect(unauthorizedAtmosphereWrites([ATMOSPHERE_KEY], 'spectator')).toEqual([
      ATMOSPHERE_KEY,
    ]);
  });

  it('fails closed when the delivering connection cannot be resolved', () => {
    expect(unauthorizedAtmosphereWrites([ATMOSPHERE_KEY], null)).toEqual([ATMOSPHERE_KEY]);
    expect(unauthorizedAtmosphereWrites([ATMOSPHERE_KEY], undefined)).toEqual([
      ATMOSPHERE_KEY,
    ]);
  });

  it('does NOT consult struct clientIDs at all (audit A3 finding #3)', () => {
    // A forged GM clientID in the delta's structs changes nothing: the only
    // inputs are the touched keys and the verified sender role. This is the
    // regression pin for the spoofable-clientID hole.
    expect(unauthorizedAtmosphereWrites.length).toBe(2); // (touchedKeys, senderRole)
    expect(unauthorizedAtmosphereWrites(['current'], 'player')).toEqual(['current']);
  });

  it('is safe on empty input', () => {
    expect(unauthorizedAtmosphereWrites([], 'player')).toEqual([]);
    expect(unauthorizedAtmosphereWrites([], null)).toEqual([]);
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
    // Origin -> HMAC-verified role, mirroring the live relay's connIdentity
    // registry in scripts/ysync-server.mjs (populated from the token at
    // upgrade time).
    const roleByOrigin = new Map([
      ['conn-gm', 'gm'],
      ['conn-admin', 'admin'],
      ['conn-player', 'player'],
      ['conn-spec', 'spectator'],
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
    playerDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'clown-fiesta' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(playerDoc), 'conn-player');
    expect(guard.evictions).toBe(1);
    expect(guard.evictedKeys).toEqual([ATMOSPHERE_KEY]);
    expect(room.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toBeUndefined();
  });

  it('evicts a spectator write identically to a player write', () => {
    const { room, guard } = makeRoom();
    const specDoc = new Y.Doc();
    specDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'spectator-theme' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(specDoc), 'conn-spec');
    expect(guard.evictions).toBe(1);
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });

  // ---- audit A3 finding #3: forged clientIDs carry no privilege ----------

  it('F-A3#3: evicts a delta whose structs claim the GM clientID over a player connection', () => {
    const { room, guard } = makeRoom();
    // The GM publishes once so any clientID-label scheme would have this id
    // bound as 'gm'.
    const gmDoc = new Y.Doc({ gc: false });
    gmDoc.clientID = 111111111;
    gmDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'high-fantasy' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(gmDoc), 'conn-gm');
    expect(guard.evictions).toBe(0);

    // Mallory (verified player) forges the GM's identity: same clientID, and
    // a clock high enough to WIN last-writer-wins on the shared item.
    const forged = forgeAs(gmDoc.clientID, 50, (d) =>
      d.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'clown-fiesta' })
    );
    Y.applyUpdate(room, forged, 'conn-player');

    // The forged frame is structurally genuine: its structs really do claim
    // the GM's clientID and really do touch the host-owned key. Eviction is
    // synchronous inside applyUpdate, so the poisoned value is never
    // observable AFTER the call — this decoding step is what proves the
    // attack frame itself (not just a rejected no-op) was processed.
    const decodedFrame = inspectAtmosphereWrites(forged);
    expect(decodedFrame.writers).toContain(gmDoc.clientID);
    expect(decodedFrame.keys).toEqual([ATMOSPHERE_KEY]);

    expect(guard.evictions).toBe(1);
    // ...and eviction restored the last host-authored value.
    expect(room.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toMatchObject({
      id: 'high-fantasy',
    });
  });

  it('F-A3#3: evicts a forged-clientID write even when NO GM ever connected', () => {
    const { room, guard } = makeRoom();
    const forged = writeAtmosphere(ATMOSPHERE_KEY, { id: 'ghost-gm-poison' }, 999999999);
    Y.applyUpdate(room, forged.update, 'conn-player');
    expect(guard.evictions).toBe(1);
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });

  it('F-A3#3: a host-role connection may use ANY clientID it likes (no false positives)', () => {
    const { room, guard } = makeRoom();
    // A GM device whose Yjs doc picked some fresh random clientID — no prior
    // binding exists anywhere — still publishes successfully.
    const gmDoc = writeAtmosphere(ATMOSPHERE_KEY, { id: 'brand-new-device' }, 7777777);
    Y.applyUpdate(room, gmDoc.update, 'conn-gm');
    expect(guard.evictions).toBe(0);
    expect(room.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toMatchObject({
      id: 'brand-new-device',
    });
  });

  it('repairs peers that received the poisoned frame before eviction landed', () => {
    const { room, guard } = makeRoom();
    const poison = writeAtmosphere().update;
    const earlyPeer = new Y.Doc();
    Y.applyUpdate(earlyPeer, poison);

    const corrections = [];
    room.on('update', (u) => corrections.push(u));
    Y.applyUpdate(room, poison, 'conn-player');

    Y.applyUpdate(earlyPeer, Y.mergeUpdates(corrections));
    expect(earlyPeer.getMap(ATMOSPHERE_MAP_NAME).get(ATMOSPHERE_KEY)).toBeUndefined();
  });

  it('fails closed: an unresolvable connection origin cannot write atmosphere', () => {
    const { room, guard } = makeRoom();
    const ghost = new Y.Doc();
    ghost.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'ghost-theme' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(ghost), 'conn-unknown');
    expect(guard.evictions).toBe(1);
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });

  it('does not interfere with player speech, token, or fog traffic', () => {
    const { room, guard } = makeRoom();
    const playerDoc = new Y.Doc();
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
    gmDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'high-fantasy' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(gmDoc), 'conn-gm');

    const playerDoc = new Y.Doc();
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
    gmDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'eldritch-mystery' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(gmDoc), 'conn-gm');

    // Deletions ride the delete-set with no struct authorship; authorized via
    // the SENDING CONNECTION's verified role (the only mechanism now).
    const playerDoc = new Y.Doc();
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

  it('lets a host legitimately delete the shared selection', () => {
    const { room, guard } = makeRoom();
    const gmDoc = new Y.Doc();
    gmDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'gothic-horror' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(gmDoc), 'conn-gm');
    // Host deliberately clears the selection (the clearing doc must carry the
    // original item first so its update encodes a real tombstone).
    const clearDoc = new Y.Doc();
    Y.applyUpdate(clearDoc, Y.encodeStateAsUpdate(gmDoc));
    clearDoc.getMap(ATMOSPHERE_MAP_NAME).delete(ATMOSPHERE_KEY);
    Y.applyUpdate(
      room,
      Y.encodeStateAsUpdate(clearDoc, Y.encodeStateVector(gmDoc)),
      'conn-gm'
    );
    expect(guard.evictions).toBe(0);
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });

  it('stops reverting once a host legitimately clears the key', () => {
    const { room, guard } = makeRoom();
    const gmDoc = new Y.Doc();
    gmDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'gothic-horror' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(gmDoc), 'conn-gm');
    const clearDoc = new Y.Doc();
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
    playerDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'hijacked' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(playerDoc), 'conn-player');
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });

  it('does not resurrect poison when a hijack has no legitimate predecessor', () => {
    const { room, guard } = makeRoom();
    const ghost = new Y.Doc(); // first write is already unauthorized
    ghost.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'ghost-theme' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(ghost), 'conn-unknown');
    expect(guard.evictions).toBe(1);
    expect([...room.getMap(ATMOSPHERE_MAP_NAME).keys()]).toEqual([]);
  });

  it('never re-checks its own corrective transactions (no eviction loop)', () => {
    const { room, guard } = makeRoom();
    const playerDoc = new Y.Doc();
    playerDoc.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'hijacked' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(playerDoc), 'conn-player');
    const countAfterFirst = guard.evictions;
    expect(countAfterFirst).toBe(1);
    // The restore write itself emitted updates; if they were re-checked the
    // eviction count would climb without any further remote traffic.
    expect(guard.evictions).toBe(countAfterFirst);
  });

  it('reports every eviction to the amplifier accounting hook (audit A3 #4)', () => {
    const room = new Y.Doc();
    const reported = [];
    const roles = new Map([
      ['conn-player', 'player'],
      ['conn-gm', 'gm'],
    ]);
    const guard = installAtmosphereGuard(room, {
      roleOfConnection: (origin) => roles.get(origin) ?? null,
      onUnauthorizedWrite: (origin) => reported.push(origin),
    });
    room.on('update', (u, origin) => {
      if (origin == null) return;
      guard.checkUpdate(u, origin);
    });
    const a = new Y.Doc();
    a.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'x1' });
    const b = new Y.Doc();
    b.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'x2' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(a), 'conn-player');
    Y.applyUpdate(room, Y.encodeStateAsUpdate(b), 'conn-player');
    expect(reported).toEqual(['conn-player', 'conn-player']);
    // Legitimate host traffic never trips the hook.
    const g = new Y.Doc();
    g.getMap(ATMOSPHERE_MAP_NAME).set(ATMOSPHERE_KEY, { id: 'ok' });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(g), 'conn-gm');
    expect(reported).toEqual(['conn-player', 'conn-player']);
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
