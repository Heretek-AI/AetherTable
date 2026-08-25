import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
// Eager: only what first paint needs — landing page (default route), navbar,
// and the Cmd+K palette. Everything else is code-split below.
import { Navbar, SaaSView } from './components/Navbar';
import { AlertCircle } from 'lucide-react';
import {
  applyAtmosphereToDocument,
  loadStoredAtmosphereId,
  storeAtmosphereId,
} from './theme/atmospheres';
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
const CampaignWizardModal = lazy(() => import('./components/CampaignWizardModal').then((m) => ({ default: m.CampaignWizardModal })));

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
import { engineAttack, engineCheck, formulaModifier, ensureEngineSession } from './api/rules_engine';
import { logOutcomeForTier, shapeCheckOutcome } from './api/check_outcome';
import { authHeaders, getStoredToken } from './api/auth_headers';
import { openNarrativeStream } from './api/narrative_stream';
import { VttCrdtSyncClient, TokenTransformData } from './sync/yjs_sync_client';
import { YjsCrdtClient, type RemoteCursor } from './sync/yjs_doc_client';
import {
  computeSpotlightWeights,
  LocalSpeechLedger,
  type SpotlightView,
} from './sync/speech_ledger';
import type { CampaignSnapshot } from './api/campaign_store';
import type { Lobby } from './api/lobby_store';
import type { CampaignWizardConfig } from './components/CampaignWizardModal';
import { listSaves, loadCampaign } from './api/campaign_store';
import {
  computeLocalRewindPlan,
  computeTokenReconciliation,
  parseEngineRewind,
  parseRewoundSnapshot,
} from './ui/safetyXCard';
import { fetchSessionState, triggerXCard } from './api/safety_xcard';
import { canMoveTokensOnTransport, type BoundTransport } from './sync/transport_gate';
import {
  REPROBE_INTERVAL_MS,
  shouldAttemptReprobe,
} from './sync/transport_reprobe';
import { DiceHistoryPanel, type RollLogEntry } from './components/DiceHistoryPanel';
import type { CombatantEntry } from './components/InitiativeTracker';

/**
 * Authoritative engine combat state, mirrored from GET /api/v1/engine/session-state
 * (`combat` field of the engine's GameSession snapshot). `order` holds REAL
 * rolled initiative entries [{entity_id, name, dexterity, initiative_total}];
 * it stays empty until a GM actually begins combat on the engine.
 */
interface EngineCombatSnapshot {
  in_combat: boolean;
  round: number;
  turn_index: number;
  order: CombatantEntry[];
}

const IDLE_COMBAT_SNAPSHOT: EngineCombatSnapshot = {
  in_combat: false,
  round: 0,
  turn_index: 0,
  order: [],
};

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

/**
 * Pillar 9 spatial fallback: a user with no identifiable board token (GM with
 * wildcard assignment, spectators, unregistered peers) anchors the listener —
 * or an unmapped peer's voice pin — at this board center coordinate.
 */
const BOARD_CENTER_FALLBACK = { x: 4, y: 4 };

/** Mirrors webrtc_mesh sanitizeId so mesh userIds compare equal to auth ids. */
const normalizeUserIdForBinding = (raw: string): string =>
  raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);

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
  // Guided New Campaign wizard (GOALS.md Pillar 2) — completes only after a
  // real lobby comes back from POST /api/v1/lobbies.
  const [isCampaignWizardOpen, setIsCampaignWizardOpen] = useState(false);
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
  // Dynamic Thematic Atmosphere (GOALS.md Pillar 2). DUAL-source truth:
  // seeded from this browser's localStorage, then adopted live from the shared
  // Yjs `atmosphere` map whenever the room carries a selection (see
  // sync/yjs_doc_client.ts). The local copy still persists to localStorage so
  // the palette survives offline / no-relay runs honestly.
  const [atmosphereId, setAtmosphereId] = useState<string>(() => loadStoredAtmosphereId());

  useEffect(() => {
    applyAtmosphereToDocument(atmosphereId);
    storeAtmosphereId(atmosphereId);
    return () => applyAtmosphereToDocument('default');
  }, [atmosphereId]);

  /**
   * Write-through selection used by the GM-gated Navbar picker and the New
   * Campaign wizard: applies locally right away AND publishes to the CRDT room
   * so peers converge within one relay tick (writes are queued in the Y.Doc and
   * flushed on connect if the socket isn't up yet). Policy stays client-side:
   * only this handler's callers — all GM-gated UI — ever publish.
   */
  const handleSelectAtmosphere = useCallback(
    (id: string) => {
      setAtmosphereId(id);
      yjsClientRef.current?.setAtmosphereId(id, currentUser.id);
    },
    [currentUser.id]
  );
  // (The live room→state follow subscription lives just below the yjsClient
  // state declaration — see "adopt the room's atmosphere".)
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
          [isCampaignWizardOpen, () => setIsCampaignWizardOpen(false)],
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
    isCampaignWizardOpen,
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

  // Adopt the room's atmosphere: subscribe to the shared Yjs `atmosphere` map
  // for as long as the CRDT transport exists. The subscription fires
  // immediately with any existing entry (load-from-room path; falls back to the
  // localStorage seed in `atmosphereId` above when the room has none yet), then
  // on every remote change — including the IndexedDB restore that can land
  // after mount. Our own writes echo back too; an identical id bails out of
  // re-rendering, so there is no feedback loop.
  useEffect(() => {
    if (!yjsClient) return undefined;
    return yjsClient.observeAtmosphereId((selection) => {
      setAtmosphereId((prev) => (prev === selection.id ? prev : selection.id));
    });
  }, [yjsClient]);

  // Real peer cursors from CRDT awareness. Starts empty and stays empty while
  // alone or on the legacy relay — no fabricated stand-in cursors.
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
  // Transport the active syncClientRef is bound to. `null` while the Yjs
  // bootstrap is still racing the 3.5s fallback timer. Drives the
  // canMoveTokensOnTransport gate (see sync/transport_gate.ts).
  const [transportKind, setTransportKind] = useState<BoundTransport>(null);
  useEffect(() => {
    const engineWsUrl = import.meta.env.VITE_ENGINE_WS_URL || 'ws://localhost:8088';
    // Yjs is the DEFAULT transport; the legacy engine LWW relay is the
    // fallback when no CRDT relay is reachable.
    const ysyncUrl = import.meta.env.VITE_YSYNC_WS_URL ?? 'ws://localhost:6380';
    let disposed = false;
    /** The live Yjs client while THIS effect has bound it; null on fallback. */
    let activeYjs: YjsCrdtClient | null = null;
    let unsubscribeYjs: (() => void) | null = null;
    let unsubscribeCursors: (() => void) | null = null;
    /** Set once a successful re-probe has migrated us back onto Yjs. */
    let reprobedToYjs = false;

    const startLegacyRelay = () => {
      if (disposed) return;
      // Tear down the Yjs side first so its subscriptions stop firing into
      // token state behind the legacy relay's back.
      unsubscribeYjs?.();
      unsubscribeCursors?.();
      unsubscribeYjs = null;
      unsubscribeCursors = null;
      activeYjs?.destroy();
      activeYjs = null;
      yjsClientRef.current = null;
      setYjsClient(null);
      // The engine LWW relay carries no presence protocol: peer cursors are
      // honestly empty on this transport.
      setRemoteCursors([]);
      setTransportKind('LEGACY_LWW');
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

    /**
     * Bind the CRDT relay as the active transport. Used both at mount and by
     * the periodic re-probe below, so an upgraded session goes through exactly
     * the same wiring as a fresh one — fog layers, remote cursors, atmosphere
     * and the speech ledger are all re-adopted through the existing observe*
     * subscriptions (each fires immediately with current Y.Doc state), never
     * copied by hand.
     */
    const startYjsRelay = () => {
      const yjs = new YjsCrdtClient(ysyncUrl, 'aethertable-live');
      yjs.connect();
      activeYjs = yjs;
      yjsClientRef.current = yjs;
      setYjsClient(yjs);
      setTransportKind('YJS');
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

      unsubscribeYjs = yjs.onRemoteTokenUpdate((update: TokenTransformData) => {
        setTokens((prev) =>
          prev.map((t) => (t.id === update.tokenId ? { ...t, x: update.x, y: update.y } : t))
        );
      });

      // Peer cursors stream straight off awareness — empty list when solo.
      unsubscribeCursors = yjs.onRemoteCursors(setRemoteCursors);
    };

    startYjsRelay();

    // If the CRDT relay never connects, fall back to the engine relay.
    const fallbackTimer = setTimeout(() => {
      if (!disposed && !activeYjs?.isConnected) {
        console.warn('[Sync] Yjs relay unreachable — falling back to engine LWW relay.');
        startLegacyRelay();
      }
    }, 3500);

    // Periodic re-probe (iteration-19): the 3.5s fallback above used to be a
    // ONE-WAY downgrade — a relay that was down during app mount kept every
    // client on LWW until a manual reload. While we sit on the fallback, retry
    // the CRDT relay every REPROBE_INTERVAL_MS; when an attempt actually
    // connects, migrate back through the same startYjsRelay path used at
    // mount. Fog / cursors / atmosphere / speech hand off via each observer's
    // immediate-fire snapshot (see yjs_doc_client.ts conventions), so nothing
    // is duplicated or lost in transit. A probe that fails just leaves the
    // legacy relay running — no state churn.
    const reprobeTimer = setInterval(() => {
      if (
        reprobedToYjs ||
        disposed ||
        !shouldAttemptReprobe({
          transportKind: 'LEGACY_LWW',
          hasYsyncUrl: Boolean(ysyncUrl),
          stopped: disposed,
        })
      ) {
        return;
      }
      const probe = new YjsCrdtClient(ysyncUrl, 'aethertable-live');
      probe.connect();
      // Same settle window as the mount-time fallback race: enough for a TCP +
      // y-websocket handshake, not so long that a healthy relay waits long.
      setTimeout(() => {
        const reachable = probe.isConnected;
        probe.destroy();
        if (disposed || reprobedToYjs || !reachable) return;
        if (activeYjs?.isConnected) return; // already back on CRDT somehow
        reprobedToYjs = true;
        console.info('[Sync] Yjs relay reachable again — migrating off the LWW fallback.');
        addSystemMessage(
          'CRDT sync restored: the table migrated from the legacy relay back to the live Yjs room.'
        );
        startYjsRelay();
      }, 3500);
    }, REPROBE_INTERVAL_MS);

    return () => {
      disposed = true;
      clearTimeout(fallbackTimer);
      clearInterval(reprobeTimer);
      unsubscribeYjs?.();
      unsubscribeCursors?.();
      setRemoteCursors([]);
      activeYjs?.destroy();
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

  // Adopt converged spotlight weights from the CRDT speech ledger for as long
  // as the Yjs transport exists. The subscription fires immediately with any
  // existing ledger (late joiner / IndexedDB restore), then on every local or
  // remote VAD publication — all clients recompute from the same merged data,
  // so everyone sees the same balance.
  useEffect(() => {
    if (!yjsClient) return undefined;
    return yjsClient.observeSpotlight(setSpotlightView);
  }, [yjsClient]);

  // --- Pillar-11: local mic → speech ledger ---------------------------------
  // This browser's own VAD bursts accumulate here; NarrativeChat forwards the
  // raw Silero callbacks (its mic button is the only capture entry point).
  const localSpeechLedgerRef = useRef<LocalSpeechLedger>(new LocalSpeechLedger());

  /**
   * Feed one closed VAD burst into the ledger and publish it to the room.
   * On the Yjs transport this lands under our `user:<id>` key so every peer's
   * weights converge on real talking time. Without that transport there is NO
   * cross-client channel, so we recompute a LOCAL-ONLY view instead of
   * pretending the numbers synced — labeled `local-only` in the UI.
   */
  const handleLocalSpeechSegment = useCallback(
    (_audio: Float32Array) => {
      const now = Date.now();
      const ledger = localSpeechLedgerRef.current;
      if (!ledger.noteSpeechEnd(now)) return;

      const yjs = yjsClientRef.current;
      // Only claim room scope when the CRDT relay is ACTUALLY carrying writes;
      // signed-out sockets are rejected by the relay, so that is local-only.
      if (yjs && yjs.isConnected) {
        yjs.publishSpeech(currentUser.id, currentUser.displayName, ledger.snapshot(now));
        setSpotlightView(yjs.getSpotlightView(now));
        return;
      }
      // Legacy LWW fallback / signed-out: honest local-only accumulation.
      setSpotlightView({
        scope: 'local-only',
        shares: computeSpotlightWeights(
          [{ user_id: currentUser.id, name: currentUser.displayName, segments: ledger.snapshot(now) }],
          { nowMs: now },
        ),
      });
    },
    [currentUser.id, currentUser.displayName],
  );

  /** Open-burst live tail, throttled by the Yjs client (2s) for publication. */
  const publishLiveSpeechTail = useCallback(() => {
    const yjs = yjsClientRef.current;
    if (!yjs || !yjs.isConnected || !currentUser.id) return;
    yjs.scheduleLiveSpeechPublish(
      currentUser.id,
      currentUser.displayName,
      () => localSpeechLedgerRef.current.snapshot(Date.now()),
    );
  }, [currentUser.id, currentUser.displayName]);

  /** VAD said speech started: mark it open and begin throttled tail publishes. */
  const handleLocalSpeechStart = useCallback(() => {
    localSpeechLedgerRef.current.noteSpeechStart(Date.now());
    publishLiveSpeechTail();
  }, [publishLiveSpeechTail]);

  /** Mic released: drop any burst that never saw onSpeechEnd, then republish. */
  const handleLocalCaptureStop = useCallback(() => {
    localSpeechLedgerRef.current.cancelOpenBurst();
    const now = Date.now();
    const yjs = yjsClientRef.current;
    if (yjs && yjs.isConnected) {
      yjs.publishSpeech(currentUser.id, currentUser.displayName, localSpeechLedgerRef.current.snapshot(now));
      setSpotlightView(yjs.getSpotlightView(now));
      return;
    }
    setSpotlightView({
      scope: 'local-only',
      shares: computeSpotlightWeights(
        [{ user_id: currentUser.id, name: currentUser.displayName, segments: localSpeechLedgerRef.current.snapshot(now) }],
        { nowMs: now },
      ),
    });
  }, [currentUser.id, currentUser.displayName]);

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
  // Authoritative combat lifecycle (engine-owned). Starts idle — no
  // fabricated combatants until a GM rolls initiative for real.
  const [combat, setCombat] = useState<EngineCombatSnapshot>(IDLE_COMBAT_SNAPSHOT);
  const [isCombatBusy, setIsCombatBusy] = useState(false);
  // RAW body of the most recent engine turn-advance response. Handed to
  // InitiativeTracker verbatim; it parses the additive disclosure fields (OA
  // provocations, concentration saves) itself and displays only what arrived.
  const [lastTurnResponse, setLastTurnResponse] = useState<unknown>(null);
  // Engine session this browser talks to through the orchestrator proxies;
  // null while the engine is unreachable (tracker then shows its empty state).
  const [combatSessionId, setCombatSessionId] = useState<string | null>(null);
  // Pillar-11 spotlight balance is DERIVED, never stored. The old hardcoded
  // { Thorin: 0.55, Lyra: 0.55→0.45 } demo weights are gone; this view now
  // comes only from the CRDT speech ledger (real Silero VAD seconds per peer,
  // see sync/speech_ledger.ts). Empty until somebody actually talks.
  const [spotlightView, setSpotlightView] = useState<SpotlightView>({ scope: 'room', shares: [] });
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

  // --- Pillar 9: peer ↔ token spatial voice binding -------------------------
  // Remote peer microphones are positioned on the board so HRTF panning and
  // distance attenuation track their character token (GOALS.md Pillar 9).
  //
  // BINDING STRATEGY (identity-based): the mesh exposes each remote's userId
  // (parsed from its `at-<lobby>-<userId>` signaling id) and hello display
  // name. We match userId against known accounts' `assignedTokenIds` first,
  // then fall back to an exact display-name match on a player token. A
  // wildcard ('*') assignment means table authority, NOT a physical body —
  // GMs/spectators deliberately stay unbound.
  //
  // HONEST LIMITS:
  //  - Peers with no identifiable token are pinned by the mesh at listener
  //    distance with neutral pan. That is a FIXED placement; no simulated
  //    movement is ever generated for them here or in webrtc_mesh.ts.
  //  - Ownership comes from the static DEMO_ACCOUNTS registry + CRDT identity;
  //    there is no server-side seat→token assignment yet, so a signed-in user
  //    outside this registry binds only via display-name coincidence.
  //  - Token elevation is ignored by the audio graph (planar listener/source
  //    model in spatial_audio.ts).
  const resolveTokenForUser = useCallback(
    (userId: string, peerName: string): Token | null => {
      const uid = normalizeUserIdForBinding(userId);
      if (uid) {
        const account = DEMO_ACCOUNTS.find(
          (a) => normalizeUserIdForBinding(a.user.id) === uid
        );
        if (account) {
          for (const tid of account.user.assignedTokenIds) {
            if (tid === '*') break; // authority ≠ a body on the map
            const owned = tokens.find((t) => t.id === tid);
            if (owned) return owned;
          }
        }
      }
      return (
        tokens.find(
          (t) =>
            t.isPlayer &&
            (!!peerName && (t.name === peerName || normalizeUserIdForBinding(t.name) === normalizeUserIdForBinding(peerName)))
        ) ?? null
      );
    },
    [tokens]
  );

  // Push every connected peer's bound token position into the mesh (~10 Hz
  // throttled inside updatePeerPosition). Re-runs on any token state change —
  // local drags AND CRDT-remote moves — and re-subscribes when the roster
  // changes so peers joining mid-session get placed immediately.
  useEffect(() => {
    const syncPeerPositions = () => {
      for (const peer of globalWebRTCMesh.getRemoteTiles()) {
        const bound = resolveTokenForUser(peer.userId, peer.name);
        if (bound) {
          globalWebRTCMesh.updatePeerPosition(
            peer.peerId,
            bound.x,
            bound.y,
            bound.id,
            bound.elevationFeet
          );
        } else {
          globalWebRTCMesh.markPeerUnmapped(peer.peerId);
        }
      }
    };
    syncPeerPositions();
    return globalWebRTCMesh.onRosterUpdated(syncPeerPositions);
  }, [tokens, resolveTokenForUser]);

  // The local LISTENER follows our own bound token (board-center fallback),
  // so every one-shot cue and mapped peer voice is heard from our seat.
  useEffect(() => {
    const ownToken = resolveTokenForUser(currentUser.id, currentUser.displayName);
    if (ownToken) {
      globalSpatialAudio.setListenerPosition(ownToken.x, ownToken.y, ownToken.elevationFeet);
    } else {
      globalSpatialAudio.setListenerPosition(
        BOARD_CENTER_FALLBACK.x,
        BOARD_CENTER_FALLBACK.y,
        0
      );
    }
  }, [tokens, currentUser, resolveTokenForUser]);

  // Pillar-9 occlusion: hand the session's wall cells to the spatial engine so
  // peer voices and one-shot cues attenuate behind intervening walls. Re-runs
  // whenever the wall set changes (layer editor strokes, WFC import, campaign
  // restore) — the engine recomputes every live voice path on receipt.
  useEffect(() => {
    globalSpatialAudio.setWalls(customWalls);
  }, [customWalls]);

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

  /**
   * Honest failure state when the rules engine cannot resolve an action
   * (iteration-19). The previous fallback FABRICATED a hit plus random damage
   * client-side, which contradicted "clients never send combat math" and
   * desynced every other seat from this screen. Now nothing resolves: no HP
   * changes, no roll entry, no chat theatre. Instead a floating banner over
   * the canvas explains the failure and offers Retry (re-fires the exact same
   * action) or Dismiss.
   */
  const [pendingActionRetry, setPendingActionRetry] = useState<{
    what: 'attack' | 'spell' | 'check';
    label: string;
    retry: () => void;
  } | null>(null);
  const setEngineUnreachable = (
    what: 'attack' | 'spell' | 'check',
    label: string,
    retry: () => void
  ) => {
    setPendingActionRetry({ what, label, retry });
  };
  const renderEngineUnreachableBanner = () => {
    if (!pendingActionRetry) return null;
    return (
      <div
        role="alert"
        data-testid="engine-unreachable-banner"
        className="absolute top-14 left-1/2 -translate-x-1/2 flex items-center gap-3 px-3 py-2 rounded-lg bg-tavern-surface/95 backdrop-blur border border-tavern-border shadow-lg"
        style={{ zIndex: 'var(--z-chrome)' }}
      >
        <AlertCircle className="w-4 h-4 shrink-0" style={{ color: 'var(--state-danger)' }} aria-hidden="true" />
        <span className="text-xs text-[var(--rp-parchment-200)] font-prose">
          {pendingActionRetry.label} was not resolved — the rules engine is unreachable.
          No damage was applied.
        </span>
        <button
          type="button"
          onClick={() => {
            const retry = pendingActionRetry.retry;
            setPendingActionRetry(null);
            retry();
          }}
          className="vtt-btn vtt-btn-primary px-2 py-1 text-xs shrink-0"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={() => setPendingActionRetry(null)}
          aria-label="Dismiss unresolved action notice"
          className="vtt-badge shrink-0 cursor-pointer"
        >
          Dismiss
        </button>
      </div>
    );
  };

  /** "+5" / "-1" / "+0" — display form of a real derived attack bonus. */
  const formatSignedModifier = (mod: number): string => (mod >= 0 ? `+${mod}` : `${mod}`);

  const handleTokenMove = (tokenId: string, newX: number, newY: number) => {
    // Transport-aware authorization gate (iteration 4 follow-up): the legacy
    // engine LWW relay fails closed for non-GM tokens in non-session rooms.
    // We refuse the write here and surface an honest banner rather than
    // fabricating authority the client does not have.
    const verdict = canMoveTokensOnTransport(
      transportKind,
      currentUser.role,
      Boolean(getStoredToken()),
    );
    if (!verdict.canMove) {
      const reason = verdict.blocked?.detail ?? 'Token move blocked by transport policy.';
      addSystemMessage(
        `Token move refused on ${transportKind ?? 'no'} transport: ${reason}`,
      );
      // Still update local board state — the move IS the user's intent on
      // their own screen — but do NOT broadcast to peers who would otherwise
      // see authority the gateway would reject.
      setTokens((prev) =>
        prev.map((t) => (t.id === tokenId ? { ...t, x: newX, y: newY } : t)),
      );
      return;
    }
    setTokens((prev) =>
      prev.map((t) => (t.id === tokenId ? { ...t, x: newX, y: newY } : t))
    );
    // Peer spatial positions are pushed by the tokens effect below, which also
    // covers CRDT-remote moves that never pass through this handler.
    // Broadcast the move through the engine's CRDT relay (no-op when offline).
    syncClientRef.current?.updateTokenPosition(tokenId, newX, newY, 0);
  };

  // --- Authoritative combat plumbing (gateway /api/v1/engine/* proxies) ----

  /** Pulls live combat state via the session-state read proxy (service-
   * mediated like every other proxy call). Never throws: an unreachable
   * engine simply leaves the last known snapshot on screen. */
  const refreshCombatState = useCallback(async (): Promise<void> => {
    try {
      let sessionId = combatSessionId;
      if (!sessionId) {
        sessionId = await ensureEngineSession();
        if (!sessionId) return;
        setCombatSessionId(sessionId);
      }
      // The gateway's read proxy is authenticated (_require_auth: Bearer
      // header first, legacy ?token= back-compat); the stored session token
      // rides in the Authorization header like every other /api/v1/engine/*
      // browser HTTP call (see api/rules_engine.ts).
      const token = getStoredToken();
      if (!token) return;
      const resp = await fetch('/api/v1/engine/session-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!resp.ok) return;
      const snap = await resp.json();
      const c = snap?.combat;
      if (!c || typeof c !== 'object') return;
      setCombat({
        in_combat: Boolean(c.in_combat),
        round: Number(c.round ?? 0),
        turn_index: Number(c.turn_index ?? 0),
        order: Array.isArray(c.order) ? c.order : [],
      });
    } catch {
      /* engine unreachable — keep showing last known state */
    }
  }, [combatSessionId]);

  // Poll while at the table so GM actions from another seat converge here too.
  useEffect(() => {
    if (currentView !== 'tabletop') return;
    void refreshCombatState();
    const timer = window.setInterval(() => void refreshCombatState(), 15000);
    return () => window.clearInterval(timer);
  }, [currentView, refreshCombatState]);

  const handleBeginCombat = async () => {
    if (userRole === 'spectator') {
      addSystemMessage('🚫 Spectator view: beginning combat is a GM action.');
      return;
    }
    setIsCombatBusy(true);
    try {
      let sessionId = combatSessionId;
      if (!sessionId) {
        sessionId = await ensureEngineSession();
        if (!sessionId) {
          addSystemMessage('⚔️ Rules engine unreachable — cannot roll initiative.');
          return;
        }
        setCombatSessionId(sessionId);
      }
      const beginToken = getStoredToken();
      if (!beginToken) {
        addSystemMessage('🔒 Sign in to roll initiative — the engine proxies require a session token.');
        return;
      }
      const resp = await fetch('/api/v1/engine/combat/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!resp.ok) {
        addSystemMessage(`⚔️ Begin combat rejected by the engine (HTTP ${resp.status}).`);
        return;
      }
      const data = await resp.json();
      const order: CombatantEntry[] = Array.isArray(data.order) ? data.order : [];
      const round = Number(data.round ?? 1);
      setCombat({ in_combat: true, round, turn_index: Number(data.turn_index ?? 0), order });
      setRoundNumber(round || 1);
      setCurrentTurnIndex(Number(data.turn_index ?? 0));
      const first = order[0];
      if (first) setSelectedTokenId(first.entity_id);
      addSystemMessage(
        first
          ? `⚔️ Initiative rolled! ${first.name} acts first with ${first.initiative_total}.`
          : '⚔️ Combat begun with no combatants tracked.'
      );
    } catch {
      addSystemMessage('⚔️ Begin combat failed — rules engine unreachable.');
    } finally {
      setIsCombatBusy(false);
    }
  };

  const handleEndCombat = async () => {
    if (userRole === 'spectator') {
      addSystemMessage('🚫 Spectator view: ending combat is a GM action.');
      return;
    }
    setIsCombatBusy(true);
    try {
      if (combatSessionId) {
        const endToken = getStoredToken();
        if (!endToken) {
          addSystemMessage('🔒 Sign in to end combat — the engine proxies require a session token.');
          return;
        }
        const resp = await fetch('/api/v1/engine/combat/end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ session_id: combatSessionId }),
        });
        if (!resp.ok) {
          addSystemMessage(`⚔️ End combat rejected by the engine (HTTP ${resp.status}).`);
          return;
        }
        const data = await resp.json();
        addSystemMessage(`🏁 Combat ended after ${data.rounds_fought ?? '?'} round(s).`);
      } else {
        addSystemMessage('🏁 Combat ended.');
      }
    } catch {
      addSystemMessage('🏁 Combat ended locally (engine unreachable).');
    } finally {
      setCombat(IDLE_COMBAT_SNAPSHOT);
      setRoundNumber(1);
      setCurrentTurnIndex(0);
      setIsCombatBusy(false);
    }
  };

  const handleNextTurn = () => {
    const orderLen = combat.order.length > 0 ? combat.order.length : tokens.length;
    if (orderLen === 0) return;
    const nextIndex = (currentTurnIndex + 1) % orderLen;
    if (nextIndex === 0) {
      setRoundNumber((r) => r + 1);
    }
    setCurrentTurnIndex(nextIndex);
    const activeId = combat.order[nextIndex]?.entity_id ?? tokens[nextIndex]?.id;
    if (activeId) setSelectedTokenId(activeId);
    const anchor = tokens.find((t) => t.id === activeId) ?? tokens[0];
    if (anchor)
      globalSpatialAudio.setListenerPosition(anchor.x, anchor.y, anchor.elevationFeet);
    const name =
      combat.order[nextIndex]?.name ?? tokens[nextIndex]?.name ?? 'the next combatant';
    addSystemMessage(`Turn passed to ${name} (Round ${nextIndex === 0 ? roundNumber + 1 : roundNumber}).`);
    // Keep the engine's turn cursor converging (the poll reconciles
    // authoritative round/turn when we are not the actor). The response body —
    // core contract plus any ADDITIVE disclosure fields the engine chose to
    // include (opportunity-attack provocations, concentration saves) — is
    // captured raw and handed to InitiativeTracker, which displays only what
    // is actually present. The previous fire-and-forget version also sent NO
    // session token, so the (then query-param-only) gateway route 401'd every
    // call and nothing ever converged; identity now rides the Bearer header.
    if (combat.in_combat && combatSessionId) {
      const nextToken = getStoredToken();
      if (!nextToken) {
        addSystemMessage('🔒 Sign in so turn advances reach the authoritative engine.');
      } else {
        void fetch('/api/v1/engine/turn-next', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ session_id: combatSessionId }),
        })
          .then(async (resp) => {
            // A non-OK advance discloses nothing: clear the stale report.
            if (!resp.ok) {
              setLastTurnResponse(null);
              return;
            }
            const body = await resp.json().catch(() => null);
            setLastTurnResponse(body);
          })
          .then(() => refreshCombatState())
          .catch(() => {
            setLastTurnResponse(null);
          });
      }
    } else {
      setLastTurnResponse(null);
    }
  };

  // SSE Stream Narrative Reader
  const streamNarrativeResponse = async (
    userIntent: string,
    enginePayload: any,
    targetMsgId: string
  ) => {
    setIsStreamingResponse(true);
    try {
      // Iteration-10 gateway hardening: the stream endpoint requires an HMAC
      // session token (any seat may narrate — this is a model-spend gate, and
      // anonymous calls now 401). openNarrativeStream sends the Authorization
      // Bearer header exactly like api/rules_engine.ts / api/safety_xcard.ts
      // and surfaces NOT_SIGNED_IN / HTTP_ERROR honestly instead of stalling
      // the "..." DM bubble forever.
      const opened = await openNarrativeStream({
        user_intent: userIntent,
        engine_execution_payload: enginePayload,
      });
      if (opened.kind === 'ERROR') {
        const f = opened.failure;
        const reason =
          f.kind === 'NOT_SIGNED_IN'
            ? 'Sign in first — narration requires an authenticated session.'
            : f.kind === 'HTTP_ERROR'
              ? `Narration refused by the gateway (${f.status}): ${f.detail}`
              : 'The narration stream could not be opened (no readable body).';
        setMessages((prev) =>
          prev.map((m) => (m.id === targetMsgId ? { ...m, content: reason } : m))
        );
        return;
      }

      const reader = opened.body.getReader();
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
            ? { ...m, content: 'The narration stream failed — the gateway could not be reached.' }
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

  const handleExecuteAttack = async (
    actionName: string,
    damageFormula: string,
    damageType: string,
    toHitBonus?: number
  ) => {
    const target = tokens.find((t) => !t.isPlayer && t.hp > 0) || tokens[2];

    // Authoritative resolution via the Rust rules engine. Iteration-19: the
    // old fallback INVENTED damage (`Math.random()*12+4`) and a fake hit when
    // the engine was unreachable — fabricated combat math that never touched
    // the ledger and desynced every other seat. Now an unreachable engine is
    // an honest failure state: nothing resolves, nothing applies, and the
    // player gets a retry affordance in chat.
    const result = await engineAttack({
      attackerId: selectedToken?.id || 'thorin',
      targetId: target.id,
    });
    if (!result) {
      setEngineUnreachable('attack', `${actionName} by ${selectedToken?.name || 'Hero'}`, () => {
        void handleExecuteAttack(actionName, damageFormula, damageType, toHitBonus);
      });
      return;
    }

    // Display-only to-hit bonus from THIS sheet's bound character record
    // (ability modifier + proficiency). When no record binds, the sheet never
    // showed a to-hit number either — so the chat line shows the natural d20
    // alone instead of inventing a modifier.
    const displayToHit = typeof toHitBonus === 'number' ? toHitBonus : null;
    const isHit = result.is_hit;
    const isCritical = result.is_critical_hit;
    const naturalRoll = result.natural_roll;
    const dmg = isHit ? result.total_damage : 0;

    // Audit trail: every engine-resolved attack lands in the roll history panel.
    addRollEntry({
      kind: 'attack',
      label: `${selectedToken?.name || 'Hero'} → ${actionName}`,
      expression:
        displayToHit !== null
          ? `1d20${formatSignedModifier(displayToHit)} / ${damageFormula} ${damageType}`
          : `${damageFormula} ${damageType} (engine-resolved)`,
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
    globalSpatialAudio.playSpatialImpact(target.x, target.y, target.elevationFeet ?? 0);
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
        sender: selectedToken?.name || 'Hero',
        role: 'player',
        content: `I swing with my ${actionName} (${damageFormula} ${damageType})!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        diceRollDetails:
          displayToHit !== null
            ? {
                total: naturalRoll + displayToHit,
                expression: `1d20${formatSignedModifier(displayToHit)}`,
                rolls: [naturalRoll],
              }
            : {
                total: naturalRoll,
                expression: `1d20 (no bound sheet — engine-resolved)`,
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

  const handleCastSpell = async (
    spellId: string,
    spellName: string,
    level: number,
    toHitBonus?: number
  ) => {
    const target = tokens.find((t) => !t.isPlayer && t.hp > 0) || tokens[2];
    // The engine resolves this as its own attack pipeline; the sheet's damage
    // formula stays DISPLAY metadata only — no client-side math is applied.
    const spellDamageExpression = `${Math.max(1, 2 * level - 1)}d6`;
    const result = await engineAttack({
      attackerId: selectedToken?.id || 'lyra',
      targetId: target.id,
    });
    if (!result) {
      setEngineUnreachable('spell', `${spellName} (Lvl ${level})`, () => {
        void handleCastSpell(spellId, spellName, level, toHitBonus);
      });
      return;
    }

    const displayToHit = typeof toHitBonus === 'number' ? toHitBonus : null;
    const isHit = result.is_hit;
    const naturalRoll = result.natural_roll;
    const dmg = isHit ? result.total_damage : 0;

    // Audit trail: spell attacks are logged with their upcast level for context.
    addRollEntry({
      kind: 'spell',
      label: `${spellName} (Lvl ${level})`,
      expression:
        displayToHit !== null
          ? `1d20${formatSignedModifier(displayToHit)} / ${spellDamageExpression}`
          : `Spell attack (engine-resolved) / ${spellDamageExpression}`,
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
    globalSpatialAudio.playSpatialSpell(target.x, target.y, target.elevationFeet ?? 0);
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
        sender: selectedToken?.name || 'Caster',
        role: 'player',
        content: `I invoke the arcane weave and unleash ${spellName} (Level ${level})!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        diceRollDetails:
          displayToHit !== null
            ? {
                total: naturalRoll + displayToHit,
                expression: `1d20${formatSignedModifier(displayToHit)}`,
                rolls: [naturalRoll],
              }
            : {
                total: naturalRoll,
                expression: `1d20 (no bound sheet — engine-resolved)`,
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
    // Authoritative d20 resolution via the rules engine. Iteration-19: like the
    // attack path above, an unreachable engine no longer rolls locally and
    // grades itself — that fabricated a success/failure the ledger never saw.
    const result = await engineCheck({ modifier, dc });
    if (!result) {
      setEngineUnreachable('check', `${skillName} check (DC ${dc})`, () => {
        void handleRollCheck(skillName, modifier, dc);
      });
      return;
    }
    // Pillar-8 fail-forward band: shape the engine's 4-tier margin (including
    // its verbatim Complication costs) instead of collapsing it to pass/fail.
    // A response without a recognizable tier stays honestly unresolved.
    const shaped = shapeCheckOutcome(result);
    const roll = result.roll;
    const total = result.total;

    // Audit trail: ability checks log natural d20 so crits/fumbles stand out.
    addRollEntry({
      kind: 'check',
      label: `${skillName} (DC ${dc})`,
      expression: `1d20 + ${modifier}`,
      natural: roll,
      total,
      outcome:
        roll === 20 ? 'crit' : roll === 1 ? 'fumble' : logOutcomeForTier(shaped.tier),
      detail: shaped.detail,
    });

    if (selectedToken) {
      globalSpatialAudio.playSpatialDice(
        selectedToken.x,
        selectedToken.y,
        selectedToken.elevationFeet ?? 0
      );
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
        content:
          shaped.tier === 'unresolved'
            ? `The engine resolved ${total} vs DC ${dc} but returned no outcome tier — GM ruling required for this ${skillName} attempt.`
            : shaped.tier === 'critical_success'
              ? `Critical success! Your ${skillName} attempt is flawless.`
              : shaped.tier === 'success'
                ? `Success! You execute your ${skillName} attempt with remarkable finesse.`
                : shaped.tier === 'success_at_cost'
                  ? `${shaped.headline} on your ${skillName} attempt${shaped.detail ? ` — ${shaped.detail}` : ''}.`
                  : `Critical failure. The ${skillName} attempt goes wrong${shaped.detail ? ` — ${shaped.detail}` : ''}.`,
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
    schemaVersion: 2,
    tokens,
    customWalls,
    messages,
    roundNumber,
    currentTurnIndex,
  });

  const applyCampaignSnapshot = (snapshot: CampaignSnapshot) => {
    setTokens(snapshot.tokens as Token[]);
    setCustomWalls(snapshot.customWalls || []);
    setMessages(snapshot.messages as ChatMessage[]);
    setRoundNumber(snapshot.roundNumber ?? 1);
    setCurrentTurnIndex(snapshot.currentTurnIndex ?? 0);
    // Spotlight weights are NOT restored — deliberately. They are live VAD
    // session state in the CRDT speech ledger, not save-file state. v1
    // snapshots carried fabricated { Thorin, Lyra } numbers; that legacy
    // field is ignored here and never resurrected into the view.
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
   *  - Tokens (reverted, iteration 28): the engine's x-card response embeds a
   *    full role-projected GameSession snapshot taken AFTER its ledger replay,
   *    and the gateway forwards it verbatim inside `engine_rewind.snapshot`.
   *    When that block is absent (older engine), an immediate authenticated
   *    refetch through POST /api/v1/engine/session-state returns the same
   *    projection. The local token mirror is reconciled against whichever one
   *    arrives — HP only where the projection discloses it (own sheet / GM),
   *    positions where a numeric [x,y,z] exists; provably-removed tokens are
   *    dropped ONLY on a privileged view so GM-hidden NPCs are never erased
   *    by a player-role projection. Unmatched snapshot entities are reported
   *    in the audit line, never fabricated into the board.
   *  - STILL NOT converged here (documented drift): CharacterSheet's
   *    death-save tallies are component-local state that subscribes to
   *    nothing; SpellbookModal/CharacterSheet slot+concentration+readied
   *    reads and BossHealthBar's 15 s poll each refresh on their own cadence,
   *    not on rewind confirmation. See client/src/ui/safetyXCard.ts.
   */
  const handleSafetyRewind = async (topic: string) => {
    // Snapshot the pre-trigger chat so the revert plan is anchored to the
    // exact moment before any safety messaging was appended.
    const rewindPlan = computeLocalRewindPlan(messages);
    addSystemMessage(`SAFETY CARD TRIGGERED: Topic '${topic}' flagged. Requesting authoritative scene rewind.`);
    // Apply the rewind against the authoritative engine ledger when online.
    const sessionId = await ensureEngineSession();
    // Iteration 5: the x-card endpoint requires an HMAC session token;
    // triggerXCard sends the Bearer header exactly like heal/rest/maneuvers
    // in api/rules_engine.ts and surfaces NOT_SIGNED_IN / HTTP_ERROR honestly.
    triggerXCard({
      player_id: currentUser.id,
      topic,
      current_sequence_id: roundNumber * 10,
      engine_session_id: sessionId,
    })
      .then(async (result) => {
        if (result.kind === 'ERROR') {
          if (result.failure.kind === 'NOT_SIGNED_IN') {
            addSystemMessage(`SAFETY X-card: ${result.failure.detail}`);
          } else if (result.failure.kind === 'HTTP_ERROR') {
            addSystemMessage(`SAFETY X-card rejected by gateway (${result.failure.status}): ${result.failure.detail}`);
          } else {
            addSystemMessage('Intervention recorded locally.');
          }
          return;
        }
        const rewind = parseEngineRewind(result.body);
        if (!rewind || rewind.status !== 'SAFETY_REWIND_SUCCESS') {
          addSystemMessage('Intervention recorded; engine ledger offline.');
          return;
        }

        // --- Token reconciliation (iteration 28) --------------------------
        // Prefer the snapshot embedded in the x-card response (one round
        // trip); fall back to an immediate authenticated session-state read
        // when the engine did not include one. If neither yields usable
        // entities, tokens stay untouched and the audit line says so.
        let snapshot = rewind.snapshot;
        let snapshotSource: 'embedded' | 'refetched' | null =
          snapshot && !computeTokenReconciliation(tokens, snapshot).empty ? 'embedded' : null;
        if (!snapshotSource) {
          // The session-state body IS the projected GameSession, so it parses
          // as a snapshot directly.
          const refetch = await fetchSessionState(sessionId ?? combatSessionId);
          const refetched =
            refetch.kind === 'OK' ? parseRewoundSnapshot(refetch.body) : null;
          if (refetched && !computeTokenReconciliation(tokens, refetched).empty) {
            snapshot = refetched;
            snapshotSource = 'refetched';
          }
        }
        const reconciliation = computeTokenReconciliation(tokens, snapshot);

        const { reverted_event_count = 0, restored_entities = 0, removed_entities = 0 } = rewind.report;
        if (!reconciliation.empty) {
          setTokens((prev) =>
            prev.flatMap((t) => {
              if (reconciliation.provablyRemovedTokenIds.includes(t.id)) return [];
              const patch = reconciliation.patches.find((p) => p.id === t.id);
              if (!patch) return [t];
              return [
                {
                  ...t,
                  ...(patch.hp !== undefined ? { hp: patch.hp } : {}),
                  ...(patch.x !== undefined || patch.y !== undefined
                    ? { x: patch.x ?? t.x, y: patch.y ?? t.y }
                    : {}),
                },
              ];
            })
          );
          // Keep the CRDT room converging with the authoritative placement:
          // every token whose position was patched is re-published so peers
          // see the rewound grid cell instead of their own pre-rewind mirror.
          for (const patch of reconciliation.patches) {
            if (patch.x === undefined || patch.y === undefined) continue;
            syncClientRef.current?.updateTokenPosition(patch.id, patch.x, patch.y, 0);
          }
        }

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
              // Iteration 28: tokens converge from the post-rewind projection
              // (embedded or refetched). Disclose exactly what happened.
              (reverted_event_count > 0
                ? reconciliation.empty
                  ? ' Note: no authoritative token state available — local HP/positions may retain pre-rewind drift until the next snapshot load.'
                  : ` Tokens reconciled from the ${
                      snapshotSource === 'refetched' ? 'session-state read' : 'rewind snapshot'
                    }` +
                    ` (${reconciliation.patches.length} updated` +
                    (reconciliation.provablyRemovedTokenIds.length > 0
                      ? `, ${reconciliation.provablyRemovedTokenIds.length} removed`
                      : '') +
                    (reconciliation.unmatchedEntityIds.length > 0
                      ? `; ${reconciliation.unmatchedEntityIds.length} engine entity/entities have no local token`
                      : '') +
                    '). Death-save tallies and spell-slot panels refresh on their own surfaces.'
                : ''),
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      });
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

  /**
   * New Campaign wizard completion — fires ONLY after a real lobby was created
   * server-side. Applies the wizard's selections where real mechanisms exist:
   * campaign title state and the table-wide atmosphere preset (write-through to
   * the CRDT room via handleSelectAtmosphere). Rule version / party
   * size / starting level have no server field yet (the lobby API takes just a
   * name), so they are acknowledged in chat rather than silently dropped.
   */
  const handleCampaignWizardComplete = (
    _lobby: Lobby,
    config: CampaignWizardConfig,
    loadAdventureKey: string | null
  ) => {
    setCampaignTitle(config.name);
    if (config.atmosphereId !== atmosphereId) handleSelectAtmosphere(config.atmosphereId);
    addSystemMessage(
      `Campaign "${config.name}" created — invite code shared in the wizard. ` +
        `Config: ${config.ruleVersion === 'srd_5_2' ? 'SRD 5.2' : 'SRD 5.1'}, ` +
        `${config.partySize} seats, start level ${config.startingLevel}` +
        (loadAdventureKey ? `, starter adventure "${loadAdventureKey}" selected` : '') +
        '.'
    );
    setIsCampaignWizardOpen(false);
    setCurrentView('lobby');
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
    // Iteration-19: no local-dice fallback — an unreachable engine surfaces
    // the same honest retry banner as attacks/spells instead of a self-rolled
    // d20 the authoritative ledger never recorded.
    const modifier = formulaModifier(formula);
    const result = await engineCheck({
      modifier,
      dc: 10,
      advantage: advDis === 'advantage',
      disadvantage: advDis === 'disadvantage',
    });
    if (!result) {
      setEngineUnreachable('check', `${macroName} (${formula})`, () => {
        void handleMacroRoll(macroName, formula, isWhisper, advDis);
      });
      return;
    }
    const d20Roll = result.roll;
    const macroTotal = result.total;

    // Audit trail: quickbar macros resolve through the engine like any other
    // roll, and carry the same Pillar-8 fail-forward band as skill checks.
    const shapedMacro = shapeCheckOutcome(result);
    addRollEntry({
      kind: 'macro',
      label: macroName,
      expression: formula,
      natural: d20Roll,
      total: macroTotal,
      outcome:
        d20Roll === 20
          ? 'crit'
          : d20Roll === 1
            ? 'fumble'
            : logOutcomeForTier(shapedMacro.tier),
      detail: shapedMacro.detail,
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
        activeAtmosphereId={atmosphereId}
        onSelectAtmosphere={handleSelectAtmosphere}
        canManageAtmosphere={userRole === 'gm'}
                onOpenCampaignSaves={() => setIsCampaignSavesOpen(true)}
        onOpenCampaignWizard={guardGmSurface('the New Campaign wizard', () => setIsCampaignWizardOpen(true))}
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
            {/* Top Epic Boss Health Bar — self-sourced from the role-projected
                engine session state (highest-max-HP visible hostile with both
                HP figures disclosed). Renders NOTHING for roles the projection
                gives no hostile sheets to (players/spectators), and nothing at
                all when no qualifying hostile exists — never a fake boss. */}
            <BossHealthBar
              sessionId={combatSessionId}
              activeTurnName={combat.order[combat.turn_index]?.name ?? ''}
            />

            {/* Floating WebRTC Video Mesh Tiles */}
            <VideoMeshTiles
              isVisible={isVideoMeshVisible}
              onToggleVisible={() => setIsVideoMeshVisible(false)}
              currentUser={{ id: currentUser.id, displayName: currentUser.displayName }}
            />

            {/* Tabletop Center Workspace */}
            <div className="flex-1 flex overflow-hidden relative min-h-0">
              {/* Honest engine-failure affordance (iteration-19): replaces the
                  old fabricated random-damage fallback. Renders only while an
                  attack/spell is waiting on an unreachable engine. */}
              {renderEngineUnreachableBanner()}
              {/* Left Dock: Initiative Tracker — receives the same
                  spectator-filtered list as the canvas so hidden entities are
                  absent from turn order too (not merely invisible on map). */}
              <InitiativeTracker
                tokens={visibleTokens}
                onNextTurn={handleNextTurn}
                onSelectToken={(id) => setSelectedTokenId(id)}
                selectedTokenId={selectedTokenId}
                roundNumber={combat.round || roundNumber}
                isCollapsed={isLeftDockCollapsed}
                onToggleCollapse={() => setIsLeftDockCollapsed(!isLeftDockCollapsed)}
                inCombat={combat.in_combat}
                combatOrder={combat.order}
                activeEntityId={combat.order[combat.turn_index]?.entity_id ?? null}
                isGm={userRole === 'gm'}
                isCombatBusy={isCombatBusy}
                onBeginCombat={() => void handleBeginCombat()}
                onEndCombat={() => void handleEndCombat()}
                lastTurnResponse={lastTurnResponse}
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
              spotlightView={spotlightView}
              onSpeechStart={handleLocalSpeechStart}
              onSpeechSegment={handleLocalSpeechSegment}
              onCaptureStop={handleLocalCaptureStop}
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

      {/* Guided New Campaign Wizard (GOALS.md Pillar 2) — completes only on a
          real created lobby; failures surface inline inside the wizard. */}
      {isCampaignWizardOpen && (
        <CampaignWizardModal
          isOpen={isCampaignWizardOpen}
          onClose={() => setIsCampaignWizardOpen(false)}
          onComplete={handleCampaignWizardComplete}
        />
      )}

      {/* Streamer Broadcast HUD Modal — userRole is passed (not duplicated)
          so the modal REPORTS the live privacy posture instead of keeping its
          own copy of the filter state. The broadcast camera loop receives the
          SAME filtered inputs the canvas/chat render from (visibleTokens,
          yjsClient) so its readout cannot disagree with what spectators see. */}
      <StreamerHUDModal
        isOpen={isStreamerHUDOpen}
        onClose={() => setIsStreamerHUDOpen(false)}
        userRole={userRole}
        syncClient={yjsClient}
        projectedTokens={visibleTokens}
        gridWidth={16}
        gridHeight={12}
        totalTokenCount={tokens.length}
        excludedChatLineCount={messages.length - spectatorMessages.length}
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
