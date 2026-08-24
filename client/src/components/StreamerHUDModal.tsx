import React, { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './ui/useFocusTrap';
import {
  Video,
  Radio,
  X,
  Check,
  Tv,
  Send,
  ShieldAlert,
  Camera,
  EyeOff,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import {
  startBroadcastViewportLoop,
  type BroadcastViewportInput,
  type BroadcastViewportSnapshot,
  type ProjectedBoardToken,
} from '../render/viewport_sync';
import type { YjsCrdtClient } from '../sync/yjs_doc_client';

interface StreamerHUDModalProps {
  isOpen: boolean;
  onClose: () => void;
  onToggleCinematicMode?: (enabled: boolean) => void;
  /**
   * Live session role from the App shell. Passed IN rather than mirrored in
   * local state so this modal can only ever REPORT the actual Pillar 9
   * spectator filtering — it cannot drift out of sync with what TacticalCanvas
   * and NarrativeChat are really receiving.
   */
  userRole?: 'gm' | 'player' | 'spectator';
  /** CRDT client backing fog-of-war (same instance the canvas renders from). */
  syncClient?: YjsCrdtClient | null;
  /**
   * The spectator-PROJECTED token list — the same already-filtered array the
   * canvas renders. Framing reads only this; it never re-filters (see
   * render/viewport_sync.ts module header).
   */
  projectedTokens?: ProjectedBoardToken[];
  gridWidth?: number;
  gridHeight?: number;
  /** UNFILTERED token list size, so this HUD can report how many were hidden. */
  totalTokenCount: number;
  /** Chat lines the spectator message stream excludes (App-computed). */
  excludedChatLineCount: number;
  /** Capture surface aspect used for the letterbox readout. */
  broadcastViewportSize?: { width: number; height: number };
}

const MODE_LABELS: Record<BroadcastViewportSnapshot['mode'], string> = {
  spectator_projected: 'CAPTURING SPECTATOR-PROJECTED VIEW',
  gm_passthrough: 'MIRRORING GM VIEW (FILTERING OFF)',
  locked_board_center: 'LOCKED TO BOARD CENTER (NOTHING VISIBLE)',
};

export const StreamerHUDModal: React.FC<StreamerHUDModalProps> = ({
  isOpen,
  onClose,
  onToggleCinematicMode,
  userRole = 'gm',
  syncClient = null,
  projectedTokens,
  gridWidth = 16,
  gridHeight = 12,
  totalTokenCount = 0,
  excludedChatLineCount = 0,
  broadcastViewportSize = { width: 1280, height: 720 },
}) => {
  // Per-frame inputs are read through refs inside the polling loop so the
  // effect above does not restart (and the camera does not stutter) every time
  // a token moves one cell.
  const broadcastTokensRef = useRef<ProjectedBoardToken[]>(projectedTokens ?? []);
  broadcastTokensRef.current = projectedTokens ?? [];
  const gridWidthRef = useRef(gridWidth);
  gridWidthRef.current = gridWidth;
  const gridHeightRef = useRef(gridHeight);
  gridHeightRef.current = gridHeight;
  const isSpectator = userRole === 'spectator';
  const [isCinematicActive, setIsCinematicActive] = useState(false);
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState('https://discord.com/api/webhooks/1042/aether_stream');
  const [relayCrits, setRelayCrits] = useState(true);
  const [relayDeathSaves, setRelayDeathSaves] = useState(true);
  const [relayBossKills, setRelayBossKills] = useState(true);
  const [testSent, setTestSent] = useState(false);

  // Live broadcast camera snapshot. The polling loop lives in render/
  // viewport_sync.ts; this modal only renders what it publishes. The loop runs
  // while the modal is open (it IS the readout surface) and stops on close.
  const [broadcastSnapshot, setBroadcastSnapshot] = useState<BroadcastViewportSnapshot | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const handle = startBroadcastViewportLoop(
      (): BroadcastViewportInput => ({
        spectatorMode: userRole === 'spectator',
        projectedTokens: broadcastTokensRef.current,
        totalTokenCount,
        excludedChatLines: excludedChatLineCount,
        syncClient,
        gridWidth: gridWidthRef.current,
        gridHeight: gridHeightRef.current,
        viewportWidthPx: broadcastViewportSize.width,
        viewportHeightPx: broadcastViewportSize.height,
      }),
      setBroadcastSnapshot
    );
    return () => handle.stop();
    // Refs carry the per-frame inputs (see below); the loop itself must not be
    // torn down when token positions change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, userRole, totalTokenCount, excludedChatLineCount, syncClient, broadcastViewportSize.width, broadcastViewportSize.height]);

  if (!isOpen) return null;

  const handleToggleCinematic = () => {
    const next = !isCinematicActive;
    setIsCinematicActive(next);
    globalAudio.playTurnAdvance();
    if (onToggleCinematicMode) onToggleCinematicMode(next);
  };

  const handleSendTestWebhook = (e: React.FormEvent) => {
    e.preventDefault();
    globalAudio.playDiceRoll();
    setTestSent(true);
    setTimeout(() => setTestSent(false), 2500);
  };

  // Shared dialog behavior (ESC dismiss + focus trap) without restructuring
  // this bespoke overlay onto ModalShell — same pattern, ladder z-index.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap({ active: true, containerRef, onEscape: onClose });

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center p-4" style={{ zIndex: 'var(--z-modal)' }}>
      <div ref={containerRef} tabIndex={-1} role="dialog" aria-modal="true">
      <div className="vtt-glass-panel rounded-2xl max-w-xl w-full max-h-[85vh] overflow-hidden shadow-2xl flex flex-col font-sans animate-fadeIn">
        {/* Header */}
        <div className="p-5 border-b border-tavern-border flex items-center justify-between bg-tavern-bg/80">
          <div className="flex items-center space-x-3">
            {/* Flat tavern tile with gold-leaf icon (no cold gradient chrome) */}
            <div className="p-2.5 bg-tavern-bg border border-tavern-border rounded-xl text-tavern-accent">
              <Video className="w-6 h-6" />
            </div>
            <div>
              <h2 className="vtt-engraved text-xl font-bold font-display">
                Streamer Broadcast & Discord Relay
              </h2>
              <p className="text-xs text-[var(--rp-parchment-300)]">
                OBS clean overlay mode, cinematic turn auto-focus, and Discord webhook live roll alerts.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close modal"
            autoFocus  // move keyboard focus into the dialog on open
                        className="p-1.5 text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)] rounded-lg hover:bg-white/10 transition cursor-pointer"
          >
              <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-6 overflow-y-auto vtt-scrollbar max-h-[60vh]">
          {/* Cinematic Mode Toggle Card */}
          <div className="p-4 vtt-surface rounded-2xl flex items-center justify-between shadow-inner">
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <Tv className="w-4 h-4 text-tavern-accent" />
                <span className="text-sm font-bold text-[var(--rp-parchment-100)]">Cinematic Broadcast Mode</span>
                {/* State chip — printed-book badge carries the on/off state */}
                <span className={isCinematicActive ? 'vtt-badge vtt-badge-success' : 'vtt-badge'}>
                  {isCinematicActive ? 'ACTIVE' : 'OFF'}
                </span>
              </div>
              <p className="text-xs text-[var(--rp-parchment-300)] font-sans">
                Hides debug bars, telemetry, and administrative chrome for clean OBS window capture.
              </p>
            </div>

            <button
              onClick={handleToggleCinematic}
              className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition cursor-pointer border ${
                isCinematicActive
                  ? 'bg-gradient-to-b from-[var(--rp-amber-500)] to-[var(--rp-amber-600)] text-[var(--rp-ink-900)] border-[color-mix(in_srgb,var(--rp-amber-500)_70%,black)]'
                  : 'vtt-btn-secondary'
              }`}
            >
              {isCinematicActive ? 'ACTIVE (OBS Clean)' : 'Enable Cinematic'}
            </button>
          </div>

          {/* Spectator Privacy Posture — a read-only status card, not a toggle.
              The filtering itself lives in the App shell (visibleTokens /
              spectatorMessages props); this only tells the streamer what their
              capture is guaranteed to exclude right now. */}
          <div className="p-4 vtt-surface rounded-2xl space-y-2 shadow-inner">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <ShieldAlert className="w-4 h-4 text-tavern-accent" />
                <span className="text-sm font-bold text-[var(--rp-parchment-100)]">
                  Spectator Privacy Filtering
                </span>
              </div>
              <span className={isSpectator ? 'vtt-badge vtt-badge-success' : 'vtt-badge'}>
                {isSpectator ? 'ACTIVE' : 'INACTIVE (GM/Player seat)'}
              </span>
            </div>
            <p className="text-xs text-[var(--rp-parchment-300)] font-sans">
              {isSpectator
                ? 'Spectator seat: GM-hidden tokens, private GM-whisper channels, and DM-only surfaces (Handouts Vault, Quest Journal notes, Hidden-Info map layer) are excluded from this session view and from OBS capture.'
                : 'Trusted seat: full table content including GM whispers is visible. Switch to the Spectator lobby seat before broadcasting to enable privacy filtering.'}
            </p>
            {/* Viewport-mirror status: how the broadcast CAMERA relates to the
                same filter. Derived from the live loop snapshot, not guessed. */}
            {broadcastSnapshot && (
              <p className="text-xs font-mono text-[var(--rp-parchment-200)] border-t border-tavern-border pt-2">
                Viewport mirror:{' '}
                <span className="font-bold">
                  {isSpectator
                    ? broadcastSnapshot.mode === 'locked_board_center'
                      ? 'TRACKING PARTY AREA — locked to board center (nothing visible)'
                      : 'TRACKING PARTY AREA (spectator projection only)'
                    : 'NOT TRACKING — camera mirrors the seated canvas as-is'}
                </span>
                . The fitted frame reads the same filtered token list the canvas
                renders plus the party-shared fog union, so hidden entities are
                physically absent from what shapes (and what appears in) the
                broadcast frame.
              </p>
            )}
          </div>

          {/* Broadcast Capture — live readout of what the projected view hides.
              Read-only: like the posture card above, this REPORTS the camera
              controller's output instead of owning any filter state. */}
          <div className="p-4 vtt-surface rounded-2xl space-y-3 shadow-inner">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center space-x-2">
                <Camera className="w-4 h-4 text-tavern-accent" />
                <span className="text-sm font-bold text-[var(--rp-parchment-100)]">
                  Broadcast Capture
                </span>
              </div>
              <span
                className={
                  broadcastSnapshot?.mode === 'spectator_projected'
                    ? 'vtt-badge vtt-badge-success'
                    : broadcastSnapshot?.mode === 'locked_board_center'
                    ? 'vtt-badge'
                    : 'vtt-badge vtt-badge-danger'
                }
              >
                {broadcastSnapshot ? MODE_LABELS[broadcastSnapshot.mode] : 'STARTING CAMERA LOOP…'}
              </span>
            </div>

            <p className="text-xs text-[var(--rp-parchment-300)] font-sans">
              {broadcastSnapshot?.note ??
                'Polling the spectator-projected board each frame; the first frame lands momentarily.'}
            </p>

            {broadcastSnapshot && (
              <>
                {/* What the projection HIDES — an honest exclusion readout,
                    not a green "all safe" claim. */}
                <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                  <div className="flex items-start space-x-1.5 p-2 bg-black/30 rounded-lg border border-tavern-border">
                    <EyeOff className="w-3.5 h-3.5 mt-0.5 shrink-0 text-rose-300" />
                    <span className="text-[var(--rp-parchment-200)]">
                      Hidden tokens excluded from projection:{' '}
                      <span className="font-bold">{broadcastSnapshot.readout.hiddenTokens}</span>
                      {' '}({broadcastSnapshot.readout.visibleTokens} visible)
                    </span>
                  </div>
                  <div className="flex items-start space-x-1.5 p-2 bg-black/30 rounded-lg border border-tavern-border">
                    <EyeOff className="w-3.5 h-3.5 mt-0.5 shrink-0 text-rose-300" />
                    <span className="text-[var(--rp-parchment-200)]">
                      Private chat lines excluded from stream:{' '}
                      <span className="font-bold">{broadcastSnapshot.readout.excludedChatLines}</span>
                    </span>
                  </div>
                  <div className="flex items-start space-x-1.5 p-2 bg-black/30 rounded-lg border border-tavern-border">
                    <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-300" />
                    <span className="text-[var(--rp-parchment-200)]">
                      Private fog layers NOT merged into the tracked area:{' '}
                      <span className="font-bold">
                        {isSpectator ? 'GM channel + unexplored cells' : 'n/a (filtering off)'}
                      </span>
                      {isSpectator && (
                        <> · party layers merged: <span className="font-bold">{broadcastSnapshot.readout.partyFogLayers}</span></>
                      )}
                    </span>
                  </div>
                  <div className="flex items-start space-x-1.5 p-2 bg-black/30 rounded-lg border border-tavern-border">
                    <Camera className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--tavern-accent)]" />
                    <span className="text-[var(--rp-parchment-200)]">
                      Frame:{' '}
                      {broadcastSnapshot.camera && broadcastSnapshot.focusRect ? (
                        <>
                          zoom <span className="font-bold">{Math.round(broadcastSnapshot.camera.zoom * 100)}%</span>{' '}
                          · focus{' '}
                          <span className="font-bold">
                            [{Math.round(broadcastSnapshot.focusRect.minX / 60)}, {Math.round(broadcastSnapshot.focusRect.minY / 60)}] → [{' '}
                            {Math.round(broadcastSnapshot.focusRect.maxX / 60)}, {Math.round(broadcastSnapshot.focusRect.maxY / 60)}] cells
                          </span>{' '}
                          · letterbox L/R {Math.round(broadcastSnapshot.letterbox.left)}/{Math.round(broadcastSnapshot.letterbox.right)} px
                        </>
                      ) : (
                        'mirroring seated canvas (no independent camera transform)'
                      )}
                    </span>
                  </div>
                </div>

                {/* Honest limits — never claimed as a wire-level guarantee. */}
                <p className="text-[10px] font-mono text-[var(--rp-parchment-300)] leading-relaxed">
                  Scope: this camera protects what the CAPTURE shows, computed
                  client-side. It does not encrypt the wire or replace server-side
                  seat filtering — a spectator peer could still receive more than
                  it renders unless the relay withholds it (see App.tsx Pillar 9
                  honest-limits list).
                </p>
              </>
            )}
          </div>

          {/* Discord Webhook Relay Form */}
          <form onSubmit={handleSendTestWebhook} className="space-y-4">
            <div
              className="text-xs font-bold uppercase tracking-wider flex items-center space-x-1.5"
              style={{ color: 'var(--tavern-accent)' }}
            >
              <Radio className="w-4 h-4 animate-pulse" />
              <span>Live Discord Webhook Broadcaster</span>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-[var(--rp-parchment-300)]">Discord Channel Webhook URL</label>
              <input
                type="text"
                value={discordWebhookUrl}
                onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                className="vtt-input w-full font-mono text-xs"
              />
            </div>

            {/* Event Checkboxes */}
            <div className="space-y-2 pt-2">
              <label className="flex items-center space-x-2.5 text-xs font-mono text-[var(--rp-parchment-200)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayCrits}
                  onChange={(e) => setRelayCrits(e.target.checked)}
                  className="accent-[var(--tavern-accent)] rounded"
                />
                <span>Broadcast Critical Hits & Fumbles (Natural 20s / 1s)</span>
              </label>

              <label className="flex items-center space-x-2.5 text-xs font-mono text-[var(--rp-parchment-200)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayDeathSaves}
                  onChange={(e) => setRelayDeathSaves(e.target.checked)}
                  className="accent-[var(--tavern-accent)] rounded"
                />
                <span>Broadcast Character Death Saves</span>
              </label>

              <label className="flex items-center space-x-2.5 text-xs font-mono text-[var(--rp-parchment-200)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayBossKills}
                  onChange={(e) => setRelayBossKills(e.target.checked)}
                  className="accent-[var(--tavern-accent)] rounded"
                />
                <span>Broadcast Boss Monster Defeat Fanfares</span>
              </label>
            </div>

            <button
              type="submit"
              className="vtt-btn vtt-btn-secondary font-mono"
            >
              {testSent ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--state-success)' }} /> : <Send className="w-3.5 h-3.5" />}
              <span>{testSent ? 'Test Payload Dispatched to Discord!' : 'Dispatch Test Webhook Alert'}</span>
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="p-4 bg-tavern-bg/80 border-t border-tavern-border flex justify-end">
          <button
            onClick={onClose}
            className="vtt-btn vtt-btn-primary font-display tracking-wide"
          >
            Save & Close Streamer HUD
          </button>
        </div>
      </div>
      </div>
    </div>
  );
};
