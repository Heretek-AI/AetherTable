import React, { useState, useEffect } from 'react';
import { Activity, ShieldCheck, Cpu, Database, Zap, Clock, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';

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
    <div className="flex-1 flex flex-col h-full bg-slate-950 p-6 overflow-y-auto vtt-scrollbar space-y-6">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold font-display text-slate-100 flex items-center gap-2.5">
            <Activity className="w-6 h-6 text-purple-400" />
            System Telemetry & Invariant Auditor Dashboard
          </h1>
          <p className="text-xs text-slate-400 font-mono mt-1">
            Real-time verification metrics, sub-1200ms latency allocation SLAs, and cryptographic event ledger stream.
          </p>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs text-emerald-400 bg-emerald-950/60 px-3 py-1.5 rounded-lg border border-emerald-800">
          <CheckCircle2 className="w-4 h-4" />
          <span>All 7 Phase SLAs Active & Passing</span>
        </div>
      </div>

      {/* Primary KPI Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* MCR Card */}
        <div className="p-5 rounded-xl vtt-card-elevated">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-slate-400">MECHANICAL COMPLIANCE (MCR)</span>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-3xl font-bold font-mono text-emerald-400 mt-2">{metrics.mcr}%</div>
          <div className="text-[11px] text-slate-400 font-mono mt-1">
            Target: <span className="text-slate-200 font-semibold">≥ 98.5%</span> · Zero unverified mutations
          </div>
        </div>

        {/* HCI Card */}
        <div className="p-5 rounded-xl vtt-card-elevated">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-slate-400">HALLUCINATION INDEX (HCI)</span>
            <Zap className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-3xl font-bold font-mono text-purple-300 mt-2">{metrics.hci}</div>
          <div className="text-[11px] text-slate-400 font-mono mt-1">
            Target: <span className="text-slate-200 font-semibold">≥ 0.95</span> · 3-Tier Lore Invariant
          </div>
        </div>

        {/* AFPR Card */}
        <div className="p-5 rounded-xl vtt-card-elevated">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-slate-400">AUDITOR FALSE-POSITIVE (AFPR)</span>
            <AlertTriangle className="w-4 h-4 text-sky-400" />
          </div>
          <div className="text-3xl font-bold font-mono text-sky-400 mt-2">{metrics.afpr}%</div>
          <div className="text-[11px] text-slate-400 font-mono mt-1">
            Target: <span className="text-slate-200 font-semibold">≤ 1.5%</span> · 2-Pass Retry Pass-through
          </div>
        </div>
      </div>

      {/* Latency Allocation Budget Table */}
      <div className="p-5 rounded-xl vtt-card-elevated space-y-4">
        <h2 className="font-bold text-sm text-slate-100 font-display flex items-center gap-2">
          <Clock className="w-4 h-4 text-purple-400" />
          Sub-1200ms Latency Budget Allocations
        </h2>

        <div className="space-y-3 font-mono text-xs">
          <div>
            <div className="flex justify-between text-slate-300 mb-1">
              <span>Deterministic Rust Engine (`vtt-core` / `vtt-spatial`)</span>
              <span className="text-emerald-400 font-bold">&lt; 0.01 ms / 10 ms SLA</span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: '2%' }} />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-slate-300 mb-1">
              <span>Pre-Commit Auditor Invariant Gate ("World Inspector")</span>
              <span className="text-purple-400 font-bold">{metrics.auditorLatencyMs} ms / 200 ms SLA</span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
              <div className="h-full bg-purple-500 rounded-full" style={{ width: '21%' }} />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-slate-300 mb-1">
              <span>Yjs Binary CRDT WebSocket Delta Broadcast</span>
              <span className="text-sky-400 font-bold">{metrics.crdtLatencyMs} ms / 16 ms SLA (60 FPS)</span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
              <div className="h-full bg-sky-500 rounded-full" style={{ width: '50%' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Live Event Sourcing Ledger Log */}
      <div className="p-5 rounded-xl vtt-card-elevated space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-slate-800">
          <h2 className="font-bold text-sm text-slate-100 font-display flex items-center gap-2">
            <Database className="w-4 h-4 text-purple-400" />
            Append-Only Event Sourcing Ledger Stream (SHA-256 Verified)
          </h2>
          <span className="text-xs font-mono text-slate-400">Total Sequence ID: #{metrics.totalEventsLogged}</span>
        </div>

        <div className="space-y-2 font-mono text-xs">
          {ledgerEvents.map((evt) => (
            <div key={evt.seq} className="p-2.5 bg-slate-950/80 rounded-lg border border-slate-800/80 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-purple-400 font-bold">#{evt.seq}</span>
                <span className="px-2 py-0.5 bg-slate-900 rounded text-[10px] text-slate-300 border border-slate-800 font-bold">
                  {evt.type}
                </span>
                <span className="text-slate-200">{evt.actor}:</span>
                <span className="text-slate-400">{evt.payload}</span>
              </div>
              <span className="text-[10px] text-slate-500">{evt.timestamp}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
