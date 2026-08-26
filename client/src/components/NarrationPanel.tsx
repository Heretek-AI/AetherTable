/**
 * "Speak" section mounted as a collapsible strip inside NarrativeChat
 * (Loop 3 iteration 8).
 *
 * WHO SEES IT: every signed-in seated seat — unlike SfxPanel this is NOT a
 * GM-only surface. The gateway lets any authenticated seat narrate its OWN
 * text into a session it has standing in (POST /api/v1/media/narrate logs the
 * CALLER's user id), so the panel renders for everyone; refusals (403
 * NARRATION_NOT_A_PARTICIPANT) are rendered verbatim when they arrive rather
 * than pre-empted by client-side role hiding.
 *
 * HONEST STATES: the Speak button names the real wait ("synthesizing…") while
 * the wire call is parked, rate-limits get their own actionable notice, and
 * every other failure surfaces verbatim from narration_store's result union.
 * A cached replay says so instead of pretending to be fresh synthesis.
 *
 * VOICES: four kokoro preset chips plus a free-text override — the gateway
 * validates only length (1..64), so any voice id the upstream host accepts is
 * sendable.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Play, Volume2 } from 'lucide-react';
import {
  NARRATION_TEXT_MAX_CHARS,
  VOICE_PRESETS,
  listNarrations,
  narrateText,
  type ListNarrationsResult,
  type NarrateResult,
  type NarrationRecord,
} from '../api/narration_store';

export interface NarrationPanelProps {
  /** Engine session id when one exists; omitted ⇒ unattributed narration. */
  sessionId?: string | null;
  /** Message text offered as a one-click prefill (selected chat bubble). */
  prefillText?: string | null;
  /**
   * Initial expansion. GM seats pass true (the storyteller voice is their
   * surface); other seats default collapsed so the strip costs one row until
   * someone actually wants to speak.
   */
  defaultOpen?: boolean;
}

/** One human sentence per narrate failure outcome (mirrors SfxPanel). */
function describeNarrateFailure(failure: Exclude<NarrateResult, { outcome: 'OK' }>): string {
  switch (failure.outcome) {
    case 'NOT_SIGNED_IN':
      return `Sign-in required: ${failure.detail}`;
    case 'FORBIDDEN':
      return failure.detail;
    case 'RATE_LIMITED':
      return `Rate limited — the narration bucket allows 20 syntheses per minute. Wait a moment before speaking again. (${failure.detail})`;
    case 'REJECTED':
      return `Synthesis refused: ${failure.detail}`;
    case 'UNREACHABLE':
      return `Gateway unreachable — is the orchestrator running? (${failure.detail})`;
  }
}

function describeListFailure(failure: Exclude<ListNarrationsResult, { outcome: 'OK' }>): string {
  switch (failure.outcome) {
    case 'NOT_SIGNED_IN':
      return `Sign in to read the narration log: ${failure.detail}`;
    case 'FORBIDDEN':
      return failure.detail;
    case 'REJECTED':
      return `Could not load the narration log: ${failure.detail}`;
    case 'UNREACHABLE':
      return `Gateway unreachable — is the orchestrator running? (${failure.detail})`;
  }
}

function formatTimestamp(raw: NarrationRecord['createdAtRaw']): string {
  if (raw == null || raw === '') return 'unknown time';
  if (typeof raw === 'number') {
    const ms = raw < 10_000_000_000 ? raw * 1000 : raw; // epoch s vs ms tolerance
    try {
      return new Date(ms).toLocaleTimeString();
    } catch {
      return String(raw);
    }
  }
  // PostgresStore stringifies created_at; show it as-is (honest, not parsed).
  return raw;
}

export const NarrationPanel: React.FC<NarrationPanelProps> = ({
  sessionId = null,
  prefillText = null,
  defaultOpen = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<string>(VOICE_PRESETS[0]);
  const [customVoice, setCustomVoice] = useState('');
  const [busy, setBusy] = useState(false);
  /** Last non-OK outcome + its verbatim detail, or null while idle/OK. */
  const [failure, setFailure] = useState<Exclude<NarrateResult, { outcome: 'OK' }> | null>(null);
  /** The last successful synthesis, playable through the inline <audio>. */
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [wasCached, setWasCached] = useState(false);
  const [logRows, setLogRows] = useState<NarrationRecord[] | null>(null);
  const [logFailure, setLogFailure] = useState<string | null>(null);

  const effectiveVoice = customVoice.trim() || voice;

  const refreshLog = useCallback(async () => {
    if (!sessionId) {
      setLogFailure('No engine session yet — narrations are logged per session once one starts.');
      return;
    }
    const result = await listNarrations(sessionId);
    if (result.outcome === 'OK') {
      setLogRows(result.response.narrations);
      setLogFailure(null);
    } else {
      setLogRows(null);
      setLogFailure(describeListFailure(result));
    }
  }, [sessionId]);

  // Recent narrations fetched on mount (and whenever the session flips open).
  useEffect(() => {
    if (!open) return;
    void refreshLog();
  }, [open, refreshLog]);

  const handlePrefill = () => {
    if (prefillText) setText(prefillText.slice(0, NARRATION_TEXT_MAX_CHARS));
  };

  useEffect(() => {
    // Cheap honesty: a NEW prefill replaces the box only when the user has not
    // typed their own script yet.
    if (prefillText && !text.trim()) setText(prefillText.slice(0, NARRATION_TEXT_MAX_CHARS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillText]);

  const handleSpeak = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setFailure(null);
    let result: NarrateResult;
    try {
      result = await narrateText(trimmed, {
        ...(effectiveVoice ? { voice: effectiveVoice } : {}),
        sessionId,
      });
    } finally {
      setBusy(false);
    }
    if (result.outcome === 'OK') {
      setAudioUrl(result.audioUrl);
      setWasCached(result.cached);
      // A fresh synthesis just landed in the log — pull the list again so the
      // replay rows stay honest without a timer.
      if (!result.cached) void refreshLog();
    } else {
      setFailure(result);
    }
  }, [text, busy, effectiveVoice, sessionId, refreshLog]);

  return (
    <div className="vtt-surface rounded-lg border border-tavern-border" data-testid="narration-panel">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider cursor-pointer bg-transparent border-none text-left"
        style={{ color: 'var(--rp-parchment-300)' }}
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Volume2 className="w-3 h-3" />
        <span>Speak Aloud</span>
        {!open && audioUrl && (
          <span className="vtt-badge ml-auto normal-case" style={{ fontSize: '9px', padding: '0.05rem 0.4rem' }}>
            audio ready
          </span>
        )}
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-2">
          {/* Voice presets + free-text override */}
          <div className="flex flex-wrap items-center gap-1.5">
            {VOICE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  setVoice(preset);
                  setCustomVoice('');
                }}
                data-active={!customVoice.trim() && voice === preset}
                className={`vtt-badge cursor-pointer transition ${
                  !customVoice.trim() && voice === preset ? 'vtt-badge-success' : ''
                }`}
                style={{ fontSize: '9px', padding: '0.1rem 0.45rem' }}
              >
                {preset}
              </button>
            ))}
            <input
              type="text"
              aria-label="Custom voice id"
              placeholder="custom voice…"
              value={customVoice}
              maxLength={64}
              onChange={(e) => setCustomVoice(e.target.value)}
              className="vtt-input"
              style={{ width: '9rem', padding: '0.15rem 0.4rem', fontSize: '10px', fontFamily: 'var(--font-mono, monospace)' }}
            />
          </div>

          {/* Script textarea */}
          <textarea
            aria-label="Narration script"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={NARRATION_TEXT_MAX_CHARS}
            rows={2}
            placeholder={
              prefillText && !text
                ? undefined
                : 'Words to speak aloud… e.g. “The tavern falls silent.”'
            }
            className="vtt-input w-full font-prose resize-y"
            style={{ fontSize: '11px', padding: '0.35rem 0.5rem' }}
          />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSpeak()}
              disabled={!text.trim() || busy}
              data-testid="speak-button"
              className="vtt-btn vtt-btn-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              style={{ padding: '0.25rem 0.7rem', fontSize: '11px' }}
            >
              {busy ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>synthesizing…</span>
                </>
              ) : (
                <>
                  <Volume2 className="w-3 h-3" />
                  <span>Speak{wasCached && audioUrl ? ' (cached)' : ''}</span>
                </>
              )}
            </button>

            {prefillText && (
              <button
                type="button"
                onClick={handlePrefill}
                className="vtt-btn vtt-btn-secondary"
                style={{ padding: '0.25rem 0.55rem', fontSize: '10px' }}
                title="Load the selected message into the script box"
              >
                Use selected text
              </button>
            )}

            <span className="ml-auto text-[9px]" style={{ color: 'var(--rp-parchment-300)' }}>
              {text.length}/{NARRATION_TEXT_MAX_CHARS}
            </span>
          </div>

          {/* Result player */}
          {audioUrl && (
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- synthesized speech of user-authored text; no captions exist upstream */}
              <audio controls src={audioUrl} data-testid="narration-audio" className="h-8 w-full max-w-[22rem]" />
              {wasCached && (
                <span className="vtt-badge shrink-0" style={{ fontSize: '9px', padding: '0.05rem 0.4rem' }}>
                  cached replay
                </span>
              )}
            </div>
          )}

          {/* Honest failure states */}
          {failure && (
            <div
              className={`flex items-start gap-2 p-2 rounded-lg border text-[11px] ${
                failure.outcome === 'FORBIDDEN'
                  ? 'bg-[var(--tavern-bg)]/70 border-tavern-border'
                  : 'bg-rose-950/60 border-rose-800 text-rose-200'
              }`}
              role="alert"
              data-testid="narration-failure"
            >
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{describeNarrateFailure(failure)}</span>
            </div>
          )}

          {/* Recent narrations for this session */}
          <div className="space-y-1 pt-1 border-t border-tavern-border">
            <div className="flex items-center justify-between pt-1">
              <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--rp-parchment-300)' }}>
                Session narrations
              </span>
              <button
                type="button"
                onClick={() => void refreshLog()}
                className="opacity-60 hover:opacity-100 cursor-pointer bg-transparent border-none text-[9px]"
                style={{ color: 'var(--rp-parchment-300)' }}
              >
                refresh
              </button>
            </div>
            {logFailure && (
              <div className="text-[10px] opacity-70">{logFailure}</div>
            )}
            {logRows !== null && logRows.length === 0 && !logFailure && (
              <div className="text-[10px] opacity-50 py-0.5">No narrations logged yet this session.</div>
            )}
            {logRows !== null && logRows.length > 0 && (
              <ul className="space-y-1 max-h-[120px] overflow-y-auto vtt-scrollbar pr-1" data-testid="narration-log-list">
                {logRows.map((row) => (
                  <li
                    key={row.narration_id}
                    className="p-1.5 rounded-md bg-[var(--tavern-bg)]/70 border border-tavern-border flex items-center gap-2"
                  >
                    <span
                      className="flex-1 min-w-0 truncate font-prose text-[10px]"
                      title={`${row.text_snippet} — ${row.user_id} · ${row.voice}`}
                    >
                      “{row.text_snippet}”
                    </span>
                    <span className="shrink-0 opacity-50 text-[9px]">{formatTimestamp(row.createdAtRaw)}</span>
                    <button
                      type="button"
                      aria-label={`Replay ${row.narration_id}`}
                      onClick={() => void handleReplay(row)}
                      title="Fetch and play this narration again (cached when identical)"
                      className="shrink-0 vtt-btn vtt-btn-secondary flex items-center gap-1"
                      style={{ padding: '0.1rem 0.45rem', fontSize: '9px' }}
                    >
                      <Play className="w-2.5 h-2.5" />
                      Replay
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );

  /**
   * Replays a log row. The log stores only a snippet, so replay synthesizes
   * the snippet text again under the same voice — narrateText's cache makes an
   * identical re-speak free, and anything longer than the snippet simply
   * speaks what the log actually kept (no fabricated full-text playback).
   */
  async function handleReplay(row: NarrationRecord): Promise<void> {
    setText(row.text_snippet);
    const result = await narrateText(row.text_snippet, { voice: row.voice, sessionId });
    if (result.outcome === 'OK') {
      setAudioUrl(result.audioUrl);
      setWasCached(result.cached);
      setFailure(null);
    } else {
      setFailure(result);
    }
  }
};
