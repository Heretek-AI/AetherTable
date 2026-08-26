/**
 * GM-facing "Generated SFX" section mounted inside AudioMixerModal.
 *
 * GATING: when the caller hands us a `userRole` we gate locally (a player sees
 * a lock notice and no controls). When no role is plumbed through we still
 * render the section and rely on the GATEWAY as the authority: POST
 * /api/v1/media/sfx answers non-staff seats with 403 MEDIA_SFX_FORBIDDEN,
 * which this panel renders verbatim as the same GM-only notice. Client-side
 * hiding is cosmetic either way — the server decides.
 *
 * HONEST STATES (no spinner theater):
 *  - generating: the button says generation can take 30-90 s because the
 *    upstream media gateway really is that slow on first synthesis.
 *  - rate-limited: an explicit notice rather than a generic failure, since the
 *    fix ("wait, don't hammer Generate") is different from other errors.
 *  - decode failure / rejection: surfaced verbatim from sfx_library's result.
 *
 * PLAYBACK PATH: routes through `playCachedSfx` — see sfx_library.ts module
 * docs for why this is the plain-Audio element fallback (flat stereo, no HRTF)
 * instead of the spatial engine: globalSpatialAudio imports cleanly but its
 * one-shot methods synthesize oscillator cues and accept no AudioBuffer.
 */
import React, { useCallback, useState } from 'react';
import { AlertTriangle, Loader2, Lock, Play, Volume2, Wand2 } from 'lucide-react';
import {
  SFX_PRESETS,
  generateSfx,
  playCachedSfx,
  type SfxResult,
} from '../api/sfx_library';

export type SfxSeatRole = 'gm' | 'admin' | 'player' | 'spectator';

interface SfxPanelProps {
  /**
   * Seat role from the App-shell role projection. Required: with iteration 23
   * (F12) the AudioMixerModal plumbs App.tsx's `userRole` straight through so a
   * non-staff seat renders ONLY the lock notice and the prompt input /
   * Generate button are absent (the catalog-bucket cleanup on demotion lives
   * in api/sfx_library.ts; this panel just gates the UI surface).
   */
  userRole: SfxSeatRole;
}

const GENERATION_HINT = 'generating… can take 30-90 s';

export const SfxPanel: React.FC<SfxPanelProps> = ({ userRole }) => {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  /** Last non-OK outcome + its verbatim detail, or null while idle/OK. */
  const [failure, setFailure] = useState<SfxResult | null>(null);
  /** Prompts decoded this session, newest last (mirrors the session cache). */
  const [library, setLibrary] = useState<string[]>([]);

  const isStaff = userRole === 'gm' || userRole === 'admin';

  const handleGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setFailure(null);
    let result: SfxResult;
    try {
      // A cached replay resolves instantly; a fresh generation holds the
      // "can take 30-90 s" state for real.
      result = await generateSfx(trimmed);
    } finally {
      setBusy(false);
    }
    if (result.outcome === 'OK') {
      setLibrary((prev) => (prev.includes(result.prompt) ? prev : [...prev, result.prompt]));
      playCachedSfx(result.prompt);
    } else {
      setFailure(result);
    }
  }, [prompt, busy]);

  if (!isStaff) {
    return (
      <div className="vtt-surface p-4 rounded-xl space-y-2 shadow" data-testid="sfx-panel">
        <div className="flex items-center gap-1.5 vtt-engraved text-xs font-bold uppercase tracking-wider">
          <Wand2 className="w-3.5 h-3.5" />
          <span>Generated Sound Effects</span>
        </div>
        <div className="flex items-start gap-2 p-2.5 bg-[var(--tavern-bg)]/70 border border-[var(--tavern-border)] rounded-lg text-[11px] font-mono text-[#f5ede0]/80">
          <Lock className="w-4 h-4 mt-0.5 shrink-0 text-[var(--rp-amber-600)]" />
          <span>
            GM-only seat feature. Generated sound effects play to the whole table,
            so only GM or admin seats may trigger them.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="vtt-surface p-4 rounded-xl space-y-3 shadow" data-testid="sfx-panel">
      <div className="flex items-center justify-between">
        <span className="vtt-engraved text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
          <Wand2 className="w-3.5 h-3.5" />
          <span>Generated Sound Effects</span>
        </span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[var(--tavern-bg)] text-[#f5ede0]/80 border border-[var(--tavern-border)]">
          AI Synthesis · Table-wide
        </span>
      </div>

      {/* Preset chips */}
      <div className="flex flex-wrap gap-1.5">
        {SFX_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setPrompt(preset)}
            className={`px-2 py-1 rounded-lg text-[10px] font-mono border transition ${
              prompt === preset
                ? 'bg-[var(--rp-amber-600)]/20 text-amber-300 border-[var(--tavern-accent)]'
                : 'bg-[var(--tavern-bg)] text-[#f5ede0]/75 hover:text-[#f5ede0] border-[var(--tavern-border)]'
            }`}
          >
            {preset}
          </button>
        ))}
      </div>

      {/* Prompt + Generate & Play */}
      <div className="flex gap-2">
        <input
          type="text"
          value={prompt}
          maxLength={300}
          placeholder="Describe the sound… e.g. portcullis slamming shut"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleGenerate();
          }}
          className="flex-1 min-w-0 bg-[var(--tavern-bg)] border border-[var(--tavern-border)] rounded-lg px-2.5 py-1.5 text-xs font-mono text-[#f5ede0] placeholder:text-[#f5ede0]/40 focus:outline-none focus:border-[var(--tavern-accent)]"
        />
        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={!prompt.trim() || busy}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--rp-amber-600)]/25 hover:bg-[var(--rp-amber-600)]/40 disabled:opacity-50 disabled:cursor-not-allowed text-[#f5ede0] border border-[var(--tavern-accent)] text-[11px] font-mono transition"
        >
          {busy ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>{GENERATION_HINT}</span>
            </>
          ) : (
            <>
              <Volume2 className="w-3.5 h-3.5" />
              <span>Generate &amp; Play</span>
            </>
          )}
        </button>
      </div>

      {/* Honest failure states */}
      {failure && failure.outcome !== 'OK' && (
        <div
          className={`flex items-start gap-2 p-2.5 rounded-lg border text-[11px] font-mono ${
            failure.outcome === 'FORBIDDEN'
              ? 'bg-[var(--tavern-bg)]/70 border-[var(--tavern-border)] text-[#f5ede0]/85'
              : 'bg-rose-950/60 border-rose-800 text-rose-200'
          }`}
          role="alert"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{describeFailure(failure)}</span>
        </div>
      )}

      {/* Session library */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-mono text-[#f5ede0]/60 uppercase font-bold">
          Session Library ({library.length})
        </div>
        {library.length === 0 ? (
          <div className="text-[11px] font-mono text-[#f5ede0]/45 py-1">
            Nothing generated yet this session.
          </div>
        ) : (
          <div className="space-y-1 max-h-[120px] overflow-y-auto vtt-scrollbar pr-1">
            {library.map((item) => (
              <div
                key={item}
                className="p-2 bg-[var(--tavern-bg)]/70 border border-[var(--tavern-border)] rounded-lg flex items-center justify-between gap-2"
              >
                <span className="text-[11px] font-mono text-[#f5ede0] truncate">{item}</span>
                <button
                  type="button"
                  aria-label={`Play ${item}`}
                  onClick={() => playCachedSfx(item)}
                  title="Replay (instant — cached, no regeneration)"
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--tavern-surface)] hover:bg-[var(--rp-amber-600)]/30 text-[#f5ede0] border border-[var(--tavern-border)] text-[10px] font-mono transition"
                >
                  <Play className="w-3 h-3" />
                  Play
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * One human sentence per failure outcome. FORBIDDEN keeps the server's own
 * MEDIA_SFX_FORBIDDEN copy visible (it explains WHY it is staff-only); the
 * rate-limit case gets actionable advice instead of raw HTTP noise.
 */
function describeFailure(failure: Exclude<SfxResult, { outcome: 'OK' }>): string {
  switch (failure.outcome) {
    case 'NOT_SIGNED_IN':
      return `Sign-in required: ${failure.detail}`;
    case 'FORBIDDEN':
      return failure.detail;
    case 'RATE_LIMITED':
      return `Rate limited — the synthesis provider's quota is drained. Wait a minute before generating again. (${failure.detail})`;
    case 'REJECTED':
      return `Generation refused: ${failure.detail}`;
    case 'UNREACHABLE':
      return `Gateway unreachable — is the orchestrator running? (${failure.detail})`;
  }
}
