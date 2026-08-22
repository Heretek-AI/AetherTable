import React, { useState, useEffect } from 'react';
import { 
  BookOpen, 
  Search, 
  Shield, 
  Skull, 
  Flame, 
  Sparkles, 
  Wand2, 
  Zap, 
  Plus, 
  Clock, 
  Compass, 
  Filter,
  Layers,
  ChevronRight,
  Eye,
  Check,
  X,
  Award,
  Heart,
  Sword
} from 'lucide-react';
import { Token } from './TacticalCanvas';

interface CompendiumViewProps {
  onSpawnToken: (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => void;
}

export const CompendiumView: React.FC<CompendiumViewProps> = ({ onSpawnToken }) => {
  const [activeTab, setActiveTab] = useState<'monsters' | 'spells' | 'rules'>('monsters');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSchool, setSelectedSchool] = useState<string>('All');
  const [selectedCR, setSelectedCR] = useState<string>('All');

  const [monsters, setMonsters] = useState<any[]>([]);
  const [spells, setSpells] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [spawnSuccess, setSpawnSuccess] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [monstersRes, spellsRes] = await Promise.all([
          fetch('/api/v1/compendium/monsters?limit=200').then((r) => r.json()),
          fetch('/api/v1/compendium/spells?limit=200').then((r) => r.json()),
        ]);
        if (monstersRes.monsters) setMonsters(monstersRes.monsters);
        if (spellsRes.spells) setSpells(spellsRes.spells);
      } catch (e) {
        console.error('Compendium fetch failed', e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const filteredMonsters = monsters.filter((m) => {
    const matchesSearch =
      m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (m.type && m.type.toLowerCase().includes(searchQuery.toLowerCase()));
    const crValue = String(m.challenge_rating || m.cr || '');
    const matchesCR = selectedCR === 'All' || crValue.toLowerCase().includes(selectedCR.toLowerCase());
    return matchesSearch && matchesCR;
  });

  const filteredSpells = spells.filter((s) => {
    const matchesSearch =
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.description && s.description.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesSchool = selectedSchool === 'All' || (s.school && s.school.toLowerCase() === selectedSchool.toLowerCase());
    return matchesSearch && matchesSchool;
  });

  const handleSpawnMonster = (monster: any) => {
    const tokenData: Omit<Token, 'id' | 'x' | 'y'> = {
      name: monster.name,
      hp: monster.hit_points || monster.hp || 30,
      maxHp: monster.hit_points || monster.hp || 30,
      ac: monster.armor_class || monster.ac || 14,
      color: monster.challenge_rating > 3 ? '#dc2626' : '#f59e0b',
      isPlayer: false,
      avatarIconType: monster.challenge_rating > 5 ? 'boss' : 'scout',
      elevationFeet: 0,
    };
    onSpawnToken(tokenData);
    setSpawnSuccess(monster.name);
    setTimeout(() => setSpawnSuccess(null), 2500);
  };

  return (
    <div className="space-y-6">
      {/* Header Banner (D&D Beyond Style) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-sm">
        <div className="absolute -right-6 -bottom-6 w-40 h-40 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center space-x-4">
            <div className="p-3.5 bg-amber-950/40 border border-amber-500/30 rounded-xl text-amber-400 shadow-inner">
              <BookOpen className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center space-x-3">
                <h2 className="text-2xl font-bold font-serif tracking-wide text-slate-100">
                  D&D 5e Compendium Codex
                </h2>
                <span className="px-2.5 py-0.5 text-xs font-semibold bg-amber-900/40 border border-amber-600/50 text-amber-300 rounded-full font-mono">
                  Official SRD 5.1
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Explore 319 spells, 318 monster stat blocks, equipment, and core rules. Inspect rich statblocks and spawn tokens directly to the canvas.
              </p>
            </div>
          </div>

          {/* Search & Tabs */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
              <input
                type="text"
                placeholder="Search Spells, Monsters, Rules..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-950/80 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500 shadow-inner"
              />
            </div>

            <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800 font-mono text-xs">
              <button
                onClick={() => setActiveTab('monsters')}
                className={`px-3 py-1.5 rounded-md font-bold transition cursor-pointer ${
                  activeTab === 'monsters' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Monsters ({monsters.length})
              </button>
              <button
                onClick={() => setActiveTab('spells')}
                className={`px-3 py-1.5 rounded-md font-bold transition cursor-pointer ${
                  activeTab === 'spells' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Spells ({spells.length})
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {activeTab === 'monsters' && (
          filteredMonsters.map((monster, index) => (
            <div
              key={monster.id || index}
              onClick={() => setSelectedItem(monster)}
              className="bg-slate-900/80 hover:bg-slate-850/90 border border-slate-800 hover:border-amber-500/50 rounded-xl p-5 shadow-lg transition-all cursor-pointer group flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="p-2 bg-rose-950/40 border border-rose-600/40 rounded-lg text-rose-400 group-hover:scale-105 transition-transform">
                      <Skull className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold font-serif text-slate-100 group-hover:text-amber-300 transition-colors">
                        {monster.name}
                      </h3>
                      <p className="text-[11px] text-slate-400 capitalize">
                        {monster.size || 'Medium'} {monster.type || 'Monstrosity'}
                      </p>
                    </div>
                  </div>

                  <span className="px-2 py-0.5 bg-amber-950/60 border border-amber-600/40 text-amber-300 text-xs font-mono font-bold rounded">
                    CR {monster.challenge_rating || monster.cr || '1'}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-4 text-center font-mono text-xs">
                  <div className="p-1.5 bg-slate-950/70 rounded border border-slate-800">
                    <div className="text-[9px] text-slate-500">AC</div>
                    <div className="font-bold text-sky-400">{monster.armor_class || monster.ac || 14}</div>
                  </div>
                  <div className="p-1.5 bg-slate-950/70 rounded border border-slate-800">
                    <div className="text-[9px] text-slate-500">HP</div>
                    <div className="font-bold text-emerald-400">{monster.hit_points || monster.hp || 30}</div>
                  </div>
                  <div className="p-1.5 bg-slate-950/70 rounded border border-slate-800">
                    <div className="text-[9px] text-slate-500">SPEED</div>
                    <div className="font-bold text-amber-400">{monster.speed || '30 ft'}</div>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between">
                <span className="text-[11px] text-slate-400 font-mono">
                  XP: {monster.xp || 100}
                </span>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSpawnMonster(monster);
                  }}
                  className="flex items-center space-x-1 px-3 py-1 bg-amber-600/20 hover:bg-amber-600 text-amber-300 hover:text-white border border-amber-600/40 rounded-lg text-xs font-semibold transition-all cursor-pointer"
                >
                  {spawnSuccess === monster.name ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-300" />
                      <span>Spawned!</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5" />
                      <span>Spawn to Canvas</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          ))
        )}

        {activeTab === 'spells' && (
          filteredSpells.map((spell, index) => (
            <div
              key={spell.id || index}
              onClick={() => setSelectedItem(spell)}
              className="bg-slate-900/80 hover:bg-slate-850/90 border border-slate-800 hover:border-amber-500/50 rounded-xl p-5 shadow-lg transition-all cursor-pointer group flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="p-2 bg-purple-950/40 border border-purple-600/40 rounded-lg text-purple-400 group-hover:scale-105 transition-transform">
                      <Sparkles className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold font-serif text-slate-100 group-hover:text-amber-300 transition-colors">
                        {spell.name}
                      </h3>
                      <p className="text-[11px] text-slate-400 capitalize">
                        {spell.level === 0 ? 'Cantrip' : `Level ${spell.level}`} {spell.school || 'Evocation'}
                      </p>
                    </div>
                  </div>

                  <span className="px-2 py-0.5 bg-purple-950/60 border border-purple-600/40 text-purple-300 text-xs font-mono font-bold rounded">
                    {spell.level === 0 ? 'Cantrip' : `Lvl ${spell.level}`}
                  </span>
                </div>

                <p className="text-xs text-slate-300 mt-3 line-clamp-3 leading-relaxed">
                  {spell.description || spell.desc || 'A powerful invocation shaping magical weave.'}
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>Range: {spell.range || '60 ft'}</span>
                <span>Time: {spell.casting_time || '1 Action'}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Statblock Flyout / Modal (D&D Beyond Style) */}
      {selectedItem && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl space-y-4 animate-fadeIn">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 bg-amber-950/50 border border-amber-600/40 rounded-xl text-amber-400">
                  {selectedItem.challenge_rating !== undefined ? <Skull className="w-6 h-6" /> : <Sparkles className="w-6 h-6" />}
                </div>
                <div>
                  <h3 className="text-xl font-bold font-serif text-slate-100">{selectedItem.name}</h3>
                  <p className="text-xs text-slate-400">
                    {selectedItem.type || selectedItem.school || 'Compendium Entry'}
                  </p>
                </div>
              </div>

              <button
                onClick={() => setSelectedItem(null)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Description & Mechanical Statblock */}
            <div className="p-4 bg-slate-950/80 rounded-xl border border-slate-800 text-xs text-slate-200 leading-relaxed font-sans space-y-3">
              <p className="italic font-serif text-amber-200/90 text-sm">
                "{selectedItem.description || selectedItem.desc || selectedItem.name + ' - SRD 5.1 Official Record.'}"
              </p>

              {selectedItem.challenge_rating !== undefined && (
                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800 font-mono">
                  <div><strong>Armor Class:</strong> {selectedItem.armor_class || 14}</div>
                  <div><strong>Hit Points:</strong> {selectedItem.hit_points || 30}</div>
                  <div><strong>Speed:</strong> {selectedItem.speed || '30 ft'}</div>
                  <div><strong>CR:</strong> {selectedItem.challenge_rating}</div>
                  <div><strong>XP:</strong> {selectedItem.xp || 100}</div>
                </div>
              )}
            </div>

            <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
              {selectedItem.challenge_rating !== undefined && (
                <button
                  onClick={() => {
                    handleSpawnMonster(selectedItem);
                    setSelectedItem(null);
                  }}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-lg shadow cursor-pointer flex items-center space-x-1.5"
                >
                  <Plus className="w-4 h-4" />
                  <span>Spawn to Canvas</span>
                </button>
              )}
              <button
                onClick={() => setSelectedItem(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
