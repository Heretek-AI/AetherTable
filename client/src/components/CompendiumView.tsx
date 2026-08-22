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
  ChevronRight
} from 'lucide-react';
import { Token } from './TacticalCanvas';

interface CompendiumViewProps {
  onSpawnToken: (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => void;
}

export const CompendiumView: React.FC<CompendiumViewProps> = ({ onSpawnToken }) => {
  const [activeTab, setActiveTab] = useState<'monsters' | 'spells'>('monsters');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSchool, setSelectedSchool] = useState<string>('All');
  const [selectedCR, setSelectedCR] = useState<string>('All');

  const [monsters, setMonsters] = useState<any[]>([]);
  const [spells, setSpells] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [monstersRes, spellsRes] = await Promise.all([
          fetch('/api/v1/orchestrator/compendium/monsters?limit=100').then((r) => r.json()),
          fetch('/api/v1/orchestrator/compendium/spells?limit=100').then((r) => r.json()),
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
      m.type.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCR = selectedCR === 'All' || m.cr.toLowerCase().includes(selectedCR.toLowerCase());
    return matchesSearch && matchesCR;
  });

  const filteredSpells = spells.filter((s) => {
    const matchesSearch =
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.school.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.description && s.description.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesSchool = selectedSchool === 'All' || s.school.toLowerCase() === selectedSchool.toLowerCase();
    return matchesSearch && matchesSchool;
  });

  const schools = ['All', 'Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'];
  const crTiers = ['All', '1/4', '1/2', '1', '2', '3', '4', '5', '7', '10', '15', '20'];

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden">
      {/* Top Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold font-display flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-purple-400" />
            <span>SRD 5.1 Compendium & Monster Codex</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Full 300+ spell grimoire & monster manual from official SRD 5.1 with live battlefield token spawning.
          </p>
        </div>

        {/* Tab Selector */}
        <div className="flex items-center gap-2 bg-slate-900 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => setActiveTab('monsters')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold font-mono transition ${
              activeTab === 'monsters' ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Monsters ({monsters.length})
          </button>
          <button
            onClick={() => setActiveTab('spells')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold font-mono transition ${
              activeTab === 'spells' ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Spells ({spells.length})
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-3 bg-slate-900/60 border-b border-slate-800/80 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search across ${activeTab === 'monsters' ? 'monsters by name or type' : 'spells by name, school, or effect'}...`}
            className="w-full pl-9 pr-3 py-1.5 bg-slate-950 border border-slate-700/80 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500 font-sans"
          />
        </div>

        {activeTab === 'spells' && (
          <div className="flex items-center gap-1 overflow-x-auto vtt-scrollbar py-1">
            <Filter className="w-3.5 h-3.5 text-slate-500 ml-1 mr-0.5 shrink-0" />
            {schools.map((sch) => (
              <button
                key={sch}
                onClick={() => setSelectedSchool(sch)}
                className={`px-2.5 py-1 rounded text-[11px] font-mono whitespace-nowrap transition ${
                  selectedSchool === sch
                    ? 'bg-purple-600 text-white font-bold'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                {sch}
              </button>
            ))}
          </div>
        )}

        {activeTab === 'monsters' && (
          <div className="flex items-center gap-1 overflow-x-auto vtt-scrollbar py-1">
            <span className="text-[11px] font-mono text-slate-500 ml-1 mr-1">CR:</span>
            {crTiers.map((cr) => (
              <button
                key={cr}
                onClick={() => setSelectedCR(cr)}
                className={`px-2 py-0.5 rounded text-[11px] font-mono whitespace-nowrap transition ${
                  selectedCR === cr
                    ? 'bg-purple-600 text-white font-bold'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                {cr}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Main Grid List */}
      <div className="flex-1 p-4 overflow-y-auto vtt-scrollbar">
        {activeTab === 'monsters' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredMonsters.map((monster) => (
              <div
                key={monster.id}
                className="vtt-glass-panel p-4 rounded-xl border border-slate-800/80 flex flex-col justify-between hover:border-purple-500/50 transition shadow-lg group"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-rose-950 border border-rose-800 flex items-center justify-center text-rose-400">
                        <Skull className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="font-bold text-xs text-slate-100 font-display">{monster.name}</h3>
                        <div className="text-[10px] text-slate-400">{monster.type}</div>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 bg-purple-950 text-purple-300 rounded border border-purple-800">
                      {monster.cr}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5 my-2.5 text-center font-mono text-[11px]">
                    <div className="p-1.5 bg-slate-950/80 rounded border border-slate-800">
                      <div className="text-[9px] text-slate-500">AC</div>
                      <div className="font-bold text-sky-400">{monster.ac}</div>
                    </div>
                    <div className="p-1.5 bg-slate-950/80 rounded border border-slate-800">
                      <div className="text-[9px] text-slate-500">HP</div>
                      <div className="font-bold text-emerald-400">{monster.hp}</div>
                    </div>
                    <div className="p-1.5 bg-slate-950/80 rounded border border-slate-800">
                      <div className="text-[9px] text-slate-500">SPEED</div>
                      <div className="font-bold text-amber-400">{monster.speed}</div>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed mb-3">
                    {monster.description}
                  </p>
                </div>

                <button
                  onClick={() =>
                    onSpawnToken({
                      name: monster.name,
                      hp: monster.hp,
                      maxHp: monster.hp,
                      ac: monster.ac,
                      color: '#dc2626',
                      isPlayer: false,
                      avatarIconType: monster.hp > 80 ? 'boss' : 'scout',
                    })
                  }
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-semibold transition shadow"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Spawn to Tactical Battle Map</span>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredSpells.map((spell) => (
              <div
                key={spell.id}
                className="vtt-glass-panel p-4 rounded-xl border border-slate-800/80 flex flex-col justify-between hover:border-purple-500/50 transition shadow-lg"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-indigo-950 border border-indigo-800 flex items-center justify-center text-indigo-400">
                        <Wand2 className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="font-bold text-xs text-slate-100 font-display">{spell.name}</h3>
                        <div className="text-[10px] text-purple-400 font-mono">
                          {spell.level === 0 ? 'Cantrip' : `Level ${spell.level}`} · {spell.school}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="p-2 bg-slate-950/80 rounded-lg border border-slate-800 space-y-1 my-2 text-[10px] font-mono text-slate-400">
                    <div className="flex justify-between">
                      <span>Casting Time:</span>
                      <span className="text-slate-200">{spell.casting_time}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Range:</span>
                      <span className="text-slate-200">{spell.range}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Duration:</span>
                      <span className="text-slate-200">{spell.duration}</span>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-300 line-clamp-3 leading-relaxed mb-3">
                    {spell.description}
                  </p>
                </div>

                <div className="text-[10px] font-mono text-slate-500 flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-purple-400" />
                  <span>Components: {spell.components}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
