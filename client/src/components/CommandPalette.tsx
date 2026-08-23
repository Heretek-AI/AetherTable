import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  BookOpen,
  Skull,
  Swords,
  Layers,
  Sparkles,
  Command,
  ArrowRight,
  X,
  Compass,
  Zap,
  Flame,
} from 'lucide-react';
import { SaaSView } from './Navbar';
import { globalAudio } from '../render/audio_manager';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (view: SaaSView) => void;
  onExecuteRoll?: (expression: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onNavigate,
  onExecuteRoll,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);

      const handleGlobalEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      };

      window.addEventListener('keydown', handleGlobalEsc);
      return () => window.removeEventListener('keydown', handleGlobalEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const allItems = [
    // Navigation
    { id: 'nav_tabletop', category: 'Navigation', title: 'Tactical Tabletop', subtitle: 'Live battlemap canvas & initiative order', icon: <Swords className="w-4 h-4 text-sky-400" />, action: () => onNavigate('tabletop') },
    { id: 'nav_compendium', category: 'Navigation', title: 'Compendium Codex', subtitle: '319 Spells & 318 Monsters', icon: <BookOpen className="w-4 h-4 text-amber-400" />, action: () => onNavigate('compendium') },
    { id: 'nav_builder', category: 'Navigation', title: 'Character Studio (5-Step Wizard)', subtitle: 'Create hero, 27-pt buy, export PDF', icon: <Sparkles className="w-4 h-4 text-purple-400" />, action: () => onNavigate('builder') },
    { id: 'nav_marketplace', category: 'Navigation', title: 'Campaign Marketplace', subtitle: 'Install .vttbundle modules & homebrew', icon: <Compass className="w-4 h-4 text-emerald-400" />, action: () => onNavigate('marketplace') },
    { id: 'nav_admin', category: 'Navigation', title: 'Platform Admin Console', subtitle: 'Cluster telemetry, users, RBAC roles', icon: <Zap className="w-4 h-4 text-rose-400" />, action: () => onNavigate('admin') },
    
    // Spells
    { id: 'spell_fireball', category: 'Spells (SRD)', title: 'Fireball', subtitle: '3rd-level Evocation · 8d6 Fire 20ft Sphere', icon: <Flame className="w-4 h-4 text-orange-400" />, action: () => { if (onExecuteRoll) onExecuteRoll('8d6'); } },
    { id: 'spell_shield', category: 'Spells (SRD)', title: 'Shield', subtitle: '1st-level Abjuration · +5 AC Reaction', icon: <Sparkles className="w-4 h-4 text-sky-400" />, action: () => { if (onExecuteRoll) onExecuteRoll('1d20+5'); } },
    { id: 'spell_cure_wounds', category: 'Spells (SRD)', title: 'Cure Wounds', subtitle: '1st-level Evocation · 1d8 + MOD Healing', icon: <Sparkles className="w-4 h-4 text-emerald-400" />, action: () => { if (onExecuteRoll) onExecuteRoll('1d8+3'); } },

    // Monsters
    { id: 'mon_dragon', category: 'Monsters (SRD)', title: 'Adult Red Dragon', subtitle: 'CR 17 Huge Dragon · 256 HP · 19 AC', icon: <Skull className="w-4 h-4 text-rose-400" />, action: () => onNavigate('compendium') },
    { id: 'mon_orc', category: 'Monsters (SRD)', title: 'Orc Warlord', subtitle: 'CR 3 Medium Humanoid · 58 HP · 16 AC', icon: <Skull className="w-4 h-4 text-amber-400" />, action: () => onNavigate('tabletop') },
  ];

  const filteredItems = allItems.filter(
    (item) =>
      item.title.toLowerCase().includes(query.toLowerCase()) ||
      item.subtitle.toLowerCase().includes(query.toLowerCase()) ||
      item.category.toLowerCase().includes(query.toLowerCase())
  );

  const handleSelect = (item: typeof allItems[0]) => {
    item.action();
    globalAudio.playTurnAdvance();
    onClose();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length));
    } else if (e.key === 'Enter' && filteredItems[selectedIndex]) {
      e.preventDefault();
      handleSelect(filteredItems[selectedIndex]);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-start justify-center pt-24 p-4 cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full shadow-2xl overflow-hidden animate-fadeIn flex flex-col font-sans cursor-default"
      >
        {/* Search Bar */}
        <div className="p-3.5 border-b border-slate-800 flex items-center space-x-3 bg-slate-950/80">
          <Search className="w-5 h-5 text-amber-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Type a command, spell, monster, or view..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none font-mono"
          />
          <button
            type="button"
            onClick={onClose}
            className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 rounded transition cursor-pointer"
            title="Press Escape or click to close"
          >
            ESC
          </button>
        </div>

        {/* Results List */}
        <div className="max-h-80 overflow-y-auto p-2 space-y-1">
          {filteredItems.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500 font-mono">
              No matching commands or compendium entries found.
            </div>
          ) : (
            filteredItems.map((item, idx) => (
              <div
                key={item.id}
                onClick={() => handleSelect(item)}
                className={`p-2.5 rounded-xl border flex items-center justify-between transition cursor-pointer ${
                  idx === selectedIndex
                    ? 'bg-slate-800/90 border-amber-500/50 shadow'
                    : 'bg-slate-950/40 border-transparent hover:bg-slate-850'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-slate-900 rounded-lg border border-slate-800">
                    {item.icon}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-100 flex items-center space-x-2">
                      <span>{item.title}</span>
                      <span className="text-[9px] font-mono px-1.5 py-0.2 bg-slate-900 border border-slate-800 text-slate-400 rounded">
                        {item.category}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono mt-0.5">{item.subtitle}</div>
                  </div>
                </div>

                <ArrowRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-amber-400" />
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-2.5 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-[10px] font-mono text-slate-500">
          <div className="flex items-center space-x-2">
            <span>Navigation & Compendium Hot-Search</span>
          </div>
          <div className="flex items-center space-x-2">
            <span>Select: ↵</span>
            <span>Close: Esc</span>
          </div>
        </div>
      </div>
    </div>
  );
};
