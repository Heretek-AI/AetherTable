import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
// Eager: only what first paint needs — landing page (default route), navbar,
// and the Cmd+K palette. Everything else is code-split below.
import { Navbar, SaaSView } from './components/Navbar';
import { LandingPageView } from './components/LandingPageView';
import { CommandPalette } from './components/CommandPalette';

// Type-only imports: their modules are lazy-loaded below.
import type { Token } from './components/TacticalCanvas';
import type { ChatMessage } from './components/NarrativeChat';
import type { MapLayerType } from './components/MapLayerEditorModal';
import type { DigitalHandout } from './components/HandoutManagerModal';
import type { ParticleFXManager } from './render/particle_effects';
import type { DiceBox3D } from './render/dice_box_3d';

/**
 * Code splitting (perf): the app previously shipped every view + modal inside a
 * single ~1.9 MB chunk. Each component below is now split into its own chunk
 * that Vite fetches on demand — views when navigated to, modals when first
 * opened. Named exports need the `.then()` remap because React.lazy expects
 * `{ default }`.
 */
const TacticalCanvas = lazy(() => import('./components/TacticalCanvas').then((m) => ({ default: m.TacticalCanvas })));
const InitiativeTracker = lazy(() => import('./components/InitiativeTracker').then((m) => ({ default: m.InitiativeTracker })));
const CharacterSheet = lazy(() => import('./components/CharacterSheet').then((m) => ({ default: m.CharacterSheet })));
const NarrativeChat = lazy(() => import('./components/NarrativeChat').then((m) => ({ default: m.NarrativeChat })));
const SafetyModal = lazy(() => import('./components/SafetyModal').then((m) => ({ default: m.SafetyModal })));
const AudioMixerModal = lazy(() => import('./components/AudioMixerModal').then((m) => ({ default: m.AudioMixerModal })));
const CompendiumView = lazy(() => import('./components/CompendiumView').then((m) => ({ default: m.CompendiumView })));
const CharacterBuilderView = lazy(() => import('./components/CharacterBuilderView').then((m) => ({ default: m.CharacterBuilderView })));
const EncounterBuilderView = lazy(() => import('./components/EncounterBuilderView').then((m) => ({ default: m.EncounterBuilderView })));
const LobbyView = lazy(() => import('./components/LobbyView').then((m) => ({ default: m.LobbyView })));
const DynastyView = lazy(() => import('./components/DynastyView').then((m) => ({ default: m.DynastyView })));
const BundleManagerView = lazy(() => import('./components/BundleManagerView').then((m) => ({ default: m.BundleManagerView })));
const QuestDialogueView = lazy(() => import('./components/QuestDialogueView').then((m) => ({ default: m.QuestDialogueView })));
const WfcStudioView = lazy(() => import('./components/WfcStudioView').then((m) => ({ default: m.WfcStudioView })));
const AnalyticsView = lazy(() => import('./components/AnalyticsView').then((m) => ({ default: m.AnalyticsView })));
const MacroQuickbar = lazy(() => import('./components/MacroQuickbar').then((m) => ({ default: m.MacroQuickbar })));
const SpellbookModal = lazy(() => import('./components/SpellbookModal').then((m) => ({ default: m.SpellbookModal })));
const SubscriptionModal = lazy(() => import('./components/SubscriptionModal').then((m) => ({ default: m.SubscriptionModal })));
const AuthModal = lazy(() => import('./components/AuthModal').then((m) => ({ default: m.AuthModal })));
const UserSettingsModal = lazy(() => import('./components/UserSettingsModal').then((m) => ({ default: m.UserSettingsModal })));
const AdminDashboardView = lazy(() => import('./components/AdminDashboardView').then((m) => ({ default: m.AdminDashboardView })));
const MarketplaceView = lazy(() => import('./components/MarketplaceView').then((m) => ({ default: m.MarketplaceView })));
const SoundscapeJukeboxModal = lazy(() => import('./components/SoundscapeJukeboxModal').then((m) => ({ default: m.SoundscapeJukeboxModal })));
const MapLayerEditorModal = lazy(() => import('./components/MapLayerEditorModal').then((m) => ({ default: m.MapLayerEditorModal })));
const HandoutManagerModal = lazy(() => import('./components/HandoutManagerModal').then((m) => ({ default: m.HandoutManagerModal })));
const StreamerHUDModal = lazy(() => import('./components/StreamerHUDModal').then((m) => ({ default: m.StreamerHUDModal })));
const QuestJournalModal = lazy(() => import('./components/QuestJournalModal').then((m) => ({ default: m.QuestJournalModal })));
const VideoMeshTiles = lazy(() => import('./components/VideoMeshTiles').then((m) => ({ default: m.VideoMeshTiles })));
const BossHealthBar = lazy(() => import('./components/BossHealthBar').then((m) => ({ default: m.BossHealthBar })));
const CampaignSaveModal = lazy(() => import('./components/CampaignSaveModal').then((m) => ({ default: m.CampaignSaveModal })));
const ShortcutsModal = lazy(() => import('./components/ShortcutsModal').then((m) => ({ default: m.ShortcutsModal })));

/** Themed loading placeholder shown while a lazily-split view/modal chunk loads. */
const ChunkFallback = ({ label }: { label: string }) => (
  <div className="flex-1 flex items-center justify-center bg-tavern-bg" role="status" aria-live="polite">
    <div className="flex flex-col items-center gap-3 text-[var(--rp-parchment-300)]">
      <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
      <span className="text-sm tracking-wide">{label}</span>
    </div>
  </div>
);
import { User, DEMO_ACCOUNTS } from './types/auth';
import { globalSpatialAudio } from './render/spatial_audio';
import { globalWebRTCMesh } from './render/webrtc_mesh';
import { engineAttack, engineCheck, localD20, formulaModifier, ensureEngineSession } from './api/rules_engine';
import { VttCrdtSyncClient, TokenTransformData } from './sync/yjs_sync_client';
import { YjsCrdtClient, type RemoteCursor } from './sync/yjs_doc_client';
import type { CampaignSnapshot } from './api/campaign_store';
import { listSaves, loadCampaign } from './api/campaign_store';
import { computeLocalRewindPlan, parseEngineRewind } from './ui/safetyXCard';
import { DiceHistoryPanel, type RollLogEntry } from './components/DiceHistoryPanel';

// --- Roll history persistence ---------------------------------------------
const ROLL_HISTORY_KEY = 'vtt_roll_history_v1';
const ROLL_HISTORY_CAP = 50;

/**
 * Legacy inline whisper marker emitted by MacroQuickbar's "Whisper GM" toggle.
 * New whispered lines are tagged `channel: 'gm'` + `recipient` at creation
 * (see handleMacroRoll); this marker is still matched so pre-existing history
 * and any future caller that forgets to tag stays spectator-safe.
 */
const WHISPER_MARKER = '[WHISPER TO GM]';

export function App() {
  const [currentView, setCurrentView] = useState<SaaSView>('landing');
  const [campaignTitle, setCampaignTitle] = useState('The Fall of Baron Vane');
  const [currentUser, setCurrentUser] = useState<User>(DEMO_ACCOUNTS[0].user);
  const [isSafetyOpen, setIsSafetyOpen] = useState(false);
  const [isAudioMixerOpen, setIsAudioMixerOpen] = useState(false);
  const [isJukeboxOpen, setIsJukeboxOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isMapEditorOpen, setIsMapEditorOpen] = useState(false);
  const [isHandoutsOpen, setIsHandoutsOpen] = useState(false);
  const [isQuestJournalOpen, setIsQuestJournalOpen] = useState(false);
  const [isCampaignSavesOpen, setIsCampaignSavesOpen] = useState(false);
  const [isVideoMeshVisible, setIsVideoMeshVisible] = useState(true);
  const [isStreamerHUDOpen, setIsStreamerHUDOpen] = useState(false);
  const [activeMapLayer, setActiveMapLayer] = useState<MapLayerType>('tokens');
  const [isSpellbookOpen, setIsSpellbookOpen] = useState(false);
  const [isSubscriptionOpen, setIsSubscriptionOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [latencyMs, setLatencyMs] = useState(8);
  const [userRole, setUserRole] = useState<'gm' | 'player' | 'spectator'>('gm');
  const [activePing, setActivePing] = useState<{ x: number; y: number } | null>(null);
  const [activePeerTyping, setActivePeerTyping] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
        return;
      }

      // Never hijack keys while the user is typing in chat, search, forms, etc.
      const target = e.target as HTMLElement | null;
      const isTyping =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (isTyping) return;

      // `?` (Shift+/) — discoverable shortcut cheat-sheet.
      if (e.key === '?') {
        e.preventDefault();
        setIsShortcutsOpen((prev) => !prev);
        return;
      }

      // Escape closes the top-most open modal (first match wins = "top-most"
      // in the fixed stacking priority below).
      if (e.key === 'Escape') {
        const closeFns: Array<[boolean, () => void]> = [
          [isShortcutsOpen, () => setIsShortcutsOpen(false)],
          [isCommandPaletteOpen, () => setIsCommandPaletteOpen(false)],
          [isAuthOpen, () => setIsAuthOpen(false)],
          [isSafetyOpen, () => setIsSafetyOpen(false)],
          [isSpellbookOpen, () => setIsSpellbookOpen(false)],
          [isMapEditorOpen, () => setIsMapEditorOpen(false)],
          [isHandoutsOpen, () => setIsHandoutsOpen(false)],
          [isQuestJournalOpen, () => setIsQuestJournalOpen(false)],
          [isCampaignSavesOpen, () => setIsCampaignSavesOpen(false)],
          [isStreamerHUDOpen, () => setIsStreamerHUDOpen(false)],
          [isAudioMixerOpen, () => setIsAudioMixerOpen(false)],
          [isJukeboxOpen, () => setIsJukeboxOpen(false)],
          [isSubscriptionOpen, () => setIsSubscriptionOpen(false)],
          [isUserSettingsOpen, () => setIsUserSettingsOpen(false)],
        ];
        for (const [isOpen, close] of closeFns) {
          if (isOpen) {
            close();
            e.preventDefault();
            break;
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isShortcutsOpen,
    isCommandPaletteOpen,
    isAuthOpen,
    isSafetyOpen,
    isSpellbookOpen,
    isMapEditorOpen,
    isHandoutsOpen,
    isQuestJournalOpen,
    isCampaignSavesOpen,
    isStreamerHUDOpen,
    isAudioMixerOpen,
    isJukeboxOpen,
    isSubscriptionOpen,
    isUserSettingsOpen,
  ]);

  const handleBroadcastPing = () => {
    setActivePing({ x: 5, y: 3 });
    addSystemMessage(`📍 Tactical Beacon: Map ping broadcasted at [F4] by ${currentUser.displayName}`);
    setTimeout(() => setActivePing(null), 4000);
  };

  const [isLeftDockCollapsed, setIsLeftDockCollapsed] = useState(false);
  const [isRightDockCollapsed, setIsRightDockCollapsed] = useState(false);

  const particleFXRef = useRef<ParticleFXManager | null>(null);
  const diceBoxRef = useRef<DiceBox3D | null>(null);

  // Live CRDT sync. When a Yjs relay (VITE_YSYNC_WS_URL) is configured,
  // token + fog state merges causally through a real Y.Doc; otherwise we
  // fall back to the engine's LWW JSON relay (tokens only, solo-safe).
  const syncClientRef = useRef<VttCrdtSyncClient | null>(null);
  const yjsClientRef = useRef<YjsCrdtClient | null>(null);
  // State mirror of the ref so TacticalCanvas re-renders with fog/presence
  // once the Yjs client exists (refs alone don't trigger renders).
  const [yjsClient, setYjsClient] = useState<YjsCrdtClient | null>(null);
  // Real peer cursors from CRDT awareness. Starts empty and stays empty while
  // alone or on the legacy relay — no fabricated stand-in cursors.
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
  useEffect(() => {
    const env = (import.meta as any).env ?? {};
    const engineWsUrl = env.VITE_ENGINE_WS_URL || 'ws://localhost:8088';
    // Yjs is the DEFAULT transport; the legacy engine LWW relay is the
    // fallback when no CRDT relay is reachable.
    const ysyncUrl = (env.VITE_YSYNC_WS_URL as string | undefined) ?? 'ws://localhost:6380';
    let disposed = false;

    const startLegacyRelay = () => {
      if (disposed) return;
      syncClientRef.current?.disconnect();
      // The engine LWW relay carries no presence protocol: peer cursors are
      // honestly empty on this transport.
      setRemoteCursors([]);
      yjsClientRef.current = null;
      setYjsClient(null);
      const client = new VttCrdtSyncClient(engineWsUrl, 'aethertable-live');
      client.connect();
      syncClientRef.current = client;

      client.onRemoteTokenUpdate((update: TokenTransformData) => {
        setTokens((prev) =>
          prev.map((t) =>
            t.id === update.tokenId ? { ...t, x: update.x, y: update.y } : t
          )
        );
      });
    };

    const yjs = new YjsCrdtClient(ysyncUrl, 'aethertable-live');
    yjs.connect();
    yjsClientRef.current = yjs;
    setYjsClient(yjs);
    // Stamp the signed-in identity into awareness so peers see who this cursor is.
    yjs.setLocalUser({ user_id: currentUser.id, name: currentUser.displayName });
    syncClientRef.current = {
      connect: () => yjs.connect(),
      disconnect: () => yjs.destroy(),
      get isConnected() {
        return yjs.isConnected;
      },
      onRemoteTokenUpdate: yjs.onRemoteTokenUpdate.bind(yjs),
      updateTokenPosition: yjs.updateTokenPosition.bind(yjs),
    } as VttCrdtSyncClient;

    const unsubscribeYjs = yjs.onRemoteTokenUpdate((update: TokenTransformData) => {
      setTokens((prev) =>
        prev.map((t) => (t.id === update.tokenId ? { ...t, x: update.x, y: update.y } : t))
      );
    });

    // Peer cursors stream straight off awareness — empty list when solo.
    const unsubscribeCursors = yjs.onRemoteCursors(setRemoteCursors);

    // If the CRDT relay never connects, fall back to the engine relay.
    const fallbackTimer = setTimeout(() => {
      if (!disposed && !yjs.isConnected) {
        console.warn('[Sync] Yjs relay unreachable — falling back to engine LWW relay.');
        startLegacyRelay();
      }
    }, 3500);

    return () => {
      disposed = true;
      clearTimeout(fallbackTimer);
      unsubscribeYjs();
      unsubscribeCursors();
      setRemoteCursors([]);
      yjs.destroy();
      yjsClientRef.current = null;
      setYjsClient(null);
      syncClientRef.current = null;
    };
  }, []);

  // Keep awareness identity in step with the signed-in user (re-login / role swap).
  useEffect(() => {
    const yjs = yjsClientRef.current;
    if (!yjs) return;
    yjs.setLocalUser({ user_id: currentUser.id, name: currentUser.displayName });
  }, [currentUser]);

  // Publish our pointer to peers as the canvas reports hovered cells.
  // No-op on the legacy relay fallback, where yjsClientRef is cleared.
  const handleLocalCursorMove = useCallback((boardX: number, boardY: number) => {
    yjsClientRef.current?.updateLocalCursor(boardX, boardY);
  }, []);

  // Authoritative Tokens
  const [tokens, setTokens] = useState<Token[]>([
    {
      id: 'thorin_1',
      name: 'Thorin Oakenshield',
      x: 4,
      y: 4,
      hp: 42,
      maxHp: 42,
      ac: 18,
      color: '#3b82f6',
      isPlayer: true,
      avatarIconType: 'fighter',
    },
    {
      id: 'lyra_1',
      name: 'Lyra Moonshadow',
      x: 4,
      y: 5,
      hp: 28,
      maxHp: 28,
      ac: 15,
      color: '#8b5cf6',
      isPlayer: true,
      avatarIconType: 'caster',
      elevationFeet: 15,
    },
    {
      id: 'orc_warlord_1',
      name: 'Orc Warlord',
      x: 10,
      y: 4,
      hp: 58,
      maxHp: 58,
      ac: 16,
      color: '#dc2626',
      isPlayer: false,
      avatarIconType: 'boss',
    },
    {
      id: 'goblin_scout_1',
      name: 'Goblin Scout',
      x: 11,
      y: 6,
      hp: 12,
      maxHp: 12,
      ac: 14,
      color: '#f59e0b',
      isPlayer: false,
      avatarIconType: 'scout',
    },
  ]);

  const [customWalls, setCustomWalls] = useState<{ x: number; y: number }[]>([
    { x: 8, y: 2 }, { x: 8, y: 3 }, { x: 8, y: 4 }, { x: 8, y: 5 }, { x: 8, y: 6 },
    { x: 4, y: 8 }, { x: 5, y: 8 }, { x: 6, y: 8 },
  ]);

  const [selectedTokenId, setSelectedTokenId] = useState<string | null>('thorin_1');
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [roundNumber, setRoundNumber] = useState(1);
  const [spotlightWeights, setSpotlightWeights] = useState({ Thorin: 0.55, Lyra: 0.45 });
  const [isStreamingResponse, setIsStreamingResponse] = useState(false);

  // Chat & Narrative Messages
  // Dice roll history: a session-wide audit log of every resolved roll.
  // Restored from localStorage so a page refresh doesn't wipe the table's
  // history; capped at ROLL_HISTORY_CAP entries to bound memory.
  const [rollHistory, setRollHistory] = useState<RollLogEntry[]>(() => {
    try {
      const saved = localStorage.getItem(ROLL_HISTORY_KEY);
      return saved ? (JSON.parse(saved) as RollLogEntry[]) : [];
    } catch {
      return []; // storage unavailable / corrupted — start fresh
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(ROLL_HISTORY_KEY, JSON.stringify(rollHistory.slice(0, ROLL_HISTORY_CAP)));
    } catch {
      /* private-mode browsers may reject writes; history simply won't persist */
    }
  }, [rollHistory]);

  /** Prepend a resolved roll to the history (newest first). */
  const addRollEntry = useCallback((entry: Omit<RollLogEntry, 'id' | 'timestamp'>) => {
    setRollHistory((prev) =>
      [
        {
          ...entry,
          id: `roll_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
        ...prev,
      ].slice(0, ROLL_HISTORY_CAP)
    );
  }, []);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'msg_init_1',
      sender: 'Encounter DM (AI)',
      role: 'dm',
      content:
        'The ancient stone portcullis drops with a thunderous crash. The Orc Warlord steps forward, greatsword scraping across the crypt flags as torchlight flares in his eyes.',
      timestamp: '12:00 PM',
    },
    {
      id: 'msg_init_2',
      sender: 'Pre-Commit Auditor',
      role: 'system',
      content:
        'Session #1042 authoritative invariants active: [Entity Conservation: OK, Spatial LoS: OK, 3-Tier Lore: OK].',
      timestamp: '12:00 PM',
    },
  ]);

  // --- Pillar 9: spectator privacy filtering (data-flow layer) --------------
  // GOALS.md Pillar 9 requires streamer/spectator modes that never leak secret
  // DM notes, hidden tokens, or private channels. The filtering below happens
  // HERE, on the props handed to presentation components (TacticalCanvas,
  // InitiativeTracker, AudioMixerModal, NarrativeChat, …) — those components
  // stay role-agnostic and cannot accidentally render what they never receive.
  //
  // HONEST LIMITS — what CANNOT be guaranteed client-side (backend follow-ups):
  //  1. Hidden TOKENS: the engine entity schema carries `is_visible`
  //     (crates/vtt-core/src/state.rs), but no read path delivers session
  //     entities to a browser: the orchestrator /api/v1/engine/* proxies are
  //     write-only and the engine's GET /sessions/{id} requires HMAC auth.
  //     The local demo/snapshot tokens below never set isVisible today, so
  //     this filter removes nothing YET — it becomes load-bearing the moment
  //     a snapshot or CRDT payload carries the flag. A real deployment also
  //     needs PER-SEAT reveal (player A sees the token, player B doesn't);
  //     one shared filtered list can only express the spectator contract.
  //  2. Private CHAT: messages are local React state with no server fan-out.
  //     "Privacy" here means the sender tagged the line channel:'gm' /
  //     recipient-scoped at creation. The orchestrator must enforce the same
  //     exclusion server-side before relaying chat to spectator sockets;
  //     client-side filtering only protects what is rendered, not the wire.
  //  3. Handouts & quest-journal DM notes: both modals hold module-local demo
  //     data with `revealedTo: 'gm_only'`-style fields but NO per-role API.
  //     Gating their entry points below is UI policy, not a data guarantee —
  //     a backend handout/notes service must filter by seat before serving.
  //  4. Fog-of-war layers live in one shared Y.Doc without per-layer read
  //     ACLs; see TacticalCanvas.spectatorMode for the relay-side gap.
  const isSpectator = userRole === 'spectator';

  // GM-hidden tokens (`isVisible === false`, mirroring the engine's
  // `is_visible`) never reach any spectator-facing surface. Players still
  // receive them on purpose: per-player reveal is a GM choice that needs
  // per-seat delivery (backend gap #1 above).
  const visibleTokens = useMemo(
    () => (isSpectator ? tokens.filter((t) => t.isVisible !== false) : tokens),
    [tokens, isSpectator]
  );

  // A selection whose token becomes hidden mid-session must not keep feeding
  // the character sheet / audio-radar subject for a spectator.
  const spectatorSelectedId =
    isSpectator &&
    selectedTokenId !== null &&
    !visibleTokens.some((t) => t.id === selectedTokenId)
      ? null
      : selectedTokenId;

  const selectedToken =
    visibleTokens.find((t) => t.id === spectatorSelectedId) || visibleTokens[0];

  // Private-channel chat is excluded from what NarrativeChat receives. The
  // channel tab UI stays (NarrativeChat owns it) — it just renders nothing
  // private. Every private-tagging path in the app is covered:
  //   - channel === 'gm'  → GM whispers and whispered macro rolls
  //   - recipient present → any future direct-message tagging
  //   - WHISPER_MARKER    → legacy inline whisper text from old history
  const spectatorMessages = useMemo(
    () =>
      isSpectator
        ? messages.filter(
            (m) =>
              m.channel !== 'gm' && !m.recipient && !m.content.includes(WHISPER_MARKER)
          )
        : messages,
    [messages, isSpectator]
  );

  /** GM-only modal surfaces refuse to open for spectators (Pillar 9). */
  const guardGmSurface = useCallback(
    (surface: string, open: () => void) => () => {
      if (isSpectator) {
        addSystemMessage(`🚫 Spectator view: ${surface} is GM-only content.`);
        return;
      }
      open();
    },
    [isSpectator]
  );
  const addSystemMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `sys_${Date.now()}`,
        sender: 'System Auditor',
        role: 'system',
        content: text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleTokenMove = (tokenId: string, newX: number, newY: number) => {
    setTokens((prev) =>
      prev.map((t) => (t.id === tokenId ? { ...t, x: newX, y: newY } : t))
    );
    globalWebRTCMesh.updatePeerPosition(tokenId, newX, newY);
    // Broadcast the move through the engine's CRDT relay (no-op when offline).
    syncClientRef.current?.updateTokenPosition(tokenId, newX, newY, 0);
  };

  const handleNextTurn = () => {
    const nextIndex = (currentTurnIndex + 1) % tokens.length;
    if (nextIndex === 0) {
      setRoundNumber((r) => r + 1);
    }
    setCurrentTurnIndex(nextIndex);
    setSelectedTokenId(tokens[nextIndex].id);
    globalSpatialAudio.setListenerPosition(tokens[nextIndex].x, tokens[nextIndex].y);
    addSystemMessage(`Turn passed to ${tokens[nextIndex].name} (Round ${nextIndex === 0 ? roundNumber + 1 : roundNumber}).`);
  };

  // SSE Stream Narrative Reader
  const streamNarrativeResponse = async (
    userIntent: string,
    enginePayload: any,
    targetMsgId: string
  ) => {
    setIsStreamingResponse(true);
    try {
      const response = await fetch('/api/v1/orchestrator/narrative/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_intent: userIntent,
          engine_execution_payload: enginePayload,
        }),
      });

      if (!response.body) {
        throw new Error('ReadableStream not supported');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') break;
            try {
              const data = JSON.parse(dataStr);
              if (data.token) {
                accumulatedText += data.token;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === targetMsgId ? { ...m, content: accumulatedText } : m
                  )
                );
              }
            } catch (e) {
              // Non-json chunk
            }
          }
        }
      }
    } catch (e) {
      console.error('SSE Streaming error:', e);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === targetMsgId
            ? { ...m, content: 'The strike lands with authoritative impact.' }
            : m
        )
      );
    } finally {
      setIsStreamingResponse(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === targetMsgId ? { ...m, isStreaming: false } : m))
      );
    }
  };

  const handleExecuteAttack = async (actionName: string, damageFormula: string, damageType: string) => {
    const target = tokens.find((t) => !t.isPlayer && t.hp > 0) || tokens[2];

    // Authoritative resolution via the Rust rules engine; local dice fallback offline.
    const result = await engineAttack({
      attackerId: selectedToken?.id || 'thorin',
      targetId: target.id,
    });
    const isHit = result?.is_hit ?? true;
    const isCritical = result?.is_critical_hit ?? false;
    const naturalRoll = result?.natural_roll ?? localD20();
    const dmg = isHit ? result?.total_damage ?? Math.floor(Math.random() * 12) + 4 : 0;

    // Audit trail: every engine-resolved attack lands in the roll history panel.
    addRollEntry({
      kind: 'attack',
      label: `${selectedToken?.name || 'Hero'} → ${actionName}`,
      expression: `1d20+7 / ${damageFormula} ${damageType}`,
      natural: naturalRoll,
      total: dmg,
      outcome: isCritical ? 'crit' : isHit ? 'hit' : 'miss',
    });

    if (isHit && dmg > 0) {
      setTokens((prev) =>
        prev.map((t) =>
          t.id === target.id ? { ...t, hp: Math.max(0, t.hp - dmg) } : t
        )
      );
    }

    // 3D Positional Audio + Particle Shockwave + 3D Dice
    globalSpatialAudio.playSpatialImpact(target.x, target.y);
    if (particleFXRef.current) {
      particleFXRef.current.spawnMeleeImpact((target.x + 0.5) * 60, (target.y + 0.5) * 60);
    }
    if (diceBoxRef.current) {
      diceBoxRef.current.rollDice('d20', naturalRoll, (target.x + 0.5) * 60, (target.y + 0.5) * 60);
    }

    const dmMsgId = `dm_${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: selectedToken?.name || 'Thorin Oakenshield',
        role: 'player',
        content: `I swing with my ${actionName} (${damageFormula} ${damageType})!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        diceRollDetails: {
          total: naturalRoll + 7,
          expression: `1d20 + 7`,
          rolls: [naturalRoll],
        },
      },
      {
        id: dmMsgId,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: '...',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isStreaming: true,
      },
    ]);

    streamNarrativeResponse(
      `I attack ${target.name} with ${actionName}`,
      { action_name: actionName, is_hit: isHit, total_damage: dmg, is_critical: isCritical },
      dmMsgId
    );
  };

  const handleCastSpell = async (spellId: string, spellName: string, level: number) => {
    const target = tokens.find((t) => !t.isPlayer && t.hp > 0) || tokens[2];
    // Approximate spell damage as a scaling fireball-style burst resolved by the engine.
    const spellDamageExpression = `${Math.max(1, 2 * level - 1)}d6`;
    const result = await engineAttack({
      attackerId: selectedToken?.id || 'lyra',
      targetId: target.id,
    });
    const isHit = result?.is_hit ?? true;
    const naturalRoll = result?.natural_roll ?? localD20();
    const dmg = isHit ? result?.total_damage ?? Math.floor(Math.random() * 24) + 12 : 0;

    // Audit trail: spell attacks are logged with their upcast level for context.
    addRollEntry({
      kind: 'spell',
      label: `${spellName} (Lvl ${level})`,
      expression: `1d20+8 / ${spellDamageExpression}`,
      natural: naturalRoll,
      total: dmg,
      outcome: isHit ? 'hit' : 'miss',
    });

    if (isHit && dmg > 0) {
      setTokens((prev) =>
        prev.map((t) =>
          t.id === target.id ? { ...t, hp: Math.max(0, t.hp - dmg) } : t
        )
      );
    }

    // 3D Positional Audio + Spell Particle Shockwave + 3D Dice
    globalSpatialAudio.playSpatialSpell(target.x, target.y);
    if (particleFXRef.current) {
      particleFXRef.current.spawnFireballShockwave((target.x + 0.5) * 60, (target.y + 0.5) * 60, 220);
    }
    if (diceBoxRef.current) {
      diceBoxRef.current.rollDice('d20', naturalRoll, (target.x + 0.5) * 60, (target.y + 0.5) * 60);
    }

    const dmMsgId = `dm_${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: selectedToken?.name || 'Lyra Moonshadow',
        role: 'player',
        content: `I invoke the arcane weave and unleash ${spellName} (Level ${level})!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        diceRollDetails: {
          total: naturalRoll + 8,
          expression: `1d20 + 8`,
          rolls: [naturalRoll],
        },
      },
      {
        id: dmMsgId,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: '...',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isStreaming: true,
      },
    ]);

    streamNarrativeResponse(
      `I cast ${spellName} on ${target.name}`,
      { action_name: spellName, is_hit: isHit, total_damage: dmg },
      dmMsgId
    );
  };

  const handleRollCheck = async (skillName: string, modifier: number, dc: number) => {
    // Authoritative d20 resolution via the rules engine (local fallback offline).
    const result = await engineCheck({ modifier, dc });
    const roll = result?.roll ?? localD20();
    const total = result?.total ?? roll + modifier;
    const passed = result ? ['SUCCESS', 'CRITICAL_SUCCESS', 'SUCCESS_AT_A_COST'].includes(result.outcome) : total >= dc;

    // Audit trail: ability checks log natural d20 so crits/fumbles stand out.
    addRollEntry({
      kind: 'check',
      label: `${skillName} (DC ${dc})`,
      expression: `1d20 + ${modifier}`,
      natural: roll,
      total,
      outcome: roll === 20 ? 'crit' : roll === 1 ? 'fumble' : passed ? 'success' : 'failure',
    });

    if (selectedToken) {
      globalSpatialAudio.playSpatialDice(selectedToken.x, selectedToken.y);
    }

    if (diceBoxRef.current && selectedToken) {
      diceBoxRef.current.rollDice('d20', roll, (selectedToken.x + 0.5) * 60, (selectedToken.y + 0.5) * 60);
    }

    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: selectedToken?.name || 'Player',
        role: 'player',
        content: `Rolling ${skillName} check (DC ${dc})...`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        diceRollDetails: {
          total,
          expression: `1d20 + ${modifier}`,
          rolls: [roll],
        },
      },
      {
        id: `dm_${Date.now() + 1}`,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: passed
          ? `Success! You execute your ${skillName} attempt with remarkable finesse.`
          : `Failure. The conditions prove too hazardous for your ${skillName} maneuver.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleSendMessage = (text: string) => {
    const dmMsgId = `dm_${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: selectedToken?.name || 'Player',
        role: 'player',
        content: text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: dmMsgId,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: '...',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isStreaming: true,
      },
    ]);

    streamNarrativeResponse(
      text,
      { action_name: 'Custom Action', is_hit: true, total_damage: 10 },
      dmMsgId
    );
  };

  const getCampaignSnapshot = (): CampaignSnapshot => ({
    tokens,
    customWalls,
    messages,
    roundNumber,
    currentTurnIndex,
    spotlightWeights,
  });

  const applyCampaignSnapshot = (snapshot: CampaignSnapshot) => {
    setTokens(snapshot.tokens as Token[]);
    setCustomWalls(snapshot.customWalls || []);
    setMessages(snapshot.messages as ChatMessage[]);
    setRoundNumber(snapshot.roundNumber ?? 1);
    setCurrentTurnIndex(snapshot.currentTurnIndex ?? 0);
    setSpotlightWeights((snapshot.spotlightWeights ?? { Thorin: 0.55, Lyra: 0.45 }) as { Thorin: number; Lyra: number });
    addSystemMessage('Campaign state restored from database save.');
  };

  /**
   * X-card handler — server rewind + local scene convergence.
   *
   * Server side: POST /api/v1/safety/x-card records the intervention and
   * forwards it to the engine session, whose safety_rewind replays its ledger
   * back to target_sequence_id (restoring HP, positions, consciousness,
   * concentration) and returns a count-only RewindReport.
   *
   * Client side convergence — what is and is NOT possible with current flows:
   *  - Chat (reverted): local messages carry no engine sequence ids, but the
   *    table emits a real turn-boundary marker ("Turn passed to …") on every
   *    initiative pass. Everything after the latest such marker at trigger
   *    time is the turn being reverted, so those lines are dropped when the
   *    engine confirms it actually rewound events.
   *  - Tokens (NOT reverted — documented drift): the RewindReport carries only
   *    counts, not entity ids, and there is no read path back to the
   *    post-rewind engine session for the browser (orchestrator /api/v1/engine/*
   *    proxies are write-only; the engine's GET /sessions/{id} needs HMAC auth).
   *    Local token HP/positions can therefore still show pre-rewind values
   *    until a snapshot load (lobby hydration / Campaign Save modal) or CRDT
   *    position updates arrive. See client/src/ui/safetyXCard.ts.
   */
  const handleSafetyRewind = async (topic: string) => {
    // Snapshot the pre-trigger chat so the revert plan is anchored to the
    // exact moment before any safety messaging was appended.
    const rewindPlan = computeLocalRewindPlan(messages);
    addSystemMessage(`SAFETY CARD TRIGGERED: Topic '${topic}' flagged. Requesting authoritative scene rewind.`);
    // Apply the rewind against the authoritative engine ledger when online.
    const sessionId = await ensureEngineSession();
    fetch('/api/v1/safety/x-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_id: currentUser.id,
        topic,
        current_sequence_id: roundNumber * 10,
        engine_session_id: sessionId,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const rewind = parseEngineRewind(data);
        if (!rewind || rewind.status !== 'SAFETY_REWIND_SUCCESS') {
          addSystemMessage('Intervention recorded; engine ledger offline.');
          return;
        }
        const { reverted_event_count = 0, restored_entities = 0, removed_entities = 0 } = rewind.report;
        // Local chat revert: drop the lines played out during the reverted
        // turn. Only prune when the engine actually rewound something and we
        // have a turn boundary to anchor on; the filter runs inside the
        // functional update so chat typed while the request was in flight is
        // preserved.
        const shouldPrune = reverted_event_count > 0 && rewindPlan.droppedCount > 0;
        setMessages((prev) => [
          ...(shouldPrune ? prev.filter((m) => !rewindPlan.doomedIds.has(m.id)) : prev),
          {
            id: `sys_rewind_${Date.now()}`,
            sender: 'System Auditor',
            role: 'system',
            content:
              `Scene re-synced: engine reverted ${reverted_event_count} ledger event(s) ` +
              `(${restored_entities} entity state(s) restored, ${removed_entities} removed); ` +
              `${shouldPrune ? rewindPlan.droppedCount : 0} local chat line(s) dropped.` +
              // Documented drift: without entity ids in the report the client
              // cannot restore token HP/positions authoritatively here.
              (reverted_event_count > 0 && !shouldPrune
                ? ' Note: local token HP/positions may retain pre-rewind drift until the next authoritative snapshot.'
                : ''),
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      })
      .catch(() => addSystemMessage('Intervention recorded locally.'));
    setMessages((prev) => [
      ...prev,
      {
        id: `dm_${Date.now()}`,
        sender: 'Director Agent (Safety)',
        role: 'dm',
        content: `The scene shifts smoothly away from '${topic}'. Rewinding to the preceding stable event.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleSpawnFromCompendium = (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => {
    const newId = `token_spawned_${Date.now()}`;
    const newToken: Token = {
      ...tokenData,
      id: newId,
      x: 7,
      y: 5,
    };
    setTokens((prev) => [...prev, newToken]);
    setSelectedTokenId(newId);
    setCurrentView('tabletop');
    addSystemMessage(`Spawned ${newToken.name} to the battlefield at [H6].`);
  };

  const handleDeployFromBuilder = (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => {
    const newId = `hero_builder_${Date.now()}`;
    const newToken: Token = {
      ...tokenData,
      id: newId,
      x: 3,
      y: 4,
    };
    setTokens((prev) => [...prev, newToken]);
    setSelectedTokenId(newId);
    setCurrentView('tabletop');
    addSystemMessage(`Hero ${newToken.name} crafted in Character Studio and deployed to the battlefield!`);
  };

  const handleDeployFromBundleManager = (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => {
    const newId = `homebrew_${Date.now()}`;
    const newToken: Token = {
      ...tokenData,
      id: newId,
      x: 10,
      y: 7,
    };
    setTokens((prev) => [...prev, newToken]);
    setSelectedTokenId(newId);
    setCurrentView('tabletop');
    addSystemMessage(`Custom Homebrew Creature ${newToken.name} instantiated on the battlefield at [K8]!`);
  };

  const handleLaunchFromLobby = async (seatId: string) => {
    if (seatId === 'seat_gm') {
      setUserRole('gm');
      addSystemMessage('Joined session as Game Master (Omniscient view enabled).');
    } else if (seatId === 'seat_spectator') {
      setUserRole('spectator');
      addSystemMessage('Joined session as Spectator.');
    } else {
      setUserRole('player');
      addSystemMessage(`Joined session as Player (Bound to active seat).`);
    }

    // Lobby-to-canvas hydration: prefer the latest persisted campaign state;
    // fall back to the demo encounter ONLY when nothing is stored.
    try {
      const saves = await listSaves();
      if (saves.length > 0) {
        const snapshot = await loadCampaign(saves[0].save_id);
        if (snapshot) {
          applyCampaignSnapshot(snapshot);
          setCurrentView('tabletop');
          return;
        }
      }
      addSystemMessage('No stored campaign found — loading the staging encounter.');
    } catch {
      addSystemMessage('Campaign store unreachable — loading the staging encounter.');
    }
    setCurrentView('tabletop');
  };

  const handleInjectDynastyLore = (houseName: string, text: string) => {
    addSystemMessage(`DYNASTY LORE ASSERTED: ${text}`);
    setMessages((prev) => [
      ...prev,
      {
        id: `dm_${Date.now()}`,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: `The heralds proclaim the ancient standing of ${houseName}. The current political climate shifts as long-standing bloodline pacts take precedence.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleInjectQuest = (questTitle: string, initialObjective: string) => {
    setCampaignTitle(questTitle);
    addSystemMessage(`QUEST ACTIVATED: ${questTitle}`);
    setMessages((prev) => [
      ...prev,
      {
        id: `quest_${Date.now()}`,
        sender: 'Campaign Director (AI)',
        role: 'system',
        content: `⚔️ Quest Activated: "${questTitle}"\n\n${initialObjective}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
    globalSpatialAudio.playSpatialCreatureRoar(4, 4);
    setCurrentView('tabletop');
  };

  const handleUpdateTokenElevation = (tokenId: string, newElevation: number) => {
    setTokens((prev) =>
      prev.map((t) => (t.id === tokenId ? { ...t, elevationFeet: newElevation } : t))
    );
    addSystemMessage(`Token elevation updated to ${newElevation}ft.`);
  };

  const handleLaunchEncounter = (
    monsters: Omit<Token, 'id' | 'x' | 'y'>[],
    customPositions?: { x: number; y: number }[]
  ) => {
    const newTokens: Token[] = monsters.map((m, idx) => {
      const pos = customPositions && customPositions[idx] ? customPositions[idx] : { x: 8 + (idx % 4), y: 3 + Math.floor(idx / 4) * 2 };
      return {
        ...m,
        id: `encounter_mob_${Date.now()}_${idx}`,
        x: pos.x,
        y: pos.y,
      };
    });

    setTokens((prev) => [...prev.filter((t) => t.isPlayer), ...newTokens]);
    setSelectedTokenId(newTokens[0]?.id || null);
    setCurrentView('tabletop');
    addSystemMessage(`⚔️ ENCOUNTER LAUNCHED: ${newTokens.length} hostile entities deployed to the battlefield!`);
    globalSpatialAudio.playSpatialCreatureRoar(8, 4);
  };

  const handleApplyWfcMap = (matrix: number[][], width: number, height: number) => {
    const newWalls: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (matrix[y][x] === 1) {
          newWalls.push({ x, y });
        }
      }
    }
    setCustomWalls(newWalls);
    setCurrentView('tabletop');
    addSystemMessage(`Applied procedural WFC dungeon layout (${width}x${height} tiles) to active session.`);
  };

  const handleMacroRoll = async (
    macroName: string,
    formula: string,
    isWhisper: boolean,
    advDis: 'normal' | 'advantage' | 'disadvantage'
  ) => {
    // Resolve the macro's d20 through the engine, honoring advantage state.
    const result = await engineCheck({
      modifier: formulaModifier(formula),
      dc: 10,
      advantage: advDis === 'advantage',
      disadvantage: advDis === 'disadvantage',
    });
    const d20Roll = result?.roll ?? localD20();
    const macroTotal = result?.total ?? d20Roll + formulaModifier(formula);

    // Audit trail: quickbar macros resolve through the engine like any other roll.
    addRollEntry({
      kind: 'macro',
      label: macroName,
      expression: formula,
      natural: d20Roll,
      total: macroTotal,
      outcome: d20Roll === 20 ? 'crit' : d20Roll === 1 ? 'fumble' : undefined,
    });

    if (diceBoxRef.current) {
      diceBoxRef.current.rollDice('d20', d20Roll, 400, 300);
    }
    if (particleFXRef.current) {
      particleFXRef.current.spawnGoldCritBurst(400, 300, 30);
    }

    const dmMsgId = `dm_${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        id: `macro_${Date.now()}`,
        sender: selectedToken?.name || 'Thorin',
        role: 'player',
        content: `🎲 ${isWhisper ? `${WHISPER_MARKER} ` : ''}Triggered Macro: ${macroName} (${formula}) [${advDis.toUpperCase()}] -> Result: ${macroTotal}`,
        // A whispered roll result is private to the GM: tag it so the GM
        // channel tab picks it up AND spectator filtering excludes it
        // (Pillar 9). Previously the whisper was display-only and leaked to
        // every seat via the "All Table" tab.
        channel: isWhisper ? 'gm' : undefined,
        recipient: isWhisper ? 'Game Master' : undefined,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: dmMsgId,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: '...',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isStreaming: true,
      },
    ]);

    streamNarrativeResponse(
      `I execute ${macroName} with result ${macroTotal}`,
      { action_name: macroName, is_hit: true, total_damage: macroTotal },
      dmMsgId
    );
  };

  const handleCastSpellWithUpcast = (
    spellName: string,
    baseLevel: number,
    castLevel: number,
    damageFormula: string
  ) => {
    handleCastSpell(
      `spell_${spellName.toLowerCase().replace(/ /g, '_')}`,
      `${spellName} (Upcast Lvl ${castLevel})`,
      castLevel
    );
  };

  return (
    <div className="vtt-scrollbar flex flex-col h-screen w-screen bg-tavern-bg text-[var(--rp-parchment-100)] font-sans overflow-hidden">
      {/* Top Universal Navbar */}
      <Navbar
        currentView={currentView}
        onSelectView={setCurrentView}
        onOpenSafety={() => setIsSafetyOpen(true)}
        onOpenAudioMixer={() => setIsAudioMixerOpen(true)}
        onOpenJukebox={() => setIsJukeboxOpen(true)}
                onOpenCampaignSaves={() => setIsCampaignSavesOpen(true)}
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        onOpenMapEditor={guardGmSurface('the Map & Hidden-Info Layer editor', () => setIsMapEditorOpen(true))}
        onOpenHandouts={guardGmSurface('the Handouts Vault', () => setIsHandoutsOpen(true))}
        onOpenQuestJournal={guardGmSurface('the Quest Journal DM notes', () => setIsQuestJournalOpen(true))}
        onToggleVideoMesh={() => setIsVideoMeshVisible(!isVideoMeshVisible)}
        onOpenStreamerHUD={() => setIsStreamerHUDOpen(true)}
        onOpenSubscription={() => setIsSubscriptionOpen(true)}
        onOpenUserSettings={() => setIsUserSettingsOpen(true)}
        onOpenAuth={() => setIsAuthOpen(true)}
        onFastSwitchUser={setCurrentUser}
        currentUser={currentUser}
        latencyMs={latencyMs}
        campaignName={campaignTitle}
      />

      {/* View Content — Suspense boundary so lazily-split views show a themed
          loader instead of blanking the navbar while their chunk arrives. */}
      <Suspense fallback={<ChunkFallback label="Preparing your table…" />}>
      <div className="flex-1 flex overflow-hidden relative min-h-0">
        {currentView === 'landing' && (
          <LandingPageView
            onEnterApp={(target) => setCurrentView((target as SaaSView) || 'tabletop')}
            onOpenPricing={() => setIsSubscriptionOpen(true)}
            onOpenAuth={(tab) => setIsAuthOpen(true)}
          />
        )}

        {currentView === 'tabletop' && (
          <div className="flex-1 flex flex-col h-full overflow-hidden min-h-0 relative">
            {/* Top Epic Boss Health Bar — derived from the spectator-filtered
                list so a hidden boss never broadcasts its HP on stream. */}
            {visibleTokens.find((t) => !t.isPlayer && t.maxHp >= 50) && (
              <BossHealthBar
                bossToken={visibleTokens.find((t) => !t.isPlayer && t.maxHp >= 50) || null}
                activeTurnName={visibleTokens[currentTurnIndex]?.name || 'Active Turn'}
              />
            )}

            {/* Floating WebRTC Video Mesh Tiles */}
            <VideoMeshTiles
              isVisible={isVideoMeshVisible}
              onToggleVisible={() => setIsVideoMeshVisible(false)}
            />

            {/* Tabletop Center Workspace */}
            <div className="flex-1 flex overflow-hidden relative min-h-0">
              {/* Left Dock: Initiative Tracker — receives the same
                  spectator-filtered list as the canvas so hidden entities are
                  absent from turn order too (not merely invisible on map). */}
              <InitiativeTracker
                tokens={visibleTokens}
                currentTurnIndex={currentTurnIndex}
                onNextTurn={handleNextTurn}
                onSelectToken={(id) => setSelectedTokenId(id)}
                selectedTokenId={selectedTokenId}
                roundNumber={roundNumber}
                isCollapsed={isLeftDockCollapsed}
                onToggleCollapse={() => setIsLeftDockCollapsed(!isLeftDockCollapsed)}
              />

              {/* Center Tactical Canvas */}
              <main className="flex-1 h-full relative min-h-0 overflow-hidden">
                <TacticalCanvas
                  tokens={visibleTokens}
                  onTokenMove={handleTokenMove}
                  selectedTokenId={spectatorSelectedId}
                  onSelectToken={(id) => setSelectedTokenId(id)}
                  onUpdateTokenElevation={handleUpdateTokenElevation}
                  currentUser={currentUser}
                  remoteCursors={remoteCursors}
                  onLocalCursorMove={handleLocalCursorMove}
                  syncClient={yjsClient}
                  activePing={activePing}
                  walls={customWalls}
                  particleFXRef={particleFXRef}
                  diceBoxRef={diceBoxRef}
                  spectatorMode={isSpectator}
                />

                {/* Session dice audit log — floats over the map's free corner */}
                <DiceHistoryPanel
                  entries={rollHistory}
                  onClear={() => setRollHistory([])}
                />
              </main>

              {/* Right Dock: Character Sheet */}
              <CharacterSheet
                activeToken={selectedToken}
                onExecuteAttack={handleExecuteAttack}
                onCastSpell={handleCastSpell}
                onRollCheck={handleRollCheck}
                onOpenGrimoire={() => setIsSpellbookOpen(true)}
                isCollapsed={isRightDockCollapsed}
                onToggleCollapse={() => setIsRightDockCollapsed(!isRightDockCollapsed)}
              />
            </div>

            {/* In-Canvas Roll20 Style Macro Quickbar */}
            <MacroQuickbar onExecuteRoll={handleMacroRoll} />

            {/* Bottom Floating Console — receives the private-channel-filtered
                stream; channel tabs remain but render nothing secret. */}
            <NarrativeChat
              messages={spectatorMessages}
              onSendMessage={handleSendMessage}
              spotlightWeights={spotlightWeights}
              isStreamingResponse={isStreamingResponse}
              activePeerTyping={activePeerTyping}
              onBroadcastPing={handleBroadcastPing}
            />
          </div>
        )}

        {currentView === 'compendium' && (
          <CompendiumView onSpawnToken={handleSpawnFromCompendium} />
        )}

        {currentView === 'builder' && (
          <CharacterBuilderView onDeployCharacter={handleDeployFromBuilder} />
        )}

        {currentView === 'encounters' && (
          <EncounterBuilderView onLaunchEncounter={handleLaunchEncounter} />
        )}

        {currentView === 'marketplace' && (
          <MarketplaceView onInstallBundle={(id) => addSystemMessage(`📦 Installed campaign bundle ${id}`)} />
        )}

        {currentView === 'lobby' && (
          <LobbyView onLaunchCampaign={handleLaunchFromLobby} currentUser={currentUser} />
        )}

        {currentView === 'dynasty' && (
          <DynastyView onInjectLoreToCampaign={handleInjectDynastyLore} />
        )}

        {currentView === 'bundles' && (
          <BundleManagerView
            tokens={visibleTokens}
            walls={customWalls}
            onDeployToken={handleDeployFromBundleManager}
          />
        )}

        {currentView === 'quests' && (
          <QuestDialogueView onInjectQuest={handleInjectQuest} />
        )}

        {currentView === 'wfc' && (
          <WfcStudioView onApplyMapToSession={handleApplyWfcMap} />
        )}

        {currentView === 'analytics' && (
          <AnalyticsView />
        )}

        {currentView === 'admin' && (
          <AdminDashboardView />
        )}
      </div>
      </Suspense>

      {/* On-demand modals — each lives in its own lazily-fetched chunk and only
          mounts (and downloads) when first opened. fallback={null} keeps the
          page stable while a modal chunk loads. */}
      <Suspense fallback={null}>
      {/* Tactical Jukebox & Ambient Soundscapes Modal */}
      <SoundscapeJukeboxModal
        isOpen={isJukeboxOpen}
        onClose={() => setIsJukeboxOpen(false)}
      />

      {/* Universal Command Palette (Cmd+K) */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        onNavigate={(view) => setCurrentView(view)}
        onExecuteRoll={(expr) => handleMacroRoll('Quick Roll', expr, false, 'normal')}
        onOpenShortcuts={() => setIsShortcutsOpen(true)}
      />

      {/* Map & LoS Layer Editor Modal */}
      <MapLayerEditorModal
        isOpen={isMapEditorOpen}
        onClose={() => setIsMapEditorOpen(false)}
        walls={customWalls}
        onUpdateWalls={setCustomWalls}
        activeLayer={activeMapLayer}
        onSelectLayer={setActiveMapLayer}
      />

      {/* Digital Handouts Vault Modal */}
      <HandoutManagerModal
        isOpen={isHandoutsOpen}
        onClose={() => setIsHandoutsOpen(false)}
        onBroadcastHandout={(handout) => {
          addSystemMessage(`📜 Handout Shared: "${handout.title}" revealed to ${String(handout.revealedTo).toUpperCase()}`);
        }}
      />

      {/* Campaign Notes & Interactive Quest Journal Modal */}
      <QuestJournalModal
        isOpen={isQuestJournalOpen}
        onClose={() => setIsQuestJournalOpen(false)}
        onShareToChat={(text) => addSystemMessage(text)}
      />

      {/* Campaign Save / Load Modal (Postgres-backed) */}
      <CampaignSaveModal
        isOpen={isCampaignSavesOpen}
        onClose={() => setIsCampaignSavesOpen(false)}
        getSnapshot={getCampaignSnapshot}
        onLoadSnapshot={applyCampaignSnapshot}
      />

      {/* Streamer Broadcast HUD Modal — userRole is passed (not duplicated)
          so the modal REPORTS the live privacy posture instead of keeping its
          own copy of the filter state. */}
      <StreamerHUDModal
        isOpen={isStreamerHUDOpen}
        onClose={() => setIsStreamerHUDOpen(false)}
        userRole={userRole}
        onToggleCinematicMode={(enabled) => {
          setIsLeftDockCollapsed(enabled);
          setIsRightDockCollapsed(enabled);
          addSystemMessage(enabled ? '🎥 Cinematic Streamer Mode Enabled (Clean OBS capture)' : '🎥 Cinematic Mode Disabled');
        }}
      />

      {/* 3D Spatial Audio & Radar Modal — filtered list: a hidden token must
          not be selectable as a listening subject for spectators. */}
      <AudioMixerModal
        isOpen={isAudioMixerOpen}
        onClose={() => setIsAudioMixerOpen(false)}
        tokens={visibleTokens}
        selectedTokenId={spectatorSelectedId}
      />

      {/* Hardware Safety X-Card Modal */}
      <SafetyModal
        isOpen={isSafetyOpen}
        onClose={() => setIsSafetyOpen(false)}
        onTriggerRewind={handleSafetyRewind}
      />

      {/* D&D Beyond Digital Grimoire & Upcasting Modal */}
      <SpellbookModal
        isOpen={isSpellbookOpen}
        onClose={() => setIsSpellbookOpen(false)}
        onCastSpellWithUpcast={handleCastSpellWithUpcast}
      />

      {/* SaaS Subscription & Account Profile Modal */}
      <SubscriptionModal
        isOpen={isSubscriptionOpen}
        onClose={() => setIsSubscriptionOpen(false)}
      />

      {/* Multi-User Identity Auth Modal */}
      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
        onLoginSuccess={(user) => {
          setCurrentUser(user);
          addSystemMessage(`👤 Authenticated as ${user.displayName} (${user.role.toUpperCase()})`);
        }}
      />

      {/* User Settings & Preferences Modal */}
      <UserSettingsModal
        isOpen={isUserSettingsOpen}
        onClose={() => setIsUserSettingsOpen(false)}
        currentUser={currentUser}
        onUpdateUser={setCurrentUser}
      />

      {/* Keyboard Shortcut Cheat-Sheet (`?` or via command palette) */}
      <ShortcutsModal
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
      />
      </Suspense>
    </div>
  );
}

export default App;
