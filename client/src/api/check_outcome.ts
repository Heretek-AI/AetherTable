/**
 * GOALS.md Pillar 8 — fail-forward resolution band, surfaced to players.
 *
 * The authoritative Rust engine resolves every ability check on a FOUR-tier
 * margin (crates/vtt-core/src/actions.rs `ActionResolver::resolve_check_4tier`,
 * exposed through the gateway's POST /api/v1/engine/check). A roll is not
 * merely "pass/fail": the engine also returns
 *
 *   outcome       SCREAMING_SNAKE_CASE tier:
 *                 CRITICAL_SUCCESS | SUCCESS | SUCCESS_AT_A_COST | CRITICAL_FAILURE
 *   complication  Option<Complication> — the ACTUAL fail-forward cost fields:
 *                   description           prose ("You barely manage to pull it off…")
 *                   resource_deductions   {"stamina": 3} — resources the ledger took
 *                   inflicted_conditions  ["prone"] (serde snake_case Condition)
 *                   tactical_penalty      prose ("Loss of footing, movement halved…")
 *
 * This module is the single pure mapping from that verbatim payload onto the
 * presentation contract. It never invents costs: every number and phrase in
 * the rendered band comes from the engine's own Complication. And when a
 * response arrives WITHOUT a recognizable tier (older gateway, contract break,
 * null body) the shape is honestly `unresolved` — the client refuses to grade
 * a check the authoritative ledger did not tier.
 */

/** Verbatim mirror of vtt_core::actions::Complication. */
export interface EngineCheckComplication {
  description?: string;
  resource_deductions?: Record<string, number>;
  /** serde snake_case Condition names, e.g. "prone". */
  inflicted_conditions?: string[];
  tactical_penalty?: string | null;
}

/**
 * The raw POST /api/v1/engine/check success body as vtt-core serializes
 * TaskResolutionResult. Kept structural (optional fields) so a contract break
 * degrades to `unresolved` instead of throwing in a dice handler.
 */
export interface EngineCheckPayload {
  roll?: number;
  modifier?: number;
  total?: number;
  dc?: number;
  outcome?: string;
  complication?: EngineCheckComplication | null;
}

export type CheckOutcomeTier =
  | 'critical_success'
  | 'success'
  | 'success_at_cost'
  | 'critical_failure'
  | 'unresolved';

/** Vocabulary shared with DiceHistoryPanel's RollLogEntry outcome badges. */
export type RollOutcomeTag =
  | 'hit'
  | 'miss'
  | 'success'
  | 'failure'
  | 'crit'
  | 'fumble'
  | 'success_at_cost'
  | 'unresolved';

export interface ShapedCheckOutcome {
  tier: CheckOutcomeTier;
  /** Mechanically: did the attempt go through? Fail-forward still passes. */
  passed: boolean;
  /** Short player-facing band label, e.g. "Success at a cost". */
  headline: string;
  /** The cost/outcome text quoted from the engine's Complication, or null. */
  detail: string | null;
  /** Numeric facts kept visible even for unresolved tiers. */
  rollNatural: number | null;
  rollTotal: number | null;
  dc: number | null;
}

const TIER_BY_LABEL: Record<string, CheckOutcomeTier> = {
  CRITICAL_SUCCESS: 'critical_success',
  SUCCESS: 'success',
  SUCCESS_AT_A_COST: 'success_at_cost',
  CRITICAL_FAILURE: 'critical_failure',
};

const HEADLINE_BY_TIER: Record<CheckOutcomeTier, string> = {
  critical_success: 'Critical success',
  success: 'Success',
  success_at_cost: 'Success at a cost',
  critical_failure: 'Critical failure',
  unresolved: 'Engine unresolved',
};

export const checkPassed = (tier: CheckOutcomeTier): boolean =>
  tier === 'critical_success' || tier === 'success' || tier === 'success_at_cost';

/** Map an engine tier onto the roll-history badge vocabulary. */
export const logOutcomeForTier = (tier: CheckOutcomeTier): RollOutcomeTag => {
  switch (tier) {
    case 'critical_success':
    case 'success':
      return 'success';
    case 'success_at_cost':
      return 'success_at_cost';
    case 'critical_failure':
      return 'failure';
    default:
      return 'unresolved';
  }
};

/**
 * Format resource deductions as signed costs ("stamina −3"), deterministic
 * order, skipping zero/negative entries rather than displaying fake costs.
 */
export function formatResourceDeductions(
  deductions: Record<string, number> | undefined | null,
): string[] {
  if (!deductions || typeof deductions !== 'object') return [];
  return Object.entries(deductions)
    .filter(([, amount]) => typeof amount === 'number' && amount > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([resource, amount]) => `${resource.replace(/_/g, ' ')} −${amount}`);
}

/**
 * One-line summary of the engine's Complication — description first, then the
 * concrete costs (resources, conditions) and finally the tactical penalty.
 * Returns null when there is genuinely nothing to say.
 */
export function summarizeComplication(
  complication: EngineCheckComplication | null | undefined,
): string | null {
  if (!complication || typeof complication !== 'object') return null;
  const desc =
    typeof complication.description === 'string' ? complication.description.trim() : '';
  const tail: string[] = [];
  const costs = formatResourceDeductions(complication.resource_deductions);
  if (costs.length > 0) tail.push(costs.join(', '));
  const conditions = Array.isArray(complication.inflicted_conditions)
    ? complication.inflicted_conditions.filter((c): c is string => typeof c === 'string')
    : [];
  if (conditions.length > 0) tail.push(`inflicts ${conditions.join(', ')}`);
  const penalty =
    typeof complication.tactical_penalty === 'string'
      ? complication.tactical_penalty.trim()
      : '';
  if (penalty) tail.push(penalty);
  if (!desc && tail.length === 0) return null;
  return tail.length > 0 ? [desc, tail.join('; ')].filter(Boolean).join(' — ') : desc;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Shape a raw /api/v1/engine/check payload into the presentation contract.
 * Unknown or missing tiers degrade to the honest `unresolved` state — never a
 * guessed success/failure.
 */
export function shapeCheckOutcome(result: EngineCheckPayload | null | undefined): ShapedCheckOutcome {
  const tier: CheckOutcomeTier =
    result && typeof result === 'object' && typeof result.outcome === 'string'
      ? (TIER_BY_LABEL[result.outcome] ?? 'unresolved')
      : 'unresolved';
  const detail = tier === 'unresolved' ? null : summarizeComplication(result?.complication);
  return {
    tier,
    passed: checkPassed(tier),
    headline: HEADLINE_BY_TIER[tier],
    detail,
    rollNatural: result ? numeric(result.roll) : null,
    rollTotal: result ? numeric(result.total) : null,
    dc: result ? numeric(result.dc) : null,
  };
}
