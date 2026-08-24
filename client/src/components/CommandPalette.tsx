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
  Gem,
  Feather,
  ScrollText,
  Keyboard,
} from 'lucide-react';
import { SaaSView } from './Navbar';
import { globalAudio } from '../render/audio_manager';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (view: SaaSView) => void;
  onExecuteRoll?: (expression: string) => void;
  onOpenShortcuts?: () => void;
}

interface PaletteItem {
  id: string;
  category: string;
  title: string;
  subtitle: string;
  icon: JSX.Element;
  action: () => void;
}

const COMPENDIUM_SOURCES: Array<{
  url: string;
  key: string;
  category: string;
  icon: JSX.Element;
  subtitleOf: (entry: any) => string;
}> = [
  {
    url: '/api/v1/compendium/spells?limit=400',
    key: 'spells',
    category: 'Spells (SRD)',
    icon: <Sparkles className="w-4 h-4 text-[var(--rp-crimson-400)]" />,
    subtitleOf: (s) => `${s.level === 0 ? 'Cantrip' : `${s.level}${s.level === 1 ? 'st' : s.level === 2 ? 'nd' : s.level === 3 ? 'rd' : 'th'}-level`} ${s.school || ''} · ${s.casting_time || ''}`.trim(),
  },
  {
    url: '/api/v1/compendium/magic-items?limit=300',
    key: 'magic_items',
    category: 'Magic Items (SRD)',
    icon: <Gem className="w-4 h-4 text-tavern-accent" />,
    subtitleOf: (i) => `${i.rarity || 'Common'} ${i.category || ''}${i.requires_attunement ? ' · Attunement' : ''}`.trim(),
  },
  {
    url: '/api/v1/compendium/feats?limit=100',
    key: 'feats',
    category: 'Feats (SRD)',
    icon: <Feather className="w-4 h-4 text-emerald-400" />,
    subtitleOf: (f) => `${f.category} Feat${f.prerequisite ? ` · Requires ${f.prerequisite}` : ''}`,
  },
  {
    url: '/api/v1/compendium/glossary?limit=200',
    key: 'glossary',
    category: 'Rules Glossary (SRD)',
    icon: <ScrollText className="w-4 h-4 text-[var(--rp-parchment-300)]" />,
    subtitleOf: (t) => `${t.tag ? `[${t.tag}] ` : ''}${(t.definition || '').slice(0, 70)}...`,
  },
];

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onNavigate,
  onExecuteRoll,
  onOpenShortcuts,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [compendiumEntries, setCompendiumEntries] = useState<PaletteItem[]>([]);

  // Live-index the SRD 5.2 compendium so Cmd+K searches real rules data
  // (spells, magic items, feats, glossary) rather than a hardcoded sample.
  useEffect(() => {
    if (!isOpen || compendiumEntries.length > 0) return;

    const loadCompendium = async () => {
      try {
        const results = await Promise.all(
          COMPENDIUM_SOURCES.map((src) =>
            fetch(src.url)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        );
        const entries: PaletteItem[] = [];
        results.forEach((payload, i) => {
          if (!payload) return;
          const src = COMPENDIUM_SOURCES[i];
          const list: any[] = payload[src.key] || [];
          list.slice(0, 200).forEach((entry: any) => {
            entries.push({
              id: `${src.category}-${entry.id}`,
              category: src.category,
              title: entry.name || entry.term,
              subtitle: src.subtitleOf(entry),
              icon: src.icon,
              action: () => onNavigate('compendium'),
            });
          });
        });
        setCompendiumEntries(entries);
      } catch (e) {
        console.warn('CommandPalette compendium index unavailable.');
      }
    };
    loadCompendium();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
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
    { id: 'nav_tabletop', category: 'Navigation', title: 'Tactical Tabletop', subtitle: 'Live battlemap canvas & initiative order', icon: <Swords className="w-4 h-4 text-[var(--rp-crimson-400)]" />, action: () => onNavigate('tabletop') },
    { id: 'nav_compendium', category: 'Navigation', title: 'Compendium Codex', subtitle: 'SRD 5.2 · 352 Spells · 330 Statblocks · 260 Magic Items', icon: <BookOpen className="w-4 h-4 text-tavern-accent" />, action: () => onNavigate('compendium') },
    { id: 'nav_builder', category: 'Navigation', title: 'Character Studio (5-Step Wizard)', subtitle: 'Create hero, 27-pt buy, export PDF', icon: <Sparkles className="w-4 h-4 text-[var(--rp-parchment-300)]" />, action: () => onNavigate('builder') },
    { id: 'nav_marketplace', category: 'Navigation', title: 'Campaign Marketplace', subtitle: 'Install .vttbundle modules & homebrew', icon: <Compass className="w-4 h-4 text-emerald-400" />, action: () => onNavigate('marketplace') },
    { id: 'nav_admin', category: 'Navigation', title: 'Platform Admin Console', subtitle: 'Cluster telemetry, users, RBAC roles', icon: <Zap className="w-4 h-4 text-rose-400" />, action: () => onNavigate('admin') },
    // Help & discoverability
    { id: 'help_shortcuts', category: 'Help', title: 'Keyboard Shortcuts', subtitle: 'Cheat-sheet for every shortcut (also press ? anywhere)', icon: <Keyboard className="w-4 h-4 text-[var(--rp-parchment-200)]" />, action: () => { onClose(); onOpenShortcuts?.(); } },

    // Spells
    { id: 'spell_fireball', category: 'Spells (SRD)', title: 'Fireball', subtitle: '3rd-level Evocation · 8d6 Fire 20ft Sphere', icon: <Flame className="w-4 h-4 text-orange-400" />, action: () => { if (onExecuteRoll) onExecuteRoll('8d6'); } },
    { id: 'spell_shield', category: 'Spells (SRD)', title: 'Shield', subtitle: '1st-level Abjuration · +5 AC Reaction', icon: <Sparkles className="w-4 h-4 text-[var(--rp-crimson-400)]" />, action: () => { if (onExecuteRoll) onExecuteRoll('1d20+5'); } },
    { id: 'spell_cure_wounds', category: 'Spells (SRD)', title: 'Cure Wounds', subtitle: '1st-level Evocation · 1d8 + MOD Healing', icon: <Sparkles className="w-4 h-4 text-emerald-400" />, action: () => { if (onExecuteRoll) onExecuteRoll('1d8+3'); } },

    // Monsters
    { id: 'mon_dragon', category: 'Monsters (SRD)', title: 'Adult Red Dragon', subtitle: 'CR 17 Huge Dragon · 256 HP · 19 AC', icon: <Skull className="w-4 h-4 text-rose-400" />, action: () => onNavigate('compendium') },
    { id: 'mon_orc', category: 'Monsters (SRD)', title: 'Orc Warlord', subtitle: 'CR 3 Medium Humanoid · 58 HP · 16 AC', icon: <Skull className="w-4 h-4 text-tavern-accent" />, action: () => onNavigate('tabletop') },
  ].concat(compendiumEntries);

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
      className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-start justify-center pt-24 p-4 cursor-pointer"
      style={{ zIndex: 'var(--z-command)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="vtt-glass-panel rounded-2xl max-w-xl w-full overflow-hidden animate-fadeIn flex flex-col cursor-default"
      >
        {/* Search Bar */}
        <div className="p-3.5 border-b border-tavern-border flex items-center space-x-3 bg-tavern-bg/60">
          <Search className="w-5 h-5 text-tavern-accent shrink-0" />
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
            className="vtt-input flex-1 text-sm"
          />
          <button
            type="button"
            onClick={onClose}
            className="vtt-btn vtt-btn-secondary px-1.5 py-0.5 text-[10px] font-mono"
            title="Press Escape or click to close"
          >
            ESC
          </button>
        </div>

        {/* Results List */}
        <div className="max-h-80 overflow-y-auto p-2 space-y-1 vtt-scrollbar">
          {filteredItems.length === 0 ? (
            <div className="p-6 text-center text-xs text-[var(--rp-parchment-300)] font-mono">
              No matching commands or compendium entries found.
            </div>
          ) : (
            filteredItems.map((item, idx) => (
              <div
                key={item.id}
                onClick={() => handleSelect(item)}
                className={`group p-2.5 rounded-xl border flex items-center justify-between transition cursor-pointer ${
                  idx === selectedIndex
                    ? 'bg-[color-mix(in_srgb,var(--rp-leather-700)_40%,transparent)] border-tavern-accent'
                    : 'border-transparent hover:bg-[color-mix(in_srgb,var(--rp-leather-700)_30%,transparent)] hover:text-[var(--rp-parchment-100)]'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-tavern-bg rounded-lg border border-tavern-border">
                    {item.icon}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-[var(--rp-parchment-100)] flex items-center space-x-2">
                      <span>{item.title}</span>
                      <span className="text-[10px] px-1 text-tavern-accent [font-variant:small-caps] tracking-wider">
                        {item.category}
                      </span>
                    </div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] mt-0.5">{item.subtitle}</div>
                  </div>
                </div>

                <ArrowRight className="w-3.5 h-3.5 text-[var(--rp-leather-600)] group-hover:text-tavern-accent" />
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-2.5 bg-tavern-bg border-t border-tavern-border flex items-center justify-between text-[10px] font-mono text-[var(--rp-parchment-300)]">
          <div className="flex items-center space-x-2">
            <span>Navigation &amp; Compendium Hot-Search</span>
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
