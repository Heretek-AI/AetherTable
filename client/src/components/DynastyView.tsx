import React, { useState, useEffect } from 'react';
import {
  Crown,
  Shield,
  Eye,
  Sparkles,
  Swords,
  GitBranch,
  Layers,
  Flame,
  BookOpen,
  Plus,
  Check,
  RefreshCw,
  Activity,
  ShieldAlert,
  Zap,
  Users
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { authHeaders, getStoredToken } from '../api/auth_headers';
import { LorePanel } from './LorePanel';

export interface DynastyMember {
  id: string;
  name: string;
  title: string;
  generation: number;
  is_alive: boolean;
  traits: string[];
  personality: string;
  parent_ids: string[];
  spouse_id?: string;
  historical_event?: string;
}

export interface NobleHouse {
  id: string;
  name: string;
  motto: string;
  crest_icon: string;
  theme_color: string;
  seat_of_power: string;
  primary_virtue: string;
  members: DynastyMember[];
  feuds: Record<string, string>;
}

interface DynastyViewProps {
  onInjectLoreToCampaign?: (houseName: string, text: string) => void;
}

// Shape returned by POST /api/v1/simulation/empirical-benchmark
// (python/vtt_orchestrator/simulation/empirical_playtester.py::run_benchmark).
interface EmpiricalBenchmark {
  total_simulations: number;
  win_rate: number;
  average_turns: number;
  average_remaining_hp_pct: number;
  empirical_dataset_source: string;
  balance_status: string;
}

type InjectedStatus =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string };

export const DynastyView: React.FC<DynastyViewProps> = ({ onInjectLoreToCampaign }) => {
  const [houses, setHouses] = useState<NobleHouse[]>([]);
  const [selectedHouseId, setSelectedHouseId] = useState<string>('house_vane');
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [injectedStatus, setInjectedStatus] = useState<InjectedStatus | null>(null);
  const [benchmark, setBenchmark] = useState<EmpiricalBenchmark | null>(null);
  const [isBenchmarkRunning, setIsBenchmarkRunning] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

  // Token presence is read per render of a mutation attempt (not cached at
  // mount) so signing in via AuthModal unlocks the surfaces without a remount.
  const hasToken = Boolean(getStoredToken());

  const fetchDynasties = async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/v1/dynasty/factions');
      if (!res.ok) {
        let detail = `HTTP ${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
        } catch {
          /* non-JSON error body */
        }
        setFetchError(`Dynasty service returned an error: ${detail}`);
        setHouses([]);
      } else {
        const data = await res.json();
        const nextHouses: NobleHouse[] = Array.isArray(data.houses) ? data.houses : [];
        setHouses(nextHouses);
        if (nextHouses.length > 0) {
          setSelectedHouseId((prev) =>
            nextHouses.some((h) => h.id === prev) ? prev : nextHouses[0].id
          );
        }
      }
    } catch (e) {
      setFetchError(
        `Could not reach the dynasty service at /api/v1/dynasty/factions (${e instanceof Error ? e.message : String(e)}).`
      );
      setHouses([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDynasties();
  }, []);

  const selectedHouse = houses.find((h) => h.id === selectedHouseId) || houses[0];

  const handleRunBenchmark = async () => {
    setIsBenchmarkRunning(true);
    setBenchmarkError(null);
    // Iteration-10 gateway hardening: the benchmark route is gm/admin-only
    // (hundreds of simulations per call) and rate-limited; the request must
    // carry credentials or it 401s.
    try {
      const res = await fetch('/api/v1/simulation/empirical-benchmark?simulations=200', {
        method: 'POST',
        headers: authHeaders(),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
        } catch {
          /* non-JSON error body */
        }
        setBenchmarkError(`Benchmark failed: ${detail}`);
        setBenchmark(null);
      } else {
        const data: EmpiricalBenchmark = await res.json();
        setBenchmark(data);
      }
    } catch (e) {
      setBenchmarkError(
        `Could not reach the benchmark endpoint at /api/v1/simulation/empirical-benchmark (${e instanceof Error ? e.message : String(e)}).`
      );
      setBenchmark(null);
    } finally {
      setIsBenchmarkRunning(false);
    }
  };

  const handleInjectLore = async () => {
    if (!selectedHouse) return;
    globalAudio.playSpellCast();
    setInjectedStatus(null);

    try {
      const res = await fetch('/api/v1/dynasty/inject-lore', {
        method: 'POST',
        // Iteration-10 gateway hardening: lore injection mutates the SHARED
        // canon graph and is gm/admin-only — credentials required (401/403
        // otherwise, surfaced verbatim in the error state below).
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ house_id: selectedHouse.id }),
      });

      if (res.ok) {
        const data = await res.json();
        const propositions =
          typeof data?.propositions_injected === 'number' ? data.propositions_injected : null;
        const edges = typeof data?.total_graph_edges === 'number' ? data.total_graph_edges : null;
        setInjectedStatus({
          kind: 'success',
          text:
            `Committed ${selectedHouse.name} lore to the canon graph` +
            (propositions !== null ? `: ${propositions} proposition${propositions === 1 ? '' : 's'} injected` : '') +
            (edges !== null ? `, graph now has ${edges} edges` : '') +
            '.',
        });
        if (onInjectLoreToCampaign) {
          onInjectLoreToCampaign(
            selectedHouse.name,
            `Dynasty assertions for ${selectedHouse.name} (Seat: ${selectedHouse.seat_of_power}) integrated into active lore graph.`
          );
        }
      } else {
        let detail = `HTTP ${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
        } catch {
          /* non-JSON error body */
        }
        setInjectedStatus({
          kind: 'error',
          text: `Injection of ${selectedHouse.name} lore failed: ${detail}`,
        });
      }
    } catch (e) {
      setInjectedStatus({
        kind: 'error',
        text: `Orchestrator unreachable — no lore was committed. (${e instanceof Error ? e.message : String(e)})`,
      });
    }

    setTimeout(() => setInjectedStatus(null), 8000);
  };

  const renderCrestIcon = (iconName: string) => {
    switch (iconName) {
      case 'shield':
        return <Shield className="w-5 h-5" />;
      case 'eye':
        return <Eye className="w-5 h-5" />;
      case 'crown':
      default:
        return <Crown className="w-5 h-5" />;
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-tavern-bg text-parchment-paper overflow-hidden select-none">
      {/* Top Bar */}
      <div className="p-4 border-b border-tavern-border flex items-center justify-between">
        <div>
          <h1 className="vtt-engraved text-lg font-bold flex items-center gap-2">
            <Crown className="w-5 h-5 text-tavern-accent" />
            <span>Dynasty Lineage & Faction Feud Studio</span>
          </h1>
          <p className="text-xs text-[var(--rp-parchment-300)] mt-0.5 font-prose">
            Procedural noble bloodline trees, inherited genetic traits, and an on-demand empirical party-balance simulation (class weights from oganm/dnddata).
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchDynasties}
            className="vtt-btn vtt-btn-secondary text-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Regenerate Lineages</span>
          </button>

          <button
            onClick={handleInjectLore}
            disabled={!hasToken}
            title={!hasToken ? 'Sign in as GM — lore injection mutates the shared canon graph and is GM-only.' : undefined}
            className="vtt-btn vtt-btn-primary text-xs active:scale-95 disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4" />
            <span>Inject Dynasty Lore into Campaign</span>
          </button>
          {!hasToken && (
            <span className="text-[10px] font-prose text-[var(--rp-parchment-300)]">
              Sign in as GM to inject — the shared canon graph rejects unauthenticated or non-GM writes.
            </span>
          )}
        </div>
      </div>

      {injectedStatus && (
        <div
          className={`border-b px-4 py-2 text-xs font-prose flex items-center gap-2 animate-fadeIn ${
            injectedStatus.kind === 'success'
              ? 'text-emerald-300 bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)] border-[color-mix(in_srgb,var(--state-success)_45%,transparent)]'
              : 'text-red-300 bg-[color-mix(in_srgb,var(--state-danger)_10%,transparent)] border-[color-mix(in_srgb,var(--state-danger)_45%,transparent)]'
          }`}
        >
          {injectedStatus.kind === 'success' ? (
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
          )}
          <span>{injectedStatus.text}</span>
        </div>
      )}

      {/* Main Workspace Layout */}
      <div className="flex-1 p-6 overflow-y-auto vtt-scrollbar max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left Column: Noble House Selector & Empirical Playtester Stats */}
        <div className="lg:col-span-1 space-y-6">
          <div>
            <h2 className="vtt-section-header text-xs mb-3">
              <Layers className="w-4 h-4 shrink-0" />
              <span>Great Noble Houses</span>
            </h2>

            <div className="space-y-2.5">
              {houses.map((h) => {
                const isSelected = selectedHouseId === h.id;
                return (
                  <button
                    key={h.id}
                    onClick={() => {
                      setSelectedHouseId(h.id);
                      globalAudio.playTurnAdvance();
                    }}
                    className={`w-full text-left p-3.5 rounded-xl border transition shadow flex items-center justify-between ${
                      isSelected
                        ? 'bg-[color-mix(in_srgb,var(--tavern-accent)_10%,transparent)] border-tavern-accent ring-1 ring-tavern-accent'
                        : 'bg-[color-mix(in_srgb,var(--tavern-surface)_60%,transparent)] border-tavern-border hover:border-[var(--rp-leather-600)]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center text-white shadow"
                        style={{ backgroundColor: h.theme_color }}
                      >
                        {renderCrestIcon(h.crest_icon)}
                      </div>
                      <div>
                        <div className="font-bold text-xs font-display [font-variant:small-caps] text-parchment-paper">{h.name}</div>
                        <div className="text-[10px] text-[var(--rp-parchment-300)] font-prose truncate max-w-[140px]">{h.motto}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Empirical Benchmark Card — real numbers from POST /api/v1/simulation/empirical-benchmark */}
          <div className="vtt-glass-panel p-4 rounded-xl space-y-3 shadow-lg">
            <h3 className="vtt-section-header text-xs">
              <Activity className="w-4 h-4 shrink-0" />
              <span>Empirical Party Balance</span>
            </h3>

            {benchmark ? (
              <>
                <div className="space-y-2 text-xs font-prose">
                  <div className="flex justify-between text-[var(--rp-parchment-300)]">
                    <span>Simulations run:</span>
                    <strong className="text-parchment-paper">{benchmark.total_simulations}</strong>
                  </div>
                  <div className="flex justify-between text-[var(--rp-parchment-300)]">
                    <span>Party Win Rate:</span>
                    <strong className={benchmark.win_rate >= 85 ? 'text-emerald-300' : 'text-parchment-paper'}>
                      {benchmark.win_rate}%
                    </strong>
                  </div>
                  <div className="flex justify-between text-[var(--rp-parchment-300)]">
                    <span>Avg Turns to Clear:</span>
                    <strong className="text-tavern-accent">{benchmark.average_turns}</strong>
                  </div>
                  <div className="flex justify-between text-[var(--rp-parchment-300)]">
                    <span>Avg Remaining HP:</span>
                    <strong className="text-tavern-accent">{benchmark.average_remaining_hp_pct}%</strong>
                  </div>
                  <div className="pt-2 border-t border-tavern-border text-[10px] text-[var(--rp-parchment-300)] space-y-1">
                    <div>Verdict: {benchmark.balance_status}</div>
                    <div>
                      Synthetic encounter simulation; class-popularity weights calibrated on {benchmark.empirical_dataset_source}. No real character sheets were used.
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleRunBenchmark}
                  disabled={isBenchmarkRunning || !hasToken}
                  title={!hasToken ? 'Sign in to run the benchmark — the gateway rejects unauthenticated calls.' : undefined}
                  className="vtt-btn vtt-btn-secondary text-xs w-full"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isBenchmarkRunning ? 'animate-spin' : ''}`} />
                  <span>{isBenchmarkRunning ? 'Simulating...' : 'Re-run Benchmark'}</span>
                </button>
                {!hasToken && (
                  <p className="text-[11px] font-prose p-2 rounded-lg border border-tavern-border">
                    Sign in (GM recommended — the endpoint is GM-only) to run the benchmark; the
                    gateway rejects unauthenticated simulation requests.
                  </p>
                )}
              </>
            ) : (
              <div className="space-y-2 text-xs font-prose">
                <p className="text-[var(--rp-parchment-300)] leading-relaxed">
                  No balance data loaded. Run a live simulation (200 synthetic encounters) against the
                  engine&apos;s empirical playtester to populate this card.
                </p>
                {benchmarkError && (
                  <p className="text-red-300 text-[11px] leading-relaxed break-words">{benchmarkError}</p>
                )}
                <button
                  onClick={handleRunBenchmark}
                  disabled={isBenchmarkRunning || !hasToken}
                  title={!hasToken ? 'Sign in to run the benchmark — the gateway rejects unauthenticated calls.' : undefined}
                  className="vtt-btn vtt-btn-secondary text-xs w-full"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>{isBenchmarkRunning ? 'Simulating...' : 'Run Empirical Benchmark'}</span>
                </button>
                {!hasToken && (
                  <p className="text-[11px] font-prose p-2 rounded-lg border border-tavern-border">
                    Sign in (GM recommended — the endpoint is GM-only) to run the benchmark; the
                    gateway rejects unauthenticated simulation requests.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Live canon-assertion surface (real /api/v1/lore/assert + /api/v1/npc/) */}
          <LorePanel />
        </div>

        {/* Center & Right 3 Columns: Generational Family Tree & Faction Tension Matrix */}
        {selectedHouse ? (
          <div className="lg:col-span-3 space-y-6">
            {/* House Banner */}
            <div className="vtt-card-elevated rounded-2xl p-5 flex items-center justify-between shadow-xl">
              <div className="flex items-center gap-4">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center text-white shadow-xl"
                  style={{ backgroundColor: selectedHouse.theme_color }}
                >
                  {renderCrestIcon(selectedHouse.crest_icon)}
                </div>

                <div>
                  <h2 className="vtt-statblock-nameplate text-xl font-bold">{selectedHouse.name}</h2>
                  <div className="text-xs text-tavern-accent font-prose italic mt-0.5">"{selectedHouse.motto}"</div>
                  <div className="text-[11px] text-[var(--rp-parchment-300)] font-prose mt-1 flex items-center gap-3">
                    <span>Seat of Power: <strong className="text-parchment-paper">{selectedHouse.seat_of_power}</strong></span>
                    <span>·</span>
                    <span>Core Virtue: <strong className="text-parchment-paper">{selectedHouse.primary_virtue}</strong></span>
                  </div>
                </div>
              </div>
            </div>

            {/* Generational Lineage Tree */}
            <div className="space-y-4">
              <h3 className="vtt-section-header text-xs">
                <GitBranch className="w-4 h-4 shrink-0" />
                <span>3-Generation Bloodline Tree & Inherited Traits</span>
              </h3>

              <div className="space-y-4">
                {[1, 2, 3].map((gen) => {
                  const genMembers = selectedHouse.members.filter((m) => m.generation === gen);
                  if (genMembers.length === 0) return null;

                  return (
                    <div key={`gen_${gen}`} className="space-y-2">
                      <div className="text-[11px] font-display [font-variant:small-caps] tracking-wider text-[var(--rp-parchment-300)] flex items-center gap-2">
                        <span>Generation {gen}: {gen === 1 ? 'Founders' : gen === 2 ? 'Reigning Sovereigns' : 'Heirs & Scions'}</span>
                        <div className="vtt-divider flex-1"><span /></div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {genMembers.map((member) => (
                          <div
                            key={member.id}
                            className="vtt-card-elevated p-3.5 rounded-xl space-y-2"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <h4 className="font-bold text-xs font-display [font-variant:small-caps] text-parchment-paper">{member.name}</h4>
                                <span className="text-[10px] font-prose text-tavern-accent">{member.title}</span>
                              </div>
                              <span className={`vtt-badge ${member.is_alive ? 'vtt-badge-success' : ''}`}>
                                {member.is_alive ? 'Living' : 'Deceased'}
                              </span>
                            </div>

                            <p className="selectable-text text-[11px] text-[var(--rp-parchment-200)] leading-relaxed font-prose">{member.personality}</p>

                            {member.historical_event && (
                              <div className="vtt-parchment selectable-text text-[10px] font-prose leading-relaxed p-2 rounded-sm">
                                ⚔ Historical Event: {member.historical_event}
                              </div>
                            )}

                            {/* Inherited Traits */}
                            <div className="pt-2 border-t border-tavern-border flex flex-wrap gap-1.5">
                              {member.traits.map((t, idx) => (
                                <span key={idx} className="vtt-badge">
                                  {t}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Faction Feuds & Diplomatic Tensions */}
            <div className="space-y-3 pt-2">
              <h3 className="vtt-section-header text-xs">
                <Swords className="w-4 h-4 shrink-0" />
                <span>Inter-Dynasty Feuds & Diplomatic Tensions</span>
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {Object.entries(selectedHouse.feuds).map(([targetId, rel]) => {
                  const isFeud = rel.toLowerCase().includes('feud');
                  const isAllied = rel.toLowerCase().includes('allied');
                  const relBadgeClass = isFeud ? 'vtt-badge-danger' : isAllied ? 'vtt-badge-success' : '';

                  return (
                    <div
                      key={targetId}
                      className="p-3 rounded-xl border border-tavern-border bg-[color-mix(in_srgb,var(--tavern-surface)_60%,transparent)] flex items-center justify-between text-xs font-prose shadow"
                    >
                      <div className="flex items-center gap-2">
                        {isFeud ? <ShieldAlert className="w-4 h-4 text-[var(--rp-crimson-400)]" /> : <Shield className="w-4 h-4 text-tavern-accent" />}
                        <span className="font-bold uppercase text-[11px] font-display [font-variant:small-caps] text-parchment-paper">{targetId.replace('_', ' ')}</span>
                      </div>
                      <span className={`vtt-badge ${relBadgeClass}`}>{rel}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : fetchError ? (
          <div className="lg:col-span-3 flex items-center justify-center p-12">
            <div className="vtt-card-elevated rounded-xl p-5 max-w-md space-y-3 text-center border border-[color-mix(in_srgb,var(--state-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-danger)_8%,transparent)]">
              <h3 className="text-xs font-bold font-display [font-variant:small-caps] text-red-300 flex items-center justify-center gap-2">
                <ShieldAlert className="w-4 h-4" />
                <span>Failed to Load Noble House Lineages</span>
              </h3>
              <p className="text-[11px] font-prose text-[var(--rp-parchment-200)] break-words">{fetchError}</p>
              <button onClick={fetchDynasties} disabled={isLoading} className="vtt-btn vtt-btn-secondary text-xs mx-auto">
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                <span>Retry</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="lg:col-span-3 flex items-center justify-center p-12 text-[var(--rp-parchment-300)] font-prose text-xs">
            {isLoading ? 'Loading Noble House Lineages...' : 'No noble houses available.'}
          </div>
        )}
      </div>
    </div>
  );
};
