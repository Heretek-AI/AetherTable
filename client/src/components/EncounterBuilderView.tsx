import React, { useState, useMemo } from 'react';
import {
  Swords,
  Shield,
  Skull,
  Users,
  Plus,
  Trash2,
  Play,
  CheckCircle,
  AlertTriangle,
  Flame,
  Zap,
  Sparkles,
  Search,
  Filter,
  ArrowRight,
  TrendingUp,
} from 'lucide-react';
import { Token } from './TacticalCanvas';

interface MonsterRosterItem {
  id: string;
  name: string;
  cr: string;
  xp: number;
  hp: number;
  ac: number;
  count: number;
  color: string;
  avatarIconType: string;
}

interface EncounterBuilderViewProps {
  onLaunchEncounter: (monsters: Omit<Token, 'id' | 'x' | 'y'>[], customPositions?: { x: number; y: number }[]) => void;
}

// D&D 5e SRD XP Thresholds by Character Level [Easy, Medium, Hard, Deadly]
const XP_THRESHOLDS_BY_LEVEL: Record<number, [number, number, number, number]> = {
  1: [25, 50, 75, 100],
  2: [50, 100, 150, 200],
  3: [75, 150, 225, 400],
  4: [125, 250, 375, 500],
  5: [250, 500, 750, 1100],
  6: [300, 600, 900, 1400],
  7: [350, 750, 1100, 1700],
  8: [450, 900, 1400, 2100],
  9: [550, 1100, 1600, 2400],
  10: [600, 1200, 1900, 2800],
  11: [800, 1600, 2400, 3600],
  12: [1000, 2000, 3000, 4500],
  13: [1100, 2200, 3400, 5100],
  14: [1250, 2500, 3800, 5700],
  15: [1400, 2800, 4300, 6400],
  16: [1600, 3200, 4800, 7200],
  17: [2000, 3900, 5900, 8800],
  18: [2100, 4200, 6300, 9500],
  19: [2400, 4900, 7300, 10900],
  20: [2800, 5700, 8500, 12700],
};

const COMPENDIUM_MONSTER_PRESETS: Omit<MonsterRosterItem, 'count'>[] = [
  { id: 'orc_warlord', name: 'Orc Warlord', cr: '4', xp: 1100, hp: 58, ac: 16, color: '#dc2626', avatarIconType: 'boss' },
  { id: 'goblin_scout', name: 'Goblin Scout', cr: '1/4', xp: 50, hp: 12, ac: 14, color: '#f59e0b', avatarIconType: 'scout' },
  { id: 'shadow_drake', name: 'Shadow Drake', cr: '3', xp: 700, hp: 45, ac: 15, color: '#8b5cf6', avatarIconType: 'boss' },
  { id: 'iron_golem', name: 'Iron Golem Sentry', cr: '5', xp: 1800, hp: 90, ac: 18, color: '#64748b', avatarIconType: 'boss' },
  { id: 'cult_fanatic', name: 'Cult Fanatic', cr: '2', xp: 450, hp: 33, ac: 13, color: '#9333ea', avatarIconType: 'caster' },
  { id: 'skeleton_archer', name: 'Skeleton Archer', cr: '1/4', xp: 50, hp: 13, ac: 13, color: '#cbd5e1', avatarIconType: 'scout' },
  { id: 'young_red_dragon', name: 'Young Red Dragon', cr: '10', xp: 5900, hp: 178, ac: 18, color: '#b91c1c', avatarIconType: 'boss' },
  { id: 'ogre_berserker', name: 'Ogre Berserker', cr: '2', xp: 450, hp: 59, ac: 11, color: '#ea580c', avatarIconType: 'fighter' },
];

export const EncounterBuilderView: React.FC<EncounterBuilderViewProps> = ({ onLaunchEncounter }) => {
  const [partySize, setPartySize] = useState<number>(4);
  const [partyLevel, setPartyLevel] = useState<number>(5);
  const [roster, setRoster] = useState<MonsterRosterItem[]>([
    { id: 'orc_warlord', name: 'Orc Warlord', cr: '4', xp: 1100, hp: 58, ac: 16, count: 1, color: '#dc2626', avatarIconType: 'boss' },
    { id: 'goblin_scout', name: 'Goblin Scout', cr: '1/4', xp: 50, hp: 12, ac: 14, count: 2, color: '#f59e0b', avatarIconType: 'scout' },
  ]);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [encounterLaunched, setEncounterLaunched] = useState<boolean>(false);

  // Calculate Party Thresholds
  const thresholds = useMemo(() => {
    const base = XP_THRESHOLDS_BY_LEVEL[partyLevel] || XP_THRESHOLDS_BY_LEVEL[5];
    return {
      easy: base[0] * partySize,
      medium: base[1] * partySize,
      hard: base[2] * partySize,
      deadly: base[3] * partySize,
    };
  }, [partySize, partyLevel]);

  // Calculate Total Raw XP and Adjusted XP with Multiplier
  const totalMonsters = useMemo(() => roster.reduce((sum, item) => sum + item.count, 0), [roster]);
  const rawXp = useMemo(() => roster.reduce((sum, item) => sum + item.xp * item.count, 0), [roster]);

  const multiplier = useMemo(() => {
    if (totalMonsters <= 1) return 1.0;
    if (totalMonsters === 2) return 1.5;
    if (totalMonsters >= 3 && totalMonsters <= 6) return 2.0;
    if (totalMonsters >= 7 && totalMonsters <= 10) return 2.5;
    return 3.0;
  }, [totalMonsters]);

  const adjustedXp = useMemo(() => Math.round(rawXp * multiplier), [rawXp, multiplier]);

  // Determine Encounter Difficulty
  const difficulty = useMemo(() => {
    if (adjustedXp === 0) return { label: 'Trivial', badge: 'vtt-badge' };
    if (adjustedXp < thresholds.medium) return { label: 'Easy', badge: 'vtt-badge vtt-badge-success' };
    if (adjustedXp < thresholds.hard) return { label: 'Medium', badge: 'vtt-badge' };
    if (adjustedXp < thresholds.deadly) return { label: 'Hard', badge: 'vtt-badge vtt-badge-danger' };
    return { label: 'Deadly', badge: 'vtt-badge vtt-badge-danger font-black tracking-widest' };
  }, [adjustedXp, thresholds]);

  const handleAddMonster = (preset: Omit<MonsterRosterItem, 'count'>) => {
    setRoster((prev) => {
      const existing = prev.find((item) => item.id === preset.id);
      if (existing) {
        return prev.map((item) =>
          item.id === preset.id ? { ...item, count: item.count + 1 } : item
        );
      }
      return [...prev, { ...preset, count: 1 }];
    });
  };

  const handleUpdateCount = (id: string, delta: number) => {
    setRoster((prev) =>
      prev
        .map((item) => (item.id === id ? { ...item, count: Math.max(0, item.count + delta) } : item))
        .filter((item) => item.count > 0)
    );
  };

  const handleRemoveMonster = (id: string) => {
    setRoster((prev) => prev.filter((item) => item.id !== id));
  };

  const handleDeployToTabletop = () => {
    const tokensToDeploy: Omit<Token, 'id' | 'x' | 'y'>[] = [];
    const customPositions: { x: number; y: number }[] = [];

    let currentX = 9;
    let currentY = 3;

    roster.forEach((item) => {
      for (let i = 0; i < item.count; i++) {
        tokensToDeploy.push({
          name: item.count > 1 ? `${item.name} #${i + 1}` : item.name,
          hp: item.hp,
          maxHp: item.hp,
          ac: item.ac,
          color: item.color,
          isPlayer: false,
          avatarIconType: item.avatarIconType,
          elevationFeet: 0,
        });

        customPositions.push({ x: currentX, y: currentY });
        currentY += 2;
        if (currentY > 9) {
          currentY = 3;
          currentX += 2;
        }
      }
    });

    onLaunchEncounter(tokensToDeploy, customPositions);
    setEncounterLaunched(true);
    setTimeout(() => setEncounterLaunched(false), 3000);
  };

  const filteredPresets = COMPENDIUM_MONSTER_PRESETS.filter((m) =>
    m.name.toLowerCase().includes(searchTerm.toLowerCase()) || m.cr.includes(searchTerm)
  );

  return (
    <div className="space-y-6">
      {/* Hero Banner (D&D Beyond Style) */}
      <div className="vtt-glass-panel rounded-xl p-6 relative overflow-hidden">
        <div className="absolute -right-6 -bottom-6 w-40 h-40 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center space-x-4">
            <div className="p-3.5 bg-amber-950/40 border border-tavern-accent/30 rounded-xl text-amber-400 shadow-inner">
              <Swords className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center space-x-3">
                <h2 className="vtt-engraved text-2xl font-bold tracking-wide">
                  Encounter Builder &amp; XP Budget
                </h2>
                <span className="vtt-badge font-mono">
                  D&D 5e SRD 5.1
                </span>
              </div>
              <p className="text-xs text-parchment-aged/70 mt-1">
                Calculate tactical combat difficulty thresholds, assemble monster rosters, and launch live encounters onto the tactical tabletop.
              </p>
            </div>
          </div>

          {/* Action Deploy Button */}
          <button
            onClick={handleDeployToTabletop}
            disabled={roster.length === 0}
            className="vtt-btn vtt-btn-danger px-5 py-3 uppercase tracking-wider active:scale-95 disabled:opacity-40 cursor-pointer"
          >
            {encounterLaunched ? (
              <>
                <CheckCircle className="w-4 h-4 text-emerald-300" />
                <span>Encounter Deployed to Tabletop!</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-white" />
                <span>Launch Encounter on Tabletop</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Grid Layout: Party Config & XP Scorecard (Top) + Monster Roster & Compendium (Bottom) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Party Config & Difficulty Scorecard (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Party Configuration */}
          <div className="vtt-surface rounded-xl p-5 shadow-xl">
            <h3 className="vtt-section-header text-sm font-bold border-b border-tavern-border pb-3 mb-4">
              <Users className="w-4 h-4 text-tavern-accent" />
              Party Configuration
            </h3>

            <div className="space-y-4 text-xs">
              <div>
                <label className="text-parchment-aged/90 font-semibold block mb-1.5">
                  Number of Player Characters ({partySize} Players):
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    type="range"
                    min="1"
                    max="8"
                    value={partySize}
                    onChange={(e) => setPartySize(parseInt(e.target.value))}
                    className="w-full accent-amber-500 h-1.5 bg-black/40 rounded-lg"
                  />
                  <span className="w-8 text-center font-mono font-bold text-sm text-amber-400 bg-black/40 py-1 rounded border border-tavern-border">
                    {partySize}
                  </span>
                </div>
              </div>

              <div>
                <label className="text-parchment-aged/90 font-semibold block mb-1.5">
                  Average Party Level ({partyLevel}):
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    type="range"
                    min="1"
                    max="20"
                    value={partyLevel}
                    onChange={(e) => setPartyLevel(parseInt(e.target.value))}
                    className="w-full accent-amber-500 h-1.5 bg-black/40 rounded-lg"
                  />
                  <span className="w-8 text-center font-mono font-bold text-sm text-amber-400 bg-black/40 py-1 rounded border border-tavern-border">
                    {partyLevel}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* XP & Difficulty Scorecard */}
          <div className="vtt-surface rounded-xl p-5 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-tavern-border pb-3">
              <h3 className="vtt-section-header text-sm font-bold">
                <TrendingUp className="w-4 h-4 text-tavern-accent" />
                Difficulty Gauge
              </h3>
              <span className={difficulty.badge}>
                {difficulty.label}
              </span>
            </div>

            {/* XP Breakdown */}
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="p-3 bg-black/40 border border-tavern-border rounded-lg shadow-inner">
                <div className="text-[11px] font-semibold text-parchment-aged/80">Total Raw XP</div>
                <div className="text-lg font-bold font-mono text-amber-300">{rawXp.toLocaleString()} XP</div>
              </div>
              <div className="p-3 bg-black/40 border border-tavern-border rounded-lg shadow-inner">
                <div className="text-[11px] font-semibold text-parchment-aged/80">Adjusted ({multiplier}x)</div>
                <div className="text-lg font-bold font-mono text-amber-400">{adjustedXp.toLocaleString()} XP</div>
              </div>
            </div>

            {/* Threshold Meters */}
            <div className="space-y-2 pt-2 border-t border-tavern-border text-xs">
              <div className="text-[11px] font-bold text-parchment-aged/80 uppercase tracking-wider mb-1">
                Party Thresholds ({partySize} PCs Level {partyLevel}):
              </div>
              <div className="flex justify-between py-1 px-2.5 bg-black/30 rounded border border-tavern-border/60">
                <span className="text-[color:var(--state-success)] font-semibold">Easy</span>
                <span className="font-mono text-parchment-aged/90">{thresholds.easy.toLocaleString()} XP</span>
              </div>
              <div className="flex justify-between py-1 px-2.5 bg-black/30 rounded border border-tavern-border/60">
                <span className="text-amber-400 font-semibold">Medium</span>
                <span className="font-mono text-parchment-aged/90">{thresholds.medium.toLocaleString()} XP</span>
              </div>
              <div className="flex justify-between py-1 px-2.5 bg-black/30 rounded border border-tavern-border/60">
                <span className="text-orange-400 font-semibold">Hard</span>
                <span className="font-mono text-parchment-aged/90">{thresholds.hard.toLocaleString()} XP</span>
              </div>
              <div className="flex justify-between py-1 px-2.5 bg-black/30 rounded border border-tavern-border/60">
                <span className="text-[color:var(--state-danger)] font-semibold">Deadly</span>
                <span className="font-mono text-parchment-aged/90">{thresholds.deadly.toLocaleString()} XP</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Active Monster Roster & Compendium Quick Picker (8 cols) */}
        <div className="lg:col-span-8 space-y-6">
          {/* Active Monster Roster */}
          <div className="vtt-surface rounded-xl p-5 shadow-xl">
            <div className="flex items-center justify-between border-b border-tavern-border pb-3 mb-4">
              <h3 className="vtt-section-header text-sm font-bold">
                <Skull className="w-4 h-4 text-[color:var(--state-danger)]" />
                Active Monster Roster ({totalMonsters} Creatures)
              </h3>
              {roster.length > 0 && (
                <button
                  onClick={() => setRoster([])}
                  className="text-xs text-[color:var(--state-danger)] hover:opacity-80 flex items-center space-x-1 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear All</span>
                </button>
              )}
            </div>

            {roster.length === 0 ? (
              <div className="p-8 text-center border border-dashed border-tavern-border rounded-lg text-parchment-aged/50 text-xs">
                No monsters added to this encounter yet. Select creatures from the compendium below.
              </div>
            ) : (
              <div className="space-y-2.5">
                {roster.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 p-3 vtt-surface rounded-lg shadow-sm"
                  >
                    <div className="flex items-center space-x-3 min-w-0">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs text-white border shadow shrink-0"
                        style={{ backgroundColor: item.color }}
                      >
                        {item.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <div className="vtt-statblock-nameplate text-sm">{item.name}</div>
                        {/* Compact official-book attribute strip (CR · HP · AC · XP) */}
                        <dl className="vtt-statblock-attr mt-1 inline-flex items-center gap-3 rounded-sm px-2 py-0.5 text-[11px]">
                          <div className="flex items-baseline gap-1">
                            <dt className="vtt-attr-label text-[10px]">CR</dt>
                            <dd className="vtt-attr-value font-mono">{item.cr}</dd>
                          </div>
                          <div className="flex items-baseline gap-1">
                            <dt className="vtt-attr-label text-[10px]">HP</dt>
                            <dd className="vtt-attr-value font-mono">{item.hp}</dd>
                          </div>
                          <div className="flex items-baseline gap-1">
                            <dt className="vtt-attr-label text-[10px]">AC</dt>
                            <dd className="vtt-attr-value font-mono">{item.ac}</dd>
                          </div>
                          <div className="flex items-baseline gap-1">
                            <dt className="vtt-attr-label text-[10px]">XP</dt>
                            <dd className="vtt-attr-value font-mono">{item.xp}</dd>
                          </div>
                        </dl>
                      </div>
                    </div>

                    {/* Quantity Stepper */}
                    <div className="flex items-center space-x-2 shrink-0">
                      <div className="flex items-center space-x-1 bg-black/50 border border-tavern-border rounded-lg p-1">
                        <button
                          onClick={() => handleUpdateCount(item.id, -1)}
                          className="w-6 h-6 flex items-center justify-center text-parchment-aged/70 hover:text-parchment-aged hover:bg-black/30 rounded font-bold cursor-pointer"
                        >
                          -
                        </button>
                        <span className="w-6 text-center font-mono font-bold text-xs text-amber-400">
                          {item.count}
                        </span>
                        <button
                          onClick={() => handleUpdateCount(item.id, 1)}
                          className="w-6 h-6 flex items-center justify-center text-parchment-aged/70 hover:text-parchment-aged hover:bg-black/30 rounded font-bold cursor-pointer"
                        >
                          +
                        </button>
                      </div>

                      <button
                        onClick={() => handleRemoveMonster(item.id)}
                        className="p-1.5 text-parchment-aged/50 hover:text-[color:var(--state-danger)] rounded hover:bg-black/30 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick Compendium Monster Browser */}
          <div className="vtt-surface rounded-xl p-5 shadow-xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-tavern-border pb-3 mb-4">
              <h3 className="vtt-section-header text-sm font-bold">
                <Sparkles className="w-4 h-4 text-tavern-accent" />
                SRD Monster Bestiary
              </h3>

              {/* Search Bar */}
              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-parchment-aged/50 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter monsters by name or CR..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="vtt-input w-full pl-8 text-xs"
                />
              </div>
            </div>

            {/* Monster Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-72 overflow-y-auto vtt-scrollbar pr-1">
              {filteredPresets.map((preset) => (
                <div
                  key={preset.id}
                  onClick={() => handleAddMonster(preset)}
                  className="flex items-center justify-between p-3 bg-black/30 hover:bg-black/45 border border-tavern-border hover:border-amber-500/50 rounded-lg cursor-pointer transition-all group shadow-sm"
                >
                  <div className="flex items-center space-x-2.5 min-w-0">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs text-white shadow-sm shrink-0"
                      style={{ backgroundColor: preset.color }}
                    >
                      {preset.name.charAt(0)}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-parchment-aged group-hover:text-amber-200 transition-colors">
                        {preset.name}
                      </div>
                      <div className="text-[10px] text-parchment-aged/70">
                        CR {preset.cr} · {preset.hp} HP · {preset.xp} XP
                      </div>
                    </div>
                  </div>

                  <button className="p-1 text-parchment-aged/70 group-hover:text-amber-400 bg-tavern-bg group-hover:bg-amber-950/50 border border-tavern-border group-hover:border-amber-600/50 rounded transition-colors">
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
