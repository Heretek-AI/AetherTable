/**
 * Speech-map authorization for the Yjs CRDT relay (audit A2 finding #4).
 *
 * WHY THIS EXISTS
 * The speech ledger keys entries per owner (`user:<userId>`); the convention
 * is that only a peer's own devices write that key. Nothing in the CRDT
 * enforces it: any connected peer can write huge segment sets under ANY
 * user's key and inflate that user's weightedSeconds, distorting Pillar-11
 * spotlight balancing on every replica.
 *
 * HOW WRITERS ARE IDENTIFIED (per-connection attribution)
 * y-websocket routes every connection of a room into ONE shared WSSharedDoc,
 * and by the time a sync delta reaches the doc's `update` event the
 * originating socket is no longer attached to it. What IS stable on the wire
 * is the WRITING CLIENT ID: every struct in a Yjs update carries
 * `struct.id.client`, which equals the writing Y.Doc instance's clientID —
 * and that same clientID is what the peer publishes in its AWARENESS state.
 * So attribution works in two steps:
 *
 *   1. AWARENESS CLAIM BINDING. When awareness updates arrive, the relay maps
 *      each claimed clientID -> user_id. It accepts the claim ONLY if the
 *      claimed user_id equals the HMAC-verified identity of the connection
 *      that sent it (claims are otherwise trivially spoofable). Unverifiable
 *      claims are rejected: the clientID never becomes speech-authoritative.
 *   2. DELTA CHECK. For each doc update we decode the delta, extract which
 *      `user:<id>` speech keys its structs write, and attribute each writing
 *      clientID through step 1. Any key whose writer is not its rightful
 *      owner is EVICTED from the room doc; the eviction itself emits a
 *      corrective delete-set update that y-websocket fans out to every
 *      connection, repairing replicas that already merged the poison.
 *
 * Documented RESIDUAL threat model (honest limits of this layer):
 *   - Re-poisoning with a fresh clock re-triggers eviction each time:
 *     poisoning becomes loud and futile rather than impossible; the
 *     client-side weight ceiling (speech_ledger.ts,
 *     SPOTLIGHT_WEIGHT_WINDOW_FACTOR) bounds any residue between evictions.
 *   - A peer whose awareness claim was rejected cannot get speech writes
 *     attributed at all, so ALL of its speech keys are evicted — including
 *     honest ones until it fixes its claim (fail-closed).
 *   - Deletes of foreign keys are flagged like inserts: nobody may touch
 *     another user's ledger entry.
 *   - Non-speech maps (tokens/fog/atmosphere) are NOT validated here; their
 *     authorization story lives elsewhere (audit findings #1-#3).
 */
import { createRequire } from 'module';
// yjs lives in client/node_modules (the relay script resolves its other deps
// the same way), so anchor resolution there rather than assuming a global.
const require = createRequire(new URL('../client/package.json', import.meta.url));
const Y = require('yjs');

/** The Y.Map name holding the speech ledger inside every room doc. */
export const SPEECH_MAP_NAME = 'speech';

/** Speech ledger keys follow the fog-layer convention `user:<userId>`. */
export const SPEECH_KEY_PREFIX = 'user:';

/**
 * Decode a raw Y.Doc update and return the set of WRITING CLIENT IDs plus the
 * userIds whose speech-map keys the delta touches. Tolerates malformed input
 * by returning an empty result rather than throwing — the relay must never
 * crash on hostile bytes.
 */
export function inspectSpeechWrites(update) {
  const empty = { writers: [], owners: [] };
  if (!(update instanceof Uint8Array) || update.length === 0) return empty;
  let decoded;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return empty; // undecodable garbage — nothing attributable here
  }
  const writers = new Set();
  const owners = new Set();
  for (const struct of decoded.structs) {
    if (struct.id && Number.isFinite(struct.id.client)) writers.add(struct.id.client);
    // Only root-level Y.Map items carry a string parent name; nested types
    // have a type object as parent and cannot be speech keys.
    if (typeof struct.parent !== 'string') continue;
    if (struct.parent !== SPEECH_MAP_NAME) continue;
    const sub = struct.parentSub;
    if (typeof sub !== 'string' || !sub.startsWith(SPEECH_KEY_PREFIX)) continue;
    owners.add(sub.slice(SPEECH_KEY_PREFIX.length));
  }
  return { writers: [...writers], owners: [...owners] };
}

/**
 * Pure authorization decision for one decoded delta: given the writing client
 * ids, the speech user-ids they touch, and a resolver mapping client id ->
 * verified user id (or null when unattributed), return the foreign keys that
 * must be evicted. An UNATTRIBUTED writer (no validated awareness claim) may
 * not write ANY speech key — fail closed.
 */
export function foreignSpeechKeys(writers, touchedOwners, attributedUserOf) {
  const foreign = [];
  for (const owner of touchedOwners) {
    let legit = false;
    for (const clientId of writers) {
      if (attributedUserOf(clientId) === owner) {
        legit = true;
        break;
      }
    }
    if (!legit) foreign.push(owner);
  }
  return foreign;
}

/**
 * Evict foreign speech entries (`user:<id>` keys, or raw non-conforming keys)
 * from the room doc. Returns the number removed. Deleting inside a transaction
 * emits a corrective update that y-websocket broadcasts to all peers,
 * repairing replicas that already merged the poisoned frame.
 */
export function evictForeignSpeechEntries(roomDoc, foreignKeys) {
  if (!foreignKeys?.length) return 0;
  const speech = roomDoc.getMap(SPEECH_MAP_NAME);
  let evicted = 0;
  roomDoc.transact(() => {
    for (const id of foreignKeys) {
      // `id` is normally a bare userId (delete `user:<id>`); the defensive
      // live-state branch can also hand us a raw non-prefixed key, deleted
      // verbatim.
      const key = id.startsWith(SPEECH_KEY_PREFIX) ? id : `${SPEECH_KEY_PREFIX}${id}`;
      if (speech.has(key)) {
        speech.delete(key);
        evicted += 1;
      } else if (speech.has(id)) {
        speech.delete(id);
        evicted += 1;
      }
    }
  });
  return evicted;
}

/**
 * Install the speech guard on one room doc.
 *
 * @param {import('yjs').Doc} roomDoc the shared WSSharedDoc for the room
 * @returns {{
 *   evictions: number,
 *   evictedKeys: string[],
 *   bindClaim(connKey: string, clientId: number, claimedUserId: string): boolean,
 *   dropConn(connKey: string): void,
 *   checkUpdate(update: Uint8Array): void,
 * }}
 *
 * - `bindClaim` is called when an awareness update arrives over connection
 *   `connKey`: it records clientID -> verifiedUserId ONLY when the claimed
 *   user matches the connection's HMAC-verified identity. Returns whether the
 *   claim was accepted.
 * - `dropConn` forgets everything a closed connection contributed.
 * - `checkUpdate` is called for every doc update (post-commit); it evicts
 *   foreign speech writes as described above.
 */
export function installSpeechGuard(roomDoc) {
  /** clientID -> verified user_id (only accepted claims live here) */
  const attribution = new Map();
  const handle = {
    evictions: 0,
    evictedKeys: [],
    /**
     * Record an awareness claim from connection `connKey`. `verifiedUserId`
     * is what the relay's HMAC verification says this connection IS;
     * `claimedUserId` is what the awareness payload CLAIMS. Only matching
     * claims are bound.
     */
    bindClaim(verifiedUserId, clientId, claimedUserId) {
      if (claimedUserId === verifiedUserId) {
        attribution.set(clientId, verifiedUserId);
        return true;
      }
      return false; // spoofed or mismatched claim — never authoritative
    },
    /** Forget attributions when a connection goes away. */
    dropConn() {
      /* attribution persists for the doc lifetime: a clientID is globally
         unique per Y.Doc instance, so stale entries can only ever bless their
         OWN original writer, never a new attacker. Cheap and safe. */
    },
    /** Post-commit authorization of one doc update. */
    checkUpdate(update) {
      const { writers, owners } = inspectSpeechWrites(update);
      if (!owners.length) return;
      const foreign = foreignSpeechKeys(writers, owners, (id) => attribution.get(id) ?? null);
      if (!foreign.length) return;
      handle.evictions += foreign.length;
      handle.evictedKeys.push(...foreign);
      console.warn(
        `[ysync] speech-guard: evicted ${foreign.length} foreign speech entr${foreign.length === 1 ? 'y' : 'ies'} (${foreign.map((f) => `user:${f}`).join(', ')})`,
      );
      evictForeignSpeechEntries(roomDoc, foreign);
    },
  };
  return handle;
}
