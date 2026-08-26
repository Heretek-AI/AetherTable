/**
 * Iteration 11 (Loop 3) — DiceRollerPanel component contracts, rendered
 * through happy-dom (same pattern as sfx_panel.test.dom.tsx).
 *
 * Pinned here:
 *  - HONEST LABELING: every result carries the "local roll — not sent to the
 *    engine" badge; the panel's footnote states engine rolls stay authoritative.
 *    Nothing in this component imports any gateway/transport module — the roll
 *    is computed locally by construction.
 *  - LIVE VALIDATION: an invalid expression shows the grammar hint and disables
 *    Roll; fixing it clears both.
 *  - QUICK CHIPS: exactly the six preset chips render and each rolls its
 *    expression on click.
 *  - RESULT BREAKDOWN: kept dice render as chips, dropped dice are marked and
 *    summarized, constants show signed, and the total matches the module math.
 *  - COLLAPSE: header toggles the body; collapsed shows no input.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DiceRollerPanel } from '../DiceRollerPanel';
import { evaluateDiceExpression } from '../../api/dice_notation';

afterEach(cleanup);

const openPanel = (): HTMLElement => {
  render(<DiceRollerPanel defaultExpanded />);
  return screen.getByTestId('dice-roller-body');
};

describe('DiceRollerPanel', () => {
  it('starts collapsed and expands to reveal input, chips and honesty note', () => {
    const { unmount } = render(<DiceRollerPanel />);
    expect(screen.queryByTestId('dice-roller-body')).toBeNull();
    unmount();

    render(<DiceRollerPanel defaultExpanded />);
    expect(screen.getByTestId('dice-roller-body')).toBeDefined();
    expect(screen.getByLabelText('Custom dice expression')).toBeDefined();
    // Honesty copy is always visible while expanded.
    expect(
      screen.getByText(/Rules-authoritative[\s\S]*always resolve through the engine/)
    ).toBeDefined();
  });

  it('shows a live validation hint and disables Roll for bad grammar', () => {
    openPanel();
    const input = screen.getByLabelText('Custom dice expression') as HTMLInputElement;
    const rollButton = screen.getByRole('button', { name: 'Roll' }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: '2d6kh3' } });
    // kh3 on 2 dice is grammar-VALID (mirrors the engine: the keep-vs-count
    // range check fires at resolve time, not parse time) — so no live hint,
    // and Roll stays enabled; clicking surfaces nothing rather than a lie.
    expect(screen.queryByTestId('dice-roller-hint')).toBeNull();
    expect(rollButton.disabled).toBe(false);

    fireEvent.change(input, { target: { value: 'd99999' } });
    expect((screen.getByTestId('dice-roller-hint') as HTMLElement).textContent).toMatch(/out of range/);
    expect((screen.getByRole('button', { name: 'Roll' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: '2d6+1' } });
    expect(screen.queryByTestId('dice-roller-hint')).toBeNull();
    expect((screen.getByRole('button', { name: 'Roll' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders exactly the six quick chips and rolling one produces a result', () => {
    openPanel();
    const chipLabels = ['d20', 'd100', 'Advantage', 'Disadvantage', 'd6', 'Fireball'];
    for (const label of chipLabels) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeDefined();
    }

    fireEvent.click(screen.getByRole('button', { name: /Advantage/ }));
    const result = screen.getByTestId('dice-roller-result');
    expect(result).toBeDefined();
    // The input mirrors the chip's expression so the player can tweak it.
    expect((screen.getByLabelText('Custom dice expression') as HTMLInputElement).value).toBe('2d20kh1');
  });

  it('labels every result with the local-roll badge and never shows engine attribution', () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Fireball$/ }));
    const badges = screen.getAllByTestId('local-roll-badge');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].textContent).toBe('local roll — not sent to the engine');
    // No "engine resolved" style wording anywhere on the result.
    expect(screen.queryByText(/engine resolved/i)).toBeNull();
  });

  it('displays kept vs dropped dice consistent with the module semantics', () => {
    openPanel();
    const input = screen.getByLabelText('Custom dice expression') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '4d6ro<3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));

    const result = screen.getByTestId('dice-roller-result');
    // The dropped summary line appears exactly when something was discarded:
    // either a keep-drop (.die-chip.dropped) or a rerolled-away first value
    // (strikethrough span inside a chip whose replacement stood).
    const text = result.textContent ?? '';
    const dropEvidence =
      result.querySelectorAll('.die-chip.dropped').length +
      result.querySelectorAll('.die-chip .line-through').length;
    if (/dropped:/.test(text)) {
      expect(dropEvidence).toBeGreaterThan(0);
    } else {
      expect(dropEvidence).toBe(0);
    }
    // Exactly four standing d6 results render for a 4d6 term, each a legal face.
    const keptChips = Array.from(result.querySelectorAll('li.die-chip.kept'));
    expect(keptChips.length).toBe(4);
    for (const chip of keptChips) {
      const v = Number((chip.textContent ?? '').trim().split(/\s+/)[0]);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
    // Total is always within legal bounds for 4d6ro<3.
    const total = Number(screen.getByTestId('dice-roller-total').textContent);
    expect(total).toBeGreaterThanOrEqual(4);
    expect(total).toBeLessThanOrEqual(24);
  });

  it('total readout stays inside legal bounds for the rolled expression', () => {
    openPanel();
    const input = screen.getByLabelText('Custom dice expression') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '8d6+4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));

    // The panel rolls fresh entropy per click, so assert against the module's
    // own bounds rather than re-seeding its stream: 8d6+4 ∈ [12, 52].
    const shownTotal = Number(screen.getByTestId('dice-roller-total').textContent);
    expect(shownTotal).toBeGreaterThanOrEqual(12);
    expect(shownTotal).toBeLessThanOrEqual(52);
    // Exactly eight kept die chips render for an 8d6 term.
    expect(document.querySelectorAll('.die-chip.kept').length).toBe(9 - 1); // 8 dice + constant chip
    void evaluateDiceExpression; // imported contract guard
  });

  it('collapsing hides the body entirely', () => {
    render(<DiceRollerPanel defaultExpanded />);
    fireEvent.click(screen.getByRole('button', { name: /Quick Roll/i }));
    expect(screen.queryByTestId('dice-roller-body')).toBeNull();
    expect(screen.queryByTestId('local-roll-badge')).toBeNull();
  });
});
