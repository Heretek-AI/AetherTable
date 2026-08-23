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
      coverGradient: 'from-sky-500 to-blue-900',
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
      coverGradient: 'from-purple-600 to-slate-950',
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
    <div className="flex-1 flex flex-col bg-slate-950 text-slate-100 overflow-y-auto font-sans p-6 space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-4">
            <div className="p-3.5 bg-gradient-to-br from-amber-500 to-purple-600 rounded-2xl text-white shadow-lg shadow-amber-950/50">
              <ShoppingBag className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center space-x-3">
                <h1 className="text-2xl font-bold font-serif tracking-wide text-slate-100">
                  Campaign Marketplace & Homebrew Vault
                </h1>
                <span className="px-2.5 py-0.5 text-xs font-semibold bg-amber-950/80 border border-amber-600/50 text-amber-300 rounded-full font-mono">
                  D&D 5E COMPATIBLE
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Install premium pre-built adventures or forge custom homebrew monsters and spells with auto-calculated mechanics.
              </p>
            </div>
          </div>

          {/* Tab Switcher */}
          <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 font-mono text-xs">
            <button
              onClick={() => setActiveTab('marketplace')}
              className={`px-4 py-2 rounded-lg font-bold transition cursor-pointer ${
                activeTab === 'marketplace' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Marketplace Catalog
            </button>
            <button
              onClick={() => setActiveTab('homebrew_studio')}
              className={`px-4 py-2 rounded-lg font-bold transition cursor-pointer ${
                activeTab === 'homebrew_studio' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
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
              <Search className="w-4 h-4 absolute left-3 top-3 text-slate-500" />
              <input
                type="text"
                placeholder="Search campaigns by title, author, or level range..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-9 pr-4 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500 font-mono"
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
                  className="bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden shadow-xl flex flex-col justify-between group hover:border-slate-700 transition-all"
                >
                  <div className="p-5 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center space-x-2">
                          <h3 className="text-base font-bold font-serif text-slate-100 group-hover:text-amber-300 transition-colors">
                            {bundle.title}
                          </h3>
                        </div>
                        <div className="text-xs text-slate-400 font-mono mt-0.5">
                          By {bundle.author} · <span className="text-purple-400 font-semibold">{bundle.levelRange}</span>
                        </div>
                      </div>

                      <div className="flex items-center space-x-1 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800 text-xs font-mono">
                        <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                        <span className="font-bold text-amber-300">{bundle.rating}</span>
                        <span className="text-slate-500 text-[10px]">({bundle.reviewsCount})</span>
                      </div>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed font-sans">{bundle.description}</p>

                    <div className="grid grid-cols-2 gap-1.5 pt-2 border-t border-slate-800/80">
                      {bundle.features.map((feat, idx) => (
                        <div key={idx} className="flex items-center space-x-1.5 text-[11px] font-mono text-slate-400">
                          <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                          <span className="truncate">{feat}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between">
                    <span className="text-xs font-mono font-bold text-amber-400">{bundle.price}</span>

                    <button
                      onClick={() => handleInstall(bundle.id)}
                      disabled={isInstalled}
                      className={`flex items-center space-x-1.5 px-4 py-1.5 rounded-xl text-xs font-mono font-bold transition shadow cursor-pointer ${
                        isInstalled
                          ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-600/50'
                          : 'bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white shadow-amber-950/50'
                      }`}
                    >
                      {isInstalled ? <Check className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
                      <span>{isInstalled ? 'Bundle Installed' : '1-Click Install (.vttbundle)'}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Homebrew Forge Studio Tab */}
      {activeTab === 'homebrew_studio' && (
        <form onSubmit={handleSaveHomebrew} className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4 max-w-2xl">
          <div className="flex items-center space-x-3 pb-3 border-b border-slate-800">
            <Wand2 className="w-5 h-5 text-purple-400" />
            <h2 className="text-lg font-bold font-serif text-slate-100">Homebrew Monster & Spell Forge</h2>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-mono text-slate-300">Entity Name</label>
              <input
                type="text"
                value={hbName}
                onChange={(e) => setHbName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-purple-500 font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-slate-300">Challenge Rating (CR)</label>
              <input
                type="text"
                value={hbCr}
                onChange={(e) => setHbCr(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-purple-500 font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-mono text-slate-300">Armor Class (AC)</label>
              <input
                type="number"
                value={hbAc}
                onChange={(e) => setHbAc(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-purple-500 font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-slate-300">Hit Points (HP)</label>
              <input
                type="number"
                value={hbHp}
                onChange={(e) => setHbHp(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-purple-500 font-mono"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-mono text-slate-300">Main Action & Damage Expression</label>
            <textarea
              rows={3}
              value={hbAction}
              onChange={(e) => setHbAction(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs text-slate-200 focus:outline-none focus:border-purple-500 font-mono"
            />
          </div>

          <button
            type="submit"
            className="flex items-center space-x-2 px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs font-mono rounded-xl shadow-lg transition cursor-pointer"
          >
            {hbCreatedSuccess ? <Check className="w-4 h-4 text-emerald-300" /> : <Plus className="w-4 h-4" />}
            <span>{hbCreatedSuccess ? 'Homebrew Entity Saved to Compendium!' : 'Save & Publish Homebrew Entity'}</span>
          </button>
        </form>
      )}
    </div>
  );
};
