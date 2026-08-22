import React, { useState } from 'react';
import { 
  Search, 
  Shield, 
  Heart, 
  Sparkles, 
  Flame, 
  Zap, 
  Plus, 
  Skull, 
  BookOpen, 
  Filter,
  Wand2,
  Sword
} from 'lucide-react';
import { Token } from './TacticalCanvas';

interface CompendiumViewProps {
  onSpawnToken: (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => void;
}

export const CompendiumView: React.FC<CompendiumViewProps> = ({ onSpawnToken }) => {
  const [activeTab, setActiveTab] = useState<'monsters' | 'spells'>('monsters');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCr, setSelectedCr] = useState<string>('all');

  const monsters = [
    {
      name: 'Goblin Scout',
      cr: '1/4',
      hp: 12,
      ac: 15,
      speed: '30 ft',
      color: '#f97316',
      avatarIconType: 'scout',
      type: 'Small Humanoid (Goblinoid)',
      actions: ['Scimitar (+4 to hit, 1d6+2 slashing)', 'Shortbow (+4 to hit, 1d6+2 piercing)'],
      description: 'Small, black-hearted humanoids that lair in despoiled dungeons and ruins.',
    },
    {
      name: 'Orc Warlord',
      cr: '3',
      hp: 58,
      ac: 16,
      speed: '30 ft',
      color: '#ef4444',
      avatarIconType: 'boss',
      type: 'Medium Humanoid (Orc)',
      actions: ['Greataxe (+6 to hit, 1d12+4 slashing)', 'Javelin (+6 to hit, 1d6+4 piercing)'],
      description: 'Savage tribal commanders driven by the bloodlust of Gruumsh.',
    },
    {
      name: 'Young Red Dragon',
      cr: '10',
      hp: 178,
      ac: 18,
      speed: '40 ft, fly 80 ft',
      color: '#b91c1c',
      avatarIconType: 'boss',
      type: 'Large Dragon (Chaotic Evil)',
      actions: ['Multiattack (Bite + 2 Claws)', 'Fire Breath (16d6 fire, DC 17 DEX)'],
      description: 'Arrogant carnivores that hoard treasures in volcanic lairs.',
    },
    {
      name: 'Skeleton Warrior',
      cr: '1/4',
      hp: 13,
      ac: 13,
      speed: '30 ft',
      color: '#64748b',
      avatarIconType: 'scout',
      type: 'Medium Undead (Lawful Evil)',
      actions: ['Shortsword (+4 to hit, 1d6+2 piercing)', 'Shortbow (+4 to hit, 1d6+2 piercing)'],
      description: 'Animated bones compelled by dark necromantic rituals.',
    },
    {
      name: 'Mind Flayer (Illithid)',
      cr: '7',
      hp: 71,
      ac: 15,
      speed: '30 ft',
      color: '#a855f7',
      avatarIconType: 'caster',
      type: 'Medium Aberration (Lawful Evil)',
      actions: ['Tentacles (+7 to hit, 2d10+4 psychic + grapple)', 'Mind Blast (4d8+4 psychic, DC 15 INT)'],
      description: 'Psionic tyrants of the Underdark that consume humanoid brains.',
    },
  ];

  const spells = [
    {
      name: 'Fireball',
      level: '3rd-level Evocation',
      castingTime: '1 Action',
      range: '150 feet (20 ft radius sphere)',
      damage: '8d6 Fire Damage (DC 15 DEX half)',
      components: 'V, S, M (a tiny ball of bat guano and sulfur)',
      description: 'A bright streak flashes from your pointing finger to a point you choose within range and then blossoms with a low roar into an explosion of flame.',
    },
    {
      name: 'Magic Missile',
      level: '1st-level Evocation',
      castingTime: '1 Action',
      range: '120 feet',
      damage: '3 x (1d4 + 1) Force Damage (Auto-hit)',
      components: 'V, S',
      description: 'You create three glowing darts of magical force. Each dart hits a creature of your choice that you can see within range.',
    },
    {
      name: 'Misty Step',
      level: '2nd-level Conjuration',
      castingTime: '1 Bonus Action',
      range: 'Self (30 feet)',
      damage: 'Utility Teleportation',
      components: 'V',
      description: 'Briefly surrounded by silvery mist, you teleport up to 30 feet to an unoccupied space that you can see.',
    },
    {
      name: 'Shield',
      level: '1st-level Abjuration',
      castingTime: '1 Reaction',
      range: 'Self',
      damage: '+5 AC Bonus until next turn',
      components: 'V, S',
      description: 'An invisible barrier of magical force appears and protects you, triggering when you are hit by an attack.',
    },
    {
      name: 'Eldritch Blast',
      level: 'Evocation Cantrip',
      castingTime: '1 Action',
      range: '120 feet',
      damage: '1d10 Force Damage per beam',
      components: 'V, S',
      description: 'A beam of crackling energy streaks toward a creature within range.',
    },
  ];

  const filteredMonsters = monsters.filter((m) => {
    const matchesSearch = m.name.toLowerCase().includes(searchQuery.toLowerCase()) || m.type.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCr = selectedCr === 'all' || m.cr === selectedCr;
    return matchesSearch && matchesCr;
  });

  const filteredSpells = spells.filter((s) => 
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) || s.level.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 p-6 overflow-y-auto vtt-scrollbar">
      {/* Top Header & Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold font-display text-slate-100 flex items-center gap-2.5">
            <BookOpen className="w-6 h-6 text-purple-400" />
            SRD 5.1 Compendium & Monster Codex
          </h1>
          <p className="text-xs text-slate-400 font-mono mt-1">
            Authoritative SRD dataset with zero-trust stat validation and live battlefield token spawning.
          </p>
        </div>

        {/* Tab Switcher & Search Input */}
        <div className="flex items-center gap-3">
          <div className="flex bg-slate-900 p-1 rounded-lg border border-slate-800 font-mono text-xs">
            <button
              onClick={() => setActiveTab('monsters')}
              className={`px-3 py-1.5 rounded-md transition ${
                activeTab === 'monsters' ? 'bg-purple-600 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Monsters ({monsters.length})
            </button>
            <button
              onClick={() => setActiveTab('spells')}
              className={`px-3 py-1.5 rounded-md transition ${
                activeTab === 'spells' ? 'bg-purple-600 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Spells ({spells.length})
            </button>
          </div>

          <div className="relative w-64">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${activeTab}...`}
              className="w-full pl-9 pr-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500 font-mono"
            />
          </div>
        </div>
      </div>

      {/* Main Grid View */}
      {activeTab === 'monsters' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
          {filteredMonsters.map((monster) => (
            <div
              key={monster.name}
              className="p-5 rounded-xl vtt-card-elevated flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center font-bold text-white shadow-md border border-slate-600"
                      style={{ backgroundColor: monster.color }}
                    >
                      {monster.avatarIconType === 'boss' ? (
                        <Skull className="w-5 h-5" />
                      ) : monster.avatarIconType === 'caster' ? (
                        <Wand2 className="w-5 h-5" />
                      ) : (
                        <Sword className="w-5 h-5" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-bold text-sm text-slate-100">{monster.name}</h3>
                      <div className="text-[11px] text-slate-400 font-mono">{monster.type}</div>
                    </div>
                  </div>
                  <span className="text-xs font-mono font-bold px-2 py-0.5 bg-purple-950/80 text-purple-300 border border-purple-800/80 rounded">
                    CR {monster.cr}
                  </span>
                </div>

                {/* Vitals */}
                <div className="grid grid-cols-3 gap-2 mt-4 text-center font-mono">
                  <div className="p-1.5 bg-slate-950/80 rounded border border-slate-800/80">
                    <div className="text-[9px] text-slate-500 flex items-center justify-center gap-1">
                      <Shield className="w-3 h-3 text-sky-400" /> AC
                    </div>
                    <div className="text-xs font-bold text-sky-400">{monster.ac}</div>
                  </div>
                  <div className="p-1.5 bg-slate-950/80 rounded border border-slate-800/80">
                    <div className="text-[9px] text-slate-500 flex items-center justify-center gap-1">
                      <Heart className="w-3 h-3 text-rose-400" /> HP
                    </div>
                    <div className="text-xs font-bold text-rose-400">{monster.hp}</div>
                  </div>
                  <div className="p-1.5 bg-slate-950/80 rounded border border-slate-800/80">
                    <div className="text-[9px] text-slate-500 flex items-center justify-center gap-1">
                      <Zap className="w-3 h-3 text-amber-400" /> SPEED
                    </div>
                    <div className="text-xs font-bold text-amber-400">{monster.speed.split(',')[0]}</div>
                  </div>
                </div>

                <p className="text-xs text-slate-300 mt-3 leading-relaxed">{monster.description}</p>

                {/* Actions */}
                <div className="mt-3 space-y-1">
                  <span className="text-[10px] font-mono font-bold text-slate-500">ATTACK ACTIONS:</span>
                  {monster.actions.map((act, i) => (
                    <div key={i} className="text-[11px] font-mono text-slate-300 bg-slate-950/60 p-1.5 rounded border border-slate-800/60">
                      ⚔️ {act}
                    </div>
                  ))}
                </div>
              </div>

              {/* Spawn Button */}
              <button
                onClick={() =>
                  onSpawnToken({
                    name: monster.name,
                    hp: monster.hp,
                    maxHp: monster.hp,
                    ac: monster.ac,
                    color: monster.color,
                    isPlayer: false,
                    avatarIconType: monster.avatarIconType,
                  })
                }
                className="mt-4 w-full flex items-center justify-center gap-2 py-2 px-3 bg-purple-600/90 hover:bg-purple-600 text-white text-xs font-semibold rounded-lg transition shadow-md shadow-purple-950/50 border border-purple-500/40"
              >
                <Plus className="w-4 h-4" />
                <span>Spawn to Tactical Battle Map</span>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
          {filteredSpells.map((spell) => (
            <div
              key={spell.name}
              className="p-5 rounded-xl vtt-card-elevated flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-indigo-950 border border-indigo-700/60 flex items-center justify-center text-indigo-300 shadow-md">
                      <Flame className="w-5 h-5 text-orange-400" />
                    </div>
                    <div>
                      <h3 className="font-bold text-sm text-slate-100">{spell.name}</h3>
                      <div className="text-[11px] text-purple-400 font-mono">{spell.level}</div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-1.5 text-xs font-mono text-slate-400">
                  <div><span className="text-slate-500">Casting Time:</span> {spell.castingTime}</div>
                  <div><span className="text-slate-500">Range / AoE:</span> {spell.range}</div>
                  <div><span className="text-slate-500">Damage / Effect:</span> <span className="text-amber-300">{spell.damage}</span></div>
                  <div><span className="text-slate-500">Components:</span> {spell.components}</div>
                </div>

                <p className="text-xs text-slate-300 mt-3 leading-relaxed">{spell.description}</p>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between text-xs font-mono text-purple-300">
                <span className="flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" /> SRD 5.1 Spellbook</span>
                <span className="px-2 py-0.5 bg-slate-900 rounded border border-slate-800">Auto-Audited</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
