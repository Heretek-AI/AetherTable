import React from 'react';
import { 
  Sparkles, 
  Swords, 
  BookOpen, 
  Map as MapIcon, 
  Activity, 
  Wifi, 
  AlertOctagon, 
  ShieldCheck, 
  Layers
} from 'lucide-react';

export type SaaSView = 'tabletop' | 'compendium' | 'wfc' | 'analytics';

interface NavbarProps {
  currentView: SaaSView;
  onSelectView: (view: SaaSView) => void;
  onOpenSafety: () => void;
  latencyMs: number;
  campaignName: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentView,
  onSelectView,
  onOpenSafety,
  latencyMs,
  campaignName,
}) => {
  const navTabs: { id: SaaSView; label: string; icon: React.ReactNode }[] = [
    { id: 'tabletop', label: 'Tactical Tabletop', icon: <Swords className="w-4 h-4" /> },
    { id: 'compendium', label: 'Compendium Codex', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'wfc', label: 'WFC Dungeon Studio', icon: <MapIcon className="w-4 h-4" /> },
    { id: 'analytics', label: 'SLA Telemetry', icon: <Activity className="w-4 h-4" /> },
  ];

  return (
    <header className="h-14 border-b border-slate-800/80 px-4 flex items-center justify-between bg-slate-950/95 backdrop-blur-xl z-40 shrink-0">
      {/* Brand & Campaign */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-indigo-700 flex items-center justify-center shadow-lg shadow-purple-900/40 border border-purple-400/30">
            <Sparkles className="w-4 h-4 text-purple-200" />
          </div>
          <div>
            <div className="font-display font-bold text-sm tracking-wide bg-gradient-to-r from-purple-300 via-slate-100 to-indigo-200 bg-clip-text text-transparent">
              AetherTable <span className="text-purple-400 font-mono text-xs font-semibold px-1 py-0.2 bg-purple-950/80 rounded border border-purple-800/60">AI SaaS</span>
            </div>
            <div className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
              <span className="text-slate-500">Campaign:</span> {campaignName}
            </div>
          </div>
        </div>

        <div className="h-5 w-px bg-slate-800 mx-1 hidden md:block" />

        {/* View Switcher Tabs */}
        <nav className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-lg border border-slate-800/80">
          {navTabs.map((tab) => {
            const isActive = currentView === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => onSelectView(tab.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-purple-600 text-white shadow-md shadow-purple-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Right Controls & Telemetry */}
      <div className="flex items-center gap-3 font-mono text-xs">
        {/* CRDT Vector Clock Telemetry */}
        <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 bg-slate-900/80 border border-slate-800 rounded-md text-emerald-400">
          <Wifi className="w-3.5 h-3.5" />
          <span>Sync: {latencyMs}ms (60 FPS)</span>
        </div>

        {/* Invariant Auditor Compliance Status */}
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-slate-900/80 border border-slate-800 rounded-md text-purple-300">
          <ShieldCheck className="w-3.5 h-3.5 text-purple-400" />
          <span>MCR: 100% · HCI: 1.0</span>
        </div>

        {/* Hardware X-Card Safety Control */}
        <button
          onClick={onOpenSafety}
          className="flex items-center gap-1.5 px-3 py-1 bg-gradient-to-r from-rose-600 to-red-700 hover:from-rose-500 hover:to-red-600 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-rose-950 border border-rose-500/40"
        >
          <AlertOctagon className="w-4 h-4" />
          <span>X-CARD</span>
        </button>
      </div>
    </header>
  );
};
