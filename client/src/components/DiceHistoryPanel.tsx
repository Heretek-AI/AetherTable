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

const KIND_ICON: Record<RollLogEntry['kind'], JSX.Element> = {
  attack: <Dices className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" />,
  spell: <Dices className="w-3.5 h-3.5 text-violet-400" aria-hidden="true" />,
  check: <Dices className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />,
  macro: <Dices className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />,
};

/** Tailwind classes per outcome; crits/fumbles override everything else. */
const outcomeStyle = (entry: RollLogEntry): string => {
  // Natural 20 / natural 1 always read as crit/fumble regardless of the DC math.
  if (entry.natural === 20 || entry.outcome === 'crit') return 'text-amber-300 border-amber-500/40 bg-amber-500/10';
  if (entry.natural === 1 || entry.outcome === 'fumble') return 'text-rose-300 border-rose-500/40 bg-rose-500/10';
  switch (entry.outcome) {
    case 'hit':
    case 'success':
      return 'text-emerald-300 border-emerald-500/30';
    case 'miss':
    case 'failure':
      return 'text-rose-300 border-rose-500/30';
    default:
      return 'text-slate-200 border-slate-700';
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
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 hover:bg-slate-800/90 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
      >
        <span className="flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-200">
          <History className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
          Roll History
          <span className="px-1.5 py-0.5 rounded-full bg-slate-800 text-[10px] font-mono text-slate-400">
            {entries.length}
          </span>
        </span>
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
        )}
      </button>

      {isExpanded && (
        <div
          id="dice-history-list"
          role="log"
          aria-label="Dice roll history"
          className="mt-2 max-h-72 overflow-y-auto rounded-lg bg-slate-900/95 backdrop-blur border border-slate-800 divide-y divide-slate-800/70 shadow-xl shadow-black/40"
        >
          {entries.length === 0 && (
            <p className="px-3 py-4 text-xs text-slate-500 italic">
              No rolls yet — your legend starts with a d20.
            </p>
          )}

          {entries.map((entry) => (
            <div key={entry.id} className={`flex items-center gap-2 px-3 py-2 border-l-2 ${outcomeStyle(entry)}`}>
              {KIND_ICON[entry.kind]}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium">{entry.label}</p>
                <p className="truncate text-[10px] font-mono text-slate-500">
                  {entry.expression} · {entry.timestamp}
                </p>
              </div>
              <span className="font-mono text-sm font-bold tabular-nums">{entry.total}</span>
            </div>
          ))}

          {entries.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] text-slate-500 hover:text-rose-400 hover:bg-slate-800/50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
            >
              <Trash2 className="w-3 h-3" aria-hidden="true" />
              Clear history
            </button>
          )}
        </div>
      )}
    </div>
  );
};
