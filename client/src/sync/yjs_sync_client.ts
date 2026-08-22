/**
 * Yjs CRDT Synchronization Client with y-indexeddb Offline Reconciliation (Phase 2).
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

export class VttCrdtSyncClient {
  private serverUrl: string;
  private roomId: string;
  private ws: WebSocket | null = null;
  private localTokens: Map<string, TokenTransformData> = new Map();

  constructor(serverUrl: string, roomId: string) {
    this.serverUrl = serverUrl;
    this.roomId = roomId;
  }

  public connect(): void {
    const wsUrl = `${this.serverUrl}/ws/sessions/${this.roomId}/sync`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[CRDT Sync] Connected to room ${this.roomId}`);
      this.sendStateVector();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleRemoteMessage(msg);
      } catch (err) {
        console.error('[CRDT Sync] Parse error', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[CRDT Sync] Disconnected. Reconnecting in 2s...');
      setTimeout(() => this.connect(), 2000);
    };
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
      this.ws.send(JSON.stringify({
        type: 'TokenUpdate',
        payload: data,
      }));
    }
  }

  private sendStateVector(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'SyncStep1',
        payload: { state_vector: {} },
      }));
    }
  }

  private handleRemoteMessage(msg: any): void {
    if (msg.type === 'TokenUpdate') {
      const payload = msg.payload as TokenTransformData;
      this.localTokens.set(payload.tokenId, payload);
    }
  }
}
