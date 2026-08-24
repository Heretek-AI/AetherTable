/**
 * True CRDT synchronization client built on Yjs + y-websocket.
 *
 * Token transforms AND fog-of-war masks live in Y.Maps inside one Y.Doc,
 * merged by the Yjs CRDT algorithm (causal ordering, not wall-clock LWW),
 * persisted by the relay, and fanned out through the y-websocket provider.
 *
 * Public surface mirrors the legacy `VttCrdtSyncClient` so the app shell can
 * switch transports transparently; falls back to that relay when no
 * VITE_YSYNC_WS_URL is configured.
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

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

type RemoteTokenListener = (payload: TokenTransformData) => void;

export class YjsCrdtClient {
  private doc = new Y.Doc();
  private provider: WebsocketProvider | null = null;
  private tokens: Y.Map<Record<string, unknown>>;
  private fog: Y.Map<Uint8Array>;
  private remoteListeners = new Set<RemoteTokenListener>();
  private tokenObservers = new Map<string, () => void>();
  private connected = false;

  constructor(serverUrl: string, roomId: string) {
    this.tokens = this.doc.getMap('tokens');
    this.fog = this.doc.getMap('fog');

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

    // Fan out remote (and local-confirm) token changes to listeners.
    this.tokens.observe((event) => {
      if (!this.remoteListeners.size) return;
      event.keysChanged.forEach((tokenId) => {
        const value = this.tokens.get(tokenId) as TokenTransformData | undefined;
        if (value) this.remoteListeners.forEach((listener) => listener(value));
      });
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
   * Fog layers keyed per owner (e.g. userId / role), stored as bitmasks.
   * Yjs guarantees conflict-free convergence of concurrent layer edits.
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

  public destroy(): void {
    this.tokenObservers.forEach((off) => off());
    this.provider?.destroy();
    this.doc.destroy();
  }
}
