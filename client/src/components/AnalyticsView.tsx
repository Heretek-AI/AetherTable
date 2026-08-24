import React, { useState, useEffect, useCallback } from 'react';
import { Activity, ShieldCheck, Zap, Database, Clock, CheckCircle2, AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import { EngineMetrics, fetchEngineMetrics } from '../api/engine_metrics';

/* Out-of-world (admin) telemetry palette: amber gold-leaf, book crimson,
   forest and leather carry the series ramp (replacing cold purple/sky).
   Bright variants are color-mixed toward parchment purely so small type and
   thin strokes stay legible against the iron chrome — raw --state-success
   (#166534) and --rp-leather-600 (#7a5c42) sink into #2c241d. */
const SERIES = {
  amber: 'var(--tavern-accent)',
  crimsonText: 'var(--rp-crimson-400)', // crimson accent allowed as text-size color on dark only
  forestBright: 'color-mix(in srgb, var(--state-success) 45%, var(--rp-parchment-100))',
  leatherBright: 'color-mix(in srgb, var(--rp-leather-600) 45%, var(--rp-parchment-200))',
  parchment: 'var(--rp-parchment-300)',
};

const INK_DIM = 'text-[color-mix(in_srgb,var(--rp-parchment-300)_70%,transparent)]';
const INK_FAINT = 'text-[color-mix(in_srgb,var(--rp-parchment-300)_50%,transparent)]';

/**
 * Honest telemetry view.
 *
 * The MCR / action-tally / auditor / persistence cards fetch LIVE values from
 * the engine's GET /metrics via the orchestrator proxy
 * (/api/v1/engine/metrics). Everything that has NO backing endpoint is either
 * labelled STATIC (the latency SLA table — design targets, not measurements)
 * or rendered as an explicit "no data source" empty state (the ledger feed).
 * When the engine is unreachable the numbers show "—" with an offline banner;
 * nothing here ever fabricates a value.
 */
export const AnalyticsView: React.FC = () => {
  const [metrics, setMetrics] = useState<EngineMetrics | null>(null);
  const [live, setLive] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await fetchEngineMetrics();
    if (result.status === 'live') {
      setMetrics(result.metrics);
      setLive(true);
    } else {
      setMetrics(null);
      setLive(false);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // "—" when offline; real counters otherwise. Zeros from a live engine are
  // legitimate values and are shown as-is.
  const mcr = live && metrics ? metrics.mechanical_compliance_rate_pct : null;
  const totalActions = live && metrics ? metrics.total_actions : null;
  const validActions = live && metrics ? metrics.valid_actions : null;
  const rejectedActions = live && metrics ? metrics.rejected_actions : null;
  const auditorRejection = live && metrics ? metrics.auditor_rejection_rate_pct : null;
  const persistenceFailures = live && metrics ? metrics.persistence_failures : null;

  return (
    <div className="flex-1 flex flex-col h-full bg-tavern-bg p-6 overflow-y-auto vtt-scrollbar space-y-6">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-6 border-b border-tavern-border">
        <div>
          <h1 className="text-2xl font-bold vtt-engraved flex items-center gap-2.5">
            <Activity className="w-6 h-6" style={{ color: SERIES.amber }} />
            System Telemetry &amp; Invariant Auditor Dashboard
          </h1>
          <p className={`text-xs font-mono mt-1 ${INK_FAINT}`}>
            Live verification metrics from the authoritative engine&apos;s <span className="font-semibold">/metrics</span> endpoint,
            design-target SLA budgets, and event-ledger status.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {live ? (
            <span className="vtt-badge vtt-badge-success px-3 py-1.5">
              <CheckCircle2 className="w-4 h-4" />
              Live from engine /metrics
            </span>
          ) : (
            <span className="vtt-badge vtt-badge-danger px-3 py-1.5" title="The engine did not answer /api/v1/engine/metrics">
              <WifiOff className="w-4 h-4" />
              Engine Offline — no live data
            </span>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="vtt-btn vtt-btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50"
            aria-label="Refresh engine metrics"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Degraded-state banner: never render zeros as if they were readings */}
      {!live && !loading && (
        <div className="p-4 rounded-xl border border-[var(--rp-crimson-400)]/40 bg-[color-mix(in_srgb,var(--rp-crimson-650)_12%,transparent)] flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: SERIES.crimsonText }} />
          <div className="text-xs font-mono space-y-1">
            <p className="font-bold" style={{ color: SERIES.crimsonText }}>
              ENGINE UNREACHABLE — TELEMETRY DEGRADED
            </p>
            <p className={INK_DIM}>
              The Rust engine (vtt-server) did not respond to <span className="font-semibold">GET /api/v1/engine/metrics</span>.
              All metric cards below show &ldquo;&mdash;&rdquo; instead of values because there is nothing honest to display.
              Start the engine (or check ENGINE_API_URL) and hit Refresh to restore live data.
            </p>
          </div>
        </div>
      )}

      {/* Primary KPI Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* MCR Card */}
        <div className="p-5 rounded-xl vtt-card-elevated">
          <div className="flex items-center justify-between">
            <span
              className="font-display text-xs tracking-[0.06em] font-semibold"
              style={{ color: SERIES.leatherBright }}
            >
              MECHANICAL COMPLIANCE (MCR)
            </span>
            <ShieldCheck className="w-4 h-4" style={{ color: SERIES.forestBright }} />
          </div>
          <div className="text-3xl font-bold font-prose mt-2" style={{ color: SERIES.forestBright }}>
            {mcr === null ? '—' : `${mcr.toFixed(1)}%`}
          </div>
          <div className={`text-[11px] font-mono mt-1 ${INK_FAINT}`}>
            Target: <span className="text-[var(--rp-parchment-100)] font-semibold">≥ 98.5%</span> · Zero unverified mutations
          </div>
        </div>

        {/* Action Tally Card */}
        <div className="p-5 rounded-xl vtt-card-elevated">
          <div className="flex items-center justify-between">
            <span
              className="font-display text-xs tracking-[0.06em] font-semibold"
              style={{ color: SERIES.leatherBright }}
            >
              ACTIONS ADJUDICATED
            </span>
            <Zap className="w-4 h-4" style={{ color: SERIES.amber }} />
          </div>
          <div className="text-3xl font-bold font-prose mt-2" style={{ color: SERIES.amber }}>
            {totalActions === null ? '—' : totalActions.toLocaleString()}
          </div>
          <div className={`text-[11px] font-mono mt-1 ${INK_FAINT}`}>
            <span style={{ color: SERIES.forestBright }}>{validActions ?? '—'} valid</span>
            {' · '}
            <span style={{ color: SERIES.crimsonText }}>{rejectedActions ?? '—'} rejected</span>
          </div>
        </div>

        {/* Auditor Rejection Rate Card */}
        <div className="p-5 rounded-xl vtt-card-elevated">
          <div className="flex items-center justify-between">
            <span
              className="font-display text-xs tracking-[0.06em] font-semibold"
              style={{ color: SERIES.leatherBright }}
            >
              AUDITOR REJECTION RATE
            </span>
            <AlertTriangle className="w-4 h-4" style={{ color: SERIES.crimsonText }} />
          </div>
          <div className="text-3xl font-bold font-prose mt-2" style={{ color: SERIES.crimsonText }}>
            {auditorRejection === null ? '—' : `${auditorRejection.toFixed(2)}%`}
          </div>
          <div className={`text-[11px] font-mono mt-1 ${INK_FAINT}`}>
            Pre-commit invariant gate ·{' '}
            {persistenceFailures === null ? '—' : `${persistenceFailures}`} persistence failures
          </div>
        </div>
      </div>

      {/* Latency Allocation Budget Table — DESIGN TARGETS ONLY */}
      <div className="p-5 rounded-xl vtt-surface space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-tavern-border gap-3 flex-wrap">
          <h2
            className="font-display text-sm tracking-[0.05em] flex items-center gap-2"
            style={{ color: SERIES.amber }}
          >
            <Clock className="w-4 h-4" />
            Latency Budget Allocations
          </h2>
          <span className="vtt-badge px-2 py-1 text-[10px]" title="These are engineering budget targets from the design spec, not measured latencies">
            STATIC — design targets, not measurements
          </span>
        </div>

        <div className="space-y-3 font-mono text-xs">
          <div>
            <div className={`flex justify-between mb-1 ${INK_DIM}`}>
              <span>Deterministic Rust Engine (`vtt-core` / `vtt-spatial`)</span>
              <span className="font-bold" style={{ color: SERIES.forestBright }}>Budget: &lt; 10 ms SLA</span>
            </div>
            <div className="w-full h-2 bg-black/30 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: '2%', background: 'color-mix(in srgb, var(--state-success) 55%, var(--rp-parchment-200))' }}
              />
            </div>
          </div>

          <div>
            <div className={`flex justify-between mb-1 ${INK_DIM}`}>
              <span>Pre-Commit Auditor Invariant Gate (&quot;World Inspector&quot;)</span>
              <span className="font-bold" style={{ color: SERIES.amber }}>Budget: ≤ 200 ms SLA</span>
            </div>
            <div className="w-full h-2 bg-black/30 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: '21%', background: SERIES.amber }} />
            </div>
          </div>

          <div>
            <div className={`flex justify-between mb-1 ${INK_DIM}`}>
              <span>Yjs Binary CRDT WebSocket Delta Broadcast</span>
              <span className="font-bold" style={{ color: SERIES.parchment }}>Budget: ≤ 16 ms SLA (60 FPS)</span>
            </div>
            <div className="w-full h-2 bg-black/30 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: '50%', background: SERIES.parchment }} />
            </div>
          </div>
        </div>
      </div>

      {/* Event Sourcing Ledger — NO FEED EXISTS YET (explicit empty state) */}
      <div className="p-5 rounded-xl vtt-surface space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-tavern-border">
          <h2
            className="font-display text-sm tracking-[0.05em] flex items-center gap-2"
            style={{ color: SERIES.amber }}
          >
            <Database className="w-4 h-4" />
            Append-Only Event Sourcing Ledger
          </h2>
          <span className="vtt-badge px-2 py-1 text-[10px]" title="No ledger query/streaming endpoint exists in the API yet">
            NOT WIRED — no backend feed
          </span>
        </div>

        <div className="py-8 flex flex-col items-center gap-2 text-center">
          <Database className={`w-6 h-6 ${INK_FAINT}`} />
          <p className="text-xs font-mono font-bold" style={{ color: SERIES.leatherBright }}>
            No ledger stream available
          </p>
          <p className={`text-[11px] font-mono max-w-md ${INK_FAINT}`}>
            The append-only ledger lives in vtt-server, but no read endpoint exposes it yet
            (see backlog: ledger query API). Previous sample rows shown here were hardcoded
            demo fiction and have been removed rather than presented as real events.
          </p>
        </div>
      </div>
    </div>
  );
};
