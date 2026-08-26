/**
 * Pure state & payload-shaping logic for the Guided Campaign Setup Wizard
 * (GOALS.md Pillar 2).
 *
 * Extracted from CampaignWizardModal.tsx (iteration 70) so the step-gating
 * rules and the honest "what actually goes on the wire" contract are
 * unit-testable without a DOM.
 *
 * HONEST API BOUNDARY: POST /api/v1/lobbies accepts exactly `{ name }`.
 * Rule version, party size and starting level are collected by the wizard and
 * recorded client-side only — see `clientOnlyWizardFields()` for the machine-
 * readable list the UI renders as its "server support pending" note. Nothing
 * in this module fabricates a server field that does not exist.
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
 * name (it is the ONLY field POST /api/v1/lobbies accepts), every later step
 * always has a valid default. The Review step reuses this gate for Create.
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

/**
 * The exact request body sent to POST /api/v1/lobbies. This is the whole
 * contract: the name, trimmed. Every other wizard selection travels through
 * `CampaignWizardConfig` on the client only.
 */
export function wizardCreateRequestBody(campaignName: string): { name: string } {
  return { name: campaignName.trim() };
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
 */
export function clientOnlyWizardFields(config: CampaignWizardConfig): ClientOnlyField[] {
  return [
    {
      field: 'Rule version',
      value: ruleVersionLabel(config.ruleVersion),
      reason: 'the lobby API persists the table name only',
    },
    {
      field: 'Party size',
      value: `${config.partySize} seats`,
      reason: 'no server-side seat cap exists yet',
    },
    {
      field: 'Starting level',
      value: `${config.startingLevel}`,
      reason: 'characters keep their own persisted levels',
    },
  ];
}

/**
 * Review-step rows: `[label, displayValue]` pairs summarizing every selection.
 * Which selections stay client-side is reported separately by
 * `clientOnlyWizardFields`, so the review stays scannable and the honesty note
 * lives in exactly one place.
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
