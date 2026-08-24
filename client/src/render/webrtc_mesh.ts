/**
 * Real WebRTC full mesh over PeerJS (Pillar 9 — replaces the emoji-mock mesh).
 *
 * Honest-by-construction rules enforced here:
 *  - NO seeded/fake peers anywhere. The roster is empty until real browsers
 *    connect to the signaling server and exchange presence.
 *  - Presence travels over PeerJS DataConnections, so tiles appear even when
 *    nobody has granted a camera yet (presence ≠ media).
 *  - Media travels over RTCPeerConnection MediaConnections. A peer only
 *    publishes tracks after the user explicitly enables them; toggles flip
 *    real `MediaStreamTrack.enabled` flags (no re-negotiation, no fakery).
 *  - Every failure surfaces as machine-readable status + a human reason
 *    (`getStatus()` / `onStatus`) instead of a silent mock.
 *
 * Design decisions:
 *  - Full mesh (every peer calls every peer). Fine at AetherTable sizes (≤8
 *    seats ⇒ ≤7 outbound calls/client); an SFU would be over-engineering here.
 *  - Room scoping is a deterministic peer-id namespace: peer ids are
 *    `at-<lobbyId>-<userId>` (sanitized), so discovery is just filtering the
 *    signaling server's `/peers` listing by prefix. Requires
 *    `allow_discovery: true` on OUR self-hosted peerjs server (see
 *    docker-compose.yml `vtt-peerjs`) — nothing leaves the stack.
 *  - Glare avoidance: the lexicographically smaller peer id initiates the
 *    DataConnection, so both sides never dial each other simultaneously.
 *  - Camera capture is `{video:true, audio:false}` per the pillar spec; the
 *    microphone is a SEPARATE explicit grant (`{audio:true}`) behind its own
 *    toggle. Both feed one published stream, so mute/camera-off are genuine
 *    `enabled=false` states that receivers actually observe.
 */

import Peer from 'peerjs';
import type { DataConnection, MediaConnection, PeerError } from 'peerjs';

// ---------------------------------------------------------------------------
// Public types (also consumed by components via ../types/webrtc)
// ---------------------------------------------------------------------------

export type MeshStatusKind = 'idle' | 'connecting' | 'online' | 'signaling-down';

export interface MeshStatus {
  kind: MeshStatusKind;
  /** Human-readable degradation reason, null while healthy. */
  reason: string | null;
  /** Signaling id assigned to this browser, null before 'open'. */
  selfPeerId: string | null;
}

/** One REAL remote participant (never synthesized). */
export interface RemoteVideoTile {
  peerId: string;
  userId: string;
  name: string;
  /** Live remote MediaStream, null until their first tracks arrive. */
  stream: MediaStream | null;
  /** True only while they publish an un-muted video track. */
  hasLiveVideo: boolean;
  isMuted: boolean;
  volume: number;
}

export interface LocalMediaState {
  stream: MediaStream | null;
  cameraOn: boolean;
  micOn: boolean;
  /** Driven by real mic RMS; false whenever no mic grant exists. */
  isSpeaking: boolean;
  /** Camera/mic acquisition failure reason shown verbatim in the UI. */
  error: string | null;
}

/** Legacy shape still consumed by AudioMixerModal (kept compatible). */
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

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const SIGNALING_BASE = import.meta.env.VITE_PEERJS_URL ?? 'http://localhost:9000';
const LOBBY_ID = import.meta.env.VITE_PEERJS_ROOM ?? 'aethertable-live';
const SIGNAING_KEY = 'aethertable';
const SIGNAING_PATH = '/peerjs';
/** Roster refresh cadence against the signaling server's discovery endpoint. */
const ROSTER_POLL_MS = 5000;
/** Mic RMS threshold matching the previous voice-detection behaviour. */
const SPEAK_RMS_THRESHOLD = 0.06;

/** PeerJS ids allow [A-Za-z0-9_-]; clamp length so ids stay readable. */
function sanitizeId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'anon';
}

function parseSignaling(url: string): { host: string; port: number; secure: boolean; origin: string } {
  try {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : secure ? 443 : 80,
      secure,
      origin: u.origin,
    };
  } catch {
    return { host: 'localhost', port: 9000, secure: false, origin: 'http://localhost:9000' };
  }
}

interface RemoteEntry {
  peerId: string;
  userId: string;
  name: string;
  conn: DataConnection | null;
  call: MediaConnection | null;
  stream: MediaStream | null;
  volume: number;
  isMuted: boolean;
  audioEl: HTMLAudioElement | null;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class WebRTCMeshManager {
  private peer: Peer | null = null;
  private lobbyId = LOBBY_ID;
  private roomPrefix = `at-${sanitizeId(LOBBY_ID)}-`;
  private userId = '';
  private displayName = '';

  private remotes = new Map<string, RemoteEntry>();
  private status: MeshStatus = { kind: 'idle', reason: null, selfPeerId: null };

  private localStream: MediaStream | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private localError: string | null = null;
  private localIsSpeaking = false;

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadFrame: number | null = null;

  private rosterTimer: ReturnType<typeof setInterval> | null = null;

  private rosterListeners = new Set<(remotes: RemoteVideoTile[]) => void>();
  private statusListeners = new Set<(s: MeshStatus) => void>();
  private localListeners = new Set<(s: LocalMediaState) => void>();
  private legacyListener: ((peers: PeerAudioState[]) => void) | undefined;

  // -- lifecycle ------------------------------------------------------------

  /**
   * Join the lobby-scoped mesh. Idempotent: a second call tears down the
   * previous signaling socket first. Resolves once the signaling server has
   * assigned us an id; media flows independently afterwards.
   */
  public join(userId: string, displayName: string, lobbyId: string = LOBBY_ID): Promise<MeshStatus> {
    this.destroy();
    this.userId = sanitizeId(userId);
    this.displayName = displayName || this.userId;
    this.lobbyId = lobbyId;
    this.roomPrefix = `at-${sanitizeId(lobbyId)}-`;

    this.setStatus({ kind: 'connecting', reason: null, selfPeerId: null });

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve(this.status);
        }
      };

      try {
        const sig = parseSignaling(SIGNALING_BASE);
        this.peer = new Peer(`${this.roomPrefix}${this.userId}`, {
          host: sig.host,
          port: sig.port,
          secure: sig.secure,
          path: `${SIGNAING_PATH}/`,
          key: SIGNAING_KEY,
          debug: 1,
        });

        this.peer.on('open', (id: string) => {
          this.setStatus({ kind: 'online', reason: null, selfPeerId: id });
          this.startRosterPolling();
          finish();
        });

        // Two tabs of the same user collide on one id — retry with a suffix
        // so both stay in the room instead of dying.
        this.peer.on('error', (err: PeerError<string>) => {
          if (err.type === 'unavailable-id' && !settled) {
            this.joinRetryWithSuffix();
            finish();
            return;
          }
          if (err.type === 'peer-unavailable') {
            // A roster entry vanished between listing and dialing; harmless.
            return;
          }
          this.setStatus({
            kind: 'signaling-down',
            reason: `signaling error (${err.type ?? 'unknown'})`,
            selfPeerId: this.status.selfPeerId,
          });
          finish();
        });

        this.peer.on('disconnected', () => {
          this.setStatus({
            kind: 'signaling-down',
            reason: 'lost connection to the signaling server',
            selfPeerId: this.status.selfPeerId,
          });
        });

        this.peer.on('call', (call: MediaConnection) => this.answerIncomingCall(call));
        this.peer.on('connection', (conn: DataConnection) => this.registerDataConnection(conn));
      } catch (e) {
        this.setStatus({
          kind: 'signaling-down',
          reason: e instanceof Error ? e.message : 'failed to reach the signaling server',
          selfPeerId: null,
        });
        finish();
      }
    });
  }

  private joinRetryWithSuffix(): void {
    const suffix = Math.random().toString(36).slice(2, 6);
    this.userId = sanitizeId(`${this.userId}-${suffix}`);
    void this.join(this.userId, this.displayName, this.lobbyId);
  }

  public leave(): void {
    this.destroy();
  }

  // -- local media ----------------------------------------------------------

  /** Explicit user opt-in for the camera. Captures video only (no mic grab). */
  public async enableCamera(): Promise<LocalMediaState> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('this browser exposes no getUserMedia');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      this.localStream ??= new MediaStream();
      stream.getVideoTracks().forEach((t) => {
        this.cameraTrack?.stop();
        this.cameraTrack = t;
        this.localStream!.addTrack(t);
      });
      this.localError = null;
      await this.publishToRemotes();
      return this.getLocalState();
    } catch (e) {
      this.localError =
        e instanceof Error
          ? e.name === 'NotAllowedError'
            ? 'camera permission denied'
            : e.message
          : 'camera unavailable';
      return this.getLocalState();
    }
  }

  /** Explicit user opt-in for the microphone (separate grant from camera). */
  public async enableMic(): Promise<LocalMediaState> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('this browser exposes no getUserMedia');
      }
      if (!this.micTrack) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.micTrack = stream.getAudioTracks()[0] ?? null;
        if (!this.micTrack) throw new Error('no microphone track returned');
        this.localStream ??= new MediaStream();
        this.localStream.addTrack(this.micTrack);
        this.startMicLevelMeter(this.micTrack);
      }
      this.micTrack.enabled = true;
      this.localError = null;
      await this.publishToRemotes();
      return this.getLocalState();
    } catch (e) {
      this.localError =
        e instanceof Error
          ? e.name === 'NotAllowedError'
            ? 'microphone permission denied'
            : e.message
          : 'microphone unavailable';
      return this.getLocalState();
    }
  }

  /** Real mute: flips the live track's `enabled` flag (receivers see silence). */
  public disableMic(): LocalMediaState {
    if (this.micTrack) this.micTrack.enabled = false;
    this.localIsSpeaking = false;
    return this.getLocalState();
  }

  /** Real camera-off: disables the live video track (black frame downstream). */
  public disableCamera(): LocalMediaState {
    if (this.cameraTrack) this.cameraTrack.enabled = false;
    return this.getLocalState();
  }

  public toggleMic(): void {
    if (this.micTrack?.enabled) {
      this.disableMic();
    } else {
      void this.enableMic();
    }
  }

  public toggleCamera(): void {
    if (this.cameraTrack?.enabled) {
      this.disableCamera();
    } else {
      void this.enableCamera();
    }
  }

  /**
   * (Re-)publish the current composed stream to every connected peer. Peers
   * with cameras off simply answer() with no tracks and still receive ours.
   */
  private async publishToRemotes(): Promise<void> {
    if (!this.peer || !this.localStream || this.localStream.getTracks().length === 0) return;
    for (const entry of this.remotes.values()) {
      if (!entry.conn || !entry.conn.open) continue;
      entry.call?.close();
      const call = this.peer.call(entry.peerId, this.localStream);
      entry.call = call;
      this.wireRemoteStream(entry, call);
    }
  }

  // -- presence / roster ----------------------------------------------------

  private startRosterPolling(): void {
    this.pollRoster();
    this.rosterTimer = setInterval(() => this.pollRoster(), ROSTER_POLL_MS);
  }

  /**
   * Discover room-mates from the signaling server's discovery listing and
   * open media-capable sessions with everyone sharing our lobby prefix.
   */
  private async pollRoster(): Promise<void> {
    if (!this.peer || this.status.kind !== 'online') return;
    const sig = parseSignaling(SIGNALING_BASE);
    try {
      const res = await fetch(`${sig.origin}${SIGNAING_PATH}/${SIGNAING_KEY}/peers`);
      if (!res.ok) throw new Error(`roster HTTP ${res.status}`);
      const ids: string[] = await res.json();
      for (const id of ids) {
        if (id === this.status.selfPeerId) continue;
        if (!id.startsWith(this.roomPrefix)) continue;
        this.ensureSession(id);
      }
    } catch {
      // Transient polling failures are non-fatal; the status channel already
      // reports hard signaling loss via peer events.
    }
  }

  /** Glare-free session setup: only the lower id dials the DataConnection. */
  private ensureSession(remoteId: string): void {
    const existing = this.remotes.get(remoteId);
    if (existing?.conn) return;
    if (!this.peer) return;
    const mine = this.status.selfPeerId ?? '';
    if (mine < remoteId) {
      const conn = this.peer.connect(remoteId, { reliable: true });
      this.registerDataConnection(conn);
    }
    // else: the other side will dial us; their 'connection' event registers it.
  }

  private registerDataConnection(conn: DataConnection): void {
    const entry: RemoteEntry = {
      peerId: conn.peer,
      userId: conn.peer.startsWith(this.roomPrefix)
        ? conn.peer.slice(this.roomPrefix.length)
        : conn.peer,
      name: conn.peer,
      conn,
      call: null,
      stream: null,
      volume: 1,
      isMuted: false,
      audioEl: null,
    };

    // Duplicate dials (glare residue) resolve to the first live connection.
    const prior = this.remotes.get(conn.peer);
    if (prior?.conn && prior.conn.open) {
      conn.close();
      return;
    }
    this.remotes.set(conn.peer, entry);

    conn.on('open', () => {
      entry.name = entry.name || conn.peer;
      conn.send({ t: 'hello', name: this.displayName });
      // Publish immediately so late camera-enablers receive existing video.
      void this.publishToRemotes();
      this.notifyRoster();
    });
    conn.on('data', (raw: unknown) => {
      const msg = raw as { t?: string; name?: string };
      if (msg?.t === 'hello' && typeof msg.name === 'string' && msg.name) {
        entry.name = msg.name;
        this.notifyRoster();
      }
    });
    conn.on('close', () => this.removeRemote(conn.peer));
    conn.on('error', () => this.removeRemote(conn.peer));
  }

  private answerIncomingCall(call: MediaConnection): void {
    const entry =
      this.remotes.get(call.peer) ??
      ({
        peerId: call.peer,
        userId: call.peer.startsWith(this.roomPrefix)
          ? call.peer.slice(this.roomPrefix.length)
          : call.peer,
        name: call.peer,
        conn: null,
        call,
        stream: null,
        volume: 1,
        isMuted: false,
        audioEl: null,
      } satisfies RemoteEntry);
    this.remotes.set(call.peer, entry);

    // Answer with our current stream when publishing, else receive-only.
    call.answer(
      this.localStream && this.localStream.getTracks().length > 0 ? this.localStream : undefined
    );
    this.wireRemoteStream(entry, call);
  }

  private wireRemoteStream(entry: RemoteEntry, call: MediaConnection): void {
    call.on('stream', (remote: MediaStream) => {
      entry.stream = remote;
      // Dedicated audio sink lets mixer volume/mute act on real playback
      // while tiles render the (muted) video element from the same stream.
      if (!entry.audioEl) {
        entry.audioEl = new Audio();
        entry.audioEl.autoplay = true;
        entry.audioEl.srcObject = remote;
        entry.audioEl.volume = entry.volume;
        entry.audioEl.muted = entry.isMuted;
        void entry.audioEl.play().catch(() => {
          /* autoplay policy: unmutes on first user gesture via toggle */
        });
      } else {
        entry.audioEl.srcObject = remote;
      }
      this.notifyRoster();
    });
    call.on('close', () => {
      entry.stream = null;
      entry.call = null;
      this.notifyRoster();
    });
    call.on('error', () => {
      entry.stream = null;
      this.notifyRoster();
    });
  }

  private removeRemote(peerId: string): void {
    const entry = this.remotes.get(peerId);
    if (!entry) return;
    entry.call?.close();
    entry.audioEl?.pause();
    if (entry.audioEl) entry.audioEl.srcObject = null;
    this.remotes.delete(peerId);
    this.notifyRoster();
  }

  // -- mic level meter (speaking ring, local only) ---------------------------

  private startMicLevelMeter(track: MediaStreamTrack): void {
    this.stopMicLevelMeter();
    try {
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtx();
      const source = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      const buffer = new Uint8Array(this.analyser.frequencyBinCount);
      const tick = (): void => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(buffer as unknown as Uint8Array<ArrayBuffer>);
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / buffer.length);
        this.localIsSpeaking = !!this.micTrack?.enabled && rms > SPEAK_RMS_THRESHOLD;
        this.notifyLocal();
        this.notifyLegacy();
        this.vadFrame = requestAnimationFrame(tick);
      };
      this.vadFrame = requestAnimationFrame(tick);
    } catch {
      /* no Web Audio: speaking ring honestly stays dark */
    }
  }

  private stopMicLevelMeter(): void {
    if (this.vadFrame !== null) cancelAnimationFrame(this.vadFrame);
    this.vadFrame = null;
    if (this.audioCtx && this.audioCtx.state !== 'closed') void this.audioCtx.close();
    this.audioCtx = null;
    this.analyser = null;
  }

  // -- mixer controls (legacy surface kept intact) ---------------------------

  public setPeerVolume(peerId: string, volume: number): void {
    const entry = this.remotes.get(peerId);
    if (!entry) return;
    entry.volume = Math.max(0, Math.min(1, volume));
    if (entry.audioEl) entry.audioEl.volume = entry.volume;
    this.notifyRoster();
    this.notifyLegacy();
  }

  public togglePeerMute(peerId: string): void {
    const entry = this.remotes.get(peerId);
    if (!entry) return;
    entry.isMuted = !entry.isMuted;
    if (entry.audioEl) entry.audioEl.muted = entry.isMuted;
    this.notifyRoster();
    this.notifyLegacy();
  }

  /** Kept for App.tsx compatibility; tokens no longer bind to mesh peers. */
  public updatePeerPosition(_tokenId: string, _x: number, _y: number): void {
    /* Spatial binding of tokens to peers returns with the spatial-audio wave;
       the mixer radar shows unmapped peers at origin meanwhile. */
  }

  // -- subscriptions ---------------------------------------------------------

  public onRosterUpdated(cb: (remotes: RemoteVideoTile[]) => void): () => void {
    this.rosterListeners.add(cb);
    cb(this.getRemoteTiles());
    return () => {
      this.rosterListeners.delete(cb);
    };
  }

  public onLocalStateChanged(cb: (s: LocalMediaState) => void): () => void {
    this.localListeners.add(cb);
    cb(this.getLocalState());
    return () => {
      this.localListeners.delete(cb);
    };
  }

  public onStatus(cb: (s: MeshStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /** Legacy AudioMixerModal surface: real peers only (empty until they join). */
  public onPeersUpdated(cb: (peers: PeerAudioState[]) => void): () => void {
    this.legacyListener = cb;
    cb(this.getLegacyPeers());
    return () => {
      if (this.legacyListener === cb) this.legacyListener = undefined;
    };
  }

  // -- snapshots -------------------------------------------------------------

  public getStatus(): MeshStatus {
    return this.status;
  }

  public getLocalState(): LocalMediaState {
    return {
      stream: this.localStream,
      cameraOn: !!this.cameraTrack?.enabled,
      micOn: !!this.micTrack?.enabled,
      isSpeaking: this.localIsSpeaking,
      error: this.localError,
    };
  }

  public getRemoteTiles(): RemoteVideoTile[] {
    return Array.from(this.remotes.values()).map((e) => ({
      peerId: e.peerId,
      userId: e.userId,
      name: e.name,
      stream: e.stream,
      hasLiveVideo: !!e.stream?.getVideoTracks().some((t) => t.readyState === 'live'),
      isMuted: e.isMuted,
      volume: e.volume,
    }));
  }

  public getPeers(): PeerAudioState[] {
    return this.getLegacyPeers();
  }

  private getLegacyPeers(): PeerAudioState[] {
    return Array.from(this.remotes.values()).map((e) => ({
      peerId: e.peerId,
      name: e.name,
      tokenId: '',
      x: 0,
      y: 0,
      volume: e.volume,
      isMuted: e.isMuted,
      isSpeaking: false, // remote VAD arrives with the spatial-audio wave
      audioLevel: 0,
    }));
  }

  // -- notification helpers ---------------------------------------------------

  private setStatus(s: MeshStatus): void {
    this.status = s;
    this.statusListeners.forEach((cb) => cb(s));
  }

  private notifyRoster(): void {
    const tiles = this.getRemoteTiles();
    this.rosterListeners.forEach((cb) => cb(tiles));
    this.notifyLegacy();
  }

  private notifyLocal(): void {
    const s = this.getLocalState();
    this.localListeners.forEach((cb) => cb(s));
  }

  private notifyLegacy(): void {
    this.legacyListener?.(this.getLegacyPeers());
  }

  // -- teardown ----------------------------------------------------------------

  public destroy(): void {
    if (this.rosterTimer !== null) clearInterval(this.rosterTimer);
    this.rosterTimer = null;
    this.stopMicLevelMeter();
    for (const entry of this.remotes.values()) {
      entry.call?.close();
      entry.conn?.close();
      entry.audioEl?.pause();
    }
    this.remotes.clear();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.cameraTrack = null;
    this.micTrack = null;
    this.localIsSpeaking = false;
    if (this.peer && !this.peer.destroyed) this.peer.destroy();
    this.peer = null;
    this.setStatus({ kind: 'idle', reason: null, selfPeerId: null });
  }
}

export const globalWebRTCMesh = new WebRTCMeshManager();
