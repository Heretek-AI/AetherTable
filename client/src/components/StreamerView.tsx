import React, { useEffect, useRef } from 'react';
import { Radio, X } from 'lucide-react';
import { InitiativeTracker } from './InitiativeTracker';
import { NarrativeChat, type ChatMessage } from './NarrativeChat';
import type { Token } from './TacticalCanvas';

/**
 * Dedicated full-screen Streamer View (GOALS.md Pillar 9).
 *
 * WHAT THIS IS: the actual broadcast surface. The StreamerHUDModal only
 * REPORTS what the spectator projection excludes; this component IS what an
 * OBS window captures — a clean, chrome-free frame showing exactly the
 * party-visible board and the public chat.
 *
 * FILTERING CONTRACT (do not break): this component renders ONLY the
 * projections it is HANDED (`projectedTokens`, `projectedMessages` — the same
 * `visibleTokens` / `spectatorMessages` arrays App.tsx already computes for
 * spectator seats). It deliberately adds no second filter of its own; one
 * shared projection is the whole point (see App.tsx Pillar 9 header). As a
 * defense-in-depth guard against a future caller passing raw data anyway,
 * hidden tokens (`isVisible === false`) that leak into `projectedTokens` are
 * dropped here rather than rendered, and their COUNT is shown honestly in the
 * exclusion readout instead of being silently swallowed.
 *
 * WHAT CAN NEVER APPEAR HERE: GM-whisper chat lines, private-channel tabs with
 * content behind them, DM-notes / Handouts Vault panels, GM combat controls,
 * macro bars, telemetry banners, or the navbar. Those surfaces are not mounted
 * at all — absence by construction, not CSS hiding.
 *
 * EXIT HATCHES: the on-screen ✕ control, or the Escape key (wired by App.tsx).
 */

interface StreamerViewProps {
  /** Party-visible tokens — the SAME filtered array TacticalCanvas receives. */
  projectedTokens: Token[];
  /** Public chat lines — the SAME filtered array NarrativeChat receives. */
  projectedMessages: ChatMessage[];
  /** Single escape hatch back to the normal seated view. */
  onExit: () => void;
}

export const StreamerView: React.FC<StreamerViewProps> = ({
  projectedTokens,
  projectedMessages,
  onExit,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Escape exits streamer view from anywhere inside the surface. Local to this
  // component so the hatch works even if App's global handler changes order.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onExit]);

  // Defense-in-depth: a caller that hands us raw (unprojected) data must never
  // cause hidden entities or private lines to be broadcast. Counted honestly.
  const safeTokens = projectedTokens.filter((t) => t.isVisible !== false);
  const excludedTokenCount = projectedTokens.length - safeTokens.length;
  const excludedChatCount = projectedMessages.filter(
    (m) => m.channel === 'gm' || !!m.recipient || m.content.includes('[WHISPER TO GM]')
  ).length;
  const publicMessages = projectedMessages.filter(
    (m) =>
      m.channel !== 'gm' &&
      !m.recipient &&
      !m.content.includes('[WHISPER TO GM]')
  );

  const focusSubject = safeTokens[0] ?? null;

  return (
    <div
      ref={containerRef}
      data-testid="streamer-view-root"
      className="fixed inset-0 bg-tavern-bg text-[var(--rp-parchment-100)] font-sans flex flex-col overflow-hidden"
      style={{ zIndex: 'var(--z-modal)' }}
      role="region"
      aria-label="Streamer broadcast view"
    >
      {/* Slim broadcast header: LIVE indicator + exclusion readout + exit */}
      <header className="flex items-center justify-between gap-3 px-4 py-2 border-b border-tavern-border bg-tavern-bg/90">
        <div className="flex items-center gap-3">
          <span
            data-testid="streamer-live-indicator"
            className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-red-950 border border-red-600/60 text-red-300 text-[11px] font-mono font-bold uppercase tracking-widest"
          >
            <Radio className="w-3.5 h-3.5 animate-pulse" aria-hidden="true" />
            LIVE
          </span>
          <span className="text-xs text-[var(--rp-parchment-300)]">
            Spectator-projected board &amp; public chat only
            {excludedTokenCount > 0 && (
              <>
                {' · '}
                <span data-testid="excluded-token-count" className="font-mono font-bold text-rose-300">
                  {excludedTokenCount}
                </span>{' '}
                hidden token{excludedTokenCount === 1 ? '' : 's'} withheld
              </>
            )}
            {excludedChatCount > 0 && (
              <>
                {' · '}
                <span data-testid="excluded-chat-count" className="font-mono font-bold text-rose-300">
                  {excludedChatCount}
                </span>{' '}
                private line{excludedChatCount === 1 ? '' : 's'} withheld
              </>
            )}
          </span>
        </div>

        <button
          type="button"
          data-testid="streamer-exit"
          onClick={onExit}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-tavern-border bg-[var(--tavern-surface)] hover:bg-[var(--rp-leather-700)] text-xs font-mono transition cursor-pointer"
          title="Exit streamer view (Esc)"
        >
          <X className="w-4 h-4" aria-hidden="true" />
          Exit Streamer View
        </button>
      </header>

      {/* Broadcast body: initiative rail (party-visible) + public chat. No GM
          docks, no character-sheet action surface, no macro bar. */}
      <div className="flex-1 flex min-h-0">
        <InitiativeTracker
          tokens={safeTokens}
          onNextTurn={() => {}}
          onSelectToken={() => {}}
          selectedTokenId={focusSubject?.id ?? null}
          roundNumber={0}
          isCollapsed={false}
          onToggleCollapse={() => {}}
          inCombat={false}
          combatOrder={[]}
          activeEntityId={null}
          /* Read-only broadcast surface: no Begin/End combat controls. */
          isGm={false}
          onBeginCombat={() => {}}
          onEndCombat={() => {}}
        />

        <div className="flex-1 flex flex-col min-h-0 p-4 gap-4">
          {/* Party-visible roster readout — the honest "board" stand-in for the
              capture frame: names the projection already cleared, nothing else. */}
          <section
            aria-label="Party-visible board"
            className="vtt-glass-panel rounded-2xl p-4 flex-1 overflow-y-auto vtt-scrollbar"
          >
            <h2 className="vtt-engraved text-lg font-bold font-display mb-3">
              On the Board
            </h2>
            <ul className="space-y-2">
              {safeTokens.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-3 p-2 rounded-xl vtt-surface"
                >
                  <span
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: t.color }}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-bold">{t.name}</span>
                  <span className="ml-auto text-xs font-mono text-[var(--rp-parchment-300)]">
                    HP {t.hp}/{t.maxHp} · AC {t.ac}
                  </span>
                </li>
              ))}
              {safeTokens.length === 0 && (
                <li className="text-xs text-[var(--rp-parchment-300)] font-mono">
                  Nothing visible on the projected board right now.
                </li>
              )}
            </ul>
          </section>

          {/* Public chat only — private lines were already excluded upstream
              AND are re-guarded above; publicOnly drops the GM-whisper tab so
              no private channel affordance exists in the capture at all. */}
          <NarrativeChat
            messages={publicMessages}
            onSendMessage={() => {}}
            spotlightView={{ scope: 'local-only', shares: [] }}
            publicOnly
          />
        </div>
      </div>
    </div>
  );
};
