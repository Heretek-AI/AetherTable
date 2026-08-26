/**
 * GM-facing "Ambience" section mounted inside AudioMixerModal (next to
 * SfxPanel), backed by the iteration-17 gateway surface:
 *   GET  /api/v1/media/ambience        — catalog; any authenticated seat.
 *   POST /api/v1/media/ambience/{slug} — generate + serve wav; GM/admin ONLY.
 *
 * GATING: identical convention to SfxPanel. When a `userRole` is plumbed
 * through, non-staff seats get a lock notice and no cards; when it is not,
 * cards render optimistically and the gateway's 403 MEDIA_AMBIENCE_FORBIDDEN
 * copy is surfaced verbatim as the same GM-only notice. Client-side hiding is
 * cosmetic either way — the server decides.
 *
 * HONEST STATES: while the first fetch of a slug is parked the card reads
 * "fetching…", because a cold generation really can take tens of seconds
 * upstream. Replays are instant from the client-side decoded-buffer cache and
 * show "cached". Exactly one bed loops at a time — picking another preset
 * crossfades nothing, it just swaps the loop source.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CloudRain, Flame, Lock, Moon, Music2, Square, Swords, Waves } from 'lucide-react';
import {
  currentAmbienceSlug,
  listAmbiencePresets,
  playAmbience,
  startAmbienceLoop,
  stopAmbienceLoop,
  type AmbienceListResult,
  type AmbiencePlayResult,
  type AmbiencePreset,
} from '../api/ambience_store';

export type AmbienceSeatRole = 'gm' | 'admin' | 'player' | 'spectator';

interface AmbiencePanelProps {
  /**
   * Seat role from the App-shell role projection. Required: with iteration 23
   * (F12) the AudioMixerModal plumbs App.tsx's `userRole` straight through, so
   * a non-staff seat never renders catalog cards and never fetches the catalog
   * (the cached-buffer cleanup on demotion lives in api/ambience_store.ts).
   */
  userRole: AmbienceSeatRole;
}

/** Fallback art per slug so each card reads differently without image assets. */
const SLUG_ICONS: Record<string, React.ReactNode> = {
  'tavern-murmur': <Flame className="w-4 h-4 text-[var(--rp-amber-600)]" />,
  'dungeon-drips': <Waves className="w-4 h-4 text-sky-300" />,
  'forest-night': <Moon className="w-4 h-4 text-emerald-300" />,
  'battle-clash': <Swords className="w-4 h-4 text-rose-300" />,
  thunderstorm: <CloudRain className="w-4 h-4 text-indigo-300" />,
  campfire: <Flame className="w-4 h-4 text-orange-300" />,
};

function describePlayFailure(failure: Exclude<AmbiencePlayResult, { outcome: 'OK' }>): string {
  switch (failure.outcome) {
    case 'NOT_SIGNED_IN':
      return `Sign-in required: ${failure.detail}`;
    case 'FORBIDDEN':
      return failure.detail;
    case 'UNKNOWN_PRESET':
      return `Unknown soundscape: ${failure.detail}`;
    case 'REJECTED':
      return `Soundscape refused: ${failure.detail}`;
    case 'UNREACHABLE':
      return `Gateway unreachable — is the orchestrator running? (${failure.detail})`;
  }
}

function describeListFailure(failure: Exclude<AmbienceListResult, { outcome: 'OK' }>): string {
  switch (failure.outcome) {
    case 'NOT_SIGNED_IN':
      return `Sign in to browse the ambience catalog.`;
    case 'REJECTED':
      return `Catalog unavailable: ${failure.detail}`;
    case 'UNREACHABLE':
      return `Gateway unreachable — is the orchestrator running? (${failure.detail})`;
  }
}

export const AmbiencePanel: React.FC<AmbiencePanelProps> = ({ userRole }) => {
  const [presets, setPresets] = useState<AmbiencePreset[]>([]);
  const [listFailure, setListFailure] = useState<string | null>(null);
  /** Slug whose generation is currently parked on the wire (or decoding). */
  const [busySlug, setBusySlug] = useState<string | null>(null);
  /** Last play failure + its verbatim detail, or null while idle/OK. */
  const [failure, setFailure] = useState<Exclude<AmbiencePlayResult, { outcome: 'OK' }> | null>(
    null,
  );
  const [playingSlug, setPlayingSlug] = useState<string | null>(currentAmbienceSlug());

  const isStaff = userRole === 'gm' || userRole === 'admin';


  useEffect(() => {
    if (!isStaff) return;
    let cancelled = false;
    void listAmbiencePresets().then((result) => {
      if (cancelled) return;
      if (result.outcome === 'OK') setPresets(result.presets);
      else setListFailure(describeListFailure(result));
    });
    return () => {
      cancelled = true;
    };
  }, [isStaff]);

  // Keep the indicator truthful even when something else stops the bed.
  useEffect(() => {
    const tick = setInterval(() => setPlayingSlug(currentAmbienceSlug()), 500);
    return () => clearInterval(tick);
  }, []);

  const handlePreset = useCallback(
    async (preset: AmbiencePreset) => {
      if (busySlug) return;
      if (playingSlug === preset.slug && currentAmbienceSlug() === preset.slug) {
        stopAmbienceLoop();
        setPlayingSlug(null);
        return;
      }
      setBusySlug(preset.slug);
      setFailure(null);
      let result: AmbiencePlayResult;
      try {
        result = await playAmbience(preset.slug);
      } finally {
        setBusySlug(null);
      }
      if (result.outcome === 'OK') {
        startAmbienceLoop(result.slug);
        setPlayingSlug(currentAmbienceSlug());
      } else {
        setFailure(result);
      }
    },
    [busySlug, playingSlug],
  );

  const handleStop = useCallback(() => {
    stopAmbienceLoop();
    setPlayingSlug(null);
  }, []);

  if (!isStaff) {
    return (
      <div className="vtt-surface p-4 rounded-xl space-y-2 shadow" data-testid="ambience-panel">
        <div className="flex items-center gap-1.5 vtt-engraved text-xs font-bold uppercase tracking-wider">
          <Music2 className="w-3.5 h-3.5" />
          <span>Ambience</span>
        </div>
        <div className="flex items-start gap-2 p-2.5 bg-[var(--tavern-bg)]/70 border border-[var(--tavern-border)] rounded-lg text-[11px] font-mono text-[#f5ede0]/80">
          <Lock className="w-4 h-4 mt-0.5 shrink-0 text-[var(--rp-amber-600)]" />
          <span>
            GM-only seat feature. Ambient soundscapes play to the whole table, so only GM or
            admin seats may trigger them.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="vtt-surface p-4 rounded-xl space-y-3 shadow" data-testid="ambience-panel">
      <div className="flex items-center justify-between">
        <span className="vtt-engraved text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
          <Music2 className="w-3.5 h-3.5" />
          <span>Ambience</span>
        </span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[var(--tavern-bg)] text-[#f5ede0]/80 border border-[var(--tavern-border)]">
          Curated Soundscapes · Table-wide
        </span>
      </div>

      {/* Playing indicator with stop */}
      {playingSlug && (
        <div
          aria-label={`Playing ${
            presets.find((p) => p.slug === playingSlug)?.label ?? playingSlug
          }`}
          data-testid="ambience-playing"
          className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--rp-amber-600)]/15 border border-[var(--tavern-accent)]/50 text-[11px] font-mono text-amber-200"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="truncate">
              Playing{' '}
              {presets.find((p) => p.slug === playingSlug)?.label ?? playingSlug}
            </span>
          </span>
          <button
            type="button"
            aria-label="Stop ambience"
            onClick={handleStop}
            title="Stop the ambience bed"
            className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--tavern-bg)] hover:bg-rose-900/40 text-[#f5ede0] border border-[var(--tavern-border)] text-[10px] font-mono transition"
          >
            <Square className="w-3 h-3" />
            Stop
          </button>
        </div>
      )}

      {/* Preset cards */}
      {listFailure ? (
        <div
          role="alert"
          className="flex items-start gap-2 p-2.5 rounded-lg border bg-rose-950/60 border-rose-800 text-rose-200 text-[11px] font-mono"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{listFailure}</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-[220px] overflow-y-auto vtt-scrollbar pr-1">
          {presets.map((preset) => {
            const isBusy = busySlug === preset.slug;
            const isActive = playingSlug === preset.slug;
            return (
              <button
                key={preset.slug}
                type="button"
                disabled={busySlug !== null}
                onClick={() => void handlePreset(preset)}
                title={isActive ? 'Tap again to stop' : `Start ${preset.label}`}
                className={`text-left p-2 rounded-lg border transition font-mono ${
                  isActive
                    ? 'bg-[var(--rp-amber-600)]/20 border-[var(--tavern-accent)] ring-1 ring-[var(--tavern-accent)]'
                    : 'bg-[var(--tavern-bg)]/70 border-[var(--tavern-border)] hover:border-[var(--tavern-accent)]/50 hover:bg-[var(--rp-amber-600)]/10'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 min-w-0">
                    {SLUG_ICONS[preset.slug] ?? <Music2 className="w-4 h-4 text-[#f5ede0]/70" />}
                    <span className="text-[11px] font-bold text-[#f5ede0] truncate">
                      {preset.label}
                    </span>
                  </span>
                  {preset.cached && (
                    <span className="shrink-0 text-[8px] font-mono uppercase tracking-wide px-1 py-0.5 rounded bg-emerald-950/70 text-emerald-300 border border-emerald-800/60">
                      Cached
                    </span>
                  )}
                  {isBusy && (
                    <span className="shrink-0 flex items-center gap-1 text-[9px] text-amber-300 animate-pulse">
                      fetching…
                    </span>
                  )}
                </span>
                <span className="block mt-0.5 text-[10px] leading-snug text-[#f5ede0]/65 line-clamp-2">
                  {preset.description}
                </span>
                <span className="block mt-0.5 text-[9px] font-mono text-[#f5ede0]/45">
                  {Math.round(preset.loop_seconds)} s loop
                </span>
              </button>
            );
          })}
          {presets.length === 0 && !listFailure && (
            <div className="col-span-full text-[11px] font-mono text-[#f5ede0]/45 py-1">
              Loading soundscape catalog…
            </div>
          )}
        </div>
      )}

      {/* Honest failure state for the last play attempt */}
      {failure && (
        <div
          role="alert"
          className={`flex items-start gap-2 p-2.5 rounded-lg border text-[11px] font-mono ${
            failure.outcome === 'FORBIDDEN'
              ? 'bg-[var(--tavern-bg)]/70 border-[var(--tavern-border)] text-[#f5ede0]/85'
              : 'bg-rose-950/60 border-rose-800 text-rose-200'
          }`}
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{describePlayFailure(failure)}</span>
        </div>
      )}
    </div>
  );
};
