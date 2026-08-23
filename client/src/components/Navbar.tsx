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
  Sliders,
  Scroll,
  Flame,
  Globe,
  Settings,
  ShieldAlert,
  LogOut,
  User as UserIcon,
  ChevronDown,
  ShoppingBag,
  Music,
  Search,
  Command
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { User, DEMO_ACCOUNTS } from '../types/auth';

export type SaaSView = 'landing' | 'tabletop' | 'compendium' | 'builder' | 'encounters' | 'marketplace' | 'lobby' | 'dynasty' | 'bundles' | 'quests' | 'wfc' | 'analytics' | 'admin';

interface NavbarProps {
  currentView: SaaSView;
  onSelectView: (view: SaaSView) => void;
  onOpenSafety: () => void;
  onOpenAudioMixer?: () => void;
  onOpenJukebox?: () => void;
  onOpenCommandPalette?: () => void;
  onOpenSubscription?: () => void;
  onOpenUserSettings?: () => void;
  onOpenAuth?: () => void;
  onFastSwitchUser?: (user: User) => void;
  currentUser?: User;
  latencyMs: number;
  campaignName: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentView,
  onSelectView,
  onOpenSafety,
  onOpenAudioMixer,
  onOpenJukebox,
  onOpenCommandPalette,
  onOpenSubscription,
  onOpenUserSettings,
  onOpenAuth,
  onFastSwitchUser,
  currentUser,
  latencyMs,
  campaignName,
}) => {
  const [isMuted, setIsMuted] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    globalAudio.isMuted = next;
  };

  const navItems: { id: SaaSView; label: string; icon: React.ReactNode; requiresAdmin?: boolean }[] = [
    { id: 'tabletop', label: 'Tactical Tabletop', icon: <Swords className="w-4 h-4" /> },
    { id: 'compendium', label: 'Compendium Codex', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'builder', label: 'Character Studio', icon: <UserCheck className="w-4 h-4" /> },
    { id: 'encounters', label: 'Encounter Builder', icon: <Flame className="w-4 h-4 text-orange-400" /> },
    { id: 'marketplace', label: 'Marketplace', icon: <ShoppingBag className="w-4 h-4 text-emerald-400" /> },
    { id: 'lobby', label: 'Campaign Lobby', icon: <Users className="w-4 h-4" /> },
    { id: 'dynasty', label: 'Dynasty & Factions', icon: <Crown className="w-4 h-4" /> },
    { id: 'bundles', label: 'Campaign Bundles', icon: <Package className="w-4 h-4" /> },
    { id: 'quests', label: 'Quest & Dialogue', icon: <Scroll className="w-4 h-4" /> },
    { id: 'wfc', label: 'WFC Dungeon Studio', icon: <Layers className="w-4 h-4" /> },
    { id: 'analytics', label: 'SLA Telemetry', icon: <LineChart className="w-4 h-4" /> },
    { id: 'admin', label: 'Admin Console', icon: <ShieldAlert className="w-4 h-4 text-rose-400" />, requiresAdmin: true },
  ];

  const visibleNavItems = navItems.filter(
    (item) => !item.requiresAdmin || (currentUser && currentUser.role === 'admin')
  );

  return (
    <header className="h-14 border-b border-slate-800 bg-slate-950/95 backdrop-blur-md px-4 flex items-center justify-between z-30 shrink-0 select-none shadow-md">
      {/* Brand & Campaign Meta */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => onSelectView('landing')}
          className="flex items-center gap-2 hover:opacity-90 transition cursor-pointer text-left"
          title="Return to SaaS Landing Page"
        >
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-red-600 flex items-center justify-center shadow-lg shadow-amber-950/50">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5 leading-none">
              <span className="font-extrabold text-sm tracking-tight text-slate-100 font-serif">
                AetherTable
              </span>
              <span className="text-[9px] uppercase font-mono px-1.5 py-0.2 rounded bg-amber-950 text-amber-300 border border-amber-600/50 font-bold">
                AI SaaS
              </span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono mt-0.5 truncate max-w-[130px]">
              {campaignName}
            </span>
          </div>
        </button>

        {/* Global Fast Search Command Palette Button */}
        {onOpenCommandPalette && (
          <button
            onClick={onOpenCommandPalette}
            className="hidden lg:flex items-center space-x-2 px-2.5 py-1 bg-slate-900/90 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/50 text-slate-400 hover:text-slate-200 rounded-lg text-xs font-mono transition shadow-inner cursor-pointer"
            title="Open Universal Search Palette (Cmd+K)"
          >
            <Search className="w-3.5 h-3.5 text-amber-400" />
            <span>Search Compendium...</span>
            <span className="text-[9px] px-1 py-0.2 bg-slate-950 border border-slate-700 text-slate-400 rounded">
              ⌘K
            </span>
          </button>
        )}
      </div>

      {/* Navigation Switcher */}
      <nav aria-label="Main Navigation" className="flex items-center bg-slate-900/80 p-1 rounded-xl border border-slate-800/80 shadow-inner overflow-x-auto">
        {visibleNavItems.map((item) => {
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectView(item.id)}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold font-mono transition-all duration-150 cursor-pointer whitespace-nowrap ${
                isActive
                  ? 'bg-amber-600 text-white shadow-md shadow-amber-950 border border-amber-400/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Telemetry, User Profile Menu & Actions */}
      <div className="flex items-center gap-2">
        {/* Jukebox Ambient Soundscapes Trigger */}
        {onOpenJukebox && (
          <button
            onClick={onOpenJukebox}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/80 text-indigo-300 border border-indigo-800/80 text-xs font-mono transition shadow-sm cursor-pointer"
            title="Tactical Jukebox & Ambient Soundscapes"
          >
            <Music className="w-3.5 h-3.5 text-indigo-400" />
            <span className="hidden xl:inline text-[11px]">Jukebox</span>
          </button>
        )}

        {/* Audio Radar & Spatial Mixer Trigger */}
        {onOpenAudioMixer && (
          <button
            onClick={onOpenAudioMixer}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-950/60 hover:bg-purple-900/80 text-purple-300 border border-purple-800/80 text-xs font-mono transition shadow-sm cursor-pointer"
            title="3D Spatial Audio & Voice Radar Mixer"
          >
            <Radio className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
            <span className="hidden xl:inline text-[11px]">3D Audio Radar</span>
          </button>
        )}

        {/* User Profile & Multi-User Menu */}
        {currentUser ? (
          <div className="relative">
            <button
              onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
              className="flex items-center space-x-2 p-1.5 bg-slate-900 hover:bg-slate-850 border border-slate-700 hover:border-amber-500/60 rounded-xl transition cursor-pointer"
            >
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center text-slate-950 font-bold text-xs shadow">
                {currentUser.displayName.charAt(0)}
              </div>
              <div className="hidden lg:flex flex-col text-left">
                <span className="text-[11px] font-bold text-slate-200 leading-none">
                  {currentUser.displayName.split(' ')[0]}
                </span>
                <span className="text-[9px] font-mono text-amber-400 uppercase font-semibold">
                  {currentUser.role}
                </span>
              </div>
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>

            {/* Dropdown Menu */}
            {isUserMenuOpen && (
              <div className="absolute right-0 top-12 w-64 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-2 z-50 animate-fadeIn space-y-1 font-mono text-xs">
                <div className="p-2 border-b border-slate-800 text-left">
                  <div className="font-bold text-slate-100">{currentUser.displayName}</div>
                  <div className="text-[10px] text-slate-400 truncate">{currentUser.email}</div>
                  <div className="flex items-center space-x-1.5 mt-1">
                    <span className="px-1.5 py-0.2 bg-amber-950 text-amber-300 border border-amber-600/50 rounded text-[9px] font-bold uppercase">
                      {currentUser.role}
                    </span>
                    <span className="px-1.5 py-0.2 bg-purple-950 text-purple-300 border border-purple-600/50 rounded text-[9px] font-bold uppercase">
                      {currentUser.subscriptionTier} Tier
                    </span>
                  </div>
                </div>

                {/* Switch Perspective (Multiplayer Simulator) */}
                <div className="p-1 text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                  Switch Client Perspective
                </div>
                {DEMO_ACCOUNTS.map((demo) => (
                  <button
                    key={demo.user.id}
                    onClick={() => {
                      if (onFastSwitchUser) onFastSwitchUser(demo.user);
                      setIsUserMenuOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left transition cursor-pointer ${
                      currentUser.id === demo.user.id ? 'bg-amber-950/60 text-amber-300 font-bold' : 'hover:bg-slate-800 text-slate-300'
                    }`}
                  >
                    <span>{demo.user.displayName.split(' ')[0]}</span>
                    <span className="text-[9px] opacity-70">[{demo.user.role.toUpperCase()}]</span>
                  </button>
                ))}

                <div className="border-t border-slate-800 pt-1">
                  {onOpenUserSettings && (
                    <button
                      onClick={() => {
                        onOpenUserSettings();
                        setIsUserMenuOpen(false);
                      }}
                      className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-lg text-slate-300 hover:bg-slate-800 hover:text-white transition cursor-pointer"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      <span>User Settings</span>
                    </button>
                  )}

                  {currentUser.role === 'admin' && (
                    <button
                      onClick={() => {
                        onSelectView('admin');
                        setIsUserMenuOpen(false);
                      }}
                      className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-lg text-rose-300 hover:bg-rose-950/60 transition cursor-pointer font-bold"
                    >
                      <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                      <span>Admin Console</span>
                    </button>
                  )}

                  {onOpenAuth && (
                    <button
                      onClick={() => {
                        onOpenAuth();
                        setIsUserMenuOpen(false);
                      }}
                      className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-rose-400 transition cursor-pointer"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Switch Account / Sign Out</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          onOpenAuth && (
            <button
              onClick={onOpenAuth}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs rounded-lg shadow transition cursor-pointer"
            >
              Sign In
            </button>
          )
        )}

        {/* Audio Mute Toggle */}
        <button
          onClick={toggleMute}
          className={`p-1.5 rounded-lg border transition cursor-pointer ${
            isMuted
              ? 'bg-slate-900 text-rose-400 border-slate-800'
              : 'bg-slate-900 text-amber-400 border-slate-800 hover:text-white'
          }`}
          title={isMuted ? 'Unmute Audio Cues' : 'Mute Audio Cues'}
        >
          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>

        {/* Live Latency Status */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-900/80 border border-slate-800 text-[11px] font-mono text-slate-300 shadow-inner">
          <Wifi className="w-3 h-3 text-emerald-400 animate-pulse" />
          <span>Sync: <strong className="text-emerald-400">{latencyMs}ms</strong></span>
        </div>

        {/* Hardware Safety X-Card */}
        <button
          onClick={onOpenSafety}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-xs font-bold font-mono tracking-wider shadow-lg shadow-rose-950 border border-rose-400/40 transition active:scale-95 cursor-pointer"
          title="Trigger Immediate Scene Rewind"
        >
          <AlertOctagon className="w-3.5 h-3.5" />
          <span>X-CARD</span>
        </button>
      </div>
    </header>
  );
};
