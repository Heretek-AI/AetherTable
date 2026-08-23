import React, { useEffect, useState } from 'react';
import {
  Video,
  VideoOff,
  Mic,
  MicOff,
  Volume2,
  Users,
  ChevronUp,
  ChevronDown,
  Sparkles,
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
      color: 'from-amber-600 to-red-700',
      avatarIcon: '🧙‍♂️',
      isSpeaking: false,
      isMuted: false,
      isVideoOn: true,
    },
    {
      id: 'thorin',
      name: 'Thorin',
      role: 'Fighter',
      color: 'from-blue-600 to-indigo-800',
      avatarIcon: '🛡️',
      isSpeaking: false,
      isMuted: false,
      isVideoOn: false,
    },
    {
      id: 'lyra',
      name: 'Lyra',
      role: 'Wizard',
      color: 'from-purple-600 to-violet-800',
      avatarIcon: '✨',
      isSpeaking: false,
      isMuted: true,
      isVideoOn: true,
    },
    {
      id: 'valerius',
      name: 'Valerius',
      role: 'Wizard',
      color: 'from-emerald-600 to-teal-800',
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
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center space-x-2.5 bg-slate-950/85 backdrop-blur-md p-2 rounded-2xl border border-slate-800 shadow-2xl animate-fadeIn font-mono text-xs">
      <div className="flex items-center space-x-2 pr-2 border-r border-slate-800 text-[10px] text-slate-400">
        <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
        <span className="font-bold">WEBRTC VOICE MESH</span>
      </div>

      {peers.map((peer) => (
        <div
          key={peer.id}
          className={`relative w-24 h-24 rounded-xl overflow-hidden border transition-all duration-200 flex flex-col justify-between p-1.5 ${
            peer.isSpeaking
              ? 'border-emerald-400 ring-2 ring-emerald-500/50 shadow-lg shadow-emerald-950/50 scale-105'
              : 'border-slate-800 bg-slate-900/90'
          }`}
        >
          {/* Video Placeholder / Avatar */}
          <div className="absolute inset-0 flex items-center justify-center -z-0">
            {peer.isVideoOn ? (
              <div className={`w-full h-full bg-gradient-to-br ${peer.color} opacity-40 flex items-center justify-center`}>
                <span className="text-3xl filter drop-shadow animate-pulse">{peer.avatarIcon}</span>
              </div>
            ) : (
              <div className="w-full h-full bg-slate-900 flex items-center justify-center">
                <span className="text-2xl opacity-60">{peer.avatarIcon}</span>
              </div>
            )}
          </div>

          {/* Top Info Badge */}
          <div className="flex items-center justify-between z-10">
            <span className="px-1.5 py-0.2 bg-slate-950/80 rounded text-[9px] font-bold text-slate-200 truncate max-w-[55px]">
              {peer.name}
            </span>
            {peer.isSpeaking && (
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            )}
          </div>

          {/* Bottom Action Controls */}
          <div className="flex items-center justify-between z-10 pt-1">
            <button
              onClick={() => togglePeerMic(peer.id)}
              className={`p-1 rounded transition cursor-pointer ${
                peer.isMuted
                  ? 'bg-rose-600/90 text-white'
                  : 'bg-slate-950/70 text-slate-300 hover:text-white'
              }`}
              title={peer.isMuted ? 'Unmute' : 'Mute'}
            >
              {peer.isMuted ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
            </button>

            <button
              onClick={() => togglePeerVideo(peer.id)}
              className={`p-1 rounded transition cursor-pointer ${
                !peer.isVideoOn
                  ? 'bg-slate-800 text-slate-400'
                  : 'bg-slate-950/70 text-sky-400 hover:text-white'
              }`}
              title={peer.isVideoOn ? 'Turn Off Camera' : 'Turn On Camera'}
            >
              {peer.isVideoOn ? <Video className="w-3 h-3" /> : <VideoOff className="w-3 h-3" />}
            </button>
          </div>
        </div>
      ))}

      <button
        onClick={onToggleVisible}
        className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition cursor-pointer"
        title="Minimize Video Strip"
      >
        <ChevronUp className="w-4 h-4" />
      </button>
    </div>
  );
};
