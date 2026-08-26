/**
 * Iteration 25 (Loop 3, visuals) — TacticalCanvas condition-ring render contract.
 *
 * Renders TacticalCanvas through happy-dom against a minimal prop set and
 * asserts the wire-to-render mapping that lives in
 * theme/condition_ring.ts. Pinned contracts:
 *
 *  - per-condition: the rendered ring div carries the matching
 *    `data-condition` attribute AND a Tailwind border class from the
 *    theme table (poisoned → border-emerald-500, …);
 *  - priority: multiple themed conditions collapse to the highest-priority
 *    theme;
 *  - no-conditions: NO `data-testid="token-condition-ring"` element is
 *    rendered (so the existing token-ring colour stays as the only
 *    visual signal);
 *  - overflow: when conditions exceed CONDITION_BADGE_MAX (3) the badge
 *    row renders a `+N` chip;
 *  - hidden entity (Pillar 9): a token whose projection hides it
 *    (`isVisible: false`) never reaches this component, so the canvas
 *    itself has no DOM for it. The contract under test is: even when an
 *    upstream caller accidentally leaks an `isVisible: false` token
 *    through the props, NO condition ring and NO badge renders for it —
 *    the existing token-render path keeps it visualised, but the new
 *    ring/badge surface is gated by the same `isVisible` filter so a
 *    secret is never painted.
 *  - a11y: every badge has an `aria-label`, the ring has a descriptive
 *    `title` and WCAG-AA contrast is verified through the theme module's
 *    `contrastRatioVsTavernBg` field (see theme/__tests__/condition_ring.test.ts).
 *
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TacticalCanvas, type Token } from '../TacticalCanvas';

afterEach(cleanup);

const baseProps = {
  tokens: [] as Token[],
  onTokenMove: () => undefined,
  selectedTokenId: null as string | null,
  onSelectToken: () => undefined,
  remoteCursors: [],
};

function tokenOf(overrides: Partial<Token>): Token {
  return {
    id: 't1',
    name: 'Tester',
    x: 1,
    y: 1,
    hp: 10,
    maxHp: 10,
    ac: 12,
    color: '#3b82f6',
    isPlayer: false,
    ...overrides,
  };
}

describe('TacticalCanvas — per-condition ring colour', () => {
  const perConditionCases: Array<{
    condition: string;
    expectedClass: string;
    expectedAttr: string;
  }> = [
    { condition: 'poisoned', expectedClass: 'border-emerald-500', expectedAttr: 'poisoned' },
    { condition: 'stunned', expectedClass: 'border-amber-400', expectedAttr: 'stunned' },
    { condition: 'frightened', expectedClass: 'border-violet-400', expectedAttr: 'frightened' },
    { condition: 'restrained', expectedClass: 'border-slate-400', expectedAttr: 'restrained' },
    { condition: 'paralyzed', expectedClass: 'border-rose-500', expectedAttr: 'paralyzed' },
    { condition: 'prone', expectedClass: 'border-amber-600', expectedAttr: 'prone' },
    { condition: 'charmed', expectedClass: 'border-pink-400', expectedAttr: 'charmed' },
    { condition: 'blinded', expectedClass: 'border-zinc-100', expectedAttr: 'blinded' },
    { condition: 'deafened', expectedClass: 'border-sky-400', expectedAttr: 'deafened' },
    { condition: 'grappled', expectedClass: 'border-stone-500', expectedAttr: 'grappled' },
    { condition: 'unconscious', expectedClass: 'border-slate-500', expectedAttr: 'unconscious' },
  ];

  for (const c of perConditionCases) {
    it(`renders the ring with the documented colour for ${c.condition}`, () => {
      render(
        <TacticalCanvas
          {...baseProps}
          tokens={[tokenOf({ id: `t-${c.condition}`, conditions: [c.condition] })]}
        />,
      );
      const ring = screen.getByTestId('token-condition-ring');
      expect(ring.getAttribute('data-condition')).toBe(c.expectedAttr);
      expect(ring.className).toContain(c.expectedClass);
      // Solid, NOT dashed (the pre-iteration-25 indicator was dashed red).
      expect(ring.className).not.toContain('border-dashed');
    });
  }
});

describe('TacticalCanvas — priority order', () => {
  it('paralyzed beats poisoned when both are on the same entity', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({ id: 't-priority-1', conditions: ['poisoned', 'paralyzed'] }),
        ]}
      />,
    );
    const ring = screen.getByTestId('token-condition-ring');
    expect(ring.getAttribute('data-condition')).toBe('paralyzed');
    expect(ring.className).toContain('border-rose-500');
  });

  it('unconscious beats stunned + charmed + prone + poisoned', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-priority-2',
            conditions: ['poisoned', 'prone', 'charmed', 'stunned', 'unconscious'],
          }),
        ]}
      />,
    );
    const ring = screen.getByTestId('token-condition-ring');
    expect(ring.getAttribute('data-condition')).toBe('unconscious');
    expect(ring.className).toContain('border-slate-500');
  });

  it('engine-only entries never block a themed entry', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-priority-3',
            conditions: ['invisible', 'incapacitated', 'frightened'],
          }),
        ]}
      />,
    );
    const ring = screen.getByTestId('token-condition-ring');
    expect(ring.getAttribute('data-condition')).toBe('frightened');
  });
});

describe('TacticalCanvas — no conditions fallback', () => {
  it('omits the condition ring entirely when no conditions are present', () => {
    render(
      <TacticalCanvas {...baseProps} tokens={[tokenOf({ id: 't-clean' })]} />,
    );
    expect(screen.queryByTestId('token-condition-ring')).toBeNull();
    expect(screen.queryByTestId('token-condition-badges')).toBeNull();
  });

  it('omits the condition ring when only engine-only conditions are present', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-engine-only',
            conditions: ['invisible', 'incapacitated', 'petrified'],
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId('token-condition-ring')).toBeNull();
    expect(screen.queryByTestId('token-condition-badges')).toBeNull();
  });
});

describe('TacticalCanvas — badge stack with overflow', () => {
  it('shows up to 3 badges and a +N overflow chip when conditions exceed the cap', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-overflow',
            conditions: [
              'poisoned',
              'prone',
              'frightened',
              'charmed',
              'unconscious',
              'stunned',
            ],
          }),
        ]}
      />,
    );
    // Priority order: unconscious > stunned > frightened > charmed > prone > poisoned.
    // Cap = 3 → visible = [unconscious, stunned, frightened], overflow = 3.
    const badges = screen.getByTestId('token-condition-badges');
    const badgeNodes = badges.querySelectorAll('[data-testid^="condition-badge-"]');
    const badgeIds = Array.from(badgeNodes).map((n) => n.getAttribute('data-testid'));
    expect(badgeIds).toEqual([
      'condition-badge-unconscious',
      'condition-badge-stunned',
      'condition-badge-frightened',
    ]);
    expect(badges.querySelector('[data-testid="condition-badge-charmed"]')).toBeNull();
    expect(badges.querySelector('[data-testid="condition-badge-prone"]')).toBeNull();
    expect(badges.querySelector('[data-testid="condition-badge-poisoned"]')).toBeNull();
    const overflow = screen.getByTestId('condition-overflow');
    expect(overflow.textContent).toBe('+3');
    expect(overflow.getAttribute('aria-label')).toBe('3 additional conditions');
  });

  it('renders no overflow chip when conditions fit under the cap', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-no-overflow',
            conditions: ['poisoned', 'frightened'],
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId('condition-overflow')).toBeNull();
  });

  it('deduplicates a condition that the wire carries twice', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-dedup',
            conditions: ['poisoned', 'poisoned', 'frightened'],
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId('condition-badge-poisoned')).not.toBeNull();
    expect(screen.queryByTestId('condition-badge-frightened')).not.toBeNull();
    expect(screen.queryByTestId('condition-overflow')).toBeNull();
  });
});

describe('TacticalCanvas — hidden entities never paint a ring or badge', () => {
  it('renders no condition ring or badge for an isVisible:false token', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-secret',
            name: 'Shadow Doppelganger',
            // The projection filter in App.tsx drops isVisible:false tokens for
            // spectators, so a real spectator never sees this — but if the
            // upstream contract ever leaks (eg. a non-spectator seat passing
            // through a hidden draft token), the NEW ring/badge surface must
            // NOT paint a condition colour for it. Other surfaces already keep
            // the token visible (it's still rendered as a sprite / HP bar so
            // the GM can manage it); only the condition theme is hidden.
            isVisible: false,
            conditions: ['paralyzed', 'poisoned', 'unconscious'],
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId('token-condition-ring')).toBeNull();
    expect(screen.queryByTestId('token-condition-badges')).toBeNull();
  });

  it('still renders the token sprite so the GM can manage it', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-secret-2',
            name: 'Shadow Doppelganger',
            isVisible: false,
            conditions: ['paralyzed'],
          }),
        ]}
      />,
    );
    // The token name label IS rendered (visible surface), but NOT the ring.
    expect(screen.queryByTestId('token-condition-ring')).toBeNull();
    expect(screen.getByText('Shadow Doppelganger')).not.toBeNull();
  });
});

describe('TacticalCanvas — accessibility (a11y)', () => {
  it('every condition badge carries an aria-label', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-a11y',
            conditions: ['paralyzed', 'frightened'],
          }),
        ]}
      />,
    );
    for (const c of ['paralyzed', 'frightened']) {
      const badge = screen.getByTestId(`condition-badge-${c}`);
      expect(badge.getAttribute('aria-label')).toBeTruthy();
      expect(badge.getAttribute('aria-label')).toContain(
        c.charAt(0).toUpperCase() + c.slice(1),
      );
    }
  });

  it('the ring carries a descriptive title including the active condition', () => {
    render(
      <TacticalCanvas
        {...baseProps}
        tokens={[
          tokenOf({
            id: 't-a11y-ring',
            conditions: ['paralyzed', 'poisoned'],
          }),
        ]}
      />,
    );
    const ring = screen.getByTestId('token-condition-ring');
    const title = ring.getAttribute('title') ?? '';
    // Highest-priority condition wins the parenthetical suffix.
    expect(title).toContain('Paralyzed');
    expect(title).toContain('poisoned');
    expect(title).toContain('paralyzed');
  });
});