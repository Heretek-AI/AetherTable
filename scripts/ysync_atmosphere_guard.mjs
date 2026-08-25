/**
 * Table-atmosphere authorization for the Yjs CRDT relay.
 *
 * WHY THIS EXISTS (loop-1 iteration 63 defect; hardened audit A3 finding #3)
 * The room-wide atmosphere preset — theme/palette/audio scene selection, the
 * GOALS.md Pillar 2 feature — lives under ONE Y.Map key ('current') inside
 * every room doc's 'atmosphere' map (client/src/sync/yjs_doc_client.ts,
 * ATMOSPHERE_KEY). GOALS.md Pillar 2 assigns that selection to the HOST:
 * hosts select or generate atmospheric themes for the whole table. Before
 * this guard nothing enforced it: any connected peer could rewrite shared
 * atmosphere state and every replica converged onto the attacker's choice via
 * client-side LWW. The old client POLICY NOTE admitted the gap verbatim:
 * "the transport accepts this write from ANY role; the GM-only restriction
 * lives entirely in the UI layer."
 *
 * POLICY DECIDED HERE
 * A connection whose HMAC-verified token carries role 'gm' or 'admin' may
 * write or delete the atmosphere map. Players and spectators are read-only
 * consumers of fan-out; their writes are evicted. Connections whose role
 * cannot be resolved fail closed, exactly like the speech guard.
 *
 * HOW WRITERS ARE IDENTIFIED — DELIVERY-TIME CONNECTION ORIGIN ONLY
 *
 * The FIRST version of this guard authorized SETS via awareness-claim
 * binding: a peer's awareness state published its Yjs clientID plus a
 * user_id claim, and the relay bound clientID -> verified role when the
 * claim matched the connection's HMAC identity. Audit A3 finding #3 broke
 * that: a Yjs clientID is just an attacker-chosen 32-bit integer on the
 * wire, and every struct in an update carries `struct.id.client`. A player
 * could craft a delta whose structs CLAIM the GM's already-bound clientID;
 * the attribution map then blessed poison it never inspected the bytes of.
 * ClientIDs are labels peers choose for themselves — they are NOT identity.
 *
 * The fix binds authorization to what the relay actually verified at
 * DELIVERY time: y-websocket passes the originating conn object as the Yjs
 * transaction origin for every remote frame, and scripts/ysync-server.mjs
 * registers each conn's HMAC-verified (userId, role) at upgrade in the same
 * registry the DELETE path already used. Now EVERY struct in a delta is
 * attributed to the connection that delivered it: if that connection is not
 * host-role, any atmosphere key the delta touches is EVICTED regardless of
 * which clientID its structs claim. There is no longer any awareness-claim
 * path into this decision; spoofed claims are simply irrelevant.
 *
 *   1. DELTA CHECK — every REMOTE doc update is decoded; the atmosphere keys
 *      it touches (ANY key counts — the whole map is host-owned) are evicted
 *      unless `roleOfConnection(origin)` resolves to a host role.
 *   2. DELETE CHECK — yjs propagates deletions in the update's delete-set
 *      with NO struct authorship, so they were always authorized by the
 *      sending connection's verified role. That mechanism is now the ONLY
 *      mechanism, for sets and deletes alike.
 *
 * Documented RESIDUAL threat model (honest limits of this layer):
 *   - Eviction is post-commit: an unauthorized write exists briefly at the
 *     relay before the corrective update reverts every replica. Poisoning
 *     becomes loud and futile rather than impossible (identical to the speech
 *     guard's semantics).
 *   - Fail-closed cost: because attribution follows DELIVERY, not authorship,
 *     a merged delta carrying genuine host structs but delivered over a
 *     non-host connection is evicted too. In y-websocket's shared-doc model
 *     peers do not rebroadcast other peers' structs (the server computes sync
 *     diffs itself), so this only bites deliberately replayed frames; the
 *     repair restores the last host-authored value, so such replays are
 *     self-healing no-ops.
 *   - Corrective broadcasts are themselves amplification; per-connection
 *     budget + disconnect live in scripts/ysync_relay_throttle.mjs (audit A3
 *     finding #4).
 *   - Tokens, fog, and speech are NOT validated here; their authorization
 *     stories live elsewhere (Rust relay RBAC for tokens/fog,
 *     ysync_speech_guard.mjs for speech).
 */
import { createRequire } from 'module';
// yjs lives in client/node_modules (the relay script resolves its other deps
// the same way), so anchor resolution there rather than assuming a global.
const require = createRequire(new URL('../client/package.json', import.meta.url));
const Y = require('yjs');

/** The Y.Map name holding the room-wide atmosphere inside every room doc. */
export const ATMOSPHERE_MAP_NAME = 'atmosphere';

/** Fixed Y.Map key holding the AtmosphereSelection (client contract). */
export const ATMOSPHERE_KEY = 'current';

/**
 * Roles permitted to select/generate table atmosphere (GOALS.md Pillar 2:
 * hosts choose themes). Mirrors Role::is_gm() in crates/vtt-server/src/server.rs.
 */
export function isAtmosphereWriterRole(role) {
  return role === 'gm' || role === 'admin';
}

/**
 * Decode a raw Y.Doc update and return the atmosphere-map keys the delta
 * touches (plus the raw writing clientIDs, kept for diagnostics only — they
 * are NOT used for authorization; see the header). Tolerates malformed input
 * by returning an empty result rather than throwing — the relay must never
 * crash on hostile bytes.
 */
export function inspectAtmosphereWrites(update) {
  const empty = { writers: [], keys: [] };
  if (!(update instanceof Uint8Array) || update.length === 0) return empty;
  let decoded;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return empty; // undecodable garbage — nothing attributable here
  }
  const writers = new Set();
  const keys = new Set();
  for (const struct of decoded.structs) {
    if (struct.id && Number.isFinite(struct.id.client)) writers.add(struct.id.client);
    // Only root-level Y.Map items carry a string parent name; nested types
    // have a type object as parent and cannot be atmosphere keys.
    if (typeof struct.parent !== 'string') continue;
    if (struct.parent !== ATMOSPHERE_MAP_NAME) continue;
    if (typeof struct.parentSub !== 'string') continue;
    keys.add(struct.parentSub);
  }
  return { writers: [...writers], keys: [...keys] };
}

/**
 * Pure authorization decision for one decoded delta delivered over a
 * connection whose HMAC-verified role is `senderRole`: return the touched
 * keys that must be evicted. Struct-level clientIDs are deliberately NOT an
 * input (audit A3 finding #3: they are attacker-chosen). An unknown or
 * non-host sender fails closed for every key it touches.
 */
export function unauthorizedAtmosphereWrites(touchedKeys, senderRole) {
  if (!touchedKeys?.length) return [];
  return isAtmosphereWriterRole(senderRole) ? [] : [...touchedKeys];
}

/**
 * Evict unauthorized atmosphere entries from the room doc, optionally
 * REVERTING each key to a caller-supplied last-known-good host-authored value.
 * Bare deletion would hand an attacker a denial of service: hijacking
 * 'current' and getting evicted would leave the whole table with NO atmosphere
 * until a GM manually re-picked. Restoring is only ever fed values the relay
 * itself saw pass authorization (`installAtmosphereGuard` keeps them), never
 * the live map — so a first-write hijack with no legitimate predecessor is
 * deleted outright rather than resurrected. Returns the number removed.
 */
export function evictUnauthorizedAtmosphereEntries(
  roomDoc,
  unauthorizedKeys,
  restoreValues = new Map()
) {
  if (!unauthorizedKeys?.length) return 0;
  const atmosphere = roomDoc.getMap(ATMOSPHERE_MAP_NAME);
  let evicted = 0;
  roomDoc.transact(() => {
    for (const key of unauthorizedKeys) {
      if (atmosphere.has(key)) {
        atmosphere.delete(key);
        evicted += 1;
      }
      const knownGood = restoreValues.get(key);
      if (knownGood !== undefined) atmosphere.set(key, knownGood);
    }
  });
  return evicted;
}

/**
 * Install the atmosphere guard on one room doc.
 *
 * @param {import('yjs').Doc} roomDoc the shared WSSharedDoc for the room
 * @param {{
 *   roleOfConnection?: (origin: unknown) => string|null,
 *   onUnauthorizedWrite?: (origin: unknown) => void,
 * }} [options]
 *   `roleOfConnection` resolves the HMAC-verified role of the CONNECTION that
 *   delivered a frame (y-websocket passes its conn object as the transaction
 *   origin). It is REQUIRED for authorization: both sets and deletes are now
 *   gated on the delivering connection's verified role, never on struct
 *   clientIDs (audit A3 finding #3). Unresolvable roles fail closed.
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
 * evicts non-host atmosphere writes as described above.
 */
export function installAtmosphereGuard(roomDoc, options = {}) {
  /** atmosphere key -> last value the relay saw pass authorization. */
  const lastKnownGood = new Map();
  const handle = {
    evictions: 0,
    evictedKeys: [],
    /**
     * Post-commit authorization of one doc update.
     *
     * WIRING CONTRACT: call this ONLY for updates that arrived over a remote
     * connection (y-websocket passes the conn object as the transaction
     * origin). The guard's own corrective transactions have a null origin and
     * MUST NOT be re-checked: their restore writes carry atmosphere structs
     * authored with a null origin, which fails closed, so re-checking them
     * would evict-loop the very repair this guard just wrote.
     */
    checkUpdate(update, origin) {
      const { writers, keys } = inspectAtmosphereWrites(update);
      if (!keys.length && !lastKnownGood.size) return;
      const atmosphere = roomDoc.getMap(ATMOSPHERE_MAP_NAME);

      // Delivery-time authorization: WHOSE connection carried these bytes is
      // the only question that matters. Null origin (relay-local transaction)
      // can only reach us through a wiring bug — treat it as non-host.
      const senderRole =
        origin == null ? null : options.roleOfConnection?.(origin) ?? null;

      // 1. Struct-visible writes (sets): every touched key rides the sender's
      //    verified role, whatever clientID the structs claim.
      const unauthorized = new Set(unauthorizedAtmosphereWrites(keys, senderRole));

      // 2. Deletions: a tracked key that vanished from committed state was
      //    deleted by THIS frame (the only actor between commits). Delete-sets
      //    carry no author, so the same sender-role gate decides.
      const vanished = [...lastKnownGood.keys()].filter(
        (k) => !atmosphere.has(k)
      ).filter((k) => !unauthorized.has(k));
      if (vanished.length && !isAtmosphereWriterRole(senderRole)) {
        for (const k of vanished) unauthorized.add(k);
      }

      if (unauthorized.size) {
        const list = [...unauthorized];
        handle.evictions += list.length;
        handle.evictedKeys.push(...list);
        console.warn(
          `[ysync] atmosphere-guard: evicted ${list.length} non-host atmosphere write${list.length === 1 ? '' : 's'} (${list.join(', ')}) from ${writers.length} claimed writer clientID(s); delivering origin role='${senderRole ?? 'unknown'}'`,
        );
        try {
          evictUnauthorizedAtmosphereEntries(roomDoc, list, lastKnownGood);
        } finally {
          // Report AFTER the repair so a throwing eviction cannot skip the
          // amplifier accounting (audit A3 finding #4).
          options.onUnauthorizedWrite?.(origin);
        }
      }

      // Baseline maintenance. Legitimate host deletions clear the baseline so
      // a later hijack cannot resurrect a preset the host retired; everything
      // else refreshes from committed post-eviction state.
      for (const k of vanished) {
        if (!unauthorized.has(k)) lastKnownGood.delete(k);
      }
      for (const key of keys) {
        if (unauthorized.has(key)) continue;
        if (atmosphere.has(key)) lastKnownGood.set(key, atmosphere.get(key));
        else lastKnownGood.delete(key);
      }
    },
  };
  return handle;
}
