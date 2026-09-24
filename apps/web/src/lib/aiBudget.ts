/**
 * Shared, read-only view of the AI budget contract for the web app (#6004).
 *
 * The API owns the merge (`getEffectiveAiBudget` /
 * `GET /orgs/organizations/:id/effective-settings`): defaults ← org
 * `ai_budgets` row ← partner `partners.settings.aiBudgets`, with every
 * partner-set field additionally listed in `locked` as `aiBudgets.<field>`.
 * Nothing here re-implements that merge; these constants only let the web tell
 * an INHERITED value apart from an org-set one, which the payload cannot say
 * on its own (it returns the merged result, never the raw org row).
 *
 * Keep `AI_BUDGET_DEFAULTS` in sync with `AI_BUDGET_DEFAULTS` in
 * `apps/api/src/services/effectiveSettings.ts` — it is the same contract.
 */

export const AI_BUDGET_FIELDS = [
  'enabled',
  'monthlyBudgetCents',
  'dailyBudgetCents',
  'maxTurnsPerSession',
  'messagesPerMinutePerUser',
  'messagesPerHourPerOrg',
  'approvalMode',
  'alertThresholdPercents',
  'toolRateLimitMultiplier',
] as const;

export type AiBudgetField = (typeof AI_BUDGET_FIELDS)[number];

export type ApprovalMode = 'per_step' | 'action_plan' | 'auto_approve' | 'hybrid_plan';

export interface EffectiveAiBudget {
  enabled: boolean;
  monthlyBudgetCents: number | null;
  dailyBudgetCents: number | null;
  maxTurnsPerSession: number;
  messagesPerMinutePerUser: number;
  messagesPerHourPerOrg: number;
  approvalMode: ApprovalMode;
  alertThresholdPercents: number[];
  /** #6476 — raises every per-tool AI/MCP rate limit; integer 1–10. */
  toolRateLimitMultiplier: number;
}

export const AI_BUDGET_DEFAULTS: EffectiveAiBudget = {
  enabled: true,
  monthlyBudgetCents: null,
  dailyBudgetCents: null,
  maxTurnsPerSession: 50,
  messagesPerMinutePerUser: 20,
  messagesPerHourPerOrg: 200,
  approvalMode: 'per_step',
  alertThresholdPercents: [50, 80, 95],
  toolRateLimitMultiplier: 1,
};

/** #6476 — bounds of `toolRateLimitMultiplier`; the API rejects anything outside. */
export const TOOL_RATE_LIMIT_MULTIPLIER_MIN = 1;
export const TOOL_RATE_LIMIT_MULTIPLIER_MAX = 10;

/** Where an effective value came from, for the usage page's source chips. */
export type AiBudgetSource = 'partner' | 'organization' | 'default';

export function isAiBudgetFieldLocked(locked: readonly string[] | undefined, field: AiBudgetField): boolean {
  return locked?.includes(`aiBudgets.${field}`) ?? false;
}

function sameAsDefault(field: AiBudgetField, value: unknown): boolean {
  const def = AI_BUDGET_DEFAULTS[field] as unknown;
  if (Array.isArray(def) || Array.isArray(value)) {
    const a = Array.isArray(def) ? def : [];
    const b = Array.isArray(value) ? value : [];
    return a.length === b.length && a.every((n, i) => n === b[i]);
  }
  // A missing field is the default: the merge always starts from the defaults,
  // so an absent key can only mean the payload predates the field.
  if (value === undefined) return true;
  return def === value;
}

/**
 * Classify one field of the merged budget.
 *
 * `locked` is authoritative for Partner. The Organization/Default split is a
 * comparison against the shipped defaults, because the payload carries only
 * the merged result — an org row that explicitly stores the default value is
 * indistinguishable from inheriting it and is reported as Default. That is a
 * deliberate limit of doing this without an API change (#6004 design §API);
 * it never mislabels a value the user can see, only its provenance in the one
 * case where both provenances yield the same number.
 */
export function aiBudgetSource(
  field: AiBudgetField,
  effective: Partial<EffectiveAiBudget> | null | undefined,
  locked: readonly string[] | undefined,
): AiBudgetSource {
  if (isAiBudgetFieldLocked(locked, field)) return 'partner';
  if (sameAsDefault(field, effective?.[field])) return 'default';
  return 'organization';
}

/** The merged budget with any missing field filled from the defaults. */
export function withAiBudgetDefaults(effective: Partial<EffectiveAiBudget> | null | undefined): EffectiveAiBudget {
  return {
    ...AI_BUDGET_DEFAULTS,
    alertThresholdPercents: [...AI_BUDGET_DEFAULTS.alertThresholdPercents],
    ...Object.fromEntries(
      AI_BUDGET_FIELDS.filter((f) => effective?.[f] !== undefined).map((f) => [f, effective![f]]),
    ),
  } as EffectiveAiBudget;
}
