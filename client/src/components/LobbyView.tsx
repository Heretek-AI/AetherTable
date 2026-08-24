import React, { useEffect, useState } from 'react';
import { createLobby, joinLobby, launchLobby, fetchLobby, listMyLobbies, type Lobby } from '../api/lobby_store';
import {
  Users,
  Shield,
  Crown,
  Link,
  Copy,
  Check,
  Play,
  UserCheck,
  Wifi,
  Eye,
  Radio
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { User } from '../types/auth';

export interface PlayerSeat {
  id: string;
  role: 'gm' | 'player' | 'spectator';
  characterName: string;
  playerName: string;
  status: 'connected' | 'ready' | 'idle';
  pingMs: number;
  avatarIcon: string;
  isHost?: boolean;
}

interface LobbyViewProps {
  onLaunchCampaign: (selectedSeatId: string) => void;
  currentUser?: User;
}

export const LobbyView: React.FC<LobbyViewProps> = ({ onLaunchCampaign, currentUser }) => {
  const [copied, setCopied] = useState(false);
  const [selectedSeat, setSelectedSeat] = useState<string>('seat_gm');
  // Live presence from the engine relay; null while unreachable (solo session).
  const [livePeers, setLivePeers] = useState<number | null>(null);
  // REAL lobby state: created/joined via /api/v1/lobbies. Null = demo fallback.
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [joinCode, setJoinCode] = useState('');

  useEffect(() => {
    let cancelled = false;
    const pollPresence = () => {
      fetch('/api/v1/engine/rooms/aethertable-live/presence')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled) setLivePeers(data ? data.connected_peers : null);
        })
        .catch(() => {
          if (!cancelled) setLivePeers(null);
        });
    };
    pollPresence();
    const timer = setInterval(pollPresence, 5000);

    // Restore the user's most recent lobby and refresh its roster.
    listMyLobbies().then((mine) => {
      if (!cancelled && mine && mine.length > 0) setLobby(mine[0]);
    });
    const rosterTimer = setInterval(() => {
      setLobby((current) => {
        if (current) fetchLobby(current.lobby_id).then((fresh) => { if (!cancelled && fresh) setLobby(fresh); });
        return current;
      });
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(rosterTimer);
    };
  }, []);

  const [campaignMeta, setCampaignMeta] = useState({
    title: 'The Fall of Baron Vane',
    ruleset: 'D&D 5e SRD + Homebrew Modifiers',
    dmName: 'AI Multi-Agent Director',
    maxPlayers: 6,
    difficulty: 'Heroic Challenge (CR 5-8)',
    passcode: 'VANE-1042',
  });

  const displayCode = lobby?.invite_code ?? campaignMeta.passcode;

  const [seats, setSeats] = useState<PlayerSeat[]>([
    {
      id: 'seat_gm',
      role: 'gm',
      characterName: 'Dungeon Master (Omniscient)',
      playerName: 'Lead GM (You)',
      status: 'ready',
      pingMs: 8,
      avatarIcon: 'crown',
      isHost: true,
    },
    {
      id: 'seat_thorin',
      role: 'player',
      characterName: 'Thorin Oakenshield (Fighter)',
      playerName: 'Player 1 (John)',
      status: 'connected',
      pingMs: 12,
      avatarIcon: 'fighter',
    },
    {
      id: 'seat_lyra',
      role: 'player',
      characterName: 'Lyra Moonshadow (Caster)',
      playerName: 'Player 2 (Sarah)',
      status: 'connected',
      pingMs: 16,
      avatarIcon: 'caster',
    },
    {
      id: 'seat_valerius',
      role: 'player',
      characterName: 'Valerius the Bold (Dwarf Fighter)',
      playerName: 'Player 3 (Open Slot)',
      status: 'ready',
      pingMs: 10,
      avatarIcon: 'fighter',
    },
    {
      id: 'seat_spectator',
      role: 'spectator',
      characterName: 'Broadcast Spectator',
      playerName: 'Twitch / Discord Streamer',
      status: 'idle',
      pingMs: 24,
      avatarIcon: 'spectator',
    },
  ]);

  const inviteUrl = `http://localhost:3000?campaign=vane-1042&passcode=${displayCode}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    globalAudio.playTurnAdvance();
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSeatClick = (id: string) => {
    setSelectedSeat(id);
    // Silent selection — audio feedback is reserved for commit actions
    // (launch campaign) rather than every seat pick.
  };

  // Host: create a real lobby bound to this table name; players join by code.
  const handleCreateLobby = async () => {
    const created = await createLobby(campaignMeta.title);
    if (created) setLobby(created);
  };

  const handleJoinLobby = async () => {
    if (!joinCode.trim()) return;
    // Join by code against the host's lobby id carried in the invite URL,
    // or fall back to the most recent lobby we know of.
    const target = lobby?.lobby_id ?? new URLSearchParams(window.location.search).get('lobby');
    if (!target) return;
    const joined = await joinLobby(target, joinCode.trim());
    if (joined) setLobby(joined);
  };

  const handleLaunch = async () => {
    globalAudio.playSpellCast();
    if (lobby && !lobby.engine_session_id) {
      const launched = await launchLobby(lobby.lobby_id);
      if (launched?.session_id) {
        setLobby({ ...lobby, engine_session_id: launched.session_id });
      }
      // Offline/failed launch still proceeds into the demo tabletop.
    }
    onLaunchCampaign(selectedSeat);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-tavern-bg text-[var(--rp-parchment-200)] overflow-hidden select-none">
      {/* Top Header */}
      <div className="p-4 border-b border-tavern-border flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold font-display flex items-center gap-2">
            <Users className="w-5 h-5 text-tavern-accent" />
            <span className="vtt-engraved">Multi-Player Campaign Room Lobby</span>
          </h1>
          <p className="text-xs text-[var(--rp-parchment-300)] mt-0.5">
            Real-time CRDT synchronized room with role-based seating, GM controls, and shareable join links.
          </p>
        </div>

        <button
          onClick={handleLaunch}
          className="vtt-btn vtt-btn-primary font-display tracking-wide"
        >
          <Play className="w-4 h-4 fill-current" />
          <span>Launch Campaign Tabletop</span>
        </button>
      </div>

      {/* Main Grid */}
      <div className="flex-1 p-6 overflow-y-auto vtt-scrollbar max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Columns: Player Seat Roster */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="vtt-section-header text-sm font-bold">
              <UserCheck className="w-4 h-4 shrink-0" />
              <span>Assigned Seats &amp; Presence ({seats.length} / {campaignMeta.maxPlayers})</span>
              {livePeers !== null && (
                <span className="vtt-badge vtt-badge-success ml-2">
                  ● {livePeers} live via relay
                </span>
              )}
            </h2>
            <span className="text-xs font-mono text-emerald-400 flex items-center gap-1 shrink-0">
              <Radio className="w-3 h-3 animate-pulse" />
              <span>CRDT Sync Active</span>
            </span>
          </div>

          <div className="space-y-3">
            {seats.map((seat) => {
              const isSelected = selectedSeat === seat.id;
              const isGm = seat.role === 'gm';
              const isSpectator = seat.role === 'spectator';

              return (
                <div
                  key={seat.id}
                  onClick={() => handleSeatClick(seat.id)}
                  className={`p-4 rounded-xl border cursor-pointer transition flex items-center justify-between ${
                    isSelected
                      ? 'bg-[color-mix(in_srgb,var(--tavern-accent)_12%,transparent)] border-tavern-accent ring-1 ring-tavern-accent'
                      : 'vtt-card-elevated'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center border shadow ${
                        isGm
                          ? 'bg-[color-mix(in_srgb,var(--rp-amber-600)_25%,transparent)] border-tavern-accent text-tavern-accent'
                          : 'bg-tavern-surface border-tavern-border text-[var(--rp-parchment-300)]'
                      }`}
                    >
                      {isGm ? <Crown className="w-5 h-5" /> : isSpectator ? <Eye className="w-5 h-5" /> : <Shield className="w-5 h-5" />}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-xs font-display text-[var(--rp-parchment-100)]">
                          {seat.characterName}
                        </h3>
                        {seat.isHost && (
                          <span className="vtt-badge">HOST</span>
                        )}
                      </div>
                      <div className="text-[11px] text-[var(--rp-parchment-300)] font-mono mt-0.5">
                        Claimed by: <span className="text-[var(--rp-parchment-100)]">{seat.playerName}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1.5 text-[11px] font-mono text-emerald-400">
                      <Wifi className="w-3.5 h-3.5" />
                      <span>{seat.pingMs}ms</span>
                    </div>

                    <span
                      className={`vtt-badge uppercase ${
                        seat.status === 'ready' ? 'vtt-badge-success' : ''
                      }`}
                    >
                      {seat.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Campaign Invitation & Room Settings */}
        <div className="space-y-4">
          <h2 className="vtt-section-header text-sm font-bold">
            <Link className="w-4 h-4 shrink-0" />
            <span>Shareable Invite Link</span>
          </h2>

          <div className="vtt-glass-panel p-4 rounded-xl space-y-3">
            <p className="text-xs text-[var(--rp-parchment-300)] leading-relaxed font-prose">
              Send this instant join link to your remote players or Twitch streamers:
            </p>

            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={inviteUrl}
                className="vtt-input flex-1 text-xs font-mono select-all"
              />
              <button
                onClick={handleCopyLink}
                className="vtt-btn vtt-btn-primary px-2.5"
                title="Copy Invite Link to Clipboard"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            <div className="p-3 rounded-lg border border-tavern-border text-xs font-mono space-y-1.5 text-[var(--rp-parchment-300)] bg-tavern-bg/60">
              <div className="flex justify-between">
                <span>Room Passcode:</span>
<div className="flex items-center gap-2 mb-2">
                  <button
                    onClick={handleCreateLobby}
                    className="px-2 py-1 text-xs vtt-surface hover:bg-black/20 rounded-lg transition"
                    title="Create a real multiplayer lobby (requires login)"
                  >
                    Create Lobby
                  </button>
                  <input
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="CODE"
                    maxLength={6}
                    className="w-16 px-1 py-1 text-xs bg-black/40 border border-tavern-border rounded-lg font-mono"
                  />
                  <button
                    onClick={handleJoinLobby}
                    className="px-2 py-1 text-xs vtt-surface hover:bg-black/20 rounded-lg transition"
                    title="Join by invite code (requires lobby id in URL)"
                  >
                    Join
                  </button>
                </div>
                
                <strong className="text-[var(--rp-parchment-100)]">{displayCode}</strong>
              </div>
              <div className="flex justify-between">
                <span>Ruleset:</span>
                <span className="text-[var(--rp-parchment-100)]">{campaignMeta.ruleset}</span>
              </div>
              <div className="flex justify-between">
                <span>Difficulty Tier:</span>
                <span className="text-tavern-accent">{campaignMeta.difficulty}</span>
              </div>
              <div className="flex justify-between">
                <span>AI Director:</span>
                <span className="text-[var(--rp-crimson-400)]">{campaignMeta.dmName}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
