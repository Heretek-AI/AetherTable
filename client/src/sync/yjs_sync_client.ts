/**
 * Live CRDT Synchronization Client
 *
 * Connects to the Rust engine's WebSocket relay (/ws/sessions/{id}/sync).
 * Token position updates flow through server-side Last-Write-Wins arbitration;
 * only winning transforms are fanned out to peers. Includes exponential
 * backoff reconnection and graceful no-op behavior when the engine is offline.
 */

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

export class VttCrdtSyncClient {
  private serverUrl: string;
  private roomId: string;
  private ws: WebSocket | null = null;
  private localTokens: Map<string, TokenTransformData> = new Map();
  private remoteListeners = new Set<RemoteTokenListener>();
  private reconnectAttempt = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(serverUrl: string, roomId: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.roomId = roomId;
  }

  public connect(): void {
    this.closedByUser = false;
    try {
      this.ws = new WebSocket(`${this.serverUrl}/ws/sessions/${this.roomId}/sync`);
    } catch {
      console.warn('[CRDT Sync] WebSocket unavailable; running solo.');
      return;
    }

    this.ws.onopen = () => {
      console.log(`[CRDT Sync] Connected to room ${this.roomId}`);
      this.reconnectAttempt = 0;
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'TokenUpdate' && msg.payload) {
          const payload = msg.payload as TokenTransformData;
          const known = this.localTokens.get(payload.tokenId);
          // Never echo a stale transform over our own newer local edit.
          if (!known || payload.timestamp >= known.timestamp) {
            this.localTokens.set(payload.tokenId, payload);
            this.remoteListeners.forEach((listener) => listener(payload));
          }
        }
      } catch (err) {
        console.error('[CRDT Sync] Parse error', err);
      }
    };

    this.ws.onclose = () => {
      if (this.closedByUser) return;
      const delay = Math.min(2000 * 2 ** this.reconnectAttempt++, 30000);
      console.log(`[CRDT Sync] Disconnected. Reconnecting in ${delay}ms...`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  public disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  public get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  public onRemoteTokenUpdate(listener: RemoteTokenListener): () => void {
    this.remoteListeners.add(listener);
    return () => this.remoteListeners.delete(listener);
  }

  public updateTokenPosition(tokenId: string, x: number, y: number, z: number = 0): void {
    const data: TokenTransformData = {
      tokenId,
      x,
      y,
      z,
      rotation: 0,
      scale: 1,
      elevation: z,
      timestamp: Date.now(),
    };
    this.localTokens.set(tokenId, data);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'TokenUpdate', payload: data }));
    }
  }
}
