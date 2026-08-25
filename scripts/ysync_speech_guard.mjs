/**
 * Speech-map authorization for the Yjs CRDT relay (audit A2 finding #4;
 * hardened audit A3 finding #3).
 *
 * WHY THIS EXISTS
 * The speech ledger keys entries per owner (`user:<userId>`); the convention
 * is that only a peer's own devices write that key. Nothing in the CRDT
 * enforced it: any connected peer can write huge segment sets under ANY
 * user's key and inflate that user's weightedSeconds, distorting Pillar-11
 * spotlight balancing on every replica.
 *
 * HOW WRITERS ARE IDENTIFIED — DELIVERY-TIME CONNECTION ORIGIN ONLY
 *
 * The FIRST version of this guard attributed writes via awareness-claim
 * binding: a peer published its Yjs clientID plus a user_id claim in its
 * awareness state, and the relay bound clientID -> user only when the claim
 * matched the connection's HMAC identity. Audit A3 finding #3 broke that
 * binding exactly as it broke the atmosphere guard's: a Yjs clientID is an
 * attacker-chosen 32-bit value that every struct in an update carries
 * (`struct.id.client`), so once VICTIM's clientID was legitimately bound,
 * any peer could craft deltas CLAIMING it and write under
 * `user:<victim>` with full authorization. The claim check validated what
 * a peer said about itself over its own connection — never the bytes of
 * the delta it later delivered.
 *
 * The fix binds authorization to what the relay actually verified at
 * DELIVERY time. y-websocket passes the originating conn object as the Yjs
 * transaction origin for every remote frame, and scripts/ysync-server.mjs
 * registers each conn's HMAC-verified (userId, role) at upgrade. Now a
 * speech key may be written ONLY over a connection whose verified user_id
 * equals the key's owner; every struct in the delta is attributed to the
 * connection that delivered it, regardless of which clientID it claims.
 *
 *   DELTA CHECK — every REMOTE doc update is decoded; each `user:<id>` key
 *   it touches is evicted unless `userOfConnection(origin)` resolves to
 *   exactly that id. Unresolvable origins fail closed.
 *
 * Documented RESIDUAL threat model (honest limits of this layer):
 *   - Eviction is post-commit: an unauthorized write exists briefly at the
 *     relay before the corrective update repairs replicas that already
 *     merged it. Poisoning becomes loud and futile rather than impossible.
 *     The client-side weight ceiling (speech_ledger.ts,
 *     SPOTLIGHT_WEIGHT_WINDOW_FACTOR) bounds any residue between evictions.
 *   - Pure DELETIONS ride the update's delete-set with NO struct authorship,
 *     so this guard cannot see who deleted a foreign key from committed
 *     state alone. Deleting another user's ledger entry is therefore NOT
 *     gated here (pre-existing gap, unchanged by this hardening); the
 *     atmosphere guard's vanished-key tracking pattern is the model for a
 *     future fix.
 *   - Corrective broadcasts are themselves amplification; per-connection
 *     budget + disconnect live in scripts/ysync_relay_throttle.mjs (audit A3
 *     finding #4).
 *   - Non-speech maps (tokens/fog/atmosphere) are NOT validated here; their
 *     authorization stories live elsewhere (Rust relay RBAC for tokens/fog,
 *     ysync_atmosphere_guard.mjs for atmosphere).
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
 * Decode a raw Y.Doc update and return the userIds whose speech-map keys the
 * delta touches (plus the raw writing clientIDs, kept for diagnostics only —
 * they are NOT used for authorization; see the header). Tolerates malformed
 * input by returning an empty result rather than throwing — the relay must
 * never crash on hostile bytes.
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
 * Pure authorization decision for one decoded delta delivered over a
 * connection whose HMAC-verified user id is `senderUserId`: return the
 * touched owner ids whose keys must be evicted. Struct-level clientIDs are
 * deliberately NOT an input (audit A3 finding #3: they are attacker-chosen).
 * An unknown sender fails closed for every key it touches; a sender may only
 * ever touch its OWN ledger key.
 */
export function foreignSpeechKeys(touchedOwners, senderUserId) {
  if (!touchedOwners?.length) return [];
  return touchedOwners.filter((owner) => owner !== senderUserId);
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
 * @param {{
 *   userOfConnection?: (origin: unknown) => string|null,
 *   onUnauthorizedWrite?: (origin: unknown) => void,
 * }} [options]
 *   `userOfConnection` resolves the HMAC-verified user_id of the CONNECTION
 *   that delivered a frame (y-websocket passes its conn object as the
 *   transaction origin; the server registers verified identities at
 *   upgrade). REQUIRED for authorization — unresolvable origins fail closed.
 *   `onUnauthorizedWrite` fires once per eviction event so the relay can rate
 *   limit corrective-broadcast amplification and disconnect abusive
 *   connections (audit A3 finding #4).
 * @returns {{
 *   evictions: number,
 *   evictedKeys: string[],
 *   checkUpdate(update: Uint8Array, origin?: unknown): void,
 * }}
 *
 * `checkUpdate` is called for every REMOTE doc update (post-commit); it
 * evicts foreign speech writes as described above.
 */
export function installSpeechGuard(roomDoc, options = {}) {
  const handle = {
    evictions: 0,
    evictedKeys: [],
    /**
     * Post-commit authorization of one doc update.
     *
     * WIRING CONTRACT: call this ONLY for updates that arrived over a remote
     * connection. Null-origin (relay-local corrective) transactions carry no
     * speech structs, but gating them out keeps both guards symmetric and
     * makes the fail-closed path unreachable for our own repairs.
     */
    checkUpdate(update, origin) {
      const { writers, owners } = inspectSpeechWrites(update);
      if (!owners.length) return;
      const senderUserId =
        origin == null ? null : options.userOfConnection?.(origin) ?? null;
      const foreign = foreignSpeechKeys(owners, senderUserId);
      if (!foreign.length) return;
      handle.evictions += foreign.length;
      handle.evictedKeys.push(...foreign);
      console.warn(
        `[ysync] speech-guard: evicted ${foreign.length} foreign speech entr${foreign.length === 1 ? 'y' : 'ies'} (${foreign.map((f) => `user:${f}`).join(', ')}) from ${writers.length} claimed writer clientID(s); delivering origin user='${senderUserId ?? 'unknown'}'`,
      );
      try {
        evictForeignSpeechEntries(roomDoc, foreign);
      } finally {
        // Report AFTER the repair so a throwing eviction cannot skip the
        // amplifier accounting (audit A3 finding #4).
        options.onUnauthorizedWrite?.(origin);
      }
    },
  };
  return handle;
}
