import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Video,
  VideoOff,
  Mic,
  MicOff,
  ChevronUp,
  Radio,
  WifiOff,
} from 'lucide-react';
import { globalWebRTCMesh } from '../render/webrtc_mesh';
import type { LocalMediaState, MeshStatus, RemoteVideoTile } from '../types/webrtc';

interface VideoMeshTilesProps {
  isVisible: boolean;
  onToggleVisible: () => void;
  /** Identity used to build the lobby-scoped PeerJS peer id. */
  currentUser: { id: string; displayName: string };
}

const STATUS_DOT_COLOR: Record<MeshStatus['kind'], string> = {
  idle: 'var(--tavern-border)',
  connecting: 'var(--state-warning, #eab308)',
  online: 'var(--state-success)',
  'signaling-down': 'var(--rp-crimson-600)',
};

/** Deterministic initials avatar — replaces the old emoji actors. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '?';
}

export const VideoMeshTiles: React.FC<VideoMeshTilesProps> = ({
  isVisible,
  onToggleVisible,
  currentUser,
}) => {
  const [remotes, setRemotes] = useState<RemoteVideoTile[]>([]);
  const [local, setLocal] = useState<LocalMediaState>({
    stream: null,
    cameraOn: false,
    micOn: false,
    isSpeaking: false,
    error: null,
  });
  const [status, setStatus] = useState<MeshStatus>({
    kind: 'idle',
    reason: null,
    selfPeerId: null,
  });
  /** Video elements need their srcObject set imperatively. */
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRefs = useRef(new Map<string, HTMLVideoElement>());

  // Join the real mesh once; roster/status stream in via callbacks only.
  useEffect(() => {
    const offRoster = globalWebRTCMesh.onRosterUpdated(setRemotes);
    const offLocal = globalWebRTCMesh.onLocalStateChanged(setLocal);
    const offStatus = globalWebRTCMesh.onStatus(setStatus);
    void globalWebRTCMesh.join(currentUser.id, currentUser.displayName);
    return () => {
      offRoster();
      offLocal();
      offStatus();
      globalWebRTCMesh.leave();
    };
    // Re-join only when the signed-in identity actually changes.
  }, [currentUser.id, currentUser.displayName]);

  // Keep <video> sinks in step with the streams React re-renders.
  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = local.stream;
  }, [local.stream]);

  useEffect(() => {
    remoteVideoRefs.current.forEach((el, peerId) => {
      const src = remotes.find((r) => r.peerId === peerId)?.stream ?? null;
      if (el.srcObject !== src) el.srcObject = src;
    });
  }, [remotes]);

  const degradedReason = useMemo(() => {
    if (status.kind === 'signaling-down') return status.reason ?? 'signaling server unreachable';
    if (status.kind === 'connecting') return 'contacting the signaling server…';
    if (local.error) return local.error;
    return null;
  }, [status, local.error]);

  if (!isVisible) return null;

  const toggleLocalMic = () => globalWebRTCMesh.toggleMic();
  const toggleLocalCamera = () => globalWebRTCMesh.toggleCamera();

  const renderTileFrame = (
    key: string,
    nameplate: string,
    videoEl: React.ReactNode | null,
    controls: React.ReactNode,
    speaking: boolean
  ) => (
    <div
      key={key}
      className={`relative w-24 h-24 rounded-xl overflow-hidden border transition-all duration-200 flex flex-col justify-between p-1.5 bg-tavern-bg/90 ${
        speaking
          ? 'border-[var(--state-success)] ring-2 ring-[color-mix(in_srgb,var(--state-success)_55%,transparent)] shadow-lg scale-105'
          : 'border-tavern-border'
      }`}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        {videoEl ?? (
          <span
            className="text-xl font-bold opacity-70"
            style={{ fontFamily: 'var(--font-display)', color: 'var(--rp-parchment-300)' }}
          >
            {initials(nameplate)}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between z-10">
        <span
          className="px-1.5 py-0.2 bg-black/70 rounded text-[9px] font-bold truncate max-w-[55px]"
          style={{
            fontFamily: 'var(--font-display)',
            fontVariant: 'small-caps',
            letterSpacing: '0.05em',
            color: 'var(--rp-parchment-200)',
          }}
        >
          {nameplate}
        </span>
        {speaking && (
          <span
            className="w-2 h-2 rounded-full animate-ping"
            style={{ backgroundColor: 'var(--state-success)' }}
          />
        )}
      </div>

      <div className="flex items-center justify-between z-10 pt-1">{controls}</div>
    </div>
  );

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-start space-x-2.5 bg-tavern-bg/85 backdrop-blur-md p-2 rounded-2xl border border-tavern-border shadow-2xl animate-fadeIn font-mono text-xs">
      <div className="flex flex-col items-start space-y-1.5">
        <div className="flex items-center space-x-2 pr-2 border-r border-tavern-border text-[10px] text-[var(--rp-parchment-300)] self-stretch">
          <Radio className="w-3.5 h-3.5" style={{ color: STATUS_DOT_COLOR[status.kind] }} />
          <span className="font-bold">WEBRTC VIDEO MESH</span>
          <span
            title={status.reason ?? status.kind}
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: STATUS_DOT_COLOR[status.kind] }}
          />
          <span className="text-[9px] opacity-60">{remotes.length + (local.stream ? 1 : 0)} connected</span>
        </div>

        {/* Honest degradation strip — never a mock actor standing in. */}
        {degradedReason && (
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/50 border text-[10px]"
            style={{ borderColor: 'var(--tavern-border)', color: 'var(--rp-parchment-300)' }}
          >
            <WifiOff className="w-3 h-3" style={{ color: 'var(--rp-crimson-600)' }} />
            <span>
              Video unavailable — {degradedReason}
              {status.kind === 'online' && !local.stream && !local.error
                ? ' · enable your camera below to join the video'
                : ''}
            </span>
          </div>
        )}

        <div className="flex items-center space-x-2.5">
          {/* Remote peers — only ever REAL connections. */}
          {remotes.length === 0 && status.kind === 'online' && !degradedReason && (
            <div
              className="px-2 py-1 rounded-lg bg-black/30 border border-dashed text-[10px] italic"
              style={{ borderColor: 'var(--tavern-border)', color: 'var(--rp-parchment-300)' }}
            >
              No other players connected yet.
            </div>
          )}
          {remotes.map((peer) =>
            renderTileFrame(
              peer.peerId,
              peer.name || peer.userId,
              peer.hasLiveVideo ? (
                <video
                  data-peer-id={peer.peerId}
                  ref={(el) => {
                    if (el) remoteVideoRefs.current.set(peer.peerId, el);
                    else remoteVideoRefs.current.delete(peer.peerId);
                  }}
                  autoPlay
                  playsInline
                  muted /* audio plays through the mesh's mixer-owned sink */
                  className="w-full h-full object-cover"
                />
              ) : null,
              <span className="text-[9px] opacity-60 px-1">
                {peer.hasLiveVideo ? 'live' : peer.isMuted ? 'muted' : 'audio-only'}
              </span>,
              false // remote speaking ring arrives with the spatial-audio wave
            )
          )}

          {/* Local preview — present only after an explicit camera grant. */}
          {(local.cameraOn || local.stream) &&
            renderTileFrame(
              'self',
              'You',
              local.stream ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted /* mandatory: avoid speaker→mic feedback */
                  className={`w-full h-full object-cover ${local.cameraOn ? '' : 'opacity-20'}`}
                />
              ) : null,
              <>
                <button
                  onClick={toggleLocalMic}
                  className={`p-1 rounded transition cursor-pointer ${
                    local.micOn ? 'bg-black/60 text-white' : ''
                  }`}
                  style={!local.micOn ? { backgroundColor: 'var(--rp-crimson-600)', color: '#fff' } : undefined}
                  title={local.micOn ? 'Mute microphone' : 'Unmute microphone'}
                >
                  {local.micOn ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3" />}
                </button>
                <button
                  onClick={toggleLocalCamera}
                  className="p-1 rounded transition cursor-pointer bg-black/60 hover:text-white"
                  style={{ color: local.cameraOn ? 'var(--tavern-accent)' : undefined }}
                  title={local.cameraOn ? 'Turn Off Camera' : 'Turn On Camera'}
                >
                  {local.cameraOn ? <Video className="w-3 h-3" /> : <VideoOff className="w-3 h-3" />}
                </button>
              </>,
              local.isSpeaking
            )}

          {/* Camera opt-in affordance while no grant exists yet. */}
          {!local.stream && (
            renderTileFrame(
              'self-off',
              'You',
              null,
              <button
                onClick={toggleLocalCamera}
                className="p-1 rounded transition cursor-pointer bg-black/60 hover:text-white ml-auto"
                style={{ color: 'var(--tavern-accent)' }}
                title="Enable camera & join the video mesh"
              >
                <VideoOff className="w-3 h-3" />
              </button>,
              false
            )
          )}
        </div>
      </div>

      <button
        onClick={onToggleVisible}
        className="p-1.5 mt-0.5 hover:bg-white/10 text-[var(--rp-parchment-300)] hover:text-white rounded-lg transition cursor-pointer"
        title="Minimize Video Strip"
      >
        <ChevronUp className="w-4 h-4" />
      </button>
    </div>
  );
};
