import React, { useState } from 'react';
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

interface AdminDashboardViewProps {
  onReturnToApp?: () => void;
}

export const AdminDashboardView: React.FC<AdminDashboardViewProps> = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRoleFilter, setSelectedRoleFilter] = useState<string>('all');

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
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center space-x-4">
            <div className="p-3.5 bg-rose-950/40 border border-rose-500/30 rounded-xl text-rose-400 shadow-inner">
              <ShieldAlert className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center space-x-3">
                <h2 className="text-2xl font-bold font-serif tracking-wide text-slate-100">
                  Platform Administrator Console
                </h2>
                <span className="px-2.5 py-0.5 text-xs font-semibold bg-rose-950/60 border border-rose-600/50 text-rose-300 rounded-full font-mono">
                  ROOT ADMIN
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Oversee multi-user authentication, live campaign rooms, system invariant telemetry, and RBAC permissions.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2 font-mono text-xs">
            <div className="px-3 py-1.5 bg-slate-950 rounded-lg border border-slate-800 flex items-center space-x-2">
              <Activity className="w-4 h-4 text-emerald-400 animate-pulse" />
              <span className="text-slate-300">Cluster Status: <strong className="text-emerald-400">HEALTHY</strong></span>
            </div>
          </div>
        </div>
      </div>

      {/* Cluster Telemetry Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl shadow-lg font-mono">
          <div className="text-[10px] text-slate-400 uppercase font-bold">Total Registered Users</div>
          <div className="text-2xl font-extrabold text-amber-400 mt-1">1,420</div>
          <div className="text-[10px] text-slate-500 mt-0.5">+48 this week</div>
        </div>

        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl shadow-lg font-mono">
          <div className="text-[10px] text-slate-400 uppercase font-bold">Active Multiplayer Rooms</div>
          <div className="text-2xl font-extrabold text-sky-400 mt-1">42 Rooms</div>
          <div className="text-[10px] text-slate-500 mt-0.5">184 connected peers</div>
        </div>

        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl shadow-lg font-mono">
          <div className="text-[10px] text-slate-400 uppercase font-bold">Mechanical Compliance</div>
          <div className="text-2xl font-extrabold text-emerald-400 mt-1">100.0%</div>
          <div className="text-[10px] text-slate-500 mt-0.5">MCR Invariant Active</div>
        </div>

        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl shadow-lg font-mono">
          <div className="text-[10px] text-slate-400 uppercase font-bold">Rust Hot-Path Latency</div>
          <div className="text-2xl font-extrabold text-purple-400 mt-1">8 ms</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Zero runtime allocations</div>
        </div>
      </div>

      {/* User Directory & RBAC Table */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center space-x-2">
            <Users className="w-5 h-5 text-amber-400" />
            <h3 className="text-sm font-bold font-serif text-slate-100">User Management & Permissions Directory</h3>
          </div>

          <div className="flex items-center space-x-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
              <input
                type="text"
                placeholder="Search by name, email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500 w-52"
              />
            </div>

            <select
              value={selectedRoleFilter}
              onChange={(e) => setSelectedRoleFilter(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-amber-500 font-mono"
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
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase text-[10px]">
              <tr>
                <th className="p-3">User</th>
                <th className="p-3">Email</th>
                <th className="p-3">Role</th>
                <th className="p-3">Subscription Tier</th>
                <th className="p-3">Token Scope</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {filteredUsers.map((u) => (
                <tr key={u.id} className="hover:bg-slate-850/50 transition">
                  <td className="p-3 font-semibold text-slate-100 flex items-center space-x-2">
                    <div className="w-6 h-6 rounded bg-slate-800 flex items-center justify-center text-[10px] font-bold text-amber-300">
                      {u.displayName.charAt(0)}
                    </div>
                    <span>{u.displayName}</span>
                  </td>
                  <td className="p-3 text-slate-400">{u.email}</td>
                  <td className="p-3">
                    <select
                      value={u.role}
                      onChange={(e) => handleUpdateRole(u.id, e.target.value as UserRole)}
                      className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-amber-300 font-bold"
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
                      className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-purple-300 font-bold uppercase"
                    >
                      <option value="free">FREE</option>
                      <option value="hero">HERO</option>
                      <option value="master">MASTER</option>
                    </select>
                  </td>
                  <td className="p-3 text-slate-400">
                    {u.assignedTokenIds.includes('*') ? 'All Battlefield Tokens' : u.assignedTokenIds.join(', ') || 'Read-only'}
                  </td>
                  <td className="p-3 text-right">
                    <button className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 text-[10px] font-bold cursor-pointer">
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
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Radio className="w-5 h-5 text-purple-400 animate-pulse" />
            <h3 className="text-sm font-bold font-serif text-slate-100">Live Campaign Room Sessions</h3>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {activeRooms.map((room) => (
            <div key={room.id} className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-100">{room.title}</span>
                <span className="px-2 py-0.5 bg-emerald-950 text-emerald-300 border border-emerald-600/40 rounded text-[10px]">
                  {room.peers} Peers
                </span>
              </div>
              <div className="text-slate-400 text-[11px]">GM: {room.gm}</div>
              <div className="flex items-center justify-between text-[10px] text-slate-500 pt-2 border-t border-slate-800">
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
