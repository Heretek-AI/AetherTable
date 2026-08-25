/**
 * Table-atmosphere authorization for the Yjs CRDT relay.
 *
 * WHY THIS EXISTS (loop-1 iteration 63 defect)
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
 * write the atmosphere map. Players and spectators are read-only consumers of
 * fan-out; their writes are evicted. Unattributed writers fail closed, exactly
 * like the speech guard.
 *
 * HOW WRITERS ARE IDENTIFIED (per-connection attribution — same mechanism as
 * scripts/ysync_speech_guard.mjs; read its header for the full rationale):
 *
 *   1. AWARENESS CLAIM BINDING — each peer's awareness state carries a
 *      `user_id` claim. On every awareness update we bind clientID -> VERIFIED
 *      ROLE only when the claim matches the connection's HMAC-verified user_id;
 *      spoofed claims never become authoritative.
 *   2. DELTA CHECK — every doc update is decoded; atmosphere keys it touches
 *      are attributed to their writing clientIDs via step 1. Any write whose
 *      writer does not carry a host role is EVICTED from the room doc, and the
 *      corrective delete-set update repairs every replica that already merged
 *      the unauthorized frame.
 *
 * Documented RESIDUAL threat model (honest limits of this layer):
 *   - Eviction is post-commit: an unauthorized write exists briefly at the
 *     relay before the corrective update reverts every replica. Poisoning
 *     becomes loud and futile rather than impossible (identical to the speech
 *     guard's semantics).
 *   - A peer whose awareness claim was rejected cannot get writes attributed,
 *     so its atmosphere writes are evicted too (fail closed) until it fixes
 *     its claim. y-websocket publishes awareness automatically on connect, so
 *     honest clients self-heal immediately.
 *   - Tokens, fog, speech, and awareness maps are NOT validated here; their
 *     authorization stories live elsewhere (Rust relay RBAC for tokens/fog,
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
 * Decode a raw Y.Doc update and return the set of WRITING CLIENT IDs plus the
 * atmosphere-map keys the delta touches (ANY key counts — the whole map is
 * host-owned; the client only ever uses 'current'). Tolerates malformed input
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
 * Pure authorization decision for one decoded delta: given the writing client
 * ids, the atmosphere keys they touch, and a resolver mapping client id ->
 * verified role string (or null when unattributed), return the keys whose
 * writes must be evicted. A key stays legitimate when ANY riding writer holds
 * a host role — merged deltas legitimately mix contributors, and the host's
 * own edit must not be reverted because a player's stale struct rode along.
 * UNATTRIBUTED or non-host writers fail closed.
 */
export function unauthorizedAtmosphereWrites(writers, touchedKeys, roleOf) {
  const unauthorized = [];
  for (const key of touchedKeys) {
    let legit = false;
    for (const clientId of writers) {
      if (isAtmosphereWriterRole(roleOf(clientId))) {
        legit = true;
        break;
      }
    }
    if (!legit) unauthorized.push(key);
  }
  return unauthorized;
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
 * @param {{roleOfConnection?: (origin: unknown) => string|null}} [options]
 *   `roleOfConnection` resolves the HMAC-verified role of the CONNECTION that
 *   delivered a frame (y-websocket passes its conn object as the transaction
 *   origin). It is required for DELETE authorization: yjs propagates deletions
 *   in the update's delete-set with NO struct authorship, so struct-level
 *   clientID attribution cannot see who deleted a key — only the sending
 *   connection's verified role can.
 * @returns {{
 *   evictions: number,
 *   evictedKeys: string[],
 *   bindClaim(verifiedUserId: string, verifiedRole: string|null,
 *             clientId: number, claimedUserId: string): boolean,
 *   checkUpdate(update: Uint8Array, origin?: unknown): void,
 * }}
 *
 * - `bindClaim` is called when an awareness update arrives over a connection
 *   HMAC-verified as (`verifiedUserId`, `verifiedRole`): it records
 *   clientID -> verifiedRole ONLY when the claimed user matches the verified
 *   identity. Spoofed claims are rejected and the clientID stays unattributed
 *   (which then fails closed). Returns whether the claim was accepted.
 * - `checkUpdate` is called for every REMOTE doc update (post-commit); it
 *   evicts non-host atmosphere writes as described above.
 */
export function installAtmosphereGuard(roomDoc, options = {}) {
  /** clientID -> verified role string ('gm'|'admin'|'player'|'spectator') */
  const attribution = new Map();
  /** atmosphere key -> last value the relay saw pass authorization. */
  const lastKnownGood = new Map();
  const handle = {
    evictions: 0,
    evictedKeys: [],
    bindClaim(verifiedUserId, verifiedRole, clientId, claimedUserId) {
      // Attribution is IDENTITY binding only; policy (who may write) lives in
      // unauthorizedAtmosphereWrites so roles are always evaluated from what
      // the relay VERIFIED, never from what a peer claims about itself.
      if (claimedUserId === verifiedUserId) {
        attribution.set(clientId, verifiedRole ?? null);
        return true;
      }
      return false; // spoofed or mismatched claim — never authoritative
    },
    /**
     * Post-commit authorization of one doc update.
     *
     * WIRING CONTRACT: call this ONLY for updates that arrived over a remote
     * connection (y-websocket passes the conn object as the transaction
     * origin). The guard's own corrective transactions have a null origin and
     * MUST NOT be re-checked — their structs are authored by the relay doc's
     * clientID, which is unattributed by design, so re-checking them would
     * evict the very restore this guard just wrote.
     */
    checkUpdate(update, origin) {
      const { writers, keys } = inspectAtmosphereWrites(update);
      const atmosphere = roomDoc.getMap(ATMOSPHERE_MAP_NAME);
      const roleOf = (id) => attribution.get(id) ?? null;

      // 1. Struct-visible writes (sets) attributed via clientIDs.
      const unauthorized = new Set(
        unauthorizedAtmosphereWrites(writers, keys, roleOf)
      );

      // 2. Deletions: a tracked key that vanished from committed state was
      // deleted by THIS frame (the only actor between commits). Delete-sets
      // carry no author, so the sending connection's verified role decides;
      // fail closed when it is unknown or non-host.
      const vanished = [...lastKnownGood.keys()].filter(
        (k) => !atmosphere.has(k)
      ).filter((k) => !unauthorized.has(k));
      const hostStructWriter = writers.some((w) => isAtmosphereWriterRole(roleOf(w)));
      const senderRole =
        origin == null ? null : options.roleOfConnection?.(origin) ?? null;
      const hostSender = isAtmosphereWriterRole(senderRole);
      if (vanished.length && !hostSender && !hostStructWriter) {
        for (const k of vanished) unauthorized.add(k);
      }

      if (unauthorized.size) {
        const list = [...unauthorized];
        handle.evictions += list.length;
        handle.evictedKeys.push(...list);
        console.warn(
          `[ysync] atmosphere-guard: evicted ${list.length} non-host atmosphere write${list.length === 1 ? '' : 's'} (${list.join(', ')})`,
        );
        evictUnauthorizedAtmosphereEntries(roomDoc, list, lastKnownGood);
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
