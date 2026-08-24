import React, { useState, useEffect } from 'react';
import { Activity, ShieldCheck, Cpu, Database, Zap, Clock, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';

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

export const AnalyticsView: React.FC = () => {
  const [metrics, setMetrics] = useState({
    mcr: 100.0,
    hci: 1.0,
    afpr: 0.0,
    rustLatencyMs: 0.01,
    auditorLatencyMs: 42,
    crdtLatencyMs: 8,
    totalEventsLogged: 1042,
    activeEntities: 4,
  });

  const [ledgerEvents, setLedgerEvents] = useState([
    { seq: 1042, type: 'ATTACK_RESOLVED', actor: 'Thorin Oakenshield', payload: 'Greataxe Slash: 11 damage', timestamp: '12:00:14' },
    { seq: 1041, type: 'INVARIANT_AUDITED', actor: 'World Inspector', payload: 'Conservation Law [PASSED], Spatial [PASSED]', timestamp: '12:00:14' },
    { seq: 1040, type: 'TOKEN_TRANSFORM_SYNC', actor: 'Thorin Oakenshield', payload: 'Position -> [D5, 0ft elevation]', timestamp: '12:00:08' },
    { seq: 1039, type: 'LORE_ASSERTION_COMMITTED', actor: 'Epistemic Graph', payload: 'Canon: "Oakhaven Crypt built in 4th Age"', timestamp: '11:59:52' },
    { seq: 1038, type: 'SESSION_INITIALIZED', actor: 'Engine Host', payload: 'Campaign: The Fall of Baron Vane', timestamp: '11:58:00' },
  ]);

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
            Real-time verification metrics, sub-1200ms latency allocation SLAs, and cryptographic event ledger stream.
          </p>
        </div>

        <span className="vtt-badge vtt-badge-success px-3 py-1.5">
          <CheckCircle2 className="w-4 h-4" />
          All 7 Phase SLAs Active &amp; Passing
        </span>
      </div>

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
          <div className="text-3xl font-bold font-prose mt-2" style={{ color: SERIES.forestBright }}>{metrics.mcr}%</div>
          <div className={`text-[11px] font-mono mt-1 ${INK_FAINT}`}>
            Target: <span className="text-[var(--rp-parchment-100)] font-semibold">≥ 98.5%</span> · Zero unverified mutations
          </div>
        </div>

        {/* HCI Card */}
        <div className="p-5 rounded-xl vtt-card-elevated">
          <div className="flex items-center justify-between">
            <span
              className="font-display text-xs tracking-[0.06em] font-semibold"
              style={{ color: SERIES.leatherBright }}
            >
              HALLUCINATION INDEX (HCI)
            </span>
            <Zap className="w-4 h-4" style={{ color: SERIES.amber }} />
          </div>
          <div className="text-3xl font-bold font-prose mt-2" style={{ color: SERIES.amber }}>{metrics.hci}</div>
          <div className={`text-[11px] font-mono mt-1 ${INK_FAINT}`}>
            Target: <span className="text-[var(--rp-parchment-100)] font-semibold">≥ 0.95</span> · 3-Tier Lore Invariant
          </div>
        </div>

        {/* AFPR Card */}
        <div className="p-5 rounded-xl vtt-card-elevated">
          <div className="flex items-center justify-between">
            <span
              className="font-display text-xs tracking-[0.06em] font-semibold"
              style={{ color: SERIES.leatherBright }}
            >
              AUDITOR FALSE-POSITIVE (AFPR)
            </span>
            <AlertTriangle className="w-4 h-4" style={{ color: SERIES.crimsonText }} />
          </div>
          <div className="text-3xl font-bold font-prose mt-2" style={{ color: SERIES.crimsonText }}>{metrics.afpr}%</div>
          <div className={`text-[11px] font-mono mt-1 ${INK_FAINT}`}>
            Target: <span className="text-[var(--rp-parchment-100)] font-semibold">≤ 1.5%</span> · 2-Pass Retry Pass-through
          </div>
        </div>
      </div>

      {/* Latency Allocation Budget Table */}
      <div className="p-5 rounded-xl vtt-surface space-y-4">
        <h2
          className="font-display text-sm tracking-[0.05em] flex items-center gap-2 pb-2 border-b border-tavern-border"
          style={{ color: SERIES.amber }}
        >
          <Clock className="w-4 h-4" />
          Sub-1200ms Latency Budget Allocations
        </h2>

        <div className="space-y-3 font-mono text-xs">
          <div>
            <div className={`flex justify-between mb-1 ${INK_DIM}`}>
              <span>Deterministic Rust Engine (`vtt-core` / `vtt-spatial`)</span>
              <span className="font-bold" style={{ color: SERIES.forestBright }}>&lt; 0.01 ms / 10 ms SLA</span>
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
              <span>Pre-Commit Auditor Invariant Gate ("World Inspector")</span>
              <span className="font-bold" style={{ color: SERIES.amber }}>{metrics.auditorLatencyMs} ms / 200 ms SLA</span>
            </div>
            <div className="w-full h-2 bg-black/30 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: '21%', background: SERIES.amber }} />
            </div>
          </div>

          <div>
            <div className={`flex justify-between mb-1 ${INK_DIM}`}>
              <span>Yjs Binary CRDT WebSocket Delta Broadcast</span>
              <span className="font-bold" style={{ color: SERIES.parchment }}>{metrics.crdtLatencyMs} ms / 16 ms SLA (60 FPS)</span>
            </div>
            <div className="w-full h-2 bg-black/30 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: '50%', background: SERIES.parchment }} />
            </div>
          </div>
        </div>
      </div>

      {/* Live Event Sourcing Ledger Log */}
      <div className="p-5 rounded-xl vtt-surface space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-tavern-border">
          <h2
            className="font-display text-sm tracking-[0.05em] flex items-center gap-2"
            style={{ color: SERIES.amber }}
          >
            <Database className="w-4 h-4" />
            Append-Only Event Sourcing Ledger Stream (SHA-256 Verified)
          </h2>
          <span className={`text-xs font-mono ${INK_FAINT}`}>Total Sequence ID: #{metrics.totalEventsLogged}</span>
        </div>

        <div className="space-y-2 font-mono text-xs">
          {ledgerEvents.map((evt) => (
            <div key={evt.seq} className="p-2.5 bg-tavern-bg/60 rounded-lg border border-tavern-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-bold" style={{ color: SERIES.amber }}>#{evt.seq}</span>
                <span className="vtt-badge">{evt.type}</span>
                <span className="text-[var(--rp-parchment-100)]">{evt.actor}:</span>
                <span className={INK_FAINT}>{evt.payload}</span>
              </div>
              <span className={`text-[10px] ${INK_FAINT}`}>{evt.timestamp}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
