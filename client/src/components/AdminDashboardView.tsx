import React, { useState, useEffect } from 'react';
import {
  ShieldAlert,
  Users,
  Cpu,
  Activity,
  HardDrive,
  CheckCircle2,
  AlertTriangle,
  Search,
  Lock,
  Unlock,
  Crown,
  Radio,
  Layers,
  RefreshCw,
  Server,
  Terminal,
  Filter,
} from 'lucide-react';
import { User, UserRole, SubscriptionTier } from '../types/auth';
import { fetchEngineMetrics } from '../api/engine_metrics';

/* Badge marking content that has NO backend data source behind it. Rendered
   wherever this console would otherwise present hardcoded sample values as
   live platform telemetry. */
const DemoBadge = ({ title }: { title: string }) => (
  <span className="vtt-badge px-2 py-0.5 text-[10px]" title={title}>
    DEMO DATA
  </span>
);

/* Out-of-world (admin) palette: the dark tavern chrome carries amber gold-leaf,
   book crimson, forest and leather accents — never cold slate/purple. Bright
   variants are color-mixed toward parchment purely for legibility of small
   type on iron (raw --state-success/--rp-leather-600 are too dark on #2c241d). */
const C = {
  amber: 'var(--tavern-accent)',
  crimsonText: 'var(--rp-crimson-400)', // the only crimson allowed as text-size accent on dark
  forestBright: 'color-mix(in srgb, var(--state-success) 45%, var(--rp-parchment-100))',
  leatherBright: 'color-mix(in srgb, var(--rp-leather-600) 45%, var(--rp-parchment-200))',
};

interface AdminDashboardViewProps {
  onReturnToApp?: () => void;
}

export const AdminDashboardView: React.FC<AdminDashboardViewProps> = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRoleFilter, setSelectedRoleFilter] = useState<string>('all');
  // Only live signal available: engine /metrics via the orchestrator proxy.
  const [engineMcr, setEngineMcr] = useState<number | null>(null);
  const [engineLive, setEngineLive] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchEngineMetrics();
      if (cancelled) return;
      if (result.status === 'live') {
        setEngineMcr(result.metrics.mechanical_compliance_rate_pct);
        setEngineLive(true);
      } else {
        setEngineMcr(null);
        setEngineLive(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [platformUsers, setPlatformUsers] = useState<User[]>([
    {
      id: 'usr_admin',
      username: 'lead_gm',
      email: 'admin@aethertable.io',
      displayName: 'Arch-Mage Arthur',
      avatarUrl: 'crown',
      role: 'admin',
      subscriptionTier: 'master',
      assignedTokenIds: ['*'],
      diceTheme: 'gold',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'usr_thorin',
      username: 'thorin_player',
      email: 'thorin@aethertable.io',
      displayName: 'Thorin Oakenshield',
      avatarUrl: 'fighter',
      role: 'player',
      subscriptionTier: 'hero',
      assignedTokenIds: ['thorin_1'],
      diceTheme: 'crimson',
      createdAt: '2026-02-15T12:00:00Z',
    },
    {
      id: 'usr_lyra',
      username: 'lyra_player',
      email: 'lyra@aethertable.io',
      displayName: 'Lyra Moonshadow',
      avatarUrl: 'mage',
      role: 'player',
      subscriptionTier: 'hero',
      assignedTokenIds: ['lyra_1'],
      diceTheme: 'mithril',
      createdAt: '2026-03-01T08:30:00Z',
    },
    {
      id: 'usr_spectator',
      username: 'guest_watcher',
      email: 'spectator@aethertable.io',
      displayName: 'Guest Spectator',
      avatarUrl: 'scout',
      role: 'spectator',
      subscriptionTier: 'free',
      assignedTokenIds: [],
      diceTheme: 'obsidian',
      createdAt: '2026-08-20T19:00:00Z',
    },
    {
      id: 'usr_elrond',
      username: 'elrond_gm',
      email: 'elrond@rivendell.net',
      displayName: 'Lord Elrond (Rivendell Campaign)',
      avatarUrl: 'crown',
      role: 'gm',
      subscriptionTier: 'master',
      assignedTokenIds: ['*'],
      diceTheme: 'mithril',
      createdAt: '2026-04-10T11:20:00Z',
    },
  ]);

  const activeRooms = [
    { id: 'room_vane_1042', title: 'The Fall of Baron Vane', gm: 'Arch-Mage Arthur', peers: 4, status: 'Active Combat', latency: '8ms' },
    { id: 'room_rivendell_201', title: 'Council of the North', gm: 'Lord Elrond', peers: 6, status: 'Roleplay Narrative', latency: '12ms' },
    { id: 'room_underdark_88', title: 'Depths of Menzoberranzan', gm: 'DrowMaster', peers: 3, status: 'Exploration & WFC', latency: '15ms' },
  ];

  const handleUpdateRole = (userId: string, newRole: UserRole) => {
    setPlatformUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u))
    );
  };

  const handleUpdateTier = (userId: string, newTier: SubscriptionTier) => {
    setPlatformUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, subscriptionTier: newTier } : u))
    );
  };

  const filteredUsers = platformUsers.filter((u) => {
    const matchesSearch =
      u.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.username.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRole = selectedRoleFilter === 'all' || u.role === selectedRoleFilter;
    return matchesSearch && matchesRole;
  });

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="vtt-glass-panel rounded-xl p-6 relative overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center space-x-4">
            <div
              className="p-3.5 rounded-xl border border-tavern-border shadow-inner"
              style={{ background: 'color-mix(in srgb, var(--rp-crimson-650) 14%, transparent)', color: C.crimsonText }}
            >
              <ShieldAlert className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center space-x-3">
                <h2 className="text-2xl font-bold vtt-engraved tracking-wide">
                  Platform Administrator Console
                </h2>
                <span className="vtt-badge vtt-badge-danger font-mono">ROOT ADMIN</span>
              </div>
              <p className="text-xs text-[color-mix(in_srgb,var(--rp-parchment-300)_80%,transparent)] mt-1">
                Oversee multi-user authentication, live campaign rooms, system invariant telemetry, and RBAC permissions.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2 font-mono text-xs">
            {engineLive ? (
              <span className="vtt-badge vtt-badge-success px-3 py-1.5">
                <Activity className="w-4 h-4 animate-pulse" style={{ color: C.forestBright }} />
                Engine: REACHABLE
              </span>
            ) : (
              <span className="vtt-badge vtt-badge-danger px-3 py-1.5" title="GET /api/v1/engine/metrics did not answer">
                <AlertTriangle className="w-4 h-4" />
                Engine: UNREACHABLE
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Cluster Telemetry Stats — only the MCR card is backed by a real
          endpoint (engine /metrics). The rest have no API yet and show "—". */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="p-4 vtt-card-elevated rounded-xl shadow-lg">
          <div
            className="font-display text-[10px] uppercase tracking-[0.08em] font-semibold flex items-center justify-between gap-1"
            style={{ color: C.leatherBright }}
          >
            <span>Registered Users</span>
            <DemoBadge title="No user-directory/listing endpoint exists; the previous count (1,420) was hardcoded fiction" />
          </div>
          <div className="text-2xl font-prose font-bold mt-1" style={{ color: C.amber }}>—</div>
          <div className="text-[10px] text-[color-mix(in_srgb,var(--rp-parchment-300)_60%,transparent)] mt-0.5">No directory API yet</div>
        </div>

        <div className="p-4 vtt-card-elevated rounded-xl shadow-lg">
          <div
            className="font-display text-[10px] uppercase tracking-[0.08em] font-semibold flex items-center justify-between gap-1"
            style={{ color: C.leatherBright }}
          >
            <span>Active Rooms</span>
            <DemoBadge title="No platform-wide room listing endpoint exists; the previous counts (42 rooms / 184 peers) were hardcoded fiction" />
          </div>
          <div className="text-2xl font-prose font-bold mt-1" style={{ color: C.crimsonText }}>—</div>
          <div className="text-[10px] text-[color-mix(in_srgb,var(--rp-parchment-300)_60%,transparent)] mt-0.5">No fleet-wide room API yet</div>
        </div>

        <div className="p-4 vtt-card-elevated rounded-xl shadow-lg">
          <div
            className="font-display text-[10px] uppercase tracking-[0.08em] font-semibold flex items-center justify-between gap-1"
            style={{ color: C.leatherBright }}
          >
            <span>Mechanical Compliance</span>
            {engineLive ? (
              <span className="vtt-badge vtt-badge-success px-1.5 py-0.5 text-[9px]" title="Live value from engine GET /metrics via /api/v1/engine/metrics">
                LIVE
              </span>
            ) : (
              <DemoBadge title="Engine unreachable — no honest MCR reading to display" />
            )}
          </div>
          <div className="text-2xl font-prose font-bold mt-1" style={{ color: C.forestBright }}>
            {engineLive && engineMcr !== null ? `${engineMcr.toFixed(1)}%` : '—'}
          </div>
          <div className="text-[10px] text-[color-mix(in_srgb,var(--rp-parchment-300)_60%,transparent)] mt-0.5">
            {engineLive ? 'From engine /metrics' : 'Engine offline'}
          </div>
        </div>

        <div className="p-4 vtt-card-elevated rounded-xl shadow-lg">
          <div
            className="font-display text-[10px] uppercase tracking-[0.08em] font-semibold flex items-center justify-between gap-1"
            style={{ color: C.leatherBright }}
          >
            <span>Rust Hot-Path Latency</span>
            <DemoBadge title="No latency instrumentation endpoint exists; the previous reading (8 ms) was hardcoded fiction. The design budget is < 10 ms." />
          </div>
          <div className="text-2xl font-prose font-bold mt-1" style={{ color: C.amber }}>—</div>
          <div className="text-[10px] text-[color-mix(in_srgb,var(--rp-parchment-300)_60%,transparent)] mt-0.5">Design budget &lt; 10 ms (STATIC)</div>
        </div>
      </div>

      {/* User Directory & RBAC Table */}
      <div className="vtt-surface rounded-xl p-5 shadow-lg space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center space-x-2">
            <Users className="w-5 h-5" style={{ color: C.amber }} />
            <h3
              className="font-display text-sm tracking-[0.05em]"
              style={{ color: C.amber }}
            >
              User Management &amp; Permissions Directory
            </h3>
            {/* Honest labelling: this directory is a local sample — role/tier
                edits mutate client state only and are never persisted. */}
            <DemoBadge title="Sample accounts. No admin user-directory or RBAC-write API exists yet; edits below are local to this screen and are not persisted." />
          </div>

          <div className="flex items-center space-x-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[color-mix(in_srgb,var(--rp-parchment-300)_55%,transparent)]" />
              <input
                type="text"
                placeholder="Search by name, email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="vtt-input pl-8 pr-3 py-1.5 text-xs w-52"
              />
            </div>

            <select
              value={selectedRoleFilter}
              onChange={(e) => setSelectedRoleFilter(e.target.value)}
              className="vtt-select px-2.5 py-1.5 text-xs font-mono"
            >
              <option value="all">All Roles</option>
              <option value="admin">Admins</option>
              <option value="gm">Game Masters</option>
              <option value="player">Players</option>
              <option value="spectator">Spectators</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="vtt-table vtt-table--dark w-full text-left text-xs font-mono">
            <thead className="uppercase text-[10px]">
              <tr>
                <th className="p-3">User</th>
                <th className="p-3">Email</th>
                <th className="p-3">Role</th>
                <th className="p-3">Subscription Tier</th>
                <th className="p-3">Token Scope</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id} className="hover:bg-white/5 transition">
                  <td className="p-3 font-semibold flex items-center space-x-2">
                    <div className="w-6 h-6 rounded bg-tavern-bg border border-tavern-border flex items-center justify-center text-[10px] font-bold" style={{ color: C.amber }}>
                      {u.displayName.charAt(0)}
                    </div>
                    <span>{u.displayName}</span>
                  </td>
                  <td className="p-3 text-[color-mix(in_srgb,var(--rp-parchment-300)_75%,transparent)]">{u.email}</td>
                  <td className="p-3">
                    <select
                      value={u.role}
                      onChange={(e) => handleUpdateRole(u.id, e.target.value as UserRole)}
                      className="vtt-select px-2 py-1 text-[11px] font-bold"
                      style={{ color: C.amber }}
                    >
                      <option value="admin">ADMIN</option>
                      <option value="gm">GM</option>
                      <option value="player">PLAYER</option>
                      <option value="spectator">SPECTATOR</option>
                    </select>
                  </td>
                  <td className="p-3">
                    <select
                      value={u.subscriptionTier}
                      onChange={(e) => handleUpdateTier(u.id, e.target.value as SubscriptionTier)}
                      className="vtt-select px-2 py-1 text-[11px] font-bold uppercase"
                      style={{ color: C.crimsonText }}
                    >
                      <option value="free">FREE</option>
                      <option value="hero">HERO</option>
                      <option value="master">MASTER</option>
                    </select>
                  </td>
                  <td className="p-3 text-[color-mix(in_srgb,var(--rp-parchment-300)_75%,transparent)]">
                    {u.assignedTokenIds.includes('*') ? 'All Battlefield Tokens' : u.assignedTokenIds.join(', ') || 'Read-only'}
                  </td>
                  <td className="p-3 text-right">
                    <button className="vtt-btn vtt-btn-secondary px-2 py-1 text-[10px]">
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Active Multiplayer Rooms Inspector */}
      <div className="vtt-surface rounded-xl p-5 shadow-lg space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Radio className="w-5 h-5" style={{ color: C.crimsonText }} />
            <h3
              className="font-display text-sm tracking-[0.05em]"
              style={{ color: C.amber }}
            >
              Campaign Room Sessions
            </h3>
            {/* Honest labelling: no platform-wide room listing endpoint exists. */}
            <DemoBadge title="Sample rooms. No platform-wide room listing endpoint exists; these entries are hardcoded fiction, not live sessions." />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {activeRooms.map((room) => (
            <div key={room.id} className="p-4 vtt-card-elevated rounded-xl space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[var(--rp-parchment-100)]">{room.title}</span>
                <span className="vtt-badge vtt-badge-success">{room.peers} Peers</span>
              </div>
              <div className="text-[11px] text-[color-mix(in_srgb,var(--rp-parchment-300)_75%,transparent)]">GM: {room.gm}</div>
              <div className="flex items-center justify-between text-[10px] text-[color-mix(in_srgb,var(--rp-parchment-300)_55%,transparent)] pt-2 border-t border-tavern-border">
                <span>Status: {room.status}</span>
                <span>Latency: {room.latency}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
