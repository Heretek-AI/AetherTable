import React, { useMemo, useState } from 'react';
import { Dices, ChevronDown, ChevronUp, ShieldQuestion, AlertTriangle } from 'lucide-react';
import {
  evaluateDiceExpression,
  randomSeed,
  validateDiceExpression,
  type LocalRollResult,
} from '../api/dice_notation';

/**
 * DiceRollerPanel — free-form ad-hoc dice roller ("roll me 2d20kh1+1d4").
 *
 * HONESTY BOUNDARY (iteration 11): every roll made here is evaluated LOCALLY
 * in the browser via the dice_notation port of the engine grammar. It is
 * THEATER — it never reaches the Rust rules engine, is absent from the
 * authoritative ledger and the DiceHistoryPanel audit log by construction,
 * and must never gate a rules decision. The result badge says exactly that.
 * Skill/attack/spell/macro flows keep resolving through engineCheck etc.
 */
export const LOCAL_ROLL_BADGE = 'local roll — not sent to the engine';

/** One-tap chips for the rolls players actually ask for at the table. */
const QUICK_CHIPS: Array<{ label: string; expression: string }> = [
  { label: 'd20', expression: 'd20' },
  { label: 'd100', expression: 'd100' },
  { label: 'Advantage', expression: '2d20kh1' },
  { label: 'Disadvantage', expression: '2d20kl1' },
  { label: 'd6', expression: 'd6' },
  { label: 'Fireball', expression: '8d6' },
];

interface DiceRollerPanelProps {
  /** Collapsed state is owned here; the parent just places the panel. */
  defaultExpanded?: boolean;
}

export const DiceRollerPanel: React.FC<DiceRollerPanelProps> = ({ defaultExpanded = false }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState<LocalRollResult | null>(null);

  // Live validation hint — pure client-side mirror of the engine grammar.
  const validationError = useMemo(
    () => (expression.trim() ? validateDiceExpression(expression) : null),
    [expression]
  );

  const roll = (expr: string): void => {
    if (validateDiceExpression(expr)) return;
    try {
      setResult(evaluateDiceExpression(expr));
    } catch {
      // Semantic rejection (e.g. kh3 on 2 dice) — surface via the same band.
      setResult(null);
    }
  };

  return (
    <div
      className="absolute bottom-24 left-4 w-64 pointer-events-auto"
      style={{ zIndex: 'var(--z-chrome)' }}
      data-testid="dice-roller-panel"
    >
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
        aria-controls="dice-roller-body"
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-tavern-surface/90 backdrop-blur border border-tavern-border hover:brightness-125 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-tavern-accent cursor-pointer"
      >
        <span className="flex items-center gap-2 text-xs font-semibold tracking-wide text-[var(--rp-parchment-200)]">
          <Dices className="w-3.5 h-3.5 text-tavern-accent" aria-hidden="true" />
          Quick Roll
        </span>
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--rp-parchment-300)]" aria-hidden="true" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-[var(--rp-parchment-300)]" aria-hidden="true" />
        )}
      </button>

      {isExpanded && (
        <div
          id="dice-roller-body"
          data-testid="dice-roller-body"
          className="mt-2 rounded-lg bg-tavern-surface/95 backdrop-blur border border-tavern-border shadow-xl shadow-black/40 vtt-scrollbar p-3 space-y-2"
        >
          {/* Free-form expression input with live grammar hints */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              roll(expression);
            }}
            className="flex items-center gap-1.5"
          >
            <input
              type="text"
              value={expression}
              onChange={(e) => setExpression(e.target.value)}
              placeholder="2d20kh1+1d4"
              aria-label="Custom dice expression"
              aria-invalid={validationError !== null}
              spellCheck={false}
              className="min-w-0 flex-1 bg-black/30 border border-[var(--tavern-border)] rounded-lg px-2 py-1.5 text-xs font-mono text-[var(--rp-parchment-100)] focus:outline-none focus:border-amber-500"
            />
            <button
              type="submit"
              disabled={!expression.trim() || validationError !== null}
              title="Roll locally"
              className="px-2.5 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition cursor-pointer"
            >
              Roll
            </button>
          </form>

          {validationError && (
            <p role="alert" data-testid="dice-roller-hint" className="text-[10px]" style={{ color: 'var(--state-danger)' }}>
              {validationError}
            </p>
          )}

          {/* Quick chips */}
          <div className="flex flex-wrap gap-1" data-testid="dice-roller-chips">
            {QUICK_CHIPS.map((chip) => (
              <button
                key={chip.expression}
                type="button"
                onClick={() => {
                  setExpression(chip.expression);
                  roll(chip.expression);
                }}
                title={`Roll ${chip.expression}`}
                className="px-2 py-0.5 rounded-md border border-[var(--tavern-border)] bg-black/30 hover:border-[var(--tavern-accent)]/60 hover:brightness-125 text-[10px] font-mono text-[var(--rp-parchment-300)] transition cursor-pointer"
              >
                {chip.label}
              </button>
            ))}
          </div>

          {/* Result readout */}
          {result && (
            <div
              data-testid="dice-roller-result"
              className="rounded-lg border p-2"
              style={{
                borderColor: 'color-mix(in srgb, var(--tavern-border) 55%, transparent)',
                background: 'color-mix(in srgb, var(--rp-leather-600) 15%, transparent)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[10px] font-mono text-[var(--rp-parchment-300)]">
                  {result.expression}
                </span>
                <span
                  data-testid="local-roll-badge"
                  className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-full text-[9px]"
                  style={{
                    background: 'color-mix(in srgb, var(--state-warning, #b45309) 18%, transparent)',
                    color: 'var(--state-warning, #f59e0b)',
                  }}
                  title="Rolled in this browser only. The rules engine did not see this roll."
                >
                  <ShieldQuestion className="w-3 h-3" aria-hidden="true" />
                  local roll — not sent to the engine
                </span>
              </div>

              {/* Per-die breakdown with kept/dropped styling */}
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {result.terms.flatMap((term, ti) =>
                  term.dice.length > 0 ? (
                    term.dice.flatMap((die, di) => [
                      ...die.explodedTo.map((extra, ei) => (
                        <li key={`t${ti}d${di}x${ei}`} className="die-chip kept">
                          {extra}
                          <span className="text-[8px] opacity-70">!</span>
                        </li>
                      )),
                      die.kept ? (
                        <li key={`t${ti}d${di}`} className="die-chip kept">
                          {die.value}
                          {die.rerolledFrom !== undefined && (
                            <span className="text-[8px] line-through opacity-60"> {die.rerolledFrom}</span>
                          )}
                        </li>
                      ) : (
                        <li key={`t${ti}d${di}`} className="die-chip dropped">
                          {die.value}
                        </li>
                      ),
                    ])
                  ) : (
                    <li key={`t${ti}`} className="die-chip constant">
                      {term.constant < 0 ? '−' : '+'}
                      {Math.abs(term.constant)}
                    </li>
                  )
                )}
              </ul>

              <p
                data-testid="dice-roller-total"
                className="mt-1 text-right font-prose text-2xl font-bold tabular-nums leading-none text-[var(--rp-parchment-100)]"
              >
                {result.total}
              </p>
              {result.dropped.length > 0 && (
                <p className="text-right text-[9px] text-[var(--rp-parchment-300)]">
                  dropped: {result.dropped.join(', ')}
                </p>
              )}
            </div>
          )}

          {/* Honesty footnote */}
          <p className="flex items-start gap-1 text-[9px] leading-snug text-[var(--rp-parchment-300)] italic font-prose">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
            Ad-hoc rolls happen in your browser for flavor and speed. Rules-authoritative
            rolls (attacks, checks, saves) always resolve through the engine.
          </p>
        </div>
      )}
    </div>
  );
};
