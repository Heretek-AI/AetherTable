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
  Layers,
  AlertTriangle,
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

/**
 * One real endpoint per section (python/vtt_orchestrator/server.py serves
 * each from the SRD 5.2 fixtures under /compendium). `pick` extracts the
 * payload key so loading/failure/empty can be tracked per section honestly —
 * there is deliberately NO client-side fallback dataset: if the service is
 * unreachable the section says so instead of showing invented entries.
 */
const SECTION_SOURCES: Record<CompendiumTab, { url: string; pick: (json: any) => unknown }> = {
  monsters: { url: '/api/v1/compendium/monsters?limit=400', pick: (j) => j?.monsters },
  spells: { url: '/api/v1/compendium/spells?limit=400', pick: (j) => j?.spells },
  'magic-items': { url: '/api/v1/compendium/magic-items?limit=300', pick: (j) => j?.magic_items },
  feats: { url: '/api/v1/compendium/feats?limit=100', pick: (j) => j?.feats },
  animals: { url: '/api/v1/compendium/animals?limit=150', pick: (j) => j?.animals },
  glossary: { url: '/api/v1/compendium/glossary?limit=200', pick: (j) => j?.glossary },
};

type SectionStatus = 'loading' | 'ready' | 'empty' | 'failed';

const initialSections = (): Record<CompendiumTab, any[]> => ({
  monsters: [],
  spells: [],
  'magic-items': [],
  feats: [],
  animals: [],
  glossary: [],
});

const initialSectionStatus = (): Record<CompendiumTab, SectionStatus> => ({
  monsters: 'loading',
  spells: 'loading',
  'magic-items': 'loading',
  feats: 'loading',
  animals: 'loading',
  glossary: 'loading',
});

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

/** How many hits per section the cross-section search shows before "more". */
const CROSS_SECTION_LIMIT = 6;

/** Tab → shared Statblock renderer kind. Feats print like items. */
function statblockKindForTab(tab: CompendiumTab): StatblockKind {
  if (tab === 'spells') return 'spell';
  if (tab === 'monsters' || tab === 'animals') return 'monster';
  return 'item';
}

export const CompendiumView: React.FC<CompendiumViewProps> = ({ onSpawnToken }) => {
  const [activeTab, setActiveTab] = useState<CompendiumTab>('monsters');
  const [searchQuery, setSearchQuery] = useState('');
  // Cross-section mode: one query box filters every fetched set at once.
  const [searchAllSections, setSearchAllSections] = useState(false);
  const [selectedSchool, setSelectedSchool] = useState<string>('All');
  const [selectedCR, setSelectedCR] = useState<string>('All');

  const [sections, setSections] = useState<Record<CompendiumTab, any[]>>(initialSections);
  const [sectionStatus, setSectionStatus] = useState<Record<CompendiumTab, SectionStatus>>(
    initialSectionStatus,
  );
  const [selectedItem, setSelectedItem] = useState<Record<string, any> | null>(null);
  /** Which section the open detail entry came from (drives the Statblock kind). */
  const [selectedKind, setSelectedKind] = useState<CompendiumTab>('monsters');
  const [spawnSuccess, setSpawnSuccess] = useState<string | null>(null);

  // Pagination State
  const [currentPage, setCurrentPage] = useState<number>(1);
  const ITEMS_PER_PAGE = 12;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await Promise.all(
        TABS.map(async ({ id }) => {
          const { url, pick } = SECTION_SOURCES[id];
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const items = pick(await res.json());
            if (cancelled) return;
            const list = Array.isArray(items) ? items : [];
            setSections((prev) => ({ ...prev, [id]: list }));
            setSectionStatus((prev) => ({ ...prev, [id]: list.length > 0 ? 'ready' : 'empty' }));
          } catch {
            if (cancelled) return;
            setSectionStatus((prev) => ({ ...prev, [id]: 'failed' }));
          }
        }),
      );
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reset pagination on search or tab change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedSchool, selectedCR, activeTab, searchAllSections]);

  const q = searchQuery.toLowerCase();
  const matchesText = (entry: any) =>
    !q ||
    entry.name?.toLowerCase().includes(q) ||
    entry.term?.toLowerCase().includes(q) ||
    entry.description?.toLowerCase().includes(q) ||
    entry.definition?.toLowerCase().includes(q);

  const filteredMonsters = sections.monsters.filter((m) => {
    const matchesSearch =
      m.name.toLowerCase().includes(q) || (m.type || m.creature_type || '').toLowerCase().includes(q);
    const crValue = String(m.challenge_rating || m.cr || '');
    const matchesCR = selectedCR === 'All' || crValue.toLowerCase().includes(selectedCR.toLowerCase());
    return matchesSearch && matchesCR;
  });

  const filteredSpells = sections.spells.filter((s) => {
    const matchesSearch =
      s.name.toLowerCase().includes(q) ||
      (s.description && s.description.toLowerCase().includes(q));
    const matchesSchool =
      selectedSchool === 'All' || (s.school && s.school.toLowerCase() === selectedSchool.toLowerCase());
    return matchesSearch && matchesSchool;
  });

  const filteredMagicItems = sections['magic-items'].filter(matchesText);
  const filteredFeats = sections.feats.filter(matchesText);
  const filteredAnimals = sections.animals.filter(
    (a) =>
      matchesText(a) &&
      (q ? a.name.toLowerCase().includes(q) || (a.type || a.creature_type || '').toLowerCase().includes(q) : true) &&
      (selectedCR === 'All' ||
        String(a.challenge_rating || '').includes(selectedCR.toLowerCase()))
  );
  const filteredGlossary = sections.glossary.filter(matchesText);

  const filteredByTab: Record<CompendiumTab, any[]> = {
    monsters: filteredMonsters,
    spells: filteredSpells,
    'magic-items': filteredMagicItems,
    feats: filteredFeats,
    animals: filteredAnimals,
    glossary: filteredGlossary,
  };

  /** True when the query box is driving the cross-section result view. */
  const crossSearchActive = searchAllSections && q.trim().length > 0;

  // Cross-section groups: up to CROSS_SECTION_LIMIT hits per fetched set.
  const crossGroups = TABS.map(({ id, label, icon }) => ({
    tab: id,
    label,
    icon,
    total: filteredByTab[id].length,
    items: filteredByTab[id].slice(0, CROSS_SECTION_LIMIT),
  })).filter((g) => g.items.length > 0);
  const crossTotalMatches = crossGroups.reduce((sum, g) => sum + g.total, 0);

  const activeItems = filteredByTab[activeTab];
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

  const openEntry = (entry: Record<string, any>, tab: CompendiumTab) => {
    // Glossary entries key on term/definition; normalize so the Statblock
    // renderer (which prints item.name/item.description) sees both.
    setSelectedKind(tab);
    setSelectedItem(
      tab === 'glossary' ? { ...entry, name: entry.term, description: entry.definition } : entry,
    );
  };

  const selectedCanSpawn = selectedKind === 'monsters' || selectedKind === 'animals';

  const pageNavBtn =
    'vtt-btn vtt-btn-secondary disabled:opacity-30 disabled:pointer-events-none';

  /** Shared banner panel for loading / failure / empty states. */
  const noticePanel = (icon: React.ReactNode, text: string, tone: 'muted' | 'danger' = 'muted') => (
    <div
      role="status"
      className={`p-12 text-center font-mono text-xs bg-tavern-bg border rounded-xl flex flex-col items-center gap-3 ${
        tone === 'danger'
          ? 'border-[var(--state-danger)] text-[var(--state-danger)]'
          : 'border-tavern-border text-[var(--rp-parchment-300)]'
      }`}
    >
      {icon}
      <span>{text}</span>
    </div>
  );

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
                placeholder={
                  searchAllSections ? 'Search every section...' : 'Search monsters, spells, rules...'
                }
                aria-label="Search the compendium"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="vtt-input w-full pl-9 text-xs font-mono"
              />
            </div>

            <button
              type="button"
              onClick={() => setSearchAllSections((v) => !v)}
              aria-pressed={searchAllSections}
              title="Filter every compendium section with one query"
              className={`vtt-btn text-[11px] whitespace-nowrap ${
                searchAllSections ? 'vtt-btn-primary' : 'vtt-btn-secondary'
              }`}
            >
              <Layers className="w-3.5 h-3.5" aria-hidden="true" />
              <span>All Sections</span>
            </button>

            {activeTab === 'spells' && !crossSearchActive && (
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

            {(activeTab === 'monsters' || activeTab === 'animals') && !crossSearchActive && (
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
        {/* Loading: nothing is shown as data until the real fetch resolves. */}
        {TABS.every((t) => sectionStatus[t.id] === 'loading') ? (
          noticePanel(<Wand2 className="w-6 h-6 animate-pulse" aria-hidden="true" />, 'Consulting the archives...')
        ) : crossSearchActive ? (
          crossGroups.length === 0 ? (
            noticePanel(<Search className="w-6 h-6 opacity-60" aria-hidden="true" />, `No entries found matching "${searchQuery}" in any section.`)
          ) : (
            <div className="space-y-6">
              {crossGroups.map(({ tab, label, icon: Icon, total, items }) => (
                <section key={tab} aria-label={`${label} results`}>
                  <h3 className="flex items-center gap-2 mb-3 font-mono text-xs uppercase tracking-wide text-[var(--rp-parchment-300)]">
                    <Icon className="w-4 h-4 text-tavern-accent" aria-hidden="true" />
                    {label}
                    <span className="vtt-badge">{total}</span>
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {items.map((entry: Record<string, any>, index: number) => (
                      <CompendiumCard
                        key={entry.id || index}
                        entry={entry}
                        kind={tab}
                        spawned={spawnSuccess === (entry.name ?? entry.term)}
                        onOpen={() => openEntry(entry, tab)}
                        onSpawn={
                          tab === 'monsters' || tab === 'animals'
                            ? () => handleSpawnMonster(entry)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                  {total > items.length && (
                    <p className="mt-2 font-mono text-[10px] text-[var(--rp-parchment-300)] opacity-70">
                      Showing first {items.length} of {total} — switch to the {label} tab to page through the rest.
                    </p>
                  )}
                </section>
              ))}
            </div>
          )
        ) : paginatedItems.length === 0 ? (
          sectionStatus[activeTab] === 'loading' ? (
            noticePanel(<Wand2 className="w-6 h-6 animate-pulse" aria-hidden="true" />, 'Consulting the archives...')
          ) : sectionStatus[activeTab] === 'failed' ? (
            noticePanel(
              <AlertTriangle className="w-6 h-6" aria-hidden="true" />,
              `The compendium service could not be reached for this section, so no entries are shown.`,
              'danger',
            )
          ) : sectionStatus[activeTab] === 'empty' && !q ? (
            noticePanel(<BookOpen className="w-6 h-6 opacity-60" aria-hidden="true" />, 'This section has no entries.')
          ) : (
            noticePanel(<Search className="w-6 h-6 opacity-60" aria-hidden="true" />, `No entries found matching "${searchQuery}".`)
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {paginatedItems.map((entry: Record<string, any>, index: number) => (
              <CompendiumCard
                key={entry.id || index}
                entry={entry}
                kind={activeTab}
                spawned={spawnSuccess === (entry.name ?? entry.term)}
                onOpen={() => openEntry(entry, activeTab)}
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
        {crossSearchActive ? (
          <div className="text-xs">
            <strong className="text-tavern-accent">{crossTotalMatches}</strong> matches across{' '}
            <strong className="text-parchment-paper">{crossGroups.length}</strong> sections for "{searchQuery}"
          </div>
        ) : (
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
        )}

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
        {!crossSearchActive && (
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
        )}
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
        <Statblock item={selectedItem ?? {}} kind={statblockKindForTab(selectedKind)} />
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
 * Absent SRD fields render as em-dashes (or drop their badge) — the card never
 * invents placeholder stats for what the server did not send.
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

  const creatureType = entry.type || entry.creature_type;

  let title = entry.name ?? entry.term ?? 'Untitled';
  let tagline = '';
  switch (kind) {
    case 'monsters':
      tagline = [entry.size, creatureType].filter(Boolean).join(' ') || '—';
      break;
    case 'animals':
      tagline = [entry.size, creatureType || 'Beast'].filter(Boolean).join(' ');
      break;
    case 'spells':
      tagline =
        [
          entry.level == null ? null : entry.level === 0 ? 'Cantrip' : `Level ${entry.level}`,
          entry.school,
        ]
          .filter(Boolean)
          .join(' · ') || '—';
      break;
    case 'magic-items':
      tagline = entry.item_type || entry.category || '—';
      break;
    case 'feats':
      tagline = entry.category ? `${entry.category} Feat` : '—';
      break;
    case 'glossary':
      tagline = entry.tag ? `[${entry.tag}]` : 'Rules Term';
      break;
  }

  // Badges only appear when the server actually sent the field — an unknown
  // rarity or school stays blank rather than masquerading as "Common".
  const crValue = entry.challenge_rating ?? entry.cr;
  const badge =
    isCreature
      ? crValue != null && crValue !== ''
        ? `CR ${crValue}`
        : null
      : kind === 'spells'
        ? entry.school || null
        : kind === 'magic-items'
          ? entry.rarity || null
          : null;

  const body =
    kind === 'spells' || kind === 'magic-items' || kind === 'feats' || kind === 'glossary'
      ? (entry.description ?? entry.definition) || null
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
            background needs ink-dark values, hence text-parchment-ink here.
            Nullish coalescing keeps legitimate zeros (e.g. AC 6 oozes). */}
        {isCreature && (
          <dl className="vtt-statblock-attr grid grid-cols-3 gap-2 px-2.5 py-1.5 mt-3 rounded-sm text-parchment-ink">
            <MiniAttr label="AC" value={entry.armor_class ?? entry.ac ?? null} />
            <MiniAttr label="HP" value={entry.hit_points ?? entry.hp ?? null} />
            <MiniAttr label="Speed" value={entry.speed ?? null} />
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
            {kind === 'monsters' && (
              <span className="text-[10px]">XP: {entry.xp != null && entry.xp !== '' ? entry.xp : '—'}</span>
            )}

            {kind === 'spells' && (
              <>
                <span>{entry.casting_time || '—'}</span>
                <span>{entry.range || '—'}</span>
              </>
            )}

            {kind === 'magic-items' && (
              <>
                <span className="capitalize">{entry.category || '—'}</span>
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
