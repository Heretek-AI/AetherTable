import React, { useState } from 'react';
import {
  ShoppingBag,
  Download,
  Sparkles,
  Star,
  Shield,
  Layers,
  Plus,
  Search,
  Check,
  Package,
  Wand2,
  Skull,
  ExternalLink,
  Tag,
  Flame,
  ArrowRight,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';

interface CampaignBundleItem {
  id: string;
  title: string;
  author: string;
  levelRange: string;
  rating: number;
  reviewsCount: number;
  price: string;
  isFree?: boolean;
  isInstalled?: boolean;
  coverGradient: string;
  description: string;
  features: string[];
}

interface MarketplaceViewProps {
  onInstallBundle?: (bundleId: string) => void;
  onLaunchHomebrew?: (homebrewItem: any) => void;
}

export const MarketplaceView: React.FC<MarketplaceViewProps> = ({
  onInstallBundle,
  onLaunchHomebrew,
}) => {
  const [activeTab, setActiveTab] = useState<'marketplace' | 'homebrew_studio'>('marketplace');
  const [searchQuery, setSearchQuery] = useState('');
  const [installedBundles, setInstalledBundles] = useState<string[]>(['vane_1042']);

  // Homebrew Studio State
  const [hbName, setHbName] = useState('Void Golem Titan');
  const [hbType, setHbType] = useState<'monster' | 'spell'>('monster');
  const [hbCr, setHbCr] = useState('9');
  const [hbHp, setHbHp] = useState('178');
  const [hbAc, setHbAc] = useState('18');
  const [hbAction, setHbAction] = useState('Void Siphon: 4d10+5 Necrotic Damage');
  const [hbCreatedSuccess, setHbCreatedSuccess] = useState(false);

  const bundles: CampaignBundleItem[] = [
    {
      id: 'vane_1042',
      title: 'The Fall of Baron Vane',
      author: 'AetherTable Studios',
      levelRange: 'Levels 3–6',
      rating: 4.9,
      reviewsCount: 142,
      price: 'Included (Core)',
      isFree: true,
      coverGradient: 'from-amber-600 to-rose-900',
      description: 'Storm the corrupted crypts of the Baron, solve socket-carved dungeon puzzles, and defeat the Orc Warlord.',
      features: ['12 Tactical Battlemaps', '6 Pre-Built Tokens', 'Dynamic LoS Walls', 'WFC Procedural Vaults'],
    },
    {
      id: 'frost_lich_201',
      title: 'Curse of the Frost Lich',
      author: 'Grimoire Press',
      levelRange: 'Levels 5–10',
      rating: 4.8,
      reviewsCount: 98,
      price: '$9.99',
      coverGradient: 'from-cyan-800 to-blue-950',
      description: 'Venture into the howling blizzards of the Glacial Peak to shatter the phylactery of the Frost Lord.',
      features: ['Blizzard Weather FX', '3D Elevation Ice Spire', '15 Arctic Monsters', 'Custom Soundscapes'],
    },
    {
      id: 'atlantis_304',
      title: 'Sunken Ruins of Atlantis',
      author: 'Nautilus Lore',
      levelRange: 'Levels 8–12',
      rating: 5.0,
      reviewsCount: 215,
      price: '$14.99',
      coverGradient: 'from-emerald-500 to-teal-900',
      description: 'Underwater tactical combat with 3D depth raycasting, pressure hazards, and ancient aboleth sovereigns.',
      features: ['Underwater Acoustic FX', '3D Elevation Grid', 'Kraken Boss Token', 'Concordia Dialogue Tree'],
    },
    {
      id: 'shadow_queen_409',
      title: 'Tomb of the Shadow Queen',
      author: 'Eldritch Factions',
      levelRange: 'Levels 10–15',
      rating: 4.7,
      reviewsCount: 84,
      price: '$12.99',
      coverGradient: 'from-red-900 to-stone-950',
      description: 'Delve into the Shadowfell to confront an immortal sorceress commanding legions of necrotic wraiths.',
      features: ['18 High-Res Maps', 'Raycast Darkness Fields', 'Pre-Commit Invariants', 'Vector PDF Handouts'],
    },
  ];

  const handleInstall = (id: string) => {
    if (!installedBundles.includes(id)) {
      setInstalledBundles([...installedBundles, id]);
      globalAudio.playTurnAdvance();
      if (onInstallBundle) onInstallBundle(id);
    }
  };

  const handleSaveHomebrew = (e: React.FormEvent) => {
    e.preventDefault();
    globalAudio.playDiceRoll();
    setHbCreatedSuccess(true);
    setTimeout(() => setHbCreatedSuccess(false), 2000);
  };

  const filteredBundles = bundles.filter(
    (b) =>
      b.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      b.author.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col bg-tavern-bg text-parchment-paper overflow-y-auto font-sans p-6 space-y-6">
      {/* Header Banner */}
      <div className="vtt-glass-panel rounded-2xl p-6 relative overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-4">
            <div className="p-3.5 rounded-2xl bg-[linear-gradient(180deg,var(--rp-amber-500),var(--rp-amber-600))] text-[var(--rp-ink-900)] shadow-lg">
              <ShoppingBag className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center space-x-3">
                <h1 className="vtt-engraved text-2xl font-bold tracking-wide">
                  Campaign Marketplace & Homebrew Vault
                </h1>
                <span className="vtt-badge">
                  D&D 5E Compatible
                </span>
              </div>
              <p className="text-xs text-[var(--rp-parchment-300)] mt-1 font-prose max-w-2xl">
                Install premium pre-built adventures or forge custom homebrew monsters and spells with auto-calculated mechanics.
              </p>
            </div>
          </div>

          {/* Tab Switcher */}
          <div className="vtt-tabbar">
            <button
              onClick={() => setActiveTab('marketplace')}
              data-active={activeTab === 'marketplace'}
              className="vtt-tab cursor-pointer"
            >
              Marketplace Catalog
            </button>
            <button
              onClick={() => setActiveTab('homebrew_studio')}
              data-active={activeTab === 'homebrew_studio'}
              className="vtt-tab cursor-pointer"
            >
              Homebrew Forge Studio
            </button>
          </div>
        </div>
      </div>

      {/* Main Tab Content */}
      {activeTab === 'marketplace' && (
        <div className="space-y-4">
          {/* Search Bar */}
          <div className="flex items-center space-x-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-[var(--rp-parchment-300)]" />
              <input
                type="text"
                placeholder="Search campaigns by title, author, or level range..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="vtt-input w-full pl-9 font-prose"
              />
            </div>
          </div>

          {/* Bundle Catalog Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredBundles.map((bundle) => {
              const isInstalled = installedBundles.includes(bundle.id);
              return (
                <div
                  key={bundle.id}
                  className="vtt-card-elevated rounded-2xl overflow-hidden flex flex-col justify-between group"
                >
                  <div className="p-5 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center space-x-2">
                          <h3 className="text-base font-bold font-display [font-variant:small-caps] text-parchment-paper group-hover:text-tavern-accent transition-colors">
                            {bundle.title}
                          </h3>
                        </div>
                        <div className="text-xs text-[var(--rp-parchment-300)] font-prose mt-0.5">
                          By {bundle.author} · <span className="text-tavern-accent font-semibold">{bundle.levelRange}</span>
                        </div>
                      </div>

                      <div className="flex items-center space-x-1 bg-tavern-bg px-2 py-1 rounded-lg border border-tavern-border text-xs font-prose">
                        <Star className="w-3.5 h-3.5 fill-tavern-accent text-tavern-accent" />
                        <span className="font-bold text-tavern-accent">{bundle.rating}</span>
                        <span className="text-[var(--rp-parchment-300)] text-[10px]">({bundle.reviewsCount})</span>
                      </div>
                    </div>

                    <p className="selectable-text text-xs text-[var(--rp-parchment-200)] leading-relaxed font-prose">{bundle.description}</p>

                    <div className="grid grid-cols-2 gap-1.5 pt-2 border-t border-tavern-border">
                      {bundle.features.map((feat, idx) => (
                        <div key={idx} className="flex items-center space-x-1.5 text-[11px] font-prose text-[var(--rp-parchment-300)]">
                          <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                          <span className="truncate">{feat}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="p-4 bg-tavern-bg border-t border-tavern-border flex items-center justify-between">
                    <span className="text-sm font-bold text-tavern-accent font-prose">{bundle.price}</span>

                    {isInstalled ? (
                      <span className="vtt-badge vtt-badge-success">
                        <Check className="w-3.5 h-3.5" />
                        Bundle Installed
                      </span>
                    ) : (
                      <button
                        onClick={() => handleInstall(bundle.id)}
                        className="vtt-btn vtt-btn-primary text-xs cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>1-Click Install (.vttbundle)</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Homebrew Forge Studio Tab */}
      {activeTab === 'homebrew_studio' && (
        <form onSubmit={handleSaveHomebrew} className="vtt-card-elevated rounded-2xl p-6 space-y-4 max-w-2xl">
          <h2 className="vtt-section-header text-lg pb-3">
            <Wand2 className="w-5 h-5 shrink-0" />
            <span>Homebrew Monster & Spell Forge</span>
          </h2>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)]">Entity Name</label>
              <input
                type="text"
                value={hbName}
                onChange={(e) => setHbName(e.target.value)}
                className="vtt-input w-full font-prose"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)]">Challenge Rating (CR)</label>
              <input
                type="text"
                value={hbCr}
                onChange={(e) => setHbCr(e.target.value)}
                className="vtt-input w-full font-prose"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)]">Armor Class (AC)</label>
              <input
                type="number"
                value={hbAc}
                onChange={(e) => setHbAc(e.target.value)}
                className="vtt-input w-full font-prose"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)]">Hit Points (HP)</label>
              <input
                type="number"
                value={hbHp}
                onChange={(e) => setHbHp(e.target.value)}
                className="vtt-input w-full font-prose"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)]">Main Action & Damage Expression</label>
            <textarea
              rows={3}
              value={hbAction}
              onChange={(e) => setHbAction(e.target.value)}
              className="vtt-input w-full font-prose"
            />
          </div>

          <button
            type="submit"
            className="vtt-btn vtt-btn-primary cursor-pointer"
          >
            {hbCreatedSuccess ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            <span>{hbCreatedSuccess ? 'Homebrew Entity Saved to Compendium!' : 'Save & Publish Homebrew Entity'}</span>
          </button>
        </form>
      )}
    </div>
  );
};
