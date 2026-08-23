import React, { useEffect, useState } from 'react';
import { 
  Users, 
  Shield, 
  Crown, 
  Sparkles, 
  Link, 
  Copy, 
  Check, 
  Play, 
  Settings, 
  UserCheck, 
  Wifi, 
  Eye,
  Swords,
  Layers,
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
    return () => {
      cancelled = true;
      clearInterval(timer);
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

  const inviteUrl = `http://localhost:3000?campaign=vane-1042&passcode=${campaignMeta.passcode}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    globalAudio.playTurnAdvance();
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSeatClick = (id: string) => {
    setSelectedSeat(id);
    globalAudio.playTurnAdvance();
  };

  const handleLaunch = () => {
    globalAudio.playSpellCast();
    onLaunchCampaign(selectedSeat);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden select-none">
      {/* Top Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold font-display flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-400" />
            <span>Multi-Player Campaign Room Lobby</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time CRDT synchronized room with role-based seating, GM controls, and shareable join links.
          </p>
        </div>

        <button
          onClick={handleLaunch}
          className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold font-mono shadow-lg shadow-purple-950 transition active:scale-95"
        >
          <Play className="w-4 h-4 fill-white" />
          <span>Launch Campaign Tabletop</span>
        </button>
      </div>

      {/* Main Grid */}
      <div className="flex-1 p-6 overflow-y-auto vtt-scrollbar max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Columns: Player Seat Roster */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold font-display uppercase tracking-wider text-purple-400 flex items-center gap-2">
              <UserCheck className="w-4 h-4" />
              <span>Assigned Seats & Presence ({seats.length} / {campaignMeta.maxPlayers})</span>
              {livePeers !== null && (
                <span className="ml-2 px-2 py-0.5 text-[9px] font-mono bg-emerald-950/60 text-emerald-300 border border-emerald-600/40 rounded-full">
                  ● {livePeers} live via relay
                </span>
              )}
            </h2>
            <span className="text-xs font-mono text-emerald-400 flex items-center gap-1">
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
                  className={`p-4 rounded-xl border cursor-pointer transition flex items-center justify-between shadow ${
                    isSelected
                      ? 'bg-purple-950/50 border-purple-500 ring-1 ring-purple-500'
                      : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center border shadow ${
                        isGm
                          ? 'bg-amber-950 border-amber-600 text-amber-300'
                          : isSpectator
                          ? 'bg-slate-800 border-slate-700 text-slate-300'
                          : 'bg-indigo-950 border-indigo-600 text-indigo-300'
                      }`}
                    >
                      {isGm ? <Crown className="w-5 h-5" /> : isSpectator ? <Eye className="w-5 h-5" /> : <Shield className="w-5 h-5" />}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-xs font-display text-slate-100">
                          {seat.characterName}
                        </h3>
                        {seat.isHost && (
                          <span className="text-[9px] font-mono px-1.5 py-0.2 bg-amber-950 text-amber-300 rounded border border-amber-800">
                            HOST
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                        Claimed by: <span className="text-slate-200">{seat.playerName}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1.5 text-[11px] font-mono text-emerald-400">
                      <Wifi className="w-3.5 h-3.5" />
                      <span>{seat.pingMs}ms</span>
                    </div>

                    <div
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold uppercase border ${
                        seat.status === 'ready'
                          ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                          : seat.status === 'connected'
                          ? 'bg-sky-950 text-sky-300 border-sky-800'
                          : 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}
                    >
                      {seat.status}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Campaign Invitation & Room Settings */}
        <div className="space-y-4">
          <h2 className="text-sm font-bold font-display uppercase tracking-wider text-purple-400 flex items-center gap-2">
            <Link className="w-4 h-4" />
            <span>Shareable Invite Link</span>
          </h2>

          <div className="vtt-glass-panel p-4 rounded-xl border border-slate-800 space-y-3 shadow-lg">
            <p className="text-xs text-slate-400 leading-relaxed">
              Send this instant join link to your remote players or Twitch streamers:
            </p>

            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={inviteUrl}
                className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-purple-300 select-all focus:outline-none"
              />
              <button
                onClick={handleCopyLink}
                className="p-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-bold transition shadow"
                title="Copy Invite Link to Clipboard"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-300" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            <div className="p-3 bg-slate-950/80 rounded-lg border border-slate-800 text-xs font-mono space-y-1.5 text-slate-400">
              <div className="flex justify-between">
                <span>Room Passcode:</span>
                <strong className="text-slate-200">{campaignMeta.passcode}</strong>
              </div>
              <div className="flex justify-between">
                <span>Ruleset:</span>
                <span className="text-slate-200">{campaignMeta.ruleset}</span>
              </div>
              <div className="flex justify-between">
                <span>Difficulty Tier:</span>
                <span className="text-amber-400">{campaignMeta.difficulty}</span>
              </div>
              <div className="flex justify-between">
                <span>AI Director:</span>
                <span className="text-purple-400">{campaignMeta.dmName}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
