/**
 * Iteration 58 — ConcentrationBadge.
 *
 * A tiny presentational component that surfaces "this entity is concentrating"
 * wherever a token or sheet has the data to support it. The engine (vtt-core,
 * vtt-server) is the source of truth: the badge only renders when the parsed
 * session-state projection carries a non-empty `concentration` field, and the
 * label uses ONLY the engine-provided spell_id. There is no local fallback,
 * no "spellbook guess", and no animation that could imply a status we cannot
 * prove — absence of `concentration` data means the badge simply does not
 * render.
 *
 * The save-outcome toast (transient, self-dismissing) is also rendered here
 * so concentration messaging stays in one visual family.
 */
import React, { useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import type { ConcentrationInfo } from '../api/concentration_state';

/** Plain-text label a `ConcentrationBadge` shows: never invented, only formatted. */
export function concentrationBadgeLabel(info: ConcentrationInfo | null | undefined): string | null {
  if (!info) return null;
  if (info.spellId && info.spellId.length > 0) return `Concentrating: ${info.spellId}`;
  if (info.startedRound !== undefined) return `Concentrating since round ${info.startedRound}`;
  return 'Concentrating';
}

interface ConcentrationBadgeProps {
  info: ConcentrationInfo | null | undefined;
  /** Visual treatment: `inline` for sheet lines, `token` for ring overlays. */
  variant?: 'inline' | 'token';
  className?: string;
}

export const ConcentrationBadge: React.FC<ConcentrationBadgeProps> = ({
  info,
  variant = 'inline',
  className,
}) => {
  const label = concentrationBadgeLabel(info);
  if (!label) return null;
  if (variant === 'token') {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-testid="concentration-badge-token"
        className={
          'inline-flex items-center justify-center w-4 h-4 rounded-full ' +
          'bg-violet-500/90 text-white shadow-md ring-1 ring-violet-200/80 ' +
          (className ?? '')
        }
      >
        <Sparkles className="w-2.5 h-2.5" />
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-label={label}
      data-testid="concentration-badge-inline"
      className={
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full ' +
        'bg-violet-900/40 border border-violet-300/40 text-violet-100 ' +
        'text-[10px] font-semibold uppercase tracking-wider ' +
        (className ?? '')
      }
    >
      <Sparkles className="w-3 h-3" />
      <span>{label}</span>
    </span>
  );
};

/**
 * Transient (auto-dismissing) concentration-save notice. Renders nothing when
 * `message` is null — the surface is reserved only when the parent actually
 * has a real save line to surface. Dismiss timer is reset whenever a new
 * message arrives so rapid back-to-back disclosures stay visible long enough
 * to read.
 */
interface TransientSaveToastProps {
  message: string | null;
  onDismiss: () => void;
  /** Lifetime in ms before auto-dismiss; defaults to 6s. */
  durationMs?: number;
}

export const TransientSaveToast: React.FC<TransientSaveToastProps> = ({
  message,
  onDismiss,
  durationMs = 6000,
}) => {
  useEffect(() => {
    if (!message) return undefined;
    const handle = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(handle);
  }, [message, durationMs, onDismiss]);

  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="concentration-save-toast"
      className="fixed top-4 right-4 z-50 max-w-sm px-3 py-2 rounded-lg shadow-xl
                 bg-violet-950/95 border border-violet-300/50 text-violet-50
                 text-xs font-mono"
    >
      {message}
    </div>
  );
};
