import React, { useState } from 'react';
import { 
  Swords, 
  BookOpen, 
  Dices, 
  LineChart, 
  AlertOctagon, 
  Wifi, 
  Layers, 
  Volume2, 
  VolumeX, 
  CheckCircle2, 
  Sparkles, 
  UserCheck, 
  Users, 
  Crown, 
  Package, 
  Radio, 
  Sliders 
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';

export type SaaSView = 'tabletop' | 'compendium' | 'builder' | 'lobby' | 'dynasty' | 'bundles' | 'wfc' | 'analytics';

interface NavbarProps {
  currentView: SaaSView;
  onSelectView: (view: SaaSView) => void;
  onOpenSafety: () => void;
  onOpenAudioMixer?: () => void;
  latencyMs: number;
  campaignName: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentView,
  onSelectView,
  onOpenSafety,
  onOpenAudioMixer,
  latencyMs,
  campaignName,
}) => {
  const [isMuted, setIsMuted] = useState(false);

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    globalAudio.isMuted = next;
  };

  const navItems: { id: SaaSView; label: string; icon: React.ReactNode }[] = [
    { id: 'tabletop', label: 'Tactical Tabletop', icon: <Swords className="w-4 h-4" /> },
    { id: 'compendium', label: 'Compendium Codex', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'builder', label: 'Character Studio', icon: <UserCheck className="w-4 h-4" /> },
    { id: 'lobby', label: 'Campaign Lobby', icon: <Users className="w-4 h-4" /> },
    { id: 'dynasty', label: 'Dynasty & Factions', icon: <Crown className="w-4 h-4" /> },
    { id: 'bundles', label: 'Campaign Bundles', icon: <Package className="w-4 h-4" /> },
    { id: 'wfc', label: 'WFC Dungeon Studio', icon: <Layers className="w-4 h-4" /> },
    { id: 'analytics', label: 'SLA Telemetry', icon: <LineChart className="w-4 h-4" /> },
  ];

  return (
    <header className="h-14 border-b border-slate-800 bg-slate-950/95 backdrop-blur-md px-4 flex items-center justify-between z-30 shrink-0 select-none shadow-md">
      {/* Brand & Campaign Meta */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-purple-900/40">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5 leading-none">
              <span className="font-extrabold text-sm tracking-tight text-slate-100 font-display">
                AetherTable
              </span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800 font-bold">
                AI SaaS
              </span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono mt-0.5 truncate max-w-[160px]">
              Campaign: {campaignName}
            </span>
          </div>
        </div>
      </div>

      {/* Navigation Switcher */}
      <nav aria-label="Main Navigation" className="flex items-center bg-slate-900/80 p-1 rounded-xl border border-slate-800/80 shadow-inner">
        {navItems.map((item) => {
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectView(item.id)}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold font-mono transition-all duration-150 ${
                isActive
                  ? 'bg-purple-600 text-white shadow-md shadow-purple-950 border border-purple-400/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Telemetry & Actions */}
      <div className="flex items-center gap-3">
        {/* Audio Radar & Spatial Mixer Trigger */}
        {onOpenAudioMixer && (
          <button
            onClick={onOpenAudioMixer}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-950/60 hover:bg-purple-900/80 text-purple-300 border border-purple-800/80 text-xs font-mono transition shadow-sm"
            title="3D Spatial Audio & Voice Radar Mixer"
          >
            <Radio className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
            <span className="hidden lg:inline text-[11px]">3D Audio Radar</span>
          </button>
        )}

        {/* Audio Mute Toggle */}
        <button
          onClick={toggleMute}
          className={`p-1.5 rounded-lg border transition ${
            isMuted
              ? 'bg-slate-900 text-rose-400 border-slate-800'
              : 'bg-slate-900 text-purple-400 border-slate-800 hover:text-white'
          }`}
          title={isMuted ? 'Unmute Audio Cues' : 'Mute Audio Cues'}
        >
          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>

        {/* Live Latency Status */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-800 text-[11px] font-mono text-slate-300 shadow-inner">
          <Wifi className="w-3 h-3 text-emerald-400 animate-pulse" />
          <span>Sync: <strong className="text-emerald-400">{latencyMs}ms</strong> (60 FPS)</span>
        </div>

        {/* MCR Invariant Badge */}
        <div className="hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-800 text-[11px] font-mono text-purple-300">
          <CheckCircle2 className="w-3.5 h-3.5 text-purple-400" />
          <span>MCR: 100% · HCI: 1.0</span>
        </div>

        {/* Hardware Safety X-Card */}
        <button
          onClick={onOpenSafety}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-xs font-bold font-mono tracking-wider shadow-lg shadow-rose-950 border border-rose-400/40 transition active:scale-95"
          title="Trigger Immediate Scene Rewind"
        >
          <AlertOctagon className="w-3.5 h-3.5" />
          <span>X-CARD</span>
        </button>
      </div>
    </header>
  );
};
