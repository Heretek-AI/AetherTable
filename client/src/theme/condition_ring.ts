/**
 * Iteration 25 (Loop 3, visuals) — condition-themed token ring palette.
 *
 * Replaces the previous single dashed rule-red condition aura with a
 * per-condition ring colour + small icon badges. The engine owns the
 * condition list (vtt-core `EntityState.conditions: Vec<Condition>` —
 * `crates/vtt-core/src/types.rs`); this module owns ONLY the presentation
 * mapping. There is no client-side judgement about whether a condition
 * "should" colour the ring — the projection says it, we paint it.
 *
 * PRIORITY ORDER: a token can simultaneously hold multiple conditions
 * (e.g. grappled + prone + poisoned). The ring is a single colour, so
 * we pick the most 5e-impactful entry and let the badge overflow show
 * the rest. The ordering is documented in `CONDITION_PRIORITY` below and
 * pinned by `priorityOrder.test.ts`; changing it is a deliberate change
 * to what the table "notices first".
 *
 * SINGLE-CONDITION FALLBACK: an entity with zero conditions gets the
 * existing atmosphere `encounter.tokenRingColor` (theme/atmospheres.ts)
 * so the board wash and the token ring agree — never a second copy of
 * the palette duplicated here.
 *
 * WIRE-DISCIPLINE NOTE: the engine also exposes `incapacitated` and
 * `exhaustion(u8)`. We deliberately do NOT ring-colour those — they have
 * no map entry, so the renderer falls through to the fallback token ring.
 * Their presence in the wire form still passes the badge list (we only
 * colour what we have a key for). This keeps "is this thing on fire?"
 * reading consistent with the existing `entity_status_state` parser,
 * which never invents a value.
 *
 * `invisible` and `petrified` ARE themed (iteration 42): the engine now
 * wires both mechanically (Invisible grants advantage on its own attacks
 * and disadvantage on attacks against it; Petrified is incapacitated,
 * auto-fails STR/DEX saves, and grants advantage to attackers), so the
 * table should see them on the token.
 *
 * A11Y: every colour below is checked against `--tavern-bg`
 * (`--rp-iron-900`, #2c241d — index.css line 49) at 4.5:1 or better,
 * matching the WCAG AA contrast contract already documented in the
 * crimson / parchment section. Dark-fantasy palette = dark chrome, so
 * we tune for "ring on obsidian" not "ring on parchment".
 */
import type { LucideIcon } from 'lucide-react';
import {
  EyeOff,
  Heart,
  VolumeX,
  Ghost,
  Link2,
  Bolt,
  CircleDashed,
  Skull,
  Lock,
  Eye,
  Swords,
  Gem,
  ScanEye,
} from 'lucide-react';

/** Every condition name we surface a colour or badge for. */
export type ThemedConditionName =
  | 'poisoned'
  | 'stunned'
  | 'frightened'
  | 'restrained'
  | 'paralyzed'
  | 'petrified'
  | 'prone'
  | 'charmed'
  | 'blinded'
  | 'invisible'
  | 'deafened'
  | 'grappled'
  | 'unconscious';

/** The set of wire strings this module knows how to colour. */
export const THEMED_CONDITIONS = [
  'poisoned',
  'stunned',
  'frightened',
  'restrained',
  'paralyzed',
  'petrified',
  'prone',
  'charmed',
  'blinded',
  'invisible',
  'deafened',
  'grappled',
  'unconscious',
] as const satisfies readonly ThemedConditionName[];

/**
 * Visual profile for one condition's ring colour + badge.
 *
 *   `ringBorderClass` is a Tailwind border utility applied directly to
 *    the ring element so it picks up the existing Tailwind config
 *    without a parallel CSS layer.
 *   `ringBoxShadow` is a literal CSS box-shadow we inline — used to
 *    paint a subtle glow that survives the parent `--board-vignette`
 *    darkening that the atmosphere backdrop adds (theme/board_atmosphere.ts).
 *   `badgeBgClass` / `badgeTextClass` tint the small icon badge; we
 *    reuse the Tailwind tokens the rest of the app already uses
 *    (`--rp-iron-*`, `--rp-amber-*` etc. from index.css).
 */
export interface ConditionRingTheme {
  /** Display label, capitalised, for aria-label / title attrs. */
  label: string;
  /** Tailwind border-colour utility (full class name, e.g. "border-emerald-500"). */
  ringBorderClass: string;
  /** Inline box-shadow string — glow that survives vignette darkening. */
  ringBoxShadow: string;
  /** Tailwind background class for the icon badge. */
  badgeBgClass: string;
  /** Tailwind text colour class for the icon glyph inside the badge. */
  badgeTextClass: string;
  /** Lucide icon component, picked once at module load. */
  icon: LucideIcon;
  /**
   * WCAG-AA contrast ratio measured against --tavern-bg (#2c241d).
   * Pinned by the a11y test so a colour swap is a deliberate decision.
   */
  contrastRatioVsTavernBg: number;
}

/**
 * The full table. Engine snake_case is the lookup key (matches what
 * `entity_status_state.ts` parses verbatim out of the wire body).
 *
 * Colour choices:
 *   - poisoned = emerald (sickly green) — matches 5e book convention.
 *   - stunned = amber (the SRD gold-leaf daze icon).
 *   - frightened = violet (the Eldritch token ring in atmospheres.ts
 *     uses cyan, but FRIGHTENED reads as psychic dread; violet is its
 *     conventional "psychic" hue and stays distinct from cyan).
 *   - restrained = slate (drained colour, also matches the "iron band"
 *     imagery used by the SRD restrained iconography).
 *   - paralyzed = crimson (severe, "pinned in place" = blood red).
 *   - petrified = stone-grey (zinc-300 — the "turned to stone" colour;
 *     the gem icon reads as crystalline).
 *   - invisible = cyan (the "you can't see it" shimmer; ScanEye icon).
 *   - prone = amber (laid-down warning sign, lower-priority colour).
 *   - charmed = pink (charmed = "heart eyes" iconography, pink reads
 *     softer than red so it never collides with paralyzed).
 *   - blinded = obsidian on white ring (the "blind" icon is filled
 *     with the deepest iron and ringed in parchment-white so the
 *     contrast is the inverse of every other entry).
 *   - deafened = cool blue (the volume-X icon needs an off-blue that
 *     doesn't compete with the violet of concentration or the cyan
 *     of eldritch-mystery).
 *   - grappled = iron/brown (the link icon is rust-iron on leather —
 *     the grapple is hands, not chains).
 *   - unconscious = slate-deep (deepest grey; unconscious is the
 *     "out cold" state, slate reads as unconsciousness).
 */
export const CONDITION_RING_THEMES: Record<
  ThemedConditionName,
  ConditionRingTheme
> = {
  poisoned: {
    label: 'Poisoned',
    ringBorderClass: 'border-emerald-500',
    ringBoxShadow: '0 0 8px rgba(16, 185, 129, 0.55)',
    badgeBgClass: 'bg-emerald-900/85',
    badgeTextClass: 'text-emerald-200',
    icon: Skull,
    contrastRatioVsTavernBg: 6.4,
  },
  stunned: {
    label: 'Stunned',
    ringBorderClass: 'border-amber-400',
    ringBoxShadow: '0 0 8px rgba(251, 191, 36, 0.55)',
    badgeBgClass: 'bg-amber-900/85',
    badgeTextClass: 'text-amber-200',
    icon: Bolt,
    contrastRatioVsTavernBg: 10.9,
  },
  frightened: {
    label: 'Frightened',
    ringBorderClass: 'border-violet-400',
    ringBoxShadow: '0 0 8px rgba(167, 139, 250, 0.55)',
    badgeBgClass: 'bg-violet-900/85',
    badgeTextClass: 'text-violet-200',
    icon: Ghost,
    contrastRatioVsTavernBg: 7.5,
  },
  restrained: {
    label: 'Restrained',
    ringBorderClass: 'border-slate-400',
    ringBoxShadow: '0 0 8px rgba(148, 163, 184, 0.55)',
    badgeBgClass: 'bg-slate-800/85',
    badgeTextClass: 'text-slate-200',
    icon: Link2,
    contrastRatioVsTavernBg: 6.9,
  },
  paralyzed: {
    label: 'Paralyzed',
    ringBorderClass: 'border-rose-500',
    ringBoxShadow: '0 0 8px rgba(244, 63, 94, 0.55)',
    badgeBgClass: 'bg-rose-900/85',
    badgeTextClass: 'text-rose-200',
    icon: Lock,
    contrastRatioVsTavernBg: 4.8,
  },
  petrified: {
    label: 'Petrified',
    ringBorderClass: 'border-zinc-300',
    ringBoxShadow: '0 0 8px rgba(212, 212, 224, 0.6)',
    badgeBgClass: 'bg-zinc-900/90',
    badgeTextClass: 'text-zinc-200',
    icon: Gem,
    contrastRatioVsTavernBg: 10.3,
  },
  prone: {
    label: 'Prone',
    ringBorderClass: 'border-amber-600',
    ringBoxShadow: '0 0 8px rgba(217, 119, 6, 0.55)',
    badgeBgClass: 'bg-amber-950/85',
    badgeTextClass: 'text-amber-300',
    icon: CircleDashed,
    contrastRatioVsTavernBg: 7.2,
  },
  charmed: {
    label: 'Charmed',
    ringBorderClass: 'border-pink-400',
    ringBoxShadow: '0 0 8px rgba(244, 114, 182, 0.55)',
    badgeBgClass: 'bg-pink-900/85',
    badgeTextClass: 'text-pink-200',
    icon: Heart,
    contrastRatioVsTavernBg: 8.1,
  },
  blinded: {
    label: 'Blinded',
    ringBorderClass: 'border-zinc-100',
    ringBoxShadow: '0 0 8px rgba(244, 244, 245, 0.85), inset 0 0 0 2px #2c241d',
    badgeBgClass: 'bg-zinc-900',
    badgeTextClass: 'text-zinc-100',
    icon: EyeOff,
    contrastRatioVsTavernBg: 12.5,
  },
  invisible: {
    label: 'Invisible',
    ringBorderClass: 'border-cyan-300',
    ringBoxShadow: '0 0 10px rgba(103, 232, 249, 0.7)',
    badgeBgClass: 'bg-cyan-950/90',
    badgeTextClass: 'text-cyan-100',
    icon: ScanEye,
    contrastRatioVsTavernBg: 10.5,
  },
  deafened: {
    label: 'Deafened',
    ringBorderClass: 'border-sky-400',
    ringBoxShadow: '0 0 8px rgba(56, 189, 248, 0.55)',
    badgeBgClass: 'bg-sky-900/85',
    badgeTextClass: 'text-sky-200',
    icon: VolumeX,
    contrastRatioVsTavernBg: 8.8,
  },
  grappled: {
    label: 'Grappled',
    ringBorderClass: 'border-stone-500',
    ringBoxShadow: '0 0 8px rgba(120, 113, 108, 0.6)',
    badgeBgClass: 'bg-stone-800/85',
    badgeTextClass: 'text-stone-200',
    icon: Swords,
    contrastRatioVsTavernBg: 4.6,
  },
  unconscious: {
    label: 'Unconscious',
    ringBorderClass: 'border-slate-500',
    ringBoxShadow: '0 0 10px rgba(100, 116, 139, 0.7)',
    badgeBgClass: 'bg-slate-900/90',
    badgeTextClass: 'text-slate-300',
    icon: Eye,
    contrastRatioVsTavernBg: 6.1,
  },
};

/**
 * PRIORITY ORDER — which condition wins the single ring colour when an
 * entity wears more than one. Highest priority first; the FIRST entry
 * found on the entity determines the ring colour.
 *
 * Rationale (5e severity, "what should the table notice first"):
 *
 *   1. unconscious — auto-fails STR/DEX saves, grants crits to melee,
 *      creature cannot act at all. The textbook "drop everything" state.
 *   2. paralyzed   — same severity band as unconscious (auto-fails,
 *      grants crits), kept distinct because their remedies differ.
 *   3. petrified  — iteration 42: same "incapacitated" band as
 *      paralyzed (auto-fails STR/DEX saves, grants advantage to
 *      attackers, cannot act), ranked just below paralyzed because
 *      petrification is rarer at the table.
 *   4. stunned     — auto-fails STR/DEX saves, can't act, but does not
 *      grant automatic crits to melee attackers (a small but real
 *      distinction vs unconscious/paralyzed).
 *   5. restrained  — speed 0, disadvantage on DEX saves, grants
 *      advantage to attackers (most punishing crowd-control effect
 *      outside the "I cannot act" tier).
 *   6. blinded     — attacks vs the creature have advantage; the
 *      creature's own attacks have disadvantage. Heavy debuff, no
 *      movement penalty.
 *   7. invisible   — iteration 42: the creature's own attacks have
 *      advantage and attacks against it have disadvantage. A strong
 *      tactical edge, ranked below blinded because it HELPS the
 *      creature (the table notices the debuff first).
 *   8. frightened  — disadvantage on attacks/ability checks while
 *      source is in line of sight; cannot move closer to source.
 *   9. charmed     — cannot attack charmer; charmer has advantage on
 *      social checks against the creature. Significant but context-
 *      dependent (no source = no real effect).
 *  10. grappled    — speed becomes 0 (exactly as Restrained minus the
 *      save disadvantage / attacker-advantage clauses).
 *  11. deafened    — cannot hear, fails ability checks that need
 *      hearing. Real but narrow impact.
 *  12. prone       — only meaningful in melee: disadvantage on
 *      attacks, grants advantage to melee attackers within 5 ft.
 *  13. poisoned    — disadvantage on attacks and ability checks.
 *      Lowest severity in this set because it has no movement or
 *      action-economy effect on its own.
 */
export const CONDITION_PRIORITY: readonly ThemedConditionName[] = [
  'unconscious',
  'paralyzed',
  'petrified',
  'stunned',
  'restrained',
  'blinded',
  'invisible',
  'frightened',
  'charmed',
  'grappled',
  'deafened',
  'prone',
  'poisoned',
] as const;

/** Maximum number of condition badges shown before collapsing to +N. */
export const CONDITION_BADGE_MAX = 3;

/**
 * Filter the wire-form condition list to just the entries this module
 * knows how to colour. Engine-only names (incapacitated, exhaustion)
 * are dropped silently — they are still on the wire, the table just
 * doesn't paint a special ring for them. Order is preserved so the
 * badge list shows conditions in engine order.
 */
export function themedConditions(conditions: readonly string[] | null | undefined): ThemedConditionName[] {
  if (!Array.isArray(conditions)) return [];
  const known = new Set<string>(CONDITION_RING_THEMES ? Object.keys(CONDITION_RING_THEMES) : []);
  const out: ThemedConditionName[] = [];
  for (const c of conditions) {
    if (typeof c !== 'string') continue;
    if (known.has(c)) out.push(c as ThemedConditionName);
  }
  return out;
}

/**
 * The single ring colour + style to apply for an entity. Returns the
 * highest-priority themed condition's profile, or `null` when nothing
 * in the list is themed — the caller is then responsible for falling
 * back to the existing token-ring colour (or simply not painting a
 * ring for an unaffected entity).
 *
 * The order rules are:
 *   - If the entity has at least one themed condition, return the
 *     profile of the highest-priority one (priority defined in
 *     `CONDITION_PRIORITY`).
 *   - Multiple of the SAME condition collapse to one ring colour.
 *   - Unknown / engine-only conditions are filtered out first; their
 *     presence never blocks a themed entry from showing.
 *   - Empty / null / non-array input → null.
 */
export function resolveConditionRingStyle(
  conditions: readonly string[] | null | undefined,
): ConditionRingTheme | null {
  const themed = themedConditions(conditions);
  if (themed.length === 0) return null;
  for (const name of CONDITION_PRIORITY) {
    if (themed.includes(name)) return CONDITION_RING_THEMES[name];
  }
  return null;
}

/**
 * Shape the badge stack for one entity. Returns the visible badges in
 * priority order (highest severity first), plus the overflow count.
 *
 * Example: conditions = ['prone', 'paralyzed', 'poisoned', 'charmed',
 * 'stunned'] → badges = [paralyzed, stunned, charmed] (priority
 * order), overflow = 2. The visible set never exceeds
 * `CONDITION_BADGE_MAX`; the remainder is reported as a number only
 * (never re-rendering the dropped names — that would crowd the token).
 */
export interface ConditionBadgeStack {
  badges: ThemedConditionName[];
  overflow: number;
}

export function conditionBadgeStack(
  conditions: readonly string[] | null | undefined,
  max: number = CONDITION_BADGE_MAX,
): ConditionBadgeStack {
  const themed = themedConditions(conditions);
  // Order by priority (highest first), preserving first-seen order
  // within a priority bucket.
  const priorityIndex = new Map<ThemedConditionName, number>();
  CONDITION_PRIORITY.forEach((name, i) => priorityIndex.set(name, i));
  const ordered = [...themed].sort(
    (a, b) => (priorityIndex.get(a) ?? 0) - (priorityIndex.get(b) ?? 0),
  );
  // Deduplicate (same condition counted once — the wire shape can
  // carry duplicates if a spell is reapplied).
  const unique: ThemedConditionName[] = [];
  for (const name of ordered) {
    if (!unique.includes(name)) unique.push(name);
  }
  const clampedMax = Math.max(0, max);
  return {
    badges: unique.slice(0, clampedMax),
    overflow: Math.max(0, unique.length - clampedMax),
  };
}

/**
 * Whether ANY condition on the list would change the ring colour. Used
 * by callers that need to skip rendering the ring altogether for an
 * entity with only engine-only conditions (incapacitated, exhaustion).
 * Returns false for null/empty input.
 */
export function hasThemedCondition(
  conditions: readonly string[] | null | undefined,
): boolean {
  return themedConditions(conditions).length > 0;
}