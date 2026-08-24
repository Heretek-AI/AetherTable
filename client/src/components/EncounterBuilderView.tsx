import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Swords,
  Skull,
  Users,
  Plus,
  Trash2,
  Play,
  AlertTriangle,
  Sparkles,
  Search,
  TrendingUp,
  RefreshCw,
} from 'lucide-react';
import {
  ensureEngineSession,
  engineSessionEntities,
  type EngineActionOutcome,
} from '../api/rules_engine';
import {
  fetchCompendiumMonsters,
  spawnMonsterToEngine,
  crToXp,
  partyThresholds,
  encounterMultiplier,
  parsePrimarySpeedFeet,
  type CompendiumMonster,
} from '../api/encounter_store';

interface EncounterBuilderViewProps {
  /**
   * Legacy callback retained only so App.tsx keeps compiling. The builder no
   * longer fabricates local board tokens: spawning goes exclusively through
   * the authoritative engine proxy, and spawned entities appear on the table
   * via the existing session-state snapshot polling. This prop is NOT called.
   */
  onLaunchEncounter?: unknown;
  /**
   * Current authoritative engine session id (same pattern as CharacterSheet's
   * maneuverSessionId: an explicit prop wins, otherwise the builder lazily
   * reuses/creates this client's session via ensureEngineSession()).
   */
  engineSessionId?: string | null;
}

/** One roster line: a real compendium stat block plus how many to spawn. */
interface RosterEntry {
  monster: CompendiumMonster;
  count: number;
}

type SpawnRowOutcome =
  | { kind: 'applied'; label: string; entityId?: string }
  | { kind: 'rejected'; label: string; status: number; code: string | null; message: string | null };

export const EncounterBuilderView: React.FC<EncounterBuilderViewProps> = ({ engineSessionId }) => {
  /* --- Live compendium state -------------------------------------------- */
  const [monsters, setMonsters] = useState<CompendiumMonster[]>([]);
  const [compendiumLoading, setCompendiumLoading] = useState(true);
  const [compendiumError, setCompendiumError] = useState<string | null>(null);

  const loadCompendium = useCallback(async () => {
    setCompendiumLoading(true);
    setCompendiumError(null);
    const result = await fetchCompendiumMonsters();
    if (result.kind === 'ok') {
      setMonsters(result.monsters);
    } else {
      setMonsters([]);
      setCompendiumError(result.message);
    }
    setCompendiumLoading(false);
  }, []);

  useEffect(() => {
    void loadCompendium();
  }, [loadCompendium]);

  /* --- Encounter assembly (session-scoped in memory ONLY — there is no
   *     encounter-save endpoint server-side, so nothing here is persisted) --- */
  const [partySize, setPartySize] = useState<number>(4);
  const [partyLevel, setPartyLevel] = useState<number>(5);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [searchTerm, setSearchTerm] = useState<string>('');

  /* --- Spawn plumbing ------------------------------------------------------ */
  const [spawning, setSpawning] = useState(false);
  const [spawnResults, setSpawnResults] = useState<SpawnRowOutcome[]>([]);
  /** Engine-confirmed entity count from a READ of projected session state. */
  const [confirmedEntityCount, setConfirmedEntityCount] = useState<number | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  /* --- Party thresholds & budget ------------------------------------------ */
  // Formula (see encounter_store.ts): threshold_x = per_char_threshold(level, x)
  // × party_size; adjusted_xp = round(raw_xp × multiplier(creature_count));
  // difficulty compares adjusted_xp against the four thresholds.
  const thresholds = useMemo(() => partyThresholds(partyLevel, partySize), [partyLevel, partySize]);

  const totalCreatures = useMemo(
    () => roster.reduce((sum, entry) => sum + entry.count, 0),
    [roster],
  );

  const unmappedCrCount = useMemo(
    () => roster.filter((entry) => crToXp(entry.monster.challenge_rating) === null).length,
    [roster],
  );

  const rawXp = useMemo(
    () =>
      roster.reduce((sum, entry) => {
        const xp = crToXp(entry.monster.challenge_rating);
        return sum + (xp ?? 0) * entry.count;
      }, 0),
    [roster],
  );

  const multiplier = useMemo(() => encounterMultiplier(totalCreatures), [totalCreatures]);
  const adjustedXp = useMemo(() => Math.round(rawXp * multiplier), [rawXp, multiplier]);

  const difficulty = useMemo(() => {
    if (adjustedXp === 0) return { label: 'Trivial', badge: 'vtt-badge' };
    if (adjustedXp < thresholds.medium) return { label: 'Easy', badge: 'vtt-badge vtt-badge-success' };
    if (adjustedXp < thresholds.hard) return { label: 'Medium', badge: 'vtt-badge' };
    if (adjustedXp < thresholds.deadly) return { label: 'Hard', badge: 'vtt-badge vtt-badge-danger' };
    return { label: 'Deadly', badge: 'vtt-badge vtt-badge-danger font-black tracking-widest' };
  }, [adjustedXp, thresholds]);

  /* --- Roster editing ------------------------------------------------------- */
  const handleAddMonster = (monster: CompendiumMonster) => {
    setRoster((prev) => {
      const existing = prev.find((entry) => entry.monster.id === monster.id);
      if (existing) {
        return prev.map((entry) =>
          entry.monster.id === monster.id ? { ...entry, count: entry.count + 1 } : entry,
        );
      }
      return [...prev, { monster, count: 1 }];
    });
  };

  const handleUpdateCount = (id: string, delta: number) => {
    setRoster((prev) =>
      prev
        .map((entry) => (entry.monster.id === id ? { ...entry, count: Math.max(0, entry.count + delta) } : entry))
        .filter((entry) => entry.count > 0),
    );
  };

  const handleRemoveMonster = (id: string) => {
    setRoster((prev) => prev.filter((entry) => entry.monster.id !== id));
  };

  /* --- Spawning -------------------------------------------------------------
   * Every selected copy goes to the engine one at a time. A GM seat is
   * required: the engine rejects monster spawns from any other seat with
   * MONSTER_SPAWN_FORBIDDEN. The engine's verdict (or its machine rejection
   * code, quoted verbatim — FORBIDDEN_ROLE, MONSTER_SPAWN_FORBIDDEN,
   * OWNERSHIP_CLAIM_FORBIDDEN, …) is the only thing shown. NO optimistic board
   * mutation happens here: after spawning we issue a plain read of the
   * projected session state so the GM sees what the ENGINE actually reports;
   * tokens reach the shared tabletop through the existing snapshot polling.
   */
  const handleSpawnToTable = async () => {
    if (spawning || roster.length === 0) return;
    setSpawning(true);
    setSnapshotError(null);

    let sessionId: string | null = null;
    try {
      sessionId = engineSessionId ?? (await ensureEngineSession());
    } catch (err) {
      sessionId = null;
      console.warn('Engine session resolution failed.', err);
    }

    if (!sessionId) {
      setSpawnResults([
        {
          kind: 'rejected',
          label: 'Encounter',
          status: 0,
          code: 'ENGINE_UNREACHABLE',
          message: 'No authoritative engine session could be created or found — nothing was spawned.',
        },
      ]);
      setSpawning(false);
      return;
    }

    const results: SpawnRowOutcome[] = [];
    // Deterministic placement grid (engine coordinates); the engine owns the
    // authoritative position once spawned.
    let gridX = 9;
    let gridY = 3;

    for (const entry of roster) {
      for (let i = 1; i <= entry.count; i++) {
        const suffix = entry.count > 1 ? String(i) : '';
        const outcome = await spawnMonsterToEngine({
          sessionId,
          monster: entry.monster,
          position: [gridX, gridY, 0],
          labelSuffix: suffix,
        });
        results.push(describeOutcome(outcome, entry.monster.name, suffix));

        gridY += 2;
        if (gridY > 9) {
          gridY = 3;
          gridX += 2;
        }
      }
    }

    setSpawnResults(results);
    setSpawning(false);

    // Confirmation read (never a mutation): ask the gateway's projected
    // session-state proxy what entities the engine now reports.
    const snapshot = await engineSessionEntities(sessionId);
    if (snapshot.kind === 'applied') {
      setConfirmedEntityCount(snapshot.data.length);
    } else {
      setConfirmedEntityCount(null);
      setSnapshotError(describeRejection(snapshot));
    }
  };

  const filteredMonsters = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return monsters;
    return monsters.filter(
      (m) =>
        m.name.toLowerCase().includes(term) ||
        String(m.challenge_rating).includes(term) ||
        (m.creature_type ?? '').toLowerCase().includes(term),
    );
  }, [monsters, searchTerm]);

  return (
    <div className="space-y-6">
      {/* Hero Banner */}
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
                <span className="vtt-badge font-mono">D&amp;D 5e SRD 5.1</span>
              </div>
              <p className="text-xs text-parchment-aged/70 mt-1">
                Compose encounters from the live SRD compendium, check the XP budget against your party&apos;s
                thresholds, and spawn each creature into the current authoritative engine session.
              </p>
            </div>
          </div>

          <button
            onClick={handleSpawnToTable}
            disabled={spawning || roster.length === 0}
            className="vtt-btn vtt-btn-danger px-5 py-3 uppercase tracking-wider active:scale-95 disabled:opacity-40 cursor-pointer"
          >
            {spawning ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Spawning…</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-white" />
                <span>Spawn {totalCreatures > 0 ? `${totalCreatures} ` : ''}to Table</span>
              </>
            )}
          </button>
        </div>
        {/* Honest scoping disclosure: no backend encounter-save exists. */}
        <p className="text-[11px] text-parchment-aged/60 mt-3 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0 text-amber-400/80" />
          <span>
            Encounters are assembled <strong>in memory for this session only</strong> — the orchestrator has no
            encounter-save endpoint yet, so builds are not persisted anywhere. Spawned creatures exist only in the
            engine session they were spawned into.
          </span>
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left column */}
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

          {/* Difficulty Gauge */}
          <div className="vtt-surface rounded-xl p-5 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-tavern-border pb-3">
              <h3 className="vtt-section-header text-sm font-bold">
                <TrendingUp className="w-4 h-4 text-tavern-accent" />
                Difficulty Gauge
              </h3>
              <span className={difficulty.badge}>{difficulty.label}</span>
            </div>

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
            {unmappedCrCount > 0 && (
              <p className="text-[11px] text-amber-400/90 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>
                  {unmappedCrCount} roster entr{unmappedCrCount === 1 ? 'y has' : 'ies have'} a challenge rating
                  outside the known CR→XP table; those contribute 0 XP rather than a guessed value.
                </span>
              </p>
            )}

            <div className="space-y-2 pt-2 border-t border-tavern-border text-xs">
              <div className="text-[11px] font-bold text-parchment-aged/80 uppercase tracking-wider mb-1">
                Party Thresholds ({partySize} PCs Level {partyLevel}) — per-character SRD values × party size:
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

          {/* Engine confirmation (read-only snapshot result) */}
          {(spawnResults.length > 0 || confirmedEntityCount !== null || snapshotError) && (
            <div className="vtt-surface rounded-xl p-5 shadow-xl space-y-3">
              <h3 className="vtt-section-header text-sm font-bold border-b border-tavern-border pb-3">
                <Skull className="w-4 h-4 text-[color:var(--state-danger)]" />
                Last Spawn Report
              </h3>
              {confirmedEntityCount !== null && (
                <p className="text-xs text-parchment-aged/85">
                  The engine&apos;s session-state read now reports{' '}
                  <span className="font-mono font-bold text-emerald-300">{confirmedEntityCount}</span> visible
                  entities. Board updates arrive through the normal snapshot poll — nothing was drawn locally here.
                </p>
              )}
              {snapshotError && (
                <p className="text-xs text-[color:var(--state-danger)] flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>Could not confirm post-spawn state: {snapshotError}</span>
                </p>
              )}
              {spawnResults.length > 0 && (
                <ul className="space-y-1.5 max-h-48 overflow-y-auto vtt-scrollbar pr-1 text-[11px]">
                  {spawnResults.map((row, idx) => (
                    <li key={`${row.label}-${idx}`} className="flex flex-col gap-0.5 py-1 border-b border-tavern-border/40 last:border-0">
                      <span className={row.kind === 'applied' ? 'text-emerald-300' : 'text-[color:var(--state-danger)] font-semibold'}>
                        {row.kind === 'applied' ? (
                          <>{row.label} spawned{row.entityId ? ` (${row.entityId.slice(0, 8)}…)` : ''}</>
                        ) : (
                          <>{row.label} REFUSED — HTTP {row.status}{row.code ? ` ${row.code}` : ''}{row.message ? ` — ${row.message}` : ''}</>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="lg:col-span-8 space-y-6">
          {/* Roster */}
          <div className="vtt-surface rounded-xl p-5 shadow-xl">
            <div className="flex items-center justify-between border-b border-tavern-border pb-3 mb-4">
              <h3 className="vtt-section-header text-sm font-bold">
                <Skull className="w-4 h-4 text-[color:var(--state-danger)]" />
                Active Monster Roster ({totalCreatures} Creatures)
              </h3>
              {roster.length > 0 && (
                <button
                  onClick={() => {
                    setRoster([]);
                    setSpawnResults([]);
                    setConfirmedEntityCount(null);
                    setSnapshotError(null);
                  }}
                  className="text-xs text-[color:var(--state-danger)] hover:opacity-80 flex items-center space-x-1 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear All</span>
                </button>
              )}
            </div>

            {roster.length === 0 ? (
              <div className="p-8 text-center border border-dashed border-tavern-border rounded-lg text-parchment-aged/50 text-xs">
                No monsters added to this encounter yet. Select creatures from the live compendium below.
              </div>
            ) : (
              <div className="space-y-2.5">
                {roster.map((entry) => {
                  const xp = crToXp(entry.monster.challenge_rating);
                  return (
                    <div
                      key={entry.monster.id}
                      className="flex items-center justify-between gap-3 p-3 vtt-surface rounded-lg shadow-sm"
                    >
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs text-white border shadow shrink-0 bg-slate-700">
                          {entry.monster.name.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <div className="vtt-statblock-nameplate text-sm truncate">{entry.monster.name}</div>
                          <dl className="vtt-statblock-attr mt-1 inline-flex items-center gap-3 rounded-sm px-2 py-0.5 text-[11px]">
                            <div className="flex items-baseline gap-1">
                              <dt className="vtt-attr-label text-[10px]">CR</dt>
                              <dd className="vtt-attr-value font-mono">{entry.monster.challenge_rating}</dd>
                            </div>
                            <div className="flex items-baseline gap-1">
                              <dt className="vtt-attr-label text-[10px]">HP</dt>
                              <dd className="vtt-attr-value font-mono">{entry.monster.hp ?? '?'}</dd>
                            </div>
                            <div className="flex items-baseline gap-1">
                              <dt className="vtt-attr-label text-[10px]">AC</dt>
                              <dd className="vtt-attr-value font-mono">{entry.monster.ac ?? '?'}</dd>
                            </div>
                            <div className="flex items-baseline gap-1">
                              <dt className="vtt-attr-label text-[10px]">XP</dt>
                              <dd className="vtt-attr-value font-mono">{xp ?? 'n/a'}</dd>
                            </div>
                            {typeof entry.monster.speed === 'string' && parsePrimarySpeedFeet(entry.monster.speed) !== null && (
                              <div className="flex items-baseline gap-1">
                                <dt className="vtt-attr-label text-[10px]">SPD</dt>
                                <dd className="vtt-attr-value font-mono">{parsePrimarySpeedFeet(entry.monster.speed)}ft</dd>
                              </div>
                            )}
                          </dl>
                        </div>
                      </div>

                      <div className="flex items-center space-x-2 shrink-0">
                        <div className="flex items-center space-x-1 bg-black/50 border border-tavern-border rounded-lg p-1">
                          <button
                            onClick={() => handleUpdateCount(entry.monster.id, -1)}
                            aria-label={`Remove one ${entry.monster.name}`}
                            className="w-6 h-6 flex items-center justify-center text-parchment-aged/70 hover:text-parchment-aged hover:bg-black/30 rounded font-bold cursor-pointer"
                          >
                            -
                          </button>
                          <span className="w-6 text-center font-mono font-bold text-xs text-amber-400">{entry.count}</span>
                          <button
                            onClick={() => handleUpdateCount(entry.monster.id, 1)}
                            aria-label={`Add one ${entry.monster.name}`}
                            className="w-6 h-6 flex items-center justify-center text-parchment-aged/70 hover:text-parchment-aged hover:bg-black/30 rounded font-bold cursor-pointer"
                          >
                            +
                          </button>
                        </div>
                        <button
                          onClick={() => handleRemoveMonster(entry.monster.id)}
                          aria-label={`Remove ${entry.monster.name}`}
                          className="p-1.5 text-parchment-aged/50 hover:text-[color:var(--state-danger)] rounded hover:bg-black/30 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Live compendium picker */}
          <div className="vtt-surface rounded-xl p-5 shadow-xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-tavern-border pb-3 mb-4">
              <h3 className="vtt-section-header text-sm font-bold">
                <Sparkles className="w-4 h-4 text-tavern-accent" />
                SRD Monster Bestiary{!compendiumLoading && !compendiumError ? ` (${filteredMonsters.length}/${monsters.length})` : ''}
              </h3>

              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-parchment-aged/50 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter by name, CR, or type..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  disabled={compendiumLoading || !!compendiumError}
                  className="vtt-input w-full pl-8 text-xs disabled:opacity-50"
                />
              </div>
            </div>

            {compendiumLoading && (
              <div className="p-8 text-center text-parchment-aged/60 text-xs flex items-center justify-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading stat blocks from the live compendium…
              </div>
            )}

            {!compendiumLoading && compendiumError && (
              <div className="p-6 border border-dashed border-[color:var(--state-danger)]/40 rounded-lg text-center space-y-3">
                <p className="text-xs text-[color:var(--state-danger)] flex items-center justify-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  {compendiumError}
                </p>
                <p className="text-[11px] text-parchment-aged/60">
                  Showing no monsters rather than invented ones. Retry when the service is back.
                </p>
                <button
                  onClick={() => void loadCompendium()}
                  className="vtt-btn vtt-btn-secondary px-3 py-1.5 text-xs uppercase tracking-wider cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry</span>
                </button>
              </div>
            )}

            {!compendiumLoading && !compendiumError && filteredMonsters.length === 0 && (
              <div className="p-8 text-center border border-dashed border-tavern-border rounded-lg text-parchment-aged/50 text-xs">
                No compendium monster matches “{searchTerm}”.
              </div>
            )}

            {!compendiumLoading && !compendiumError && filteredMonsters.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-72 overflow-y-auto vtt-scrollbar pr-1">
                {filteredMonsters.map((monster) => {
                  const xp = crToXp(monster.challenge_rating);
                  return (
                    <div
                      key={monster.id}
                      onClick={() => handleAddMonster(monster)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddMonster(monster)}
                      className="flex items-center justify-between p-3 bg-black/30 hover:bg-black/45 border border-tavern-border hover:border-amber-500/50 rounded-lg cursor-pointer transition-all group shadow-sm"
                    >
                      <div className="flex items-center space-x-2.5 min-w-0">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs text-white shadow-sm shrink-0 bg-slate-700 group-hover:bg-amber-900 transition-colors">
                          {monster.name.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-parchment-aged group-hover:text-amber-200 transition-colors truncate">
                            {monster.name}
                          </div>
                          <div className="text-[10px] text-parchment-aged/70 truncate">
                            CR {monster.challenge_rating} · {monster.hp ?? '?'} HP · {monster.ac ?? '?'} AC ·{' '}
                            {xp !== null ? `${xp.toLocaleString()} XP` : 'XP n/a'}
                          </div>
                        </div>
                      </div>

                      <button
                        aria-label={`Add ${monster.name} to roster`}
                        className="p-1 text-parchment-aged/70 group-hover:text-amber-400 bg-tavern-bg group-hover:bg-amber-950/50 border border-tavern-border group-hover:border-amber-600/50 rounded transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* --- Verbatim outcome rendering ------------------------------------------- */

function describeOutcome(
  outcome: Awaited<ReturnType<typeof spawnMonsterToEngine>>,
  monsterName: string,
  suffix: string,
): SpawnRowOutcome {
  const label = suffix ? `${monsterName} #${suffix}` : monsterName;
  if (outcome.kind === 'applied') {
    return { kind: 'applied', label, entityId: outcome.data.entity_id };
  }
  if (outcome.kind === 'rejected') {
    return {
      kind: 'rejected',
      label,
      status: outcome.status,
      code: outcome.code,
      message: outcome.message,
    };
  }
  return {
    kind: 'rejected',
    label,
    status: 0,
    code: 'ENGINE_UNREACHABLE',
    message: 'The engine did not answer — this creature was NOT spawned.',
  };
}

/** Human-readable verbatim quote of any rules-engine rejection union. */
function describeRejection(outcome: EngineActionOutcome<unknown>): string {
  if (outcome.kind === 'rejected') {
    return `HTTP ${outcome.status}${outcome.code ? ` ${outcome.code}` : ''}${
      outcome.message ? ` — ${outcome.message}` : ''
    }`;
  }
  return 'the gateway/engine could not be reached.';
}
