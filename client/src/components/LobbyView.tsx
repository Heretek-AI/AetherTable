import React, { useEffect, useState } from 'react';
import {
  createLobby,
  joinLobby,
  launchLobby,
  fetchLobby,
  listMyLobbies,
  listCharacters,
  ownedCharacters,
  setMemberReady,
  setMemberCharacter,
  type Lobby,
  type StoredCharacter,
  type UnreadyMember,
} from '../api/lobby_store';
import {
  Users,
  Shield,
  Crown,
  Link,
  Copy,
  Check,
  Play,
  UserCheck,
  UserPlus,
  Eye,
  Radio,
  AlertTriangle,
  Zap
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { authHeaders, getStoredToken } from '../api/auth_headers';
import { User } from '../types/auth';

export interface PlayerSeat {
  /** Real member user_id for occupied seats; `open_N` for unfilled party slots. */
  id: string;
  role: 'gm' | 'player' | 'spectator';
  playerName: string;
  isHost: boolean;
  /** True for an empty party-slot placeholder — NOT a real player. */
  isOpen: boolean;
}

/** Map a backend role string ('gm' | 'player' | 'spectator' | 'admin') to a seat role. */
const seatRoleOf = (role: string): PlayerSeat['role'] =>
  role === 'gm' || role === 'admin' ? 'gm' : role === 'spectator' ? 'spectator' : 'player';

interface LobbyViewProps {
  onLaunchCampaign: (selectedSeatId: string) => void;
  currentUser?: User;
}

export const LobbyView: React.FC<LobbyViewProps> = ({ onLaunchCampaign, currentUser }) => {
  const [copied, setCopied] = useState(false);
  const [selectedSeat, setSelectedSeat] = useState<string>('');
  // Live presence from the engine relay; null while unreachable (solo session).
  const [livePeers, setLivePeers] = useState<number | null>(null);
  // REAL lobby state: created/joined via /api/v1/lobbies. Null = demo fallback.
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [joinCode, setJoinCode] = useState('');
  // The signed-in user's OWN sheets — the only ones the seat selector may
  // offer (a foreign bind is a hard 403 server-side).
  const [myCharacters, setMyCharacters] = useState<StoredCharacter[]>([]);
  // Honest launch-refusal state from a 409 MEMBERS_NOT_READY answer.
  const [unreadyMembers, setUnreadyMembers] = useState<UnreadyMember[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const pollPresence = () => {
      // Authenticated like every other /api/v1/engine/* HTTP call (Bearer
      // header): the gateway 401s anonymous presence reads, and a signed-out
      // visitor simply keeps the solo-session fallback (livePeers stays null).
      const token = getStoredToken();
      fetch('/api/v1/engine/rooms/aethertable-live/presence', {
        headers: authHeaders(),
      })
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

    // Restore the user's most recent lobby and refresh its roster, plus the
    // caller's own character sheets for the seat selector.
    listMyLobbies().then((mine) => {
      if (!cancelled && mine && mine.length > 0) setLobby(mine[0]);
    });
    listCharacters().then((roster) => {
      if (!cancelled) setMyCharacters(ownedCharacters(roster, currentUser?.id));
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

  // Seats come ONLY from the real lobby member list (GET /api/v1/lobbies/{id},
  // polled every 5s). Backend members expose { user_id, display_name, role }
  // only — there is no ready flag or latency metric, so none are rendered.
  // Unfilled party slots render as clearly-styled open placeholders, never as
  // fabricated players.
  const maxSeats = campaignMeta.maxPlayers;
  const seats: PlayerSeat[] = (() => {
    const filled: PlayerSeat[] = lobby
      ? lobby.members.map((m) => ({
          id: m.user_id,
          role: m.user_id === lobby.host_user_id ? 'gm' : seatRoleOf(m.role),
          playerName: m.display_name,
          isHost: m.user_id === lobby.host_user_id,
          isOpen: false,
        }))
      : currentUser
        ? [
            {
              id: currentUser.id,
              role: seatRoleOf(currentUser.role),
              playerName: `${currentUser.displayName} (You)`,
              isHost: false,
              isOpen: false,
            },
          ]
        : [];
    return [
      ...filled,
      ...Array.from({ length: Math.max(0, maxSeats - filled.length) }, (_, i) => ({
        id: `open_${i + 1}`,
        role: 'player' as const,
        playerName: '',
        isHost: false,
        isOpen: true,
      })),
    ];
  })();
  const joinedCount = seats.filter((s) => !s.isOpen).length;
  // Selection must always point at a real (non-placeholder) seat.
  const activeSeatId =
    seats.find((s) => !s.isOpen && s.id === selectedSeat)?.id ?? seats.find((s) => !s.isOpen)?.id ?? '';

  // Real invite link derived from this deployment's origin plus the actual
  // lobby id and invite code. With no live lobby there is no real id to share,
  // so the link carries no fabricated campaign parameters.
  const pageBase = `${window.location.origin}${window.location.pathname}`;
  const inviteUrl = lobby
    ? `${pageBase}?lobby=${encodeURIComponent(lobby.lobby_id)}&passcode=${encodeURIComponent(displayCode)}`
    : pageBase;

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

  const myMember = lobby && currentUser
    ? lobby.members.find((m) => m.user_id === currentUser.id) ?? null
    : null;
  const amHost = !!lobby && !!currentUser && lobby.host_user_id === currentUser.id;

  const applyRoster = (fresh: Lobby | null) => {
    if (fresh) setLobby(fresh);
  };

  // Self-only readiness toggle: the gateway flips ONLY the calling member's
  // flag, so the UI must not even offer a toggle for another seat.
  const handleToggleReady = async () => {
    if (!lobby || !myMember) return;
    setUnreadyMembers(null);
    applyRoster(await setMemberReady(lobby.lobby_id, !myMember.ready));
  };

  const handleSelectCharacter = async (characterId: string) => {
    if (!lobby) return;
    if (characterId) {
      applyRoster(await setMemberCharacter(lobby.lobby_id, characterId));
    }
  };

  const runLaunch = async (force: boolean) => {
    globalAudio.playSpellCast();
    if (lobby && !lobby.engine_session_id) {
      const launched = await launchLobby(lobby.lobby_id, force ? { force: true } : undefined);
      if (launched && launched.outcome === 'LAUNCHED') {
        setUnreadyMembers(null);
        setLobby({ ...lobby, engine_session_id: launched.sessionId });
      } else if (launched && launched.outcome === 'MEMBERS_NOT_READY') {
        // Honest refusal: show exactly who is holding up the party.
        setUnreadyMembers(launched.unreadyMembers);
        return; // do NOT enter a half-party session behind the user's back
      } else {
        setUnreadyMembers(null);
      }
    }
    onLaunchCampaign(activeSeatId);
  };

  const handleLaunch = async () => {
    await runLaunch(false);
  };

  const unreadyNames = (unreadyMembers ?? [])
    .map((m) => m.display_name || m.user_id)
    .filter(Boolean)
    .join(', ');

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
              <span>Assigned Seats &amp; Presence ({joinedCount} / {campaignMeta.maxPlayers})</span>
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
              const isSelected = !seat.isOpen && selectedSeat === seat.id;
              const isGm = seat.role === 'gm';
              const isSpectator = seat.role === 'spectator';
              // Real readiness comes only from the backend roster; demo seats
              // (no live lobby) have no flag to render.
              const member = lobby?.members.find((m) => m.user_id === seat.id) ?? null;
              const isSelf = !!currentUser && seat.id === currentUser.id;
              const boundCharacter =
                member?.selected_character_id != null
                  ? myCharacters.find((c) => c.character_id === member.selected_character_id)
                    ?.name ?? 'bound sheet'
                  : null;

              return (
                <div
                  key={seat.id}
                  onClick={() => !seat.isOpen && handleSeatClick(seat.id)}
                  className={`p-4 rounded-xl border transition flex items-center justify-between ${
                    seat.isOpen
                      ? 'border-dashed border-tavern-border bg-transparent opacity-70'
                      : `cursor-pointer ${
                          isSelected
                            ? 'bg-[color-mix(in_srgb,var(--tavern-accent)_12%,transparent)] border-tavern-accent ring-1 ring-tavern-accent'
                            : 'vtt-card-elevated'
                        }`
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center border shadow ${
                        seat.isOpen
                          ? 'border-dashed border-tavern-border text-[var(--rp-parchment-300)]/50 bg-transparent'
                          : isGm
                            ? 'bg-[color-mix(in_srgb,var(--rp-amber-600)_25%,transparent)] border-tavern-accent text-tavern-accent'
                            : 'bg-tavern-surface border-tavern-border text-[var(--rp-parchment-300)]'
                      }`}
                    >
                      {seat.isOpen ? (
                        <UserPlus className="w-5 h-5" />
                      ) : isGm ? (
                        <Crown className="w-5 h-5" />
                      ) : isSpectator ? (
                        <Eye className="w-5 h-5" />
                      ) : (
                        <Shield className="w-5 h-5" />
                      )}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <h3
                          className={`font-bold text-xs font-display ${
                            seat.isOpen
                              ? 'text-[var(--rp-parchment-300)] italic'
                              : 'text-[var(--rp-parchment-100)]'
                          }`}
                        >
                          {seat.isOpen ? 'Open Seat' : seat.playerName}
                        </h3>
                        {seat.isHost && (
                          <span className="vtt-badge">HOST</span>
                        )}
                        {!seat.isOpen && member && (
                          <span
                            data-testid={`ready-badge-${seat.id}`}
                            className={`vtt-badge uppercase ${
                              member.ready ? 'vtt-badge-success' : ''
                            }`}
                          >
                            {member.ready ? 'READY' : 'NOT READY'}
                          </span>
                        )}
                      </div>
                      <div
                        className={`text-[11px] font-mono mt-0.5 ${
                          seat.isOpen ? 'text-[var(--rp-parchment-300)]/60' : 'text-[var(--rp-parchment-300)]'
                        }`}
                      >
                        {seat.isOpen
                          ? 'Empty party slot — share the invite link to fill it'
                          : isGm
                            ? 'Dungeon Master'
                            : isSpectator
                              ? 'Read-only spectator'
                              : boundCharacter
                                ? `Playing: ${boundCharacter}`
                                : 'Party member'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {/* Character picker: ONLY the signed-in user's own sheets,
                        since the gateway 403s any foreign bind. */}
                    {isSelf && member && lobby && (
                      <select
                        aria-label="Choose your character for this table"
                        data-testid="character-select"
                        value={member.selected_character_id ?? ''}
                        onChange={(e) => void handleSelectCharacter(e.target.value)}
                        className="px-2 py-1 text-xs bg-black/40 border border-tavern-border rounded-lg font-mono max-w-[10rem]"
                      >
                        <option value="">Unassigned…</option>
                        {myCharacters.map((c) => (
                          <option key={c.character_id} value={c.character_id}>
                            {c.name} (Lv {c.level} {c.character_class})
                          </option>
                        ))}
                      </select>
                    )}
                    {/* Self-only readiness toggle: the gateway flips ONLY the
                        calling member's flag, so no toggle renders for other seats. */}
                    {isSelf && member && (
                      <button
                        onClick={() => void handleToggleReady()}
                        data-testid="ready-toggle"
                        title={member.ready ? 'Mark yourself not ready' : 'Ready up'}
                        className={`px-2 py-1 text-xs rounded-lg transition border ${
                          member.ready
                            ? 'border-emerald-500 bg-emerald-900/40 text-emerald-300'
                            : 'vtt-surface hover:bg-black/20 border-tavern-border'
                        }`}
                      >
                        {member.ready ? 'Ready ✓' : 'Ready up'}
                      </button>
                    )}
                    <span
                      className={`vtt-badge uppercase ${seat.isOpen ? '' : 'vtt-badge-success'}`}
                    >
                      {seat.isOpen ? 'open' : seat.role}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Honest launch refusal: a 409 MEMBERS_NOT_READY names exactly who
              is holding up the party, and the host alone gets a force override. */}
          {unreadyMembers !== null && unreadyMembers.length > 0 && (
            <div
              data-testid="unready-banner"
              role="alert"
              className="mt-4 p-4 rounded-xl border border-[var(--rp-crimson-400)]/60 bg-[color-mix(in_srgb,var(--rp-crimson-400)_12%,transparent)] space-y-2"
            >
              <div className="flex items-start gap-2 text-xs text-[var(--rp-parchment-100)]">
                <AlertTriangle className="w-4 h-4 text-[var(--rp-crimson-400)] shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold font-display">Cannot launch yet</p>
                  <p className="mt-0.5 font-prose">
                    Still waiting on: <strong>{unreadyNames}</strong>. Ask them to ready up before
                    starting the session.
                  </p>
                </div>
              </div>
              {amHost && (
                <button
                  onClick={() => void runLaunch(true)}
                  data-testid="force-launch"
                  className="vtt-btn vtt-btn-primary text-xs"
                  title="Launch anyway, skipping the readiness gate (host only)"
                >
                  <Zap className="w-4 h-4 fill-current" />
                  <span>Force Launch Anyway</span>
                </button>
              )}
            </div>
          )}
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
