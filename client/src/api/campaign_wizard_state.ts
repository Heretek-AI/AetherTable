/**
 * Pure state & payload-shaping logic for the Guided Campaign Setup Wizard
 * (GOALS.md Pillar 2).
 *
 * Extracted from CampaignWizardModal.tsx (iteration 70) so the step-gating
 * rules and the honest "what actually goes on the wire" contract are
 * unit-testable without a DOM.
 *
 * HONEST API BOUNDARY (iteration 73): POST /api/v1/lobbies accepts the table
 * name plus three OPTIONAL, validated selections — `rule_version`
 * ('srd_5_1' | 'srd_5_2'), `starting_level` (1..20) and `party_size` (2..8).
 * `wizardCreateRequestBody()` shapes exactly those four fields (clamped into
 * the legal bands so the wire body can never carry an out-of-range value) and
 * `clientOnlyWizardFields()` reports whatever still has no server home —
 * currently nothing. Nothing here fabricates a field the gateway rejects.
 */

/** Rule versions the wizard can record as a preference. */
export type CampaignRuleVersion = 'srd_5_1' | 'srd_5_2';

/** Wizard selections carried back to App on completion. */
export interface CampaignWizardConfig {
  name: string;
  /** Atmosphere preset id ('default' = stock obsidian/parchment palette). */
  atmosphereId: string;
  ruleVersion: CampaignRuleVersion;
  partySize: number;
  startingLevel: number;
}

/** Ordered step labels; index === step index in the modal. */
export const WIZARD_STEPS = ['Identity', 'Ruleset', 'Party', 'Review'] as const;

/**
 * Forward gate for `step`: the Identity step requires a non-blank campaign
 * name (it is the one field the create call cannot do without), every later
 * step always has a valid default. The Review step reuses this gate for
 * Create.
 */
export function canAdvanceStep(step: number, campaignName: string): boolean {
  if (!Number.isInteger(step) || step < 0 || step >= WIZARD_STEPS.length) return false;
  return step === 0 ? campaignName.trim().length > 0 : true;
}

export interface RuleVersionOption {
  id: CampaignRuleVersion;
  label: string;
  blurb: string;
}

export const RULE_VERSION_OPTIONS: readonly RuleVersionOption[] = [
  {
    id: 'srd_5_2',
    label: 'SRD 5.2',
    blurb:
      'Full stat blocks, untruncated spells, magic items, feats, origins and glossary from the 5.2 fixtures.',
  },
  {
    id: 'srd_5_1',
    label: 'SRD 5.1',
    blurb: 'The classic 5.1 compendium extracted from the official SRD markdown.',
  },
];

/** Display label for a stored rule-version id; unknown ids pass through. */
export function ruleVersionLabel(id: CampaignRuleVersion | string): string {
  return RULE_VERSION_OPTIONS.find((rv) => rv.id === id)?.label ?? String(id);
}

export const PARTY_SIZE_MIN = 2;
export const PARTY_SIZE_MAX = 8;
export const DEFAULT_PARTY_SIZE = 4;
/** Starting levels the wizard offers (characters keep their own persisted level). */
export const STARTING_LEVEL_OPTIONS = [1, 2, 3] as const;

/** Coerce arbitrary slider/input input into a legal party size. */
export function clampPartySize(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PARTY_SIZE;
  return Math.min(PARTY_SIZE_MAX, Math.max(PARTY_SIZE_MIN, Math.round(n)));
}

/** Coerce arbitrary input into one of the offered starting levels (nearest). */
export function clampStartingLevel(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return STARTING_LEVEL_OPTIONS[0];
  let best: number = STARTING_LEVEL_OPTIONS[0];
  let bestDist = Infinity;
  for (const lvl of STARTING_LEVEL_OPTIONS) {
    const dist = Math.abs(lvl - n);
    if (dist < bestDist) {
      best = lvl;
      bestDist = dist;
    }
  }
  return best;
}

/** The table-shaping selections that ride the create call (name excluded). */
export interface WizardTableSelections {
  ruleVersion: CampaignRuleVersion;
  partySize: number;
  startingLevel: number;
}

/**
 * The exact request body sent to POST /api/v1/lobbies. This is the whole
 * contract: the trimmed name plus the gateway's three optional, validated
 * selections in snake_case. Values are re-clamped here so a caller holding
 * garbage state still cannot put an out-of-band number on the wire — the
 * gateway answers 422 to anything outside rule_version's literal union,
 * level 1..20 or party size 2..8, and a refused create must stay a user
 * mistake, never a client bug.
 */
export function wizardCreateRequestBody(
  campaignName: string,
  selections: WizardTableSelections
): {
  name: string;
  rule_version: CampaignRuleVersion;
  starting_level: number;
  party_size: number;
} {
  return {
    name: campaignName.trim(),
    rule_version: selections.ruleVersion,
    starting_level: clampStartingLevel(selections.startingLevel),
    party_size: clampPartySize(selections.partySize),
  };
}

/** One wizard selection that has no server-side home yet. */
export interface ClientOnlyField {
  /** Human-readable field name shown in the review/post-create note. */
  field: string;
  value: string;
  /** Why it is not on the wire today. */
  reason: string;
}

/**
 * Enumerate the wizard selections that are DATA ONLY. Rendered verbatim by the
 * modal so the honesty note cannot drift from what the code actually sends.
 *
 * Since iteration 71 the gateway accepts rule_version / starting_level /
 * party_size and this module sends all of them, so the ledger is empty; it
 * stays as the single source of truth for any future selection that regresses
 * to client-only status (atmosphere is local-only by design but is applied via
 * theme/atmospheres.ts, not carried on this call, so it is not listed).
 */
export function clientOnlyWizardFields(config: CampaignWizardConfig): ClientOnlyField[] {
  // Every table selection now rides the wire (see wizardCreateRequestBody);
  // the parameter is kept so the call sites and the honesty contract stay
  // stable if a future selection regresses to client-only status.
  void config;
  return [];
}

/**
 * Review-step rows: `[label, displayValue]` pairs summarizing every selection.
 * Which selections stay client-side is reported separately by
 * `clientOnlyWizardFields`, so the review stays scannable and the honesty note
 * lives in exactly one place. Atmosphere is listed here for completeness but
 * never leaves the browser (see `clientOnlyWizardFields`).
 */
export function reviewRows(config: CampaignWizardConfig): Array<[string, string]> {
  return [
    ['Campaign', config.name.trim() || '(unnamed)'],
    ['Atmosphere', config.atmosphereId],
    ['Rules', ruleVersionLabel(config.ruleVersion)],
    ['Party size', `${config.partySize} player seats`],
    ['Starting level', `${config.startingLevel}`],
  ];
}
