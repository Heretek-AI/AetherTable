/**
 * Pillar 9 — real WebRTC video mesh types (PeerJS-backed).
 *
 * These mirror the runtime shapes exported from `render/webrtc_mesh.ts` so
 * components can type against the contract without importing the manager.
 * Every tile here is produced by a REAL PeerJS connection; there is no mock
 * or seeded roster anywhere in the mesh.
 */

/** Lifecycle of the signaling socket (PeerJS `open`/`disconnected`/`error`). */
export type MeshStatusKind = 'idle' | 'connecting' | 'online' | 'signaling-down';

export interface MeshStatus {
  kind: MeshStatusKind;
  /** Human-readable degradation reason; null while healthy/idle. */
  reason: string | null;
  /** Signaling id assigned to this browser (`at-<lobby>-<userId>`). */
  selfPeerId: string | null;
}

export interface RemoteVideoTile {
  peerId: string;
  userId: string;
  /** Display name exchanged over the presence DataConnection. */
  name: string;
  /** Live remote MediaStream; null until their first tracks arrive. */
  stream: MediaStream | null;
  /** True only while a remote publishes an un-muted, live video track. */
  hasLiveVideo: boolean;
  isMuted: boolean;
  volume: number;
}

export interface LocalMediaState {
  /** Composed local camera+mic stream once any grant exists. */
  stream: MediaStream | null;
  cameraOn: boolean;
  micOn: boolean;
  /** Real mic RMS above threshold; dark whenever no mic grant exists. */
  isSpeaking: boolean;
  /** Camera/mic acquisition failure reason, rendered verbatim by tiles. */
  error: string | null;
}

/** Props accepted by VideoMeshTiles for identity-scoped peer ids. */
export interface MeshIdentity {
  userId: string;
  displayName: string;
}
