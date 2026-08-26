/**
 * Iteration 25 — unit tests for theme/condition_ring.ts.
 *
 * Pins the wire-to-render mapping for the condition-themed token ring
 * against the engine's snake_case condition spelling
 * (crates/vtt-core/src/types.rs `pub enum Condition`). Central disciplines:
 *
 *   - unknown conditions are dropped silently (engine-only names like
 *     `incapacitated`, `invisible`, `petrified`, `exhaustion` flow
 *     through the wire but never invent a colour);
 *   - the priority order is documented and stable;
 *   - WCAG-AA contrast against `--tavern-bg` is never below 4.5:1.
 */
import { describe, expect, it } from 'vitest';
import {
  CONDITION_BADGE_MAX,
  CONDITION_PRIORITY,
  CONDITION_RING_THEMES,
  THEMED_CONDITIONS,
  conditionBadgeStack,
  hasThemedCondition,
  resolveConditionRingStyle,
  themedConditions,
  type ThemedConditionName,
} from '../condition_ring';

describe('condition_ring THEMED_CONDITIONS / PRIORITY tables', () => {
  it('THEMED_CONDITIONS contains every priority entry exactly once', () => {
    expect(new Set(THEMED_CONDITIONS).size).toBe(THEMED_CONDITIONS.length);
    expect(new Set(CONDITION_PRIORITY).size).toBe(CONDITION_PRIORITY.length);
    expect([...THEMED_CONDITIONS].sort()).toEqual([...CONDITION_PRIORITY].sort());
  });

  it('the priority order matches the documented rationale', () => {
    // Documented severity order — first element is "what the table
    // notices first" when an entity wears multiple conditions.
    expect([...CONDITION_PRIORITY]).toEqual([
      'unconscious',
      'paralyzed',
      'stunned',
      'restrained',
      'blinded',
      'frightened',
      'charmed',
      'grappled',
      'deafened',
      'prone',
      'poisoned',
    ]);
  });

  it('CONDITION_RING_THEMES covers every themed condition', () => {
    for (const name of THEMED_CONDITIONS) {
      expect(CONDITION_RING_THEMES[name]).toBeDefined();
    }
  });

  it('every entry has the required Tailwind + contrast fields', () => {
    for (const name of THEMED_CONDITIONS) {
      const t = CONDITION_RING_THEMES[name];
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.ringBorderClass.startsWith('border-')).toBe(true);
      expect(t.ringBoxShadow.length).toBeGreaterThan(0);
      expect(t.badgeBgClass.startsWith('bg-')).toBe(true);
      expect(t.badgeTextClass.startsWith('text-')).toBe(true);
      // WCAG-AA contract against the obsidian chrome (--tavern-bg).
      expect(t.contrastRatioVsTavernBg).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('themedConditions (wire filter)', () => {
  it('returns [] for null / non-array / empty input', () => {
    expect(themedConditions(undefined)).toEqual([]);
    expect(themedConditions(null)).toEqual([]);
    expect(themedConditions([])).toEqual([]);
  });

  it('drops engine-only names (incapacitated / invisible / petrified)', () => {
    expect(
      themedConditions(['incapacitated', 'invisible', 'petrified']),
    ).toEqual([]);
  });

  it('keeps known names verbatim and ignores any unknown entries', () => {
    expect(
      themedConditions([
        'poisoned',
        'unconscious',
        'NOT_A_REAL_CONDITION',
        'frightened',
      ]),
    ).toEqual(['poisoned', 'unconscious', 'frightened']);
  });
});

describe('resolveConditionRingStyle (single ring colour)', () => {
  it('returns null when no conditions or only engine-only conditions', () => {
    expect(resolveConditionRingStyle(undefined)).toBeNull();
    expect(resolveConditionRingStyle(null)).toBeNull();
    expect(resolveConditionRingStyle([])).toBeNull();
    expect(resolveConditionRingStyle(['incapacitated'])).toBeNull();
    expect(resolveConditionRingStyle(['invisible', 'exhaustion'])).toBeNull();
  });

  it('returns the matching theme for a single themed condition', () => {
    for (const name of THEMED_CONDITIONS) {
      expect(resolveConditionRingStyle([name])?.label).toBe(
        CONDITION_RING_THEMES[name].label,
      );
    }
  });

  it('picks the HIGHEST-priority themed condition when several are present', () => {
    // poisoned + paralyzed → paralyzed wins (paralyzed > poisoned).
    expect(resolveConditionRingStyle(['poisoned', 'paralyzed'])?.label).toBe(
      'Paralyzed',
    );
    // charmed + frightened + stunned → stunned wins.
    expect(
      resolveConditionRingStyle(['charmed', 'frightened', 'stunned'])?.label,
    ).toBe('Stunned');
    // poisoned + prone + unconscious → unconscious wins (top of priority).
    expect(
      resolveConditionRingStyle(['poisoned', 'prone', 'unconscious'])?.label,
    ).toBe('Unconscious');
    // grappled + restrained → restrained wins (restrained > grappled).
    expect(resolveConditionRingStyle(['grappled', 'restrained'])?.label).toBe(
      'Restrained',
    );
  });

  it('ignores engine-only entries when picking the ring colour', () => {
    // Engine-only entries must not block a themed entry from showing.
    expect(
      resolveConditionRingStyle(['incapacitated', 'poisoned'])?.label,
    ).toBe('Poisoned');
    expect(
      resolveConditionRingStyle(['invisible', 'exhaustion', 'frightened'])?.label,
    ).toBe('Frightened');
  });

  it('deduplicates the same condition even when the wire carries it twice', () => {
    expect(resolveConditionRingStyle(['poisoned', 'poisoned'])?.label).toBe(
      'Poisoned',
    );
  });
});

describe('conditionBadgeStack (badge list with overflow)', () => {
  it('returns empty badges and zero overflow for null / empty / unthemed input', () => {
    expect(conditionBadgeStack(undefined)).toEqual({ badges: [], overflow: 0 });
    expect(conditionBadgeStack(null)).toEqual({ badges: [], overflow: 0 });
    expect(conditionBadgeStack([])).toEqual({ badges: [], overflow: 0 });
    expect(conditionBadgeStack(['incapacitated'])).toEqual({
      badges: [],
      overflow: 0,
    });
  });

  it('orders badges by priority (highest severity first)', () => {
    const stack = conditionBadgeStack(['poisoned', 'paralyzed', 'frightened']);
    // Priority order says paralyzed > frightened > poisoned.
    expect(stack.badges).toEqual(['paralyzed', 'frightened', 'poisoned']);
    expect(stack.overflow).toBe(0);
  });

  it('clamps the visible list to CONDITION_BADGE_MAX (3) and reports overflow', () => {
    const stack = conditionBadgeStack([
      'poisoned',
      'prone',
      'frightened',
      'charmed',
      'unconscious',
      'stunned',
    ]);
    // Priority order: unconscious > stunned > charmed > frightened > prone > poisoned.
    expect(stack.badges).toHaveLength(CONDITION_BADGE_MAX);
    expect(stack.badges[0]).toBe('unconscious');
    expect(stack.overflow).toBe(3);
  });

  it('deduplicates before counting', () => {
    const stack = conditionBadgeStack(['poisoned', 'poisoned', 'prone']);
    expect(stack.badges).toEqual(['prone', 'poisoned']);
    expect(stack.overflow).toBe(0);
  });

  it('respects a custom max (caller override)', () => {
    const stack = conditionBadgeStack(['poisoned', 'prone', 'frightened'], 1);
    expect(stack.badges).toEqual(['frightened']);
    expect(stack.overflow).toBe(2);
  });

  it('handles a max of 0 by returning only overflow', () => {
    const stack = conditionBadgeStack(['poisoned', 'frightened'], 0);
    expect(stack.badges).toEqual([]);
    expect(stack.overflow).toBe(2);
  });
});

describe('hasThemedCondition', () => {
  it('is true iff at least one themed condition is on the wire', () => {
    expect(hasThemedCondition(undefined)).toBe(false);
    expect(hasThemedCondition(null)).toBe(false);
    expect(hasThemedCondition([])).toBe(false);
    expect(hasThemedCondition(['incapacitated'])).toBe(false);
    expect(hasThemedCondition(['poisoned'])).toBe(true);
    expect(hasThemedCondition(['invisible', 'poisoned'])).toBe(true);
  });
});

describe('WCAG-AA contrast contract against --tavern-bg', () => {
  // The --tavern-bg primitive is --rp-iron-900 = #2c241d (index.css).
  // We pin contrast >= 4.5:1 so any future palette tweak is a deliberate
  // decision (and tests flag a regression before it ships).
  it('every themed ring border colour meets >= 4.5:1', () => {
    for (const name of THEMED_CONDITIONS) {
      const ratio = CONDITION_RING_THEMES[name].contrastRatioVsTavernBg;
      expect(ratio, `condition ${name} should be WCAG-AA compliant`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('covers all 11 themed conditions', () => {
    const expectedNames: ThemedConditionName[] = [
      'poisoned',
      'stunned',
      'frightened',
      'restrained',
      'paralyzed',
      'prone',
      'charmed',
      'blinded',
      'deafened',
      'grappled',
      'unconscious',
    ];
    expect(THEMED_CONDITIONS).toEqual(expectedNames);
  });
});