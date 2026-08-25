/**
 * True CRDT synchronization client built on Yjs + y-websocket.
 *
 * Token transforms, fog-of-war masks, AND the room-wide table-atmosphere
 * selection live in Y.Maps inside one Y.Doc, merged by the Yjs CRDT algorithm
 * (causal ordering, not wall-clock LWW), persisted by the relay, and fanned
 * out through the y-websocket provider.
 *
 * Public surface mirrors the legacy `VttCrdtSyncClient` so the app shell can
 * switch transports transparently; falls back to that relay when no
 * VITE_YSYNC_WS_URL is configured.
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
// Bundled transitively by y-websocket (^1.0.5). Resolved from the hoisted
// node_modules root under the project's `moduleResolution: node` tsconfig and
// Vite's export-map resolution alike. If it ever stops being a transitive dep,
// promote `y-protocols` to an explicit dependency in client/package.json.
import { Awareness } from 'y-protocols/awareness';
import { AtmosphereSelection, normalizeAtmosphereId } from '../theme/atmospheres';
import {
  computeSpotlightWeights,
  sanitizeSegments,
  type LedgerEntry,
  type SpotlightView,
  type SpeechSegment,
} from './speech_ledger';

export interface TokenTransformData {
  tokenId: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  scale: number;
  elevation: number;
  timestamp: number;
}

/**
 * A peer's live pointer position, already filtered to OTHER clients and
 * expressed in BOARD coordinates (grid cells, same units as `Token.x/y` —
 * NOT pixels). This is the shape TacticalCanvas's `remoteCursors` prop wants.
 */
export interface RemoteCursor {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

/** Flat awareness payload published by every client (including us). */
interface CursorAwarenessState {
  user_id: string;
  name: string;
  color: string;
  /** Board coordinates in grid cells. */
  x: number;
  y: number;
}

type RemoteTokenListener = (payload: TokenTransformData) => void;
type RemoteCursorListener = (cursors: RemoteCursor[]) => void;
type AtmosphereListener = (selection: AtmosphereSelection) => void;
type SpotlightListener = (view: SpotlightView) => void;

/** Fixed Y.Map key holding the room-wide AtmosphereSelection. */
const ATMOSPHERE_KEY = 'current';

/** Y.Map holding the speech ledger; keys follow the fog convention. */
const SPEECH_MAP_NAME = 'speech';

/** How often an open burst's live tail is republished to the room (ms). */
export const SPEECH_PUBLISH_THROTTLE_MS = 2_000;

/**
 * Validate a raw `atmosphere` map entry into an AtmosphereSelection, or null
 * when absent/malformed (pre-sync docs, partial writes, tampered data).
 */
function readAtmosphereEntry(raw: unknown): AtmosphereSelection | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string') return null;
  return {
    // Unknown preset ids degrade to the stock palette on the consumer side.
    id: normalizeAtmosphereId(rec.id),
    set_by: typeof rec.set_by === 'string' ? rec.set_by : '',
    ts: typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : 0,
  };
}

/** Peer cursor colors are assigned deterministically from user_id. */
const CURSOR_PALETTE = [
  '#818cf8', // indigo
  '#ef4444', // red
  '#34d399', // emerald
  '#fbbf24', // amber
  '#f472b6', // pink
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#fb923c', // orange
];

function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return CURSOR_PALETTE[Math.abs(hash) % CURSOR_PALETTE.length];
}

export class YjsCrdtClient {
  private doc = new Y.Doc();
  private provider: WebsocketProvider | null = null;
  private idb: IndexeddbPersistence | null = null;
  private tokens: Y.Map<Record<string, unknown>>;
  private fog: Y.Map<Uint8Array>;
  private atmosphere: Y.Map<unknown>;
  private speech: Y.Map<unknown>;
  private remoteListeners = new Set<RemoteTokenListener>();
  private tokenObservers = new Map<string, () => void>();
  private cursorListeners = new Set<RemoteCursorListener>();
  private atmosphereListeners = new Set<AtmosphereListener>();
  private spotlightListeners = new Set<SpotlightListener>();
  /** user_id of the signed-in local peer; speech is published under this key. */
  private localUserId = '';
  private localUserName = '';
  /** Throttle for republishing the open burst's growing tail. */
  private pendingSpeechPublish = false;
  private speechThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Presence protocol instance. The provider owns one; we only create our own for local-only mode. */
  private awareness: Awareness | null = null;
  private ownAwareness = false;
  private localUser: { user_id: string; name: string; color: string } | null = null;
  // Leading+trailing throttle state for cursor publication.
  private pendingCursor: { x: number; y: number } | null = null;
  private cursorFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  /** Local pointer updates are coalesced to at most one awareness write per tick. */
  private static readonly CURSOR_THROTTLE_MS = 60;

  constructor(serverUrl: string, roomId: string) {
    this.tokens = this.doc.getMap('tokens');
    this.fog = this.doc.getMap('fog');
    this.atmosphere = this.doc.getMap('atmosphere');
    this.speech = this.doc.getMap(SPEECH_MAP_NAME);

    // Offline persistence: mirror the Y.Doc into IndexedDB so a room survives
    // page reloads even when the relay is unreachable. Scoped per room.
    try {
      this.idb = new IndexeddbPersistence(`aethertable-${roomId.split('?')[0]}`, this.doc);
      this.idb.on('synced', () => console.debug('[YjsSync] local room restored from IndexedDB'));
    } catch (e) {
      console.warn('[YjsSync] IndexedDB persistence unavailable:', e);
    }

    const base = serverUrl.replace(/\/$/, '').replace(/^http/, 'ws');
    try {
      const token =
        typeof sessionStorage !== 'undefined'
          ? sessionStorage.getItem('aethertable_token')
          : null;
      // The provider builds `<base>/<roomName>`; ride the gateway token on
      // the room path so the relay's upgrade handler sees it as a query param.
      const roomWithAuth = token ? `${roomId}?token=${encodeURIComponent(token)}` : roomId;
      this.provider = new WebsocketProvider(base, roomWithAuth, this.doc, {
        connect: true,
        disableBc: false,
      });
      this.provider.on('status', (event: { status: string }) => {
        this.connected = event.status === 'connected';
      });
    } catch (e) {
      console.warn('[YjsSync] provider unavailable; local-only CRDT mode:', e);
    }

    // Presence: reuse the provider's awareness (y-websocket already encodes/
    // broadcasts its updates over the same socket); fall back to a standalone
    // instance so cursor state still round-trips locally in local-only mode.
    if (this.provider?.awareness) {
      this.awareness = this.provider.awareness;
    } else {
      this.awareness = new Awareness(this.doc);
      this.ownAwareness = true;
    }
    this.awareness.on('change', () => {
      const snapshot = this.collectRemoteCursors();
      this.cursorListeners.forEach((listener) => listener(snapshot));
    });

    // Fan out remote (and local-confirm) token changes to listeners.
    this.tokens.observe((event) => {
      if (!this.remoteListeners.size) return;
      event.keysChanged.forEach((tokenId) => {
        const value = this.tokens.get(tokenId) as TokenTransformData | undefined;
        if (value) this.remoteListeners.forEach((listener) => listener(value));
      });
    });

    // Fan out atmosphere changes to listeners (local writes included; App.tsx
    // treats a same-id echo as a no-op, so there is no feedback loop).
    this.atmosphere.observe(() => {
      if (!this.atmosphereListeners.size) return;
      const selection = this.getAtmosphereId();
      if (selection) this.atmosphereListeners.forEach((listener) => listener(selection));
    });

    // Recompute spotlight weights from the MERGED ledger whenever any peer's
    // speech entry changes — ours or theirs. Every replica runs the same pure
    // function over the same CRDT-converged data, so all clients agree.
    this.speech.observe(() => {
      if (!this.spotlightListeners.size) return;
      const view = this.getSpotlightView();
      this.spotlightListeners.forEach((listener) => listener(view));
    });
  }

  public connect(): void {
    this.provider?.connect();
  }

  public disconnect(): void {
    this.provider?.disconnect();
  }

  public get isConnected(): boolean {
    // Without a configured provider we still run as a functional local CRDT.
    return this.provider ? this.connected : true;
  }

  public onRemoteTokenUpdate(listener: RemoteTokenListener): () => void {
    this.remoteListeners.add(listener);
    return () => {
      this.remoteListeners.delete(listener);
    };
  }

  // --- Awareness (live cursors) -------------------------------------------

  /**
   * Stamp the signed-in identity into local awareness. Call again if the
   * signed-in user changes; the current pointer position (if any) is kept.
   */
  public setLocalUser(user: { user_id: string; name: string; color?: string }): void {
    this.localUserId = user.user_id;
    this.localUserName = user.name;
    if (!this.awareness) return;
    this.localUser = {
      user_id: user.user_id,
      name: user.name,
      color: user.color ?? colorForUser(user.user_id),
    };
    const prev = this.awareness.getLocalState() ?? {};
    this.awareness.setLocalState({ ...prev, ...this.localUser });
  }

  /** Publish our pointer position in BOARD coordinates (grid cells). Throttled. */
  public updateLocalCursor(x: number, y: number): void {
    this.pendingCursor = { x, y };
    if (this.cursorFlushTimer !== null) return;
    this.flushCursor();
    // Trailing edge: guarantee the final resting position is published.
    this.cursorFlushTimer = setTimeout(() => {
      this.cursorFlushTimer = null;
      this.flushCursor();
    }, YjsCrdtClient.CURSOR_THROTTLE_MS);
  }

  private flushCursor(): void {
    if (!this.awareness || !this.pendingCursor) return;
    const { x, y } = this.pendingCursor;
    this.pendingCursor = null;
    const prev = this.awareness.getLocalState() ?? {};
    this.awareness.setLocalState({ ...prev, x, y });
  }

  /**
   * Subscribe to OTHER users' cursors. The callback receives the full list
   * each time awareness changes — an empty array means no peers are present,
   * and the UI must render nothing rather than fabricated stand-ins.
   */
  public onRemoteCursors(listener: RemoteCursorListener): () => void {
    this.cursorListeners.add(listener);
    // Deliver the current snapshot immediately so late subscribers render peers
    // that connected before they mounted.
    listener(this.collectRemoteCursors());
    return () => {
      this.cursorListeners.delete(listener);
    };
  }

  private collectRemoteCursors(): RemoteCursor[] {
    if (!this.awareness) return [];
    const selfId = this.awareness.clientID;
    const cursors: RemoteCursor[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === selfId || !state) return;
      const s = state as Partial<CursorAwarenessState>;
      if (
        typeof s.user_id !== 'string' ||
        typeof s.x !== 'number' ||
        typeof s.y !== 'number' ||
        !Number.isFinite(s.x) ||
        !Number.isFinite(s.y)
      ) {
        return;
      }
      cursors.push({
        id: String(s.user_id),
        name: typeof s.name === 'string' ? s.name : String(s.user_id),
        color: typeof s.color === 'string' ? s.color : colorForUser(String(s.user_id)),
        x: s.x,
        y: s.y,
      });
    });
    return cursors;
  }

  /** CRDT-authoritative position write — merges causally with peers. */
  public updateTokenPosition(tokenId: string, x: number, y: number, z: number = 0): void {
    this.tokens.set(tokenId, {
      tokenId,
      x,
      y,
      z,
      rotation: 0,
      scale: 1,
      elevation: z,
      timestamp: Date.now(),
    });
  }

  public getTokenPosition(tokenId: string): TokenTransformData | null {
    return (this.tokens.get(tokenId) as TokenTransformData | undefined) ?? null;
  }

  /**
   * Fog layers keyed per owner, stored as bitmasks over the grid.
   *
   * CONVENTION (mirrored by render/fog_overlay.ts and TacticalCanvas):
   *   - Layer id `user:<userId>`; GMs keep no layer (omniscient).
   *   - Flat Uint8Array, row-major: cell = y*gridWidth + x,
   *     bit (mask[cell >> 3] >> (cell & 7)) & 1; SET = REVEALED.
   *   - Reveal is monotonic (bits never cleared), so concurrent edits from
   *     DIFFERENT owners merge conflict-free. Note the Y.Map stores whole
   *     arrays per key: two devices writing the SAME user's layer resolve
   *     last-writer-wins for that layer — per-owner keying is what keeps
   *     cross-player merges conflict-free.
   *   - Missing/short mask reads as fully unrevealed.
   */
  public setFogLayer(layerId: string, mask: Uint8Array): void {
    this.fog.set(layerId, mask);
  }

  public getFogLayer(layerId: string): Uint8Array | null {
    return (this.fog.get(layerId) as Uint8Array | undefined) ?? null;
  }

  public observeFogLayer(layerId: string, cb: (mask: Uint8Array) => void): () => void {
    const observer = () => {
      const mask = this.getFogLayer(layerId);
      if (mask) cb(mask);
    };
    this.fog.observe(observer);
    return () => {
      this.fog.unobserve(observer);
    };
  }

  /** Layer ids currently present in the `fog` map (e.g. `user:<userId>`). */
  public getFogLayerIds(): string[] {
    return Array.from(this.fog.keys());
  }

  /**
   * Observe EVERY fog layer at once — local writes, remote reveals merged in
   * by the CRDT, and layers appearing for the first time. Fires immediately
   * with the current snapshot (one call per existing layer) so late
   * subscribers see exploration that happened before they mounted, then again
   * on each subsequent change.
   */
  public observeFogLayers(cb: (layerId: string, mask: Uint8Array) => void): () => void {
    const emit = (layerId: string) => {
      const mask = this.getFogLayer(layerId);
      if (mask) cb(layerId, mask);
    };
    // Initial snapshot for already-present layers.
    this.getFogLayerIds().forEach(emit);
    const observer = (event: Y.YMapEvent<Uint8Array>) => {
      event.keysChanged.forEach(emit);
    };
    this.fog.observe(observer);
    return () => {
      this.fog.unobserve(observer);
    };
  }

  // --- Table atmosphere (shared preset selection) --------------------------

  /**
   * Publish the room-wide atmosphere preset. Writes ride the same Y.Doc /
   * ysync relay as tokens and fog — no protocol change.
   *
   * POLICY NOTE: the transport accepts this write from ANY role; the GM-only
   * restriction lives entirely in the UI layer (Navbar gates the picker, App
   * only calls this from the GM-gated handler). We deliberately do not fake a
   * server-side role check that does not exist.
   *
   * CONFLICT SEMANTICS: everything is stored under ONE map key ('current'), so
   * concurrent writers resolve via Y.Map's built-in last-write-wins per key —
   * causally ordered writes converge on whichever update arrived later at each
   * replica, and TRUE simultaneous writes (no causal ordering) are broken
   * deterministically by Yjs's internal entry comparison (clientID), not by
   * `ts`. The `ts` stamp is informational/debug only. In practice exactly one
   * GM writes this key, so the concurrent-writer path is a safety net, not a
   * designed-for case.
   */
  public setAtmosphereId(id: string, setBy: string): void {
    const entry: AtmosphereSelection = {
      id: normalizeAtmosphereId(id),
      set_by: setBy,
      ts: Date.now(),
    };
    this.atmosphere.set(ATMOSPHERE_KEY, entry);
  }

  /** Current room-wide selection, or null when nothing has been published yet. */
  public getAtmosphereId(): AtmosphereSelection | null {
    return readAtmosphereEntry(this.atmosphere.get(ATMOSPHERE_KEY));
  }

  /**
   * Subscribe to the room-wide atmosphere. Fires IMMEDIATELY with the current
   * snapshot when one exists (covering late joiners and the IndexedDB restore
   * racing app mount), then again whenever the entry appears or changes —
   * locally or remotely. Returns an unsubscribe function.
   */
  public observeAtmosphereId(cb: AtmosphereListener): () => void {
    this.atmosphereListeners.add(cb);
    const existing = this.getAtmosphereId();
    if (existing) cb(existing);
    return () => {
      this.atmosphereListeners.delete(cb);
    };
  }

  // --- Speech ledger (Pillar-11 spotlight balancing) -----------------------

  /**
   * Publish THIS user's VAD speech segments to the shared Y.Doc.
   *
   * CONVENTION (mirrors the fog layers above): one key per owner,
   * `user:<userId>`. A peer's entry is written only by that peer's own
   * devices, so concurrent writes never target the same key and cross-player
   * merges are conflict-free — the CRDT converges every replica on the same
   * per-peer segment lists. Weights themselves are NEVER stored: each client
   * recomputes them locally with the pure function in speech_ledger.ts from
   * the merged ledger, so there is no LWW fight over a single weight object
   * (the failure mode of the old hardcoded `{ Thorin: 0.55, Lyra: 0.45 }`
   * snapshot field).
   *
   * Signed-out note: the Yjs relay rejects unauthenticated sockets, so with
   * no session token the provider never connects and this write lands only
   * in our local Y.Doc + IndexedDB — a genuinely local-only ledger, which is
   * exactly what App.tsx labels it as.
   */
  public publishSpeech(userId: string, name: string, segments: SpeechSegment[]): void {
    const clean = sanitizeSegments(segments);
    this.speech.set(`user:${userId}`, {
      user_id: userId,
      name,
      segments: clean,
      // Informational stamp (same status as AtmosphereSelection.ts): merge
      // order comes from the CRDT, not this clock.
      ts: Date.now(),
    } satisfies LedgerEntry & { ts: number });
  }

  /** The full merged ledger, validated entry by entry. */
  public getSpeechLedger(): LedgerEntry[] {
    return Array.from(this.speech.keys())
      .map((key) => this.readSpeechEntry(this.speech.get(key)))
      .filter((entry): entry is LedgerEntry => entry !== null);
  }

  /**
   * Compute the room spotlight view from the merged ledger right now.
   * `shares` is empty until real VAD segments exist — callers render that
   * honestly instead of substituting demo speakers.
   */
  public getSpotlightView(nowMs: number = Date.now()): SpotlightView {
    return {
      scope: 'room',
      shares: computeSpotlightWeights(this.getSpeechLedger(), { nowMs }),
    };
  }

  /**
   * Subscribe to converged spotlight updates. Fires immediately with the
   * current view (covering late joiners + IndexedDB restore), then on every
   * local or remote ledger change. Returns an unsubscribe function.
   */
  public observeSpotlight(cb: SpotlightListener): () => void {
    this.spotlightListeners.add(cb);
    cb(this.getSpotlightView());
    return () => {
      this.spotlightListeners.delete(cb);
    };
  }

  /**
   * Throttled publication of an open burst's live tail: at most one write per
   * SPEECH_PUBLISH_THROTTLE_MS while someone is mid-sentence, so the balance
   * bar moves without hammering the relay on every animation frame.
   */
  public scheduleLiveSpeechPublish(
    userId: string,
    name: string,
    snapshotFn: () => SpeechSegment[],
  ): void {
    if (this.speechThrottleTimer !== null) {
      this.pendingSpeechPublish = true;
      return;
    }
    this.publishSpeech(userId, name, snapshotFn());
    this.speechThrottleTimer = setTimeout(() => {
      this.speechThrottleTimer = null;
      if (this.pendingSpeechPublish) {
        this.pendingSpeechPublish = false;
        this.scheduleLiveSpeechPublish(userId, name, () => snapshotFn());
      }
    }, SPEECH_PUBLISH_THROTTLE_MS);
  }

  /** True when this browser has an open (un-ended) VAD burst. */
  private readSpeechEntry(raw: unknown): LedgerEntry | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.user_id !== 'string' || rec.user_id === '') return null;
    return {
      user_id: rec.user_id,
      name: typeof rec.name === 'string' && rec.name !== '' ? rec.name : rec.user_id,
      segments: sanitizeSegments(rec.segments),
    };
  }

  public destroy(): void {
    this.tokenObservers.forEach((off) => off());
    if (this.cursorFlushTimer !== null) {
      clearTimeout(this.cursorFlushTimer);
      this.cursorFlushTimer = null;
    }
    if (this.speechThrottleTimer !== null) {
      clearTimeout(this.speechThrottleTimer);
      this.speechThrottleTimer = null;
    }
    this.spotlightListeners.clear();
    // Announce departure so peers drop our cursor immediately instead of
    // waiting out the awareness stale timeout.
    try {
      this.awareness?.setLocalState(null);
    } catch {
      /* doc may already be torn down */
    }
    this.cursorListeners.clear();
    this.atmosphereListeners.clear();
    if (this.ownAwareness) this.awareness?.destroy();
    this.idb?.destroy();
    this.provider?.destroy();
    this.doc.destroy();
  }
}
