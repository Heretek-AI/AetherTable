import React, { useEffect, useState } from 'react';
import {
  Video,
  VideoOff,
  Mic,
  MicOff,
  ChevronUp,
  Radio,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { globalWebRTCMesh } from '../render/webrtc_mesh';

interface PeerVideoUser {
  id: string;
  name: string;
  role: 'GM' | 'Fighter' | 'Wizard' | 'Rogue';
  color: string;
  avatarIcon: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isVideoOn: boolean;
}

interface VideoMeshTilesProps {
  isVisible: boolean;
  onToggleVisible: () => void;
}

export const VideoMeshTiles: React.FC<VideoMeshTilesProps> = ({
  isVisible,
  onToggleVisible,
}) => {
  const [peers, setPeers] = useState<PeerVideoUser[]>([
    {
      id: 'arthur',
      name: 'Arthur [GM]',
      role: 'GM',
      color: 'from-[var(--rp-amber-500)] to-[var(--rp-crimson-600)]',
      avatarIcon: '🧙‍♂️',
      isSpeaking: false,
      isMuted: false,
      isVideoOn: true,
    },
    {
      id: 'thorin',
      name: 'Thorin',
      role: 'Fighter',
      color: 'from-[var(--rp-leather-600)] to-[var(--rp-iron-900)]',
      avatarIcon: '🛡️',
      isSpeaking: false,
      isMuted: false,
      isVideoOn: false,
    },
    {
      id: 'lyra',
      name: 'Lyra',
      role: 'Wizard',
      color: 'from-[var(--rp-crimson-600)] to-[var(--rp-crimson-700)]',
      avatarIcon: '✨',
      isSpeaking: false,
      isMuted: true,
      isVideoOn: true,
    },
    {
      id: 'valerius',
      name: 'Valerius',
      role: 'Wizard',
      color: 'from-[var(--rp-forest-600)] to-[var(--rp-leather-700)]',
      avatarIcon: '🏹',
      isSpeaking: false,
      isMuted: false,
      isVideoOn: false,
    },
  ]);

  // Real microphone drives the local player's speaking ring; remote peers
  // stay silent until genuine P2P audio tracks land.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    globalWebRTCMesh.enableLocalVoiceDetection('peer_thorin').then(() => {
      unsubscribe = globalWebRTCMesh.onPeersUpdated((updated) => {
        setPeers((prev) =>
          prev.map((tile) => {
            const meshPeer = updated.find((p) => p.peerId === `peer_${tile.id}`);
            return meshPeer ? { ...tile, isSpeaking: meshPeer.isSpeaking } : tile;
          })
        );
      });
    });
    return () => {
      unsubscribe?.();
      globalWebRTCMesh.disableLocalVoiceDetection();
    };
  }, []);

  if (!isVisible) return null;

  const togglePeerMic = (id: string) => {
    setPeers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, isMuted: !p.isMuted } : p))
    );
    // Silent: mute toggles are frequent quiet actions; a combat chime here
    // trains users to ignore the chime that actually matters (turn advance).
  };

  const togglePeerVideo = (id: string) => {
    setPeers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, isVideoOn: !p.isVideoOn } : p))
    );
    globalAudio.playTurnAdvance();
  };

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center space-x-2.5 bg-tavern-bg/85 backdrop-blur-md p-2 rounded-2xl border border-tavern-border shadow-2xl animate-fadeIn font-mono text-xs">
      <div className="flex items-center space-x-2 pr-2 border-r border-tavern-border text-[10px] text-[var(--rp-parchment-300)]">
        <Radio className="w-3.5 h-3.5 animate-pulse" style={{ color: 'var(--state-success)' }} />
        <span className="font-bold">WEBRTC VOICE MESH</span>
      </div>

      {peers.map((peer) => (
        <div
          key={peer.id}
          className={`relative w-24 h-24 rounded-xl overflow-hidden border transition-all duration-200 flex flex-col justify-between p-1.5 ${
            peer.isSpeaking
              ? 'border-[var(--state-success)] ring-2 ring-[color-mix(in_srgb,var(--state-success)_55%,transparent)] shadow-lg scale-105'
              : 'border-tavern-border bg-tavern-bg/90'
          }`}
        >
          {/* Video Placeholder / Avatar */}
          <div className="absolute inset-0 flex items-center justify-center -z-0">
            {peer.isVideoOn ? (
              <div className={`w-full h-full bg-gradient-to-br ${peer.color} opacity-40 flex items-center justify-center`}>
                <span className="text-3xl filter drop-shadow animate-pulse">{peer.avatarIcon}</span>
              </div>
            ) : (
              <div className="w-full h-full bg-tavern-surface flex items-center justify-center">
                <span className="text-2xl opacity-60">{peer.avatarIcon}</span>
              </div>
            )}
          </div>

          {/* Top Info Badge — small-caps parchment nameplate */}
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
              {peer.name}
            </span>
            {peer.isSpeaking && (
              <span
                className="w-2 h-2 rounded-full animate-ping"
                style={{ backgroundColor: 'var(--state-success)' }}
              />
            )}
          </div>

          {/* Bottom Action Controls */}
          <div className="flex items-center justify-between z-10 pt-1">
            <button
              onClick={() => togglePeerMic(peer.id)}
              className={`p-1 rounded transition cursor-pointer ${
                peer.isMuted
                  ? '' /* muted → crimson danger token */
                  : 'bg-black/60 text-[var(--rp-parchment-300)] hover:text-white'
              }`}
              style={peer.isMuted ? { backgroundColor: 'var(--rp-crimson-600)', color: '#fff' } : undefined}
              title={peer.isMuted ? 'Unmute' : 'Mute'}
            >
              {peer.isMuted ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
            </button>

            <button
              onClick={() => togglePeerVideo(peer.id)}
              className={`p-1 rounded transition cursor-pointer ${
                !peer.isVideoOn
                  ? 'bg-tavern-surface text-[var(--rp-parchment-300)]'
                  : 'bg-black/60 hover:text-white'
              }`}
              style={!peer.isVideoOn ? undefined : { color: 'var(--tavern-accent)' }}
              title={peer.isVideoOn ? 'Turn Off Camera' : 'Turn On Camera'}
            >
              {peer.isVideoOn ? <Video className="w-3 h-3" /> : <VideoOff className="w-3 h-3" />}
            </button>
          </div>
        </div>
      ))}

      <button
        onClick={onToggleVisible}
        className="p-1.5 hover:bg-white/10 text-[var(--rp-parchment-300)] hover:text-white rounded-lg transition cursor-pointer"
        title="Minimize Video Strip"
      >
        <ChevronUp className="w-4 h-4" />
      </button>
    </div>
  );
};
