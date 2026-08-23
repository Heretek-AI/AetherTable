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
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadFrame: number | null = null;
  private localPeerId: string | null = null;
  private onPeersUpdatedCallback?: (peers: PeerAudioState[]) => void;

  constructor() {
    this.seedDefaultPeers();
  }

  /**
   * Drive a peer tile's speaking ring from the real microphone (RMS level).
   * Remote peers stay silent until genuine P2P audio tracks arrive.
   */
  public async enableLocalVoiceDetection(peerId = 'peer_thorin'): Promise<boolean> {
    if (this.localPeerId === peerId && this.vadFrame !== null) return true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) return false;
      this.localPeerId = peerId;
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtx();
      const source = this.audioCtx.createMediaStreamSource(this.localStream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      const buffer = new Uint8Array(this.analyser.frequencyBinCount);

      const tick = () => {
        if (!this.analyser || !this.audioCtx) return;
        this.analyser.getByteTimeDomainData(buffer as any);
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / buffer.length); // 0..1
        const peer = this.localPeerId ? this.peers.get(this.localPeerId) : null;
        if (peer && !peer.isMuted) {
          peer.audioLevel = Math.min(1, rms * 4);
          peer.isSpeaking = rms > 0.06;
        }
        if (this.onPeersUpdatedCallback) {
          this.onPeersUpdatedCallback(Array.from(this.peers.values()));
        }
        this.vadFrame = requestAnimationFrame(tick);
      };
      this.vadFrame = requestAnimationFrame(tick);
      return true;
    } catch (e) {
      console.warn('[WebRTC Mesh] Mic unavailable; speaking indicators idle.', e);
      return false;
    }
  }

  public disableLocalVoiceDetection(): void {
    if (this.vadFrame !== null) cancelAnimationFrame(this.vadFrame);
    this.vadFrame = null;
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    this.analyser = null;
    this.localPeerId = null;
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
    // Removed: speaking state is now driven by real microphone RMS via
    // enableLocalVoiceDetection(); remote peers light up only with real
    // P2P audio tracks in a future wave.
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

  public onPeersUpdated(cb: (peers: PeerAudioState[]) => void): () => void {
    this.onPeersUpdatedCallback = cb;
    cb(Array.from(this.peers.values()));
    return () => {
      if (this.onPeersUpdatedCallback === cb) {
        this.onPeersUpdatedCallback = undefined;
      }
    };
  }

  public getPeers(): PeerAudioState[] {
    return Array.from(this.peers.values());
  }

  public destroy() {
    this.disableLocalVoiceDetection();
  }
}

export const globalWebRTCMesh = new WebRTCMeshManager();
