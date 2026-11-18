/**
 * Platform defaults for the AI budget contract: what an org gets when neither
 * its `ai_budgets` row nor its partner's `settings.aiBudgets` sets a field.
 *
 * The single owner of these values. The API merge (`getEffectiveAiBudget` /
 * `getEffectiveOrgSettings` in `apps/api/src/services/effectiveSettings.ts`),
 * the web (`apps/web/src/lib/aiBudget.ts`) and the partner settings catalog
 * all import them from here. Leaf module, no imports: it is reachable from the
 * browser-safe root barrel.
 */

export type AiBudgetApprovalMode = 'per_step' | 'action_plan' | 'auto_approve' | 'hybrid_plan';

export interface AiBudgetDefaults {
  enabled: boolean;
  monthlyBudgetCents: number | null;
  dailyBudgetCents: number | null;
  maxTurnsPerSession: number;
  messagesPerMinutePerUser: number;
  messagesPerHourPerOrg: number;
  approvalMode: AiBudgetApprovalMode;
  /** #4388 — pre-cap alert rungs (1-99). Empty = pre-cap warnings off; 100 is always implicit. */
  alertThresholdPercents: number[];
  /** #6476 — per-tool AI/MCP rate-limit multiplier, integer 1–10; 1 = the shipped limits. */
  toolRateLimitMultiplier: number;
}

/** #4388 — pre-cap alert rungs (1-99). Empty = pre-cap warnings off; 100 is always implicit. */
export const DEFAULT_AI_ALERT_THRESHOLD_PERCENTS: readonly number[] = Object.freeze([50, 80, 95]);

export const AI_BUDGET_DEFAULTS: Readonly<AiBudgetDefaults> = Object.freeze({
  enabled: true,
  monthlyBudgetCents: null,
  dailyBudgetCents: null,
  maxTurnsPerSession: 50,
  messagesPerMinutePerUser: 20,
  messagesPerHourPerOrg: 200,
  approvalMode: 'per_step',
  // Frozen as a tripwire (#4388 review finding): a merge site that forgets to
  // copy this array before handing it out throws on an in-place mutation
  // (e.g. .push()) instead of silently corrupting the defaults process-wide.
  // Every consumer spreads a fresh copy.
  alertThresholdPercents: DEFAULT_AI_ALERT_THRESHOLD_PERCENTS as number[],
  toolRateLimitMultiplier: 1,
});
