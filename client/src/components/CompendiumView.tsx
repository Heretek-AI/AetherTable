import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  Search,
  Skull,
  Sparkles,
  Gem,
  Feather,
  PawPrint,
  ScrollText,
  Wand2,
  Plus,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Check,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Token } from './TacticalCanvas';
import { globalAudio } from '../render/audio_manager';
import { ModalShell } from './ui/ModalShell';
import { Statblock } from '../ui/Statblock';
import type { StatblockKind } from '../ui/Statblock';

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

/** Tab identity doubles as the card-kind discriminator for CompendiumCard. */
const TABS: { id: CompendiumTab; label: string; icon: LucideIcon }[] = [
  { id: 'monsters', label: 'Monsters', icon: Skull },
  { id: 'spells', label: 'Spells', icon: Sparkles },
  { id: 'magic-items', label: 'Magic Items', icon: Gem },
  { id: 'feats', label: 'Feats', icon: Feather },
  { id: 'animals', label: 'Animals', icon: PawPrint },
  { id: 'glossary', label: 'Glossary', icon: ScrollText },
];

const CARD_ICONS: Record<CompendiumTab, LucideIcon> = Object.fromEntries(
  TABS.map((t) => [t.id, t.icon]),
) as Record<CompendiumTab, LucideIcon>;

const SPELL_SCHOOLS = [
  'Abjuration',
  'Conjuration',
  'Divination',
  'Enchantment',
  'Evocation',
  'Illusion',
  'Necromancy',
  'Transmutation',
];

const CR_FILTERS = ['All', '0', '1/4', '1/2', '1', '2', '3', '5', '7', '10', '13', '17', '21'];

/** Tab → shared Statblock renderer kind. Feats print like items. */
function statblockKindForTab(tab: CompendiumTab): StatblockKind {
  if (tab === 'spells') return 'spell';
  if (tab === 'monsters' || tab === 'animals') return 'monster';
  return 'item';
}

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
  const [selectedItem, setSelectedItem] = useState<Record<string, any> | null>(null);
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

  const tabCounts: Record<CompendiumTab, number> = {
    monsters: filteredMonsters.length,
    spells: filteredSpells.length,
    'magic-items': filteredMagicItems.length,
    feats: filteredFeats.length,
    animals: filteredAnimals.length,
    glossary: filteredGlossary.length,
  };

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setCurrentPage(newPage);
      // No chime here: pagination is silent UI navigation — reserving audio
      // cues for gameplay events keeps them meaningful (UX: alarm fatigue).
    }
  };

  const handleSpawnMonster = (monster: Record<string, any>) => {
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

  const openEntry = (entry: Record<string, any>) => {
    // Glossary entries key on term/definition; normalize so the Statblock
    // renderer (which prints item.name/item.description) sees both.
    if (activeTab === 'glossary') {
      setSelectedItem({ ...entry, name: entry.term, description: entry.definition });
    } else {
      setSelectedItem(entry);
    }
  };

  const selectedCanSpawn = activeTab === 'monsters' || activeTab === 'animals';

  const pageNavBtn =
    'vtt-btn vtt-btn-secondary disabled:opacity-30 disabled:pointer-events-none';

  return (
    <div className="w-full h-full flex flex-col overflow-hidden p-6 max-w-7xl mx-auto space-y-4 select-none">
      {/* Header Banner */}
      <header className="bg-tavern-surface border border-tavern-border rounded-2xl p-5 shadow-lg relative overflow-hidden shrink-0">
        <div className="absolute -right-6 -bottom-6 w-40 h-40 bg-tavern-accent/5 rounded-full blur-3xl pointer-events-none" />
        <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center space-x-3.5">
            <div className="p-3 bg-tavern-bg border border-tavern-border rounded-xl text-tavern-accent shadow-inner">
              <BookOpen className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2.5">
                <h2 className="vtt-engraved text-xl font-bold tracking-wide">
                  D&amp;D 5e Compendium Codex
                </h2>
                <span className="vtt-badge">SRD 5.2</span>
              </div>
              <p className="text-xs text-[var(--rp-parchment-300)] mt-0.5">
                Explore monster statblocks, spell grimoires, and spawn tokens directly to the tactical canvas.
              </p>
            </div>
          </div>

          {/* Search Bar, Filters & Tab Switcher */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-56">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--rp-parchment-300)] pointer-events-none" />
              <input
                type="text"
                placeholder="Search monsters, spells, rules..."
                aria-label="Search the compendium"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="vtt-input w-full pl-9 text-xs font-mono"
              />
            </div>

            {activeTab === 'spells' && (
              <select
                aria-label="Filter by school of magic"
                value={selectedSchool}
                onChange={(e) => setSelectedSchool(e.target.value)}
                className="vtt-select text-xs font-mono"
              >
                <option value="All">All Schools</option>
                {SPELL_SCHOOLS.map((school) => (
                  <option key={school} value={school}>
                    {school}
                  </option>
                ))}
              </select>
            )}

            {(activeTab === 'monsters' || activeTab === 'animals') && (
              <select
                aria-label="Filter by challenge rating"
                value={selectedCR}
                onChange={(e) => setSelectedCR(e.target.value)}
                className="vtt-select text-xs font-mono"
              >
                {CR_FILTERS.map((cr) => (
                  <option key={cr} value={cr}>
                    {cr === 'All' ? 'All CRs' : `CR ${cr}`}
                  </option>
                ))}
              </select>
            )}

            <nav aria-label="Compendium sections" className="vtt-tabbar flex-wrap max-w-full overflow-x-auto">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  data-active={activeTab === id}
                  aria-current={activeTab === id ? 'page' : undefined}
                  className="vtt-tab whitespace-nowrap flex items-center space-x-1.5"
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    {label} ({tabCounts[id]})
                  </span>
                </button>
              ))}
            </nav>
          </div>
        </div>
      </header>

      {/* Main Content Grid (Scrollable) */}
      <div className="flex-1 overflow-y-auto vtt-scrollbar pr-1 min-h-0">
        {paginatedItems.length === 0 ? (
          <div className="p-12 text-center text-[var(--rp-parchment-300)] font-mono text-xs bg-tavern-bg border border-tavern-border rounded-xl">
            No entries found matching "{searchQuery}".
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {paginatedItems.map((entry: Record<string, any>, index: number) => (
              <CompendiumCard
                key={entry.id || index}
                entry={entry}
                kind={activeTab}
                spawned={spawnSuccess === (entry.name ?? entry.term)}
                onOpen={() => openEntry(entry)}
                onSpawn={
                  activeTab === 'monsters' || activeTab === 'animals'
                    ? () => handleSpawnMonster(entry)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom Responsive Pagination Bar */}
      <footer className="bg-tavern-bg border border-tavern-border rounded-2xl p-3 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0 font-mono text-xs text-[var(--rp-parchment-300)]">
        <div className="text-xs">
          Showing{' '}
          <strong className="text-parchment-paper">
            {activeItems.length > 0 ? startIndex + 1 : 0}
          </strong>
          –
          <strong className="text-parchment-paper">
            {Math.min(startIndex + ITEMS_PER_PAGE, activeItems.length)}
          </strong>{' '}
          of <strong className="text-tavern-accent">{activeItems.length}</strong> {activeTab} (Page{' '}
          <strong className="text-parchment-paper">{currentPage}</strong> of{' '}
          <strong className="text-parchment-paper">{totalPages}</strong>)
        </div>

        <div className="hidden lg:block text-[9px] text-[var(--rp-parchment-300)] opacity-70">
          Rules content from the D&amp;D System Reference Document 5.2 © Wizards of the Coast (
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-parchment-paper"
          >
            CC BY 4.0
          </a>
          )
        </div>

        {/* Pagination Nav Buttons */}
        <div className="flex items-center space-x-1.5">
          <button
            onClick={() => handlePageChange(1)}
            disabled={currentPage === 1}
            className={pageNavBtn}
            title="First Page"
          >
            <ChevronsLeft className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 1}
            className={pageNavBtn}
            title="Previous Page"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          </button>

          {/* Page Number Pills */}
          {getPageNumbers().map((num) => (
            <button
              key={num}
              onClick={() => handlePageChange(num)}
              aria-current={num === currentPage ? 'page' : undefined}
              className={`vtt-btn w-7 h-7 text-xs ${
                num === currentPage ? 'vtt-btn-primary' : 'vtt-btn-secondary'
              }`}
            >
              {num}
            </button>
          ))}

          <button
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
            className={pageNavBtn}
            title="Next Page"
          >
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            onClick={() => handlePageChange(totalPages)}
            disabled={currentPage === totalPages}
            className={pageNavBtn}
            title="Last Page"
          >
            <ChevronsRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </footer>

      {/* Rich Statblock Detail Sheet — ModalShell owns the dialog pattern
          (ESC/trap/backdrop) and the book-red small-caps header; Statblock
          prints the printed-book body. Nested rung so it layers above the
          compendium itself. */}
      <ModalShell
        isOpen={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        title="SRD 5.2 Statblock"
        size="lg"
        tone="statblock"
        nested
        footer={
          selectedCanSpawn ? (
            <div className="flex justify-end">
              <button
                type="button"
                className="vtt-btn vtt-btn-primary"
                onClick={() => {
                  if (selectedItem) handleSpawnMonster(selectedItem);
                  setSelectedItem(null);
                }}
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>Spawn to Canvas</span>
              </button>
            </div>
          ) : undefined
        }
      >
        <Statblock item={selectedItem ?? {}} kind={statblockKindForTab(activeTab)} />
      </ModalShell>
    </div>
  );
};

/**
 * One card to rule all six tabs — the per-tab markup that used to be copied
 * six times (~lines 346–665) now branches on `kind` alone. Surface treatment
 * is uniform (vtt-card-elevated); only the details row differs per kind:
 *   monsters/animals → CR badge + mini AC/HP/SPEED statblock strip + Spawn CTA
 *   spells           → school badge + description + casting time/range footer
 *   magic-items      → rarity badge + attunement flag
 *   feats            → category + prerequisite footer
 *   glossary         → [tag] + definition prose
 */
interface CompendiumCardProps {
  /** Loosely typed SRD compendium entry (shapes vary per endpoint). */
  entry: Record<string, any>;
  /** Which tab this card belongs to — drives icon, badges, detail rows. */
  kind: CompendiumTab;
  /** True while the spawn confirmation toast is showing for this entry. */
  spawned?: boolean;
  /** Open the full statblock sheet (card click / Enter / Space). */
  onOpen: () => void;
  /** Present only for spawneable kinds (monsters, animals). */
  onSpawn?: () => void;
}

/** One cell of the compact AC/HP/SPEED strip inside creature cards. */
function MiniAttr({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 text-center">
      <dt className="vtt-attr-label text-[9px] leading-tight">{label}</dt>
      <dd className="vtt-attr-value text-xs truncate" title={String(value ?? '')}>
        {value ?? '—'}
      </dd>
    </div>
  );
}

function CompendiumCard({ entry, kind, spawned, onOpen, onSpawn }: CompendiumCardProps) {
  const Icon = CARD_ICONS[kind];
  const isCreature = kind === 'monsters' || kind === 'animals';

  let title = entry.name ?? entry.term ?? 'Untitled';
  let tagline = '';
  switch (kind) {
    case 'monsters':
      tagline = `${entry.size || 'Medium'} ${entry.type || 'Monstrosity'}`;
      break;
    case 'animals':
      tagline = `${entry.size || 'Medium'} Beast`;
      break;
    case 'spells':
      tagline = `${entry.level === 0 ? 'Cantrip' : `Level ${entry.level}`} · ${entry.school ?? ''}`;
      break;
    case 'magic-items':
      tagline = entry.item_type || entry.category || '';
      break;
    case 'feats':
      tagline = `${entry.category ?? ''} Feat`;
      break;
    case 'glossary':
      tagline = entry.tag ? `[${entry.tag}]` : 'Rules Term';
      break;
  }

  const badge =
    isCreature
      ? `CR ${entry.challenge_rating || entry.cr || '1'}`
      : kind === 'spells'
        ? entry.school
        : kind === 'magic-items'
          ? entry.rarity || 'Common'
          : null;

  const body =
    kind === 'spells' || kind === 'magic-items' || kind === 'feats' || kind === 'glossary'
      ? entry.description ?? entry.definition
      : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="vtt-card-elevated rounded-xl p-4 cursor-pointer group flex flex-col justify-between focus-visible:outline-2 focus-visible:outline-tavern-accent"
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="shrink-0 p-2 bg-tavern-bg border border-tavern-border rounded-xl text-tavern-accent group-hover:scale-105 transition-transform">
              <Icon className="w-4 h-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3 className="vtt-engraved text-sm font-bold truncate">{title}</h3>
              <p className="text-[10px] text-[var(--rp-parchment-300)] font-mono capitalize truncate">
                {tagline}
              </p>
            </div>
          </div>

          {badge && <span className="vtt-badge shrink-0">{badge}</span>}
        </div>

        {/* Creature cards carry the printed-book attribute strip; the paper
            background needs ink-dark values, hence text-parchment-ink here. */}
        {isCreature && (
          <dl className="vtt-statblock-attr grid grid-cols-3 gap-2 px-2.5 py-1.5 mt-3 rounded-sm text-parchment-ink">
            <MiniAttr label="AC" value={entry.armor_class || entry.ac || 14} />
            <MiniAttr label="HP" value={entry.hit_points || entry.hp || 30} />
            <MiniAttr label="Speed" value={entry.speed || '30 ft'} />
          </dl>
        )}

        {body && (
          <p className="font-prose text-xs text-parchment-paper/80 mt-3 line-clamp-3 leading-relaxed selectable-text">
            {body}
          </p>
        )}
      </div>

      {(isCreature || kind === 'spells' || kind === 'magic-items' || kind === 'feats') && (
        <>
          <div className="vtt-divider my-2">
            <span />
          </div>
          <div className="flex items-center justify-between font-mono text-xs text-[var(--rp-parchment-300)]">
            {kind === 'monsters' && <span className="text-[10px]">XP: {entry.xp || 100}</span>}

            {kind === 'spells' && (
              <>
                <span>{entry.casting_time || '1 action'}</span>
                <span>{entry.range || '60 ft'}</span>
              </>
            )}

            {kind === 'magic-items' && (
              <>
                <span className="capitalize">{entry.category}</span>
                {entry.requires_attunement && <span className="vtt-badge">Attunement</span>}
              </>
            )}

            {kind === 'feats' && (
              <span>{entry.prerequisite ? `Requires: ${entry.prerequisite}` : 'No prerequisite'}</span>
            )}

            {isCreature &&
              (spawned ? (
                <span className="vtt-badge vtt-badge-success">
                  <Check className="w-3 h-3" aria-hidden="true" /> Spawned!
                </span>
              ) : (
                onSpawn && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSpawn();
                    }}
                    className="vtt-btn vtt-btn-primary text-[11px]"
                  >
                    <Plus className="w-3 h-3" aria-hidden="true" />
                    <span>Spawn</span>
                  </button>
                )
              ))}
          </div>
        </>
      )}
    </div>
  );
}
