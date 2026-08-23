import React, { useState, useEffect, useRef } from 'react';
import { 
  Volume2, 
  VolumeX, 
  Radio, 
  Headphones, 
  Sliders, 
  Mic, 
  X, 
  Sparkles, 
  Swords, 
  Flame, 
  Activity, 
  ShieldAlert, 
  Users 
} from 'lucide-react';
import { globalSpatialAudio } from '../render/spatial_audio';
import { globalWebRTCMesh, PeerAudioState } from '../render/webrtc_mesh';
import { Token } from './TacticalCanvas';

interface AudioMixerModalProps {
  isOpen: boolean;
  onClose: () => void;
  tokens: Token[];
  selectedTokenId: string | null;
}

export const AudioMixerModal: React.FC<AudioMixerModalProps> = ({
  isOpen,
  onClose,
  tokens,
  selectedTokenId,
}) => {
  const [masterVolume, setMasterVolume] = useState(0.8);
  const [isSpatialEnabled, setIsSpatialEnabled] = useState(true);
  const [peers, setPeers] = useState<PeerAudioState[]>([]);
  const radarCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const selectedToken = tokens.find((t) => t.id === selectedTokenId) || tokens[0];

  useEffect(() => {
    globalWebRTCMesh.onPeersUpdated((updatedPeers) => {
      setPeers(updatedPeers);
    });
  }, []);

  // Update spatial listener position whenever selected token changes
  useEffect(() => {
    if (selectedToken) {
      globalSpatialAudio.setListenerPosition(selectedToken.x, selectedToken.y);
    }
  }, [selectedToken]);

  // Render 2D Acoustic Radar
  useEffect(() => {
    if (!isOpen) return;
    const canvas = radarCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animFrame: number;
    let angle = 0;

    const renderRadar = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const maxRadius = Math.min(cx, cy) - 16;

      // Background Radar Rings
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.2)';
      ctx.lineWidth = 1;
      [0.33, 0.66, 1.0].forEach((pct) => {
        ctx.beginPath();
        ctx.arc(cx, cy, maxRadius * pct, 0, Math.PI * 2);
        ctx.stroke();
      });

      // Crosshairs
      ctx.beginPath();
      ctx.moveTo(cx - maxRadius, cy);
      ctx.lineTo(cx + maxRadius, cy);
      ctx.moveTo(cx, cy - maxRadius);
      ctx.lineTo(cx, cy + maxRadius);
      ctx.stroke();

      // Distance labels
      ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
      ctx.font = '9px monospace';
      ctx.fillText('15 ft', cx + maxRadius * 0.33 + 4, cy - 4);
      ctx.fillText('30 ft', cx + maxRadius * 0.66 + 4, cy - 4);
      ctx.fillText('60 ft', cx + maxRadius * 1.0 - 24, cy - 4);

      // Radar Sweep Line
      angle += 0.03;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      const sweepGrad = ctx.createLinearGradient(0, 0, maxRadius, 0);
      sweepGrad.addColorStop(0, 'rgba(168, 85, 247, 0.4)');
      sweepGrad.addColorStop(1, 'rgba(168, 85, 247, 0.0)');
      ctx.fillStyle = sweepGrad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, maxRadius, 0, Math.PI / 4);
      ctx.fill();
      ctx.restore();

      // Plot Center Listener Token (Selected Token)
      ctx.fillStyle = '#a855f7';
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(selectedToken ? selectedToken.name.split(' ')[0] : 'Listener', cx + 8, cy + 3);

      // Plot Other Tokens / Sources
      const listenerX = selectedToken ? selectedToken.x : 4;
      const listenerY = selectedToken ? selectedToken.y : 4;

      tokens.forEach((t) => {
        if (t.id === selectedToken?.id) return;
        const dx = t.x - listenerX;
        const dy = t.y - listenerY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Scale distance to radar radius
        const scale = (maxRadius / 10) * Math.min(dist, 10);
        const tokenAngle = Math.atan2(dy, dx);
        const tx = cx + Math.cos(tokenAngle) * scale;
        const ty = cy + Math.sin(tokenAngle) * scale;

        // Draw Token Blip
        ctx.fillStyle = t.color || '#38bdf8';
        ctx.beginPath();
        ctx.arc(tx, ty, 5, 0, Math.PI * 2);
        ctx.fill();

        // Pulsing Ring for audio emission
        ctx.strokeStyle = t.color || '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(tx, ty, 8 + Math.sin(Date.now() * 0.005) * 2, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#94a3b8';
        ctx.font = '8px monospace';
        ctx.fillText(t.name.split(' ')[0], tx + 7, ty + 3);
      });

      animFrame = requestAnimationFrame(renderRadar);
    };

    renderRadar();
    return () => cancelAnimationFrame(animFrame);
  }, [isOpen, tokens, selectedToken]);

  if (!isOpen) return null;

  const handleMasterVolChange = (val: number) => {
    setMasterVolume(val);
    globalSpatialAudio.setMasterVolume(val);
  };

  const handleToggleSpatial = () => {
    const next = !isSpatialEnabled;
    setIsSpatialEnabled(next);
    globalSpatialAudio.setSpatialEnabled(next);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 select-none animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-purple-950/80 border border-purple-800 flex items-center justify-center text-purple-400">
              <Headphones className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-bold text-sm font-display text-slate-100 flex items-center gap-2">
                <span>3D Spatial Audio & WebRTC Voice Radar</span>
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800">
                  Web Audio API
                </span>
              </h2>
              <p className="text-[11px] text-slate-400 font-mono">
                Real-time acoustic distance rolloff & azimuth stereo panning based on battlefield coordinates.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close modal"
            autoFocus  // move keyboard focus into the dialog on open
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition"
          >
              <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Body Layout */}
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left Column: 2D Acoustic Radar Canvas */}
          <div className="flex flex-col items-center space-y-3">
            <div className="text-xs font-mono font-bold text-purple-400 uppercase tracking-wider flex items-center gap-1.5">
              <Radio className="w-4 h-4" />
              <span>Acoustic Proximity Radar</span>
            </div>

            <div className="relative p-2 bg-slate-950 rounded-2xl border border-slate-800 shadow-inner">
              <canvas
                ref={radarCanvasRef}
                width={260}
                height={260}
                className="rounded-xl block"
              />
            </div>

            {/* Spatial Sound Test Triggers */}
            <div className="w-full space-y-1.5 pt-2">
              <div className="text-[10px] font-mono text-slate-500 uppercase font-bold text-center">
                Auditory Position Tests:
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => globalSpatialAudio.playSpatialImpact(10, 4)}
                  className="px-2 py-1.5 bg-slate-800 hover:bg-purple-900/40 text-slate-200 rounded-lg text-[10px] font-mono border border-slate-700 transition"
                >
                  ⚔ Strike (Right)
                </button>
                <button
                  onClick={() => globalSpatialAudio.playSpatialSpell(4, 8)}
                  className="px-2 py-1.5 bg-slate-800 hover:bg-purple-900/40 text-slate-200 rounded-lg text-[10px] font-mono border border-slate-700 transition"
                >
                  🔥 Spell (Down)
                </button>
                <button
                  onClick={() => globalSpatialAudio.playSpatialCreatureRoar(11, 6)}
                  className="px-2 py-1.5 bg-slate-800 hover:bg-rose-900/40 text-slate-200 rounded-lg text-[10px] font-mono border border-slate-700 transition"
                >
                  🐉 Roar (Far)
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Audio Mixer & Peer Channels */}
          <div className="space-y-4">
            {/* Master Controls */}
            <div className="vtt-glass-panel p-4 rounded-xl border border-slate-800 space-y-3 shadow">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold font-display uppercase tracking-wider text-purple-400 flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Master Acoustics</span>
                </span>

                <button
                  onClick={handleToggleSpatial}
                  className={`text-[10px] font-mono px-2 py-0.5 rounded-lg border transition font-bold ${
                    isSpatialEnabled
                      ? 'bg-purple-950 text-purple-300 border-purple-600 ring-1 ring-purple-600'
                      : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}
                >
                  {isSpatialEnabled ? '3D Stereo Panning: ON' : '3D Spatial: OFF (Flat Mono)'}
                </button>
              </div>

              <div>
                <div className="flex justify-between text-xs font-mono text-slate-400 mb-1">
                  <span>Master Output Gain:</span>
                  <strong className="text-slate-200">{Math.round(masterVolume * 100)}%</strong>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={masterVolume}
                  onChange={(e) => handleMasterVolChange(parseFloat(e.target.value))}
                  className="w-full accent-purple-500 cursor-pointer"
                />
              </div>
            </div>

            {/* Peer Channels */}
            <div className="space-y-2">
              <div className="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5" />
                <span>WebRTC Voice Mesh Channels</span>
              </div>

              <div className="space-y-2 max-h-[160px] overflow-y-auto vtt-scrollbar pr-1">
                {peers.map((peer) => (
                  <div
                    key={peer.peerId}
                    className="p-2.5 bg-slate-950/70 border border-slate-800 rounded-xl flex items-center justify-between text-xs font-mono"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ${
                          peer.isSpeaking ? 'bg-emerald-400 animate-pulse' : 'bg-slate-700'
                        }`}
                      />
                      <div>
                        <div className="font-bold text-slate-200 text-xs">{peer.name}</div>
                        <div className="text-[9px] text-slate-500">
                          Pos: [{peer.x}, {peer.y}] · Vol: {Math.round(peer.volume * 100)}%
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={peer.volume}
                        onChange={(e) =>
                          globalWebRTCMesh.setPeerVolume(peer.peerId, parseFloat(e.target.value))
                        }
                        className="w-16 accent-purple-500 cursor-pointer"
                      />
                      <button
                        onClick={() => globalWebRTCMesh.togglePeerMute(peer.peerId)}
                        className={`p-1 rounded ${
                          peer.isMuted
                            ? 'bg-rose-950 text-rose-300 border border-rose-800'
                            : 'bg-slate-800 text-slate-400 hover:text-white'
                        }`}
                      >
                        {peer.isMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-3 border-t border-slate-800 bg-slate-950/60 px-6 flex items-center justify-between text-[11px] font-mono text-slate-400">
          <span>Active Acoustic Listener: <strong className="text-purple-300">{selectedToken?.name || 'Party'}</strong></span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-mono text-xs transition"
          >
            Close Mixer
          </button>
        </div>
      </div>
    </div>
  );
};
