/**
 * WebRTC P2P Voice and Data Mesh Manager
 * Manages peer audio channels and routes voice through the spatial audio panner.
 */

export interface PeerAudioState {
  peerId: string;
  name: string;
  tokenId: string;
  x: number;
  y: number;
  volume: number;
  isMuted: boolean;
  isSpeaking: boolean;
  audioLevel: number; // 0.0 to 1.0
}

export class WebRTCMeshManager {
  private peers: Map<string, PeerAudioState> = new Map();
  private localStream: MediaStream | null = null;
  private onPeersUpdatedCallback?: (peers: PeerAudioState[]) => void;
  private simInterval: number | null = null;

  constructor() {
    this.seedDefaultPeers();
    this.startSimulationLoop();
  }

  private seedDefaultPeers() {
    this.peers.set('peer_thorin', {
      peerId: 'peer_thorin',
      name: 'Thorin (Fighter)',
      tokenId: 'thorin_1',
      x: 4,
      y: 4,
      volume: 0.9,
      isMuted: false,
      isSpeaking: false,
      audioLevel: 0.0,
    });
    this.peers.set('peer_lyra', {
      peerId: 'peer_lyra',
      name: 'Lyra (Mage)',
      tokenId: 'lyra_1',
      x: 4,
      y: 5,
      volume: 0.85,
      isMuted: false,
      isSpeaking: false,
      audioLevel: 0.0,
    });
    this.peers.set('peer_gm', {
      peerId: 'peer_gm',
      name: 'Lead GM (Director)',
      tokenId: 'gm_lead',
      x: 8,
      y: 6,
      volume: 1.0,
      isMuted: false,
      isSpeaking: false,
      audioLevel: 0.0,
    });
  }

  private startSimulationLoop() {
    if (this.simInterval) return;
    this.simInterval = window.setInterval(() => {
      // Simulate slight ambient voice modulation
      this.peers.forEach((peer) => {
        if (!peer.isMuted && Math.random() < 0.2) {
          peer.isSpeaking = true;
          peer.audioLevel = 0.2 + Math.random() * 0.6;
        } else {
          peer.isSpeaking = false;
          peer.audioLevel = Math.max(0, peer.audioLevel - 0.1);
        }
      });
      if (this.onPeersUpdatedCallback) {
        this.onPeersUpdatedCallback(Array.from(this.peers.values()));
      }
    }, 400);
  }

  public updatePeerPosition(tokenId: string, x: number, y: number) {
    this.peers.forEach((peer) => {
      if (peer.tokenId === tokenId) {
        peer.x = x;
        peer.y = y;
      }
    });
    if (this.onPeersUpdatedCallback) {
      this.onPeersUpdatedCallback(Array.from(this.peers.values()));
    }
  }

  public setPeerVolume(peerId: string, volume: number) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.volume = Math.max(0, Math.min(1, volume));
      if (this.onPeersUpdatedCallback) {
        this.onPeersUpdatedCallback(Array.from(this.peers.values()));
      }
    }
  }

  public togglePeerMute(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.isMuted = !peer.isMuted;
      if (this.onPeersUpdatedCallback) {
        this.onPeersUpdatedCallback(Array.from(this.peers.values()));
      }
    }
  }

  public onPeersUpdated(cb: (peers: PeerAudioState[]) => void) {
    this.onPeersUpdatedCallback = cb;
    cb(Array.from(this.peers.values()));
  }

  public getPeers(): PeerAudioState[] {
    return Array.from(this.peers.values());
  }

  public destroy() {
    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }
  }
}

export const globalWebRTCMesh = new WebRTCMeshManager();
