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
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  Eye,
  Check,
  X,
  Award,
  Heart,
  Sword,
  Gem,
  Feather,
  PawPrint,
  ScrollText,
} from 'lucide-react';
import { Token } from './TacticalCanvas';
import { globalAudio } from '../render/audio_manager';

interface CompendiumViewProps {
  onSpawnToken: (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => void;
}

const FALLBACK_MONSTERS = [
  { id: 'm1', name: 'Adult Red Dragon', size: 'Huge', type: 'Dragon', challenge_rating: '17', ac: 19, hp: 256, speed: '40 ft, fly 80 ft', xp: 18000, description: 'Legendary apex predator breathing cone of destructive fire.' },
  { id: 'm2', name: 'Orc Warlord', size: 'Medium', type: 'Humanoid (Orc)', challenge_rating: '3', ac: 16, hp: 58, speed: '30 ft', xp: 700, description: 'Battle-hardened vanguard commander wielding heavy greataxe.' },
  { id: 'm3', name: 'Goblin Scout', size: 'Small', type: 'Humanoid (Goblinoid)', challenge_rating: '1/4', ac: 15, hp: 7, speed: '30 ft', xp: 50, description: 'Nimble skirmisher with shortbow and stealth tactics.' },
  { id: 'm4', name: 'Iron Golem Titan', size: 'Large', type: 'Construct', challenge_rating: '16', ac: 20, hp: 210, speed: '30 ft', xp: 15000, description: 'Unstoppable forged titan immune to non-magical physical strikes.' },
  { id: 'm5', name: 'Beholder', size: 'Large', type: 'Aberration', challenge_rating: '13', ac: 18, hp: 180, speed: '0 ft, fly 20 ft', xp: 10000, description: 'Central antimagic cone eye with 10 lethal eye stalks.' },
  { id: 'm6', name: 'Lich', size: 'Medium', type: 'Undead', challenge_rating: '21', ac: 17, hp: 135, speed: '30 ft', xp: 33000, description: 'Ancient spellcaster bound to a phylactery commanding 9th-level spells.' },
  { id: 'm7', name: 'Gelatinous Cube', size: 'Large', type: 'Ooze', challenge_rating: '2', ac: 6, hp: 84, speed: '15 ft', xp: 450, description: 'Transparent dungeon scavenger engulfing unwary adventurers.' },
  { id: 'm8', name: 'Mind Flayer', size: 'Medium', type: 'Aberration', challenge_rating: '7', ac: 15, hp: 71, speed: '30 ft', xp: 2900, description: 'Psionic entity extracting brains with tentacle grappling.' },
  { id: 'm9', name: 'Frost Giant', size: 'Huge', type: 'Giant', challenge_rating: '8', ac: 15, hp: 138, speed: '40 ft', xp: 3900, description: 'Immense warrior wielding greataxe and hurling glacial boulders.' },
  { id: 'm10', name: 'Vampire Lord', size: 'Medium', type: 'Undead', challenge_rating: '13', ac: 16, hp: 144, speed: '30 ft', xp: 10000, description: 'Shapechanging aristocrat drinking blood and commanding bat swarms.' },
  { id: 'm11', name: 'Dire Wolf', size: 'Large', type: 'Beast', challenge_rating: '1', ac: 14, hp: 37, speed: '50 ft', xp: 200, description: 'Pack tactics predator knocking targets prone on bite.' },
  { id: 'm12', name: 'Hydra', size: 'Huge', type: 'Monstrosity', challenge_rating: '8', ac: 15, hp: 172, speed: '30 ft, swim 30 ft', xp: 3900, description: 'Multi-headed beast regrowing two heads for every severed head.' },
  { id: 'm13', name: 'Shadow Assassin', size: 'Medium', type: 'Humanoid', challenge_rating: '5', ac: 15, hp: 78, speed: '30 ft', xp: 1800, description: 'Stealth striker executing sneak attacks with poisoned daggers.' },
  { id: 'm14', name: 'Skeleton Archer', size: 'Medium', type: 'Undead', challenge_rating: '1/4', ac: 13, hp: 13, speed: '30 ft', xp: 50, description: 'Animated bones wielding shortbow and shortsword.' },
  { id: 'm15', name: 'Zombie Vanguard', size: 'Medium', type: 'Undead', challenge_rating: '1/4', ac: 8, hp: 22, speed: '20 ft', xp: 50, description: 'Relentless undead with Undead Fortitude survival.' },
  { id: 'm16', name: 'Ancient Blue Dragon', size: 'Gargantuan', type: 'Dragon', challenge_rating: '23', ac: 22, hp: 481, speed: '40 ft, fly 80 ft', xp: 50000, description: 'Desert titan unleashing 120-ft lightning breath.' },
  { id: 'm17', name: 'Owlbear', size: 'Large', type: 'Monstrosity', challenge_rating: '3', ac: 13, hp: 59, speed: '40 ft', xp: 700, description: 'Ferocious hybrid with keen sight and smell.' },
  { id: 'm18', name: 'Treant', size: 'Huge', type: 'Plant', challenge_rating: '9', ac: 16, hp: 138, speed: '30 ft', xp: 5000, description: 'Ancient woodland guardian animating trees to crush trespassers.' },
];

const FALLBACK_SPELLS = [
  { id: 's1', name: 'Fireball', level: 3, school: 'Evocation', casting_time: '1 action', range: '150 feet', duration: 'Instantaneous', description: 'A bright streak flashes from your pointing finger to a point you choose within range and then blossoms with a low roar into an explosion of flame (8d6 Fire, 20ft sphere).' },
  { id: 's2', name: 'Shield', level: 1, school: 'Abjuration', casting_time: '1 reaction', range: 'Self', duration: '1 round', description: 'An invisible barrier of magical force appears and protects you. Until the start of your next turn, you have a +5 bonus to AC, including against the triggering attack.' },
  { id: 's3', name: 'Cure Wounds', level: 1, school: 'Evocation', casting_time: '1 action', range: 'Touch', duration: 'Instantaneous', description: 'A creature you touch regains a number of hit points equal to 1d8 + your spellcasting ability modifier.' },
  { id: 's4', name: 'Counterspell', level: 3, school: 'Abjuration', casting_time: '1 reaction', range: '60 feet', duration: 'Instantaneous', description: 'You attempt to interrupt a creature in the process of casting a spell. If the creature is casting a spell of 3rd level or lower, its spell fails.' },
  { id: 's5', name: 'Misty Step', level: 2, school: 'Conjuration', casting_time: '1 bonus action', range: 'Self', duration: 'Instantaneous', description: 'Briefly surrounded by silvery mist, you teleport up to 30 feet to an unoccupied space that you can see.' },
  { id: 's6', name: 'Magic Missile', level: 1, school: 'Evocation', casting_time: '1 action', range: '120 feet', duration: 'Instantaneous', description: 'You create three glowing darts of magical force. Each dart hits a creature of your choice that you can see within range dealing 1d4 + 1 force damage.' },
  { id: 's7', name: 'Haste', level: 3, school: 'Transmutation', casting_time: '1 action', range: '30 feet', duration: 'Concentration, up to 1 minute', description: 'Choose a willing creature. Its speed is doubled, it gains a +2 bonus to AC, advantage on Dexterity saving throws, and an additional action each turn.' },
  { id: 's8', name: 'Polymorph', level: 4, school: 'Transmutation', casting_time: '1 action', range: '60 feet', duration: 'Concentration, up to 1 hour', description: 'This spell transforms a creature with at least 1 hit point that you can see within range into a beast form (e.g. Giant Ape or Tyrannosaurus Rex).' },
  { id: 's9', name: 'Invisibility', level: 2, school: 'Illusion', casting_time: '1 action', range: 'Touch', duration: 'Concentration, up to 1 hour', description: 'A creature you touch becomes invisible until the spell ends. Anything the target is wearing or carrying is invisible.' },
  { id: 's10', name: 'Spiritual Weapon', level: 2, school: 'Evocation', casting_time: '1 bonus action', range: '60 feet', duration: '1 minute', description: 'You create a floating, spectral weapon within range that lasts for the duration. On your turn, you can bonus action attack for 1d8 + MOD force.' },
  { id: 's11', name: 'Eldritch Blast', level: 0, school: 'Evocation', casting_time: '1 action', range: '120 feet', duration: 'Instantaneous', description: 'A beam of crackling energy streaks toward a creature within range dealing 1d10 force damage.' },
  { id: 's12', name: 'Revivify', level: 3, school: 'Necromancy', casting_time: '1 action', range: 'Touch', duration: 'Instantaneous', description: 'You touch a creature that has died within the last minute. That creature returns to life with 1 hit point.' },
  { id: 's13', name: 'Hold Person', level: 2, school: 'Enchantment', casting_time: '1 action', range: '60 feet', duration: 'Concentration, up to 1 minute', description: 'Choose a humanoid that you can see within range. The target must succeed on a Wisdom saving throw or be paralyzed for the duration.' },
  { id: 's14', name: 'Fly', level: 3, school: 'Transmutation', casting_time: '1 action', range: 'Touch', duration: 'Concentration, up to 10 minutes', description: 'You touch a willing creature. The target gains a flying speed of 60 feet for the duration.' },
];

export type CompendiumTab = 'monsters' | 'spells' | 'magic-items' | 'feats' | 'animals' | 'glossary';

export const CompendiumView: React.FC<CompendiumViewProps> = ({ onSpawnToken }) => {
  const [activeTab, setActiveTab] = useState<CompendiumTab>('monsters');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSchool, setSelectedSchool] = useState<string>('All');
  const [selectedCR, setSelectedCR] = useState<string>('All');

  const [monsters, setMonsters] = useState<any[]>(FALLBACK_MONSTERS);
  const [spells, setSpells] = useState<any[]>(FALLBACK_SPELLS);
  const [magicItems, setMagicItems] = useState<any[]>([]);
  const [feats, setFeats] = useState<any[]>([]);
  const [animals, setAnimals] = useState<any[]>([]);
  const [glossaryTerms, setGlossaryTerms] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [spawnSuccess, setSpawnSuccess] = useState<string | null>(null);

  // Pagination State
  const [currentPage, setCurrentPage] = useState<number>(1);
  const ITEMS_PER_PAGE = 12;

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [
          monstersRes,
          spellsRes,
          magicItemsRes,
          featsRes,
          animalsRes,
          glossaryRes,
        ] = await Promise.all([
          fetch('/api/v1/compendium/monsters?limit=350').then((r) => (r.ok ? r.json() : null)),
          fetch('/api/v1/compendium/spells?limit=400').then((r) => (r.ok ? r.json() : null)),
          fetch('/api/v1/compendium/magic-items?limit=300').then((r) => (r.ok ? r.json() : null)),
          fetch('/api/v1/compendium/feats?limit=100').then((r) => (r.ok ? r.json() : null)),
          fetch('/api/v1/compendium/animals?limit=150').then((r) => (r.ok ? r.json() : null)),
          fetch('/api/v1/compendium/glossary?limit=200').then((r) => (r.ok ? r.json() : null)),
        ]);
        if (monstersRes?.monsters?.length) setMonsters(monstersRes.monsters);
        if (spellsRes?.spells?.length) setSpells(spellsRes.spells);
        if (magicItemsRes?.magic_items?.length) setMagicItems(magicItemsRes.magic_items);
        if (featsRes?.feats?.length) setFeats(featsRes.feats);
        if (animalsRes?.animals?.length) setAnimals(animalsRes.animals);
        if (glossaryRes?.glossary?.length) setGlossaryTerms(glossaryRes.glossary);
      } catch (e) {
        console.warn('Compendium API unavailable, using rich built-in SRD dataset.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // Reset pagination on search or tab change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedSchool, selectedCR, activeTab]);

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
    const matchesSchool =
      selectedSchool === 'All' || (s.school && s.school.toLowerCase() === selectedSchool.toLowerCase());
    return matchesSearch && matchesSchool;
  });

  const q = searchQuery.toLowerCase();
  const matchesText = (entry: any) =>
    !q ||
    entry.name?.toLowerCase().includes(q) ||
    entry.term?.toLowerCase().includes(q) ||
    entry.description?.toLowerCase().includes(q) ||
    entry.definition?.toLowerCase().includes(q);

  const filteredMagicItems = magicItems.filter(matchesText);
  const filteredFeats = feats.filter(matchesText);
  const filteredAnimals = animals.filter(
    (a) => matchesText(a) && (selectedCR === 'All' || String(a.challenge_rating || '').includes(selectedCR.toLowerCase()))
  );
  const filteredGlossary = glossaryTerms.filter(matchesText);

  // Active items and pagination calculations
  const activeItems =
    activeTab === 'monsters'
      ? filteredMonsters
      : activeTab === 'spells'
        ? filteredSpells
        : activeTab === 'magic-items'
          ? filteredMagicItems
          : activeTab === 'feats'
            ? filteredFeats
            : activeTab === 'animals'
              ? filteredAnimals
              : filteredGlossary;
  const totalPages = Math.max(1, Math.ceil(activeItems.length / ITEMS_PER_PAGE));
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const paginatedItems = activeItems.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setCurrentPage(newPage);
      // No chime here: pagination is silent UI navigation — reserving audio
      // cues for gameplay events keeps them meaningful (UX: alarm fatigue).
    }
  };

  const handleSpawnMonster = (monster: any) => {
    const tokenData: Omit<Token, 'id' | 'x' | 'y'> = {
      name: monster.name,
      hp: monster.hit_points || monster.hp || 30,
      maxHp: monster.hit_points || monster.hp || 30,
      ac: monster.armor_class || monster.ac || 14,
      color: parseFloat(monster.challenge_rating || '1') > 3 ? '#dc2626' : '#f59e0b',
      isPlayer: false,
      avatarIconType: parseFloat(monster.challenge_rating || '1') > 5 ? 'boss' : 'scout',
      elevationFeet: 0,
    };
    onSpawnToken(tokenData);
    setSpawnSuccess(monster.name);
    globalAudio.playTurnAdvance();
    setTimeout(() => setSpawnSuccess(null), 2500);
  };

  // Generate sliding pagination window (up to 5 pages)
  const getPageNumbers = () => {
    const pages: number[] = [];
    let start = Math.max(1, currentPage - 2);
    let end = Math.min(totalPages, start + 4);
    if (end - start < 4) {
      start = Math.max(1, end - 4);
    }
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  };

  return (
    <div className="w-full h-full flex flex-col overflow-hidden p-6 max-w-7xl mx-auto space-y-4 font-sans select-none">
      {/* Header Banner (D&D Beyond Style) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-2xl relative overflow-hidden backdrop-blur-sm shrink-0">
        <div className="absolute -right-6 -bottom-6 w-40 h-40 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center space-x-3.5">
            <div className="p-3 bg-amber-950/50 border border-amber-500/30 rounded-xl text-amber-400 shadow-inner">
              <BookOpen className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2.5">
                <h2 className="text-xl font-bold font-serif tracking-wide text-slate-100">
                  D&D 5e Compendium Codex
                </h2>
                <span className="px-2 py-0.5 text-[10px] font-semibold bg-amber-950 text-amber-300 border border-amber-600/50 rounded-full font-mono">
                  SRD 5.2
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Explore monster statblocks, spell grimoires, and spawn tokens directly to the tactical canvas.
              </p>
            </div>
          </div>

          {/* Search Bar & Tab Switcher */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
              <input
                type="text"
                placeholder="Search monsters, spells, rules..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-950/90 border border-slate-700 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500 shadow-inner font-mono"
              />
            </div>

            <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 font-mono text-xs">
              <button
                onClick={() => setActiveTab('monsters')}
                className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer flex items-center space-x-1.5 ${
                  activeTab === 'monsters'
                    ? 'bg-amber-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Skull className="w-3.5 h-3.5" />
                <span>Monsters ({filteredMonsters.length})</span>
              </button>
              <button
                onClick={() => setActiveTab('spells')}
                className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer flex items-center space-x-1.5 ${
                  activeTab === 'spells'
                    ? 'bg-amber-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Spells ({filteredSpells.length})</span>
              </button>
              <button
                onClick={() => setActiveTab('magic-items')}
                className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer flex items-center space-x-1.5 ${
                  activeTab === 'magic-items'
                    ? 'bg-amber-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Gem className="w-3.5 h-3.5" />
                <span>Magic Items ({filteredMagicItems.length})</span>
              </button>
              <button
                onClick={() => setActiveTab('feats')}
                className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer flex items-center space-x-1.5 ${
                  activeTab === 'feats'
                    ? 'bg-amber-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Feather className="w-3.5 h-3.5" />
                <span>Feats ({filteredFeats.length})</span>
              </button>
              <button
                onClick={() => setActiveTab('animals')}
                className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer flex items-center space-x-1.5 ${
                  activeTab === 'animals'
                    ? 'bg-amber-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <PawPrint className="w-3.5 h-3.5" />
                <span>Animals ({filteredAnimals.length})</span>
              </button>
              <button
                onClick={() => setActiveTab('glossary')}
                className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer flex items-center space-x-1.5 ${
                  activeTab === 'glossary'
                    ? 'bg-amber-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <ScrollText className="w-3.5 h-3.5" />
                <span>Glossary ({filteredGlossary.length})</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Grid (Scrollable) */}
      <div className="flex-1 overflow-y-auto pr-1 min-h-0">
        {paginatedItems.length === 0 ? (
          <div className="p-12 text-center text-slate-500 font-mono text-xs bg-slate-900/40 rounded-2xl border border-slate-800">
            No entries found matching "{searchQuery}".
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeTab === 'monsters' &&
              paginatedItems.map((monster: any, index: number) => (
                <div
                  key={monster.id || index}
                  onClick={() => setSelectedItem(monster)}
                  className="bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/50 rounded-2xl p-4 shadow-lg transition-all cursor-pointer group flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="p-2 bg-rose-950/50 border border-rose-600/40 rounded-xl text-rose-400 group-hover:scale-105 transition-transform">
                          <Skull className="w-4 h-4" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold font-serif text-slate-100 group-hover:text-amber-300 transition-colors">
                            {monster.name}
                          </h3>
                          <p className="text-[10px] text-slate-400 font-mono capitalize">
                            {monster.size || 'Medium'} {monster.type || 'Monstrosity'}
                          </p>
                        </div>
                      </div>

                      <span className="px-2 py-0.5 bg-amber-950 text-amber-300 border border-amber-600/40 text-[11px] font-mono font-bold rounded">
                        CR {monster.challenge_rating || monster.cr || '1'}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 mt-3 text-center font-mono text-xs">
                      <div className="p-1.5 bg-slate-950/80 rounded-lg border border-slate-800">
                        <div className="text-[9px] text-slate-500">AC</div>
                        <div className="font-bold text-sky-400">{monster.armor_class || monster.ac || 14}</div>
                      </div>
                      <div className="p-1.5 bg-slate-950/80 rounded-lg border border-slate-800">
                        <div className="text-[9px] text-slate-500">HP</div>
                        <div className="font-bold text-emerald-400">{monster.hit_points || monster.hp || 30}</div>
                      </div>
                      <div className="p-1.5 bg-slate-950/80 rounded-lg border border-slate-800">
                        <div className="text-[9px] text-slate-500">SPEED</div>
                        <div className="font-bold text-amber-400 truncate">{monster.speed || '30 ft'}</div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between font-mono text-xs">
                    <span className="text-[10px] text-slate-400">
                      XP: {monster.xp || 100}
                    </span>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSpawnMonster(monster);
                      }}
                      className="flex items-center space-x-1 px-2.5 py-1 bg-amber-600/20 hover:bg-amber-600 text-amber-300 hover:text-white border border-amber-600/40 rounded-lg text-xs font-semibold transition cursor-pointer"
                    >
                      {spawnSuccess === monster.name ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-300" />
                          <span>Spawned!</span>
                        </>
                      ) : (
                        <>
                          <Plus className="w-3 h-3" />
                          <span>Spawn</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}

            {activeTab === 'spells' &&
              paginatedItems.map((spell: any, index: number) => (
                <div
                  key={spell.id || index}
                  onClick={() => setSelectedItem(spell)}
                  className="bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-sky-500/50 rounded-2xl p-4 shadow-lg transition-all cursor-pointer group flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="p-2 bg-indigo-950/50 border border-indigo-600/40 rounded-xl text-indigo-400 group-hover:scale-105 transition-transform">
                          <Wand2 className="w-4 h-4" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold font-serif text-slate-100 group-hover:text-sky-300 transition-colors">
                            {spell.name}
                          </h3>
                          <p className="text-[10px] text-slate-400 font-mono">
                            {spell.level === 0 ? 'Cantrip' : `Level ${spell.level}`} · {spell.school}
                          </p>
                        </div>
                      </div>

                      <span className="px-2 py-0.5 bg-indigo-950 text-indigo-300 border border-indigo-600/40 text-[10px] font-mono font-bold rounded">
                        {spell.school}
                      </span>
                    </div>

                    <p className="text-xs text-slate-300 mt-3 line-clamp-2 font-sans leading-relaxed">
                      {spell.description}
                    </p>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-slate-400">
                    <span>{spell.casting_time || '1 action'}</span>
                    <span>{spell.range || '60 ft'}</span>
                  </div>
                </div>
              ))}

            {activeTab === 'magic-items' &&
              paginatedItems.map((item: any, index: number) => (
                <div
                  key={item.id || index}
                  onClick={() => setSelectedItem(item)}
                  className="bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-purple-500/50 rounded-2xl p-4 shadow-lg transition-all cursor-pointer group flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="p-2 bg-purple-950/50 border border-purple-600/40 rounded-xl text-purple-400 group-hover:scale-105 transition-transform">
                          <Gem className="w-4 h-4" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold font-serif text-slate-100 group-hover:text-purple-300 transition-colors">
                            {item.name}
                          </h3>
                          <p className="text-[10px] text-slate-400 font-mono capitalize">{item.item_type || item.category}</p>
                        </div>
                      </div>

                      <span className={`px-2 py-0.5 border text-[10px] font-mono font-bold rounded ${
                        item.rarity === 'Legendary' ? 'bg-orange-950 text-orange-300 border-orange-600/40'
                        : item.rarity === 'Very Rare' ? 'bg-violet-950 text-violet-300 border-violet-600/40'
                        : item.rarity === 'Rare' ? 'bg-sky-950 text-sky-300 border-sky-600/40'
                        : item.rarity === 'Uncommon' ? 'bg-emerald-950 text-emerald-300 border-emerald-600/40'
                        : 'bg-slate-800 text-slate-300 border-slate-600/40'
                      }`}>
                        {item.rarity || 'Common'}
                      </span>
                    </div>

                    <p className="text-xs text-slate-300 mt-3 line-clamp-2 font-sans leading-relaxed">
                      {item.description}
                    </p>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-slate-400">
                    <span className="capitalize">{item.category}</span>
                    {item.requires_attunement && (
                      <span className="px-1.5 py-0.5 bg-amber-950/60 text-amber-300 border border-amber-600/30 rounded">Attunement</span>
                    )}
                  </div>
                </div>
              ))}

            {activeTab === 'feats' &&
              paginatedItems.map((feat: any, index: number) => (
                <div
                  key={feat.id || index}
                  onClick={() => setSelectedItem(feat)}
                  className="bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-emerald-500/50 rounded-2xl p-4 shadow-lg transition-all cursor-pointer group flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="p-2 bg-emerald-950/50 border border-emerald-600/40 rounded-xl text-emerald-400 group-hover:scale-105 transition-transform">
                          <Feather className="w-4 h-4" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold font-serif text-slate-100 group-hover:text-emerald-300 transition-colors">
                            {feat.name}
                          </h3>
                          <p className="text-[10px] text-slate-400 font-mono">{feat.category} Feat</p>
                        </div>
                      </div>
                    </div>

                    <p className="text-xs text-slate-300 mt-3 line-clamp-3 font-sans leading-relaxed">
                      {feat.description}
                    </p>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center text-[10px] font-mono text-slate-400">
                    <span>{feat.prerequisite ? `Requires: ${feat.prerequisite}` : 'No prerequisite'}</span>
                  </div>
                </div>
              ))}

            {activeTab === 'animals' &&
              paginatedItems.map((animal: any, index: number) => (
                <div
                  key={animal.id || index}
                  onClick={() => setSelectedItem(animal)}
                  className="bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-lime-500/50 rounded-2xl p-4 shadow-lg transition-all cursor-pointer group flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="p-2 bg-lime-950/50 border border-lime-600/40 rounded-xl text-lime-400 group-hover:scale-105 transition-transform">
                          <PawPrint className="w-4 h-4" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold font-serif text-slate-100 group-hover:text-lime-300 transition-colors">
                            {animal.name}
                          </h3>
                          <p className="text-[10px] text-slate-400 font-mono capitalize">
                            {animal.size || 'Medium'} Beast
                          </p>
                        </div>
                      </div>

                      <span className="px-2 py-0.5 bg-lime-950 text-lime-300 border border-lime-600/40 text-[11px] font-mono font-bold rounded">
                        CR {animal.challenge_rating || '1/4'}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 mt-3 text-center font-mono text-xs">
                      <div className="p-1.5 bg-slate-950/80 rounded-lg border border-slate-800">
                        <div className="text-[9px] text-slate-500">AC</div>
                        <div className="font-bold text-sky-400">{animal.ac || 12}</div>
                      </div>
                      <div className="p-1.5 bg-slate-950/80 rounded-lg border border-slate-800">
                        <div className="text-[9px] text-slate-500">HP</div>
                        <div className="font-bold text-emerald-400">{animal.hp || 20}</div>
                      </div>
                      <div className="p-1.5 bg-slate-950/80 rounded-lg border border-slate-800">
                        <div className="text-[9px] text-slate-500">SPEED</div>
                        <div className="font-bold text-amber-400 truncate">{animal.speed || '30 ft'}</div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-end">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSpawnMonster(animal);
                      }}
                      className="flex items-center space-x-1 px-2.5 py-1 bg-lime-600/20 hover:bg-lime-600 text-lime-300 hover:text-white border border-lime-600/40 rounded-lg text-xs font-semibold transition cursor-pointer"
                    >
                      {spawnSuccess === animal.name ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-300" />
                          <span>Spawned!</span>
                        </>
                      ) : (
                        <>
                          <Plus className="w-3 h-3" />
                          <span>Spawn</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}

            {activeTab === 'glossary' &&
              paginatedItems.map((term: any, index: number) => (
                <div
                  key={term.id || index}
                  onClick={() => setSelectedItem({ ...term, name: term.term, description: term.definition })}
                  className="bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 rounded-2xl p-4 shadow-lg transition-all cursor-pointer group"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="p-2 bg-cyan-950/50 border border-cyan-600/40 rounded-xl text-cyan-400 group-hover:scale-105 transition-transform">
                        <ScrollText className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold font-serif text-slate-100 group-hover:text-cyan-300 transition-colors">
                          {term.term}
                        </h3>
                        {term.tag && <p className="text-[10px] text-slate-400 font-mono">[{term.tag}]</p>}
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-slate-300 mt-3 line-clamp-3 font-sans leading-relaxed">
                    {term.definition}
                  </p>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Bottom Responsive Pagination Bar */}
      <div className="bg-slate-950 border border-slate-800 rounded-2xl p-3 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0 font-mono text-xs">
        <div className="text-slate-400 text-xs">
          Showing <strong className="text-slate-200">{activeItems.length > 0 ? startIndex + 1 : 0}</strong>–
          <strong className="text-slate-200">{Math.min(startIndex + ITEMS_PER_PAGE, activeItems.length)}</strong> of{' '}
          <strong className="text-amber-400">{activeItems.length}</strong> {activeTab} (Page{' '}
          <strong className="text-slate-200">{currentPage}</strong> of <strong className="text-slate-200">{totalPages}</strong>)
        </div>

        <div className="hidden lg:block text-[9px] text-slate-600">
          Rules content from the D&amp;D System Reference Document 5.2 © Wizards of the Coast (
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className="underline hover:text-slate-400">
            CC BY 4.0
          </a>
          )
        </div>

        {/* Pagination Nav Buttons */}
        <div className="flex items-center space-x-1.5">
          <button
            onClick={() => handlePageChange(1)}
            disabled={currentPage === 1}
            className="p-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none border border-slate-800 rounded-lg text-slate-300 transition cursor-pointer"
            title="First Page"
          >
            <ChevronsLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 1}
            className="p-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none border border-slate-800 rounded-lg text-slate-300 transition cursor-pointer"
            title="Previous Page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* Page Number Pills */}
          {getPageNumbers().map((num) => (
            <button
              key={num}
              onClick={() => handlePageChange(num)}
              className={`w-7 h-7 rounded-lg border font-bold text-xs transition cursor-pointer ${
                num === currentPage
                  ? 'bg-amber-600 text-white border-amber-500 shadow'
                  : 'bg-slate-900 hover:bg-slate-800 text-slate-400 border-slate-800 hover:text-white'
              }`}
            >
              {num}
            </button>
          ))}

          <button
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
            className="p-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none border border-slate-800 rounded-lg text-slate-300 transition cursor-pointer"
            title="Next Page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => handlePageChange(totalPages)}
            disabled={currentPage === totalPages}
            className="p-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none border border-slate-800 rounded-lg text-slate-300 transition cursor-pointer"
            title="Last Page"
          >
            <ChevronsRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Rich Statblock Detail Modal */}
      {selectedItem && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl space-y-4 animate-fadeIn">
            <div className="flex items-start justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-xl font-bold font-serif text-slate-100">{selectedItem.name}</h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  {selectedItem.size || (selectedItem.level === 0 ? 'Cantrip' : `Level ${selectedItem.level}`)}{' '}
                  {selectedItem.type || selectedItem.school}
                </p>
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed font-sans bg-slate-950/60 p-4 rounded-xl border border-slate-800">
              {selectedItem.description}
            </p>

            <div className="flex justify-end space-x-2 pt-2 border-t border-slate-800">
              {(activeTab === 'monsters' || activeTab === 'animals') && (
                <button
                  onClick={() => {
                    handleSpawnMonster(selectedItem);
                    setSelectedItem(null);
                  }}
                  className="flex items-center space-x-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs font-mono rounded-xl shadow transition cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Spawn to Canvas</span>
                </button>
              )}
              <button
                onClick={() => setSelectedItem(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono rounded-xl transition cursor-pointer"
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
