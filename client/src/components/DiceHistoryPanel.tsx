import React, { useState } from 'react';
import { Dices, History, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

/**
 * One resolved dice roll in the session history.
 *
 * Every roll that flows through the authoritative Rust rules engine (or its
 * local fallback) should be appended here so players can audit results —
 * a staple VTT feature that also builds trust in "the engine decided" rolls.
 */
export interface RollLogEntry {
  id: string;
  /** Which gameplay surface produced the roll. */
  kind: 'attack' | 'check' | 'spell' | 'macro';
  label: string;
  /** Dice expression as rolled, e.g. "1d20 + 5". */
  expression: string;
  /** The natural d20 value, when applicable (crit/fumble highlighting). */
  natural?: number;
  total: number;
  /** Optional semantic outcome for colouring (hit/miss/success/failure). */
  outcome?: 'hit' | 'miss' | 'success' | 'failure' | 'crit' | 'fumble';
  timestamp: string;
}

interface DiceHistoryPanelProps {
  entries: RollLogEntry[];
  onClear: () => void;
}

/* Design tokens — dark tavern chrome panel, amber accents, ink numerals. */
const KIND_ICON: Record<RollLogEntry['kind'], JSX.Element> = {
  attack: <Dices className="w-3.5 h-3.5" style={{ color: 'var(--rp-crimson-500)' }} aria-hidden="true" />,
  spell: <Dices className="w-3.5 h-3.5" style={{ color: 'var(--statblock-header)' }} aria-hidden="true" />,
  check: <Dices className="w-3.5 h-3.5" style={{ color: 'var(--rp-parchment-300)' }} aria-hidden="true" />,
  macro: <Dices className="w-3.5 h-3.5" style={{ color: 'var(--tavern-accent)' }} aria-hidden="true" />,
};

/** Outcome marker badge; crits/fumbles override everything else. */
const outcomeBadge = (entry: RollLogEntry): { label: string; className: string } | null => {
  // Natural 20 / natural 1 always read as crit/fumble regardless of the DC math.
  if (entry.natural === 20 || entry.outcome === 'crit') return { label: 'Crit', className: 'vtt-badge-success' };
  if (entry.natural === 1 || entry.outcome === 'fumble') return { label: 'Fumble', className: 'vtt-badge-danger' };
  switch (entry.outcome) {
    case 'hit':
    case 'success':
      return { label: 'Success', className: 'vtt-badge-success' };
    case 'miss':
    case 'failure':
      return { label: 'Miss', className: 'vtt-badge-danger' };
    default:
      return null;
  }
};

/**
 * Collapsible floating panel showing every dice roll this session.
 * Newest first, capped by the parent (App keeps ~50 entries and persists
 * them to localStorage so a refresh doesn't lose the table's luck).
 */
export const DiceHistoryPanel: React.FC<DiceHistoryPanelProps> = ({ entries, onClear }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div
      className="absolute bottom-24 left-4 w-64 pointer-events-auto"
      style={{ zIndex: 'var(--z-chrome)' }}
      data-testid="dice-history-panel"
    >
      {/* Header / toggle */}
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
        aria-controls="dice-history-list"
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-tavern-surface/90 backdrop-blur border border-tavern-border hover:brightness-125 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-tavern-accent cursor-pointer"
      >
        <span className="flex items-center gap-2 text-xs font-semibold tracking-wide text-[var(--rp-parchment-200)]">
          <History className="w-3.5 h-3.5 text-tavern-accent" aria-hidden="true" />
          Roll History
          <span
            className="px-1.5 py-0.5 rounded-full text-[10px]"
            style={{
              background: 'color-mix(in srgb, var(--rp-leather-600) 25%, transparent)',
              color: 'var(--rp-parchment-300)',
            }}
          >
            {entries.length}
          </span>
        </span>
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--rp-parchment-300)]" aria-hidden="true" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-[var(--rp-parchment-300)]" aria-hidden="true" />
        )}
      </button>

      {isExpanded && (
        <div
          id="dice-history-list"
          role="log"
          aria-label="Dice roll history"
          className="mt-2 max-h-72 overflow-y-auto rounded-lg bg-tavern-surface/95 backdrop-blur border border-tavern-border shadow-xl shadow-black/40 vtt-scrollbar"
        >
          {entries.length === 0 && (
            <p className="px-3 py-4 text-xs text-[var(--rp-parchment-300)] italic font-prose">
              No rolls yet — your legend starts with a d20.
            </p>
          )}

          {/* Roll ledger — hairline leather-divided rows */}
          {entries.map((entry) => {
            const badge = outcomeBadge(entry);
            return (
              <div
                key={entry.id}
                className="flex items-center gap-2 px-3 py-2 border-b last:border-b-0"
                style={{
                  borderColor: 'color-mix(in srgb, var(--tavern-border) 55%, transparent)',
                  borderLeft: `2px solid ${
                    badge?.className === 'vtt-badge-success'
                      ? 'color-mix(in srgb, var(--state-success) 55%, transparent)'
                      : badge?.className === 'vtt-badge-danger'
                      ? 'color-mix(in srgb, var(--state-danger) 55%, transparent)'
                      : 'transparent'
                  }`,
                }}
              >
                {KIND_ICON[entry.kind]}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-[var(--rp-parchment-200)] font-prose">
                    {entry.label}
                  </p>
                  <p className="truncate text-[10px] font-prose text-[var(--rp-parchment-300)]">
                    {entry.expression} · {entry.timestamp}
                  </p>
                </div>
                {badge && (
                  <span className={`${badge.className} shrink-0`} style={{ fontSize: '9px', padding: '0.05rem 0.4rem' }}>
                    {badge.label}
                  </span>
                )}
                <span className="font-prose text-lg font-bold tabular-nums text-[var(--rp-parchment-100)] leading-none">
                  {entry.total}
                </span>
              </div>
            );
          })}

          {entries.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] text-[var(--rp-parchment-300)] hover:bg-tavern-bg/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-tavern-accent cursor-pointer group"
            >
              <Trash2
                className="w-3 h-3 group-hover:text-[var(--state-danger)]"
                aria-hidden="true"
              />
              Clear history
            </button>
          )}
        </div>
      )}
    </div>
  );
};
