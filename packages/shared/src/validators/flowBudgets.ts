import { z } from 'zod';

/**
 * Flow budgets (tool catalog W5, #5220, Decision 15). Browser safe.
 *
 * Monthly run caps are exact counters charged inside the run-creation transaction.
 * At a cap a run is refused (never paused). Limits resolve partner default → org
 * override, where the org may only lower the partner's value.
 */

export const FLOW_ADMISSION_REFUSALS = ['flow_queue_full', 'flow_monthly_cap_reached', 'owner_monthly_cap_reached'] as const;
export type FlowAdmissionRefusal = (typeof FLOW_ADMISSION_REFUSALS)[number];

const ADMISSION_REFUSAL_SET: ReadonlySet<string> = new Set(FLOW_ADMISSION_REFUSALS);

/** True for every admission refusal (handled, never retried); false for `not_enabled` / `duplicate`. */
export function isFlowAdmissionRefusal(reason: string): reason is FlowAdmissionRefusal {
  return ADMISSION_REFUSAL_SET.has(reason);
}

export const FLOW_LIMIT_DEFAULTS = {
  monthlyRunsPerOwner: 100_000,
  monthlyRunsPerFlow: 10_000,
  aiTokensPerRun: 100_000,
} as const;

/** Platform ceilings: no partner or org setting may exceed these. */
export const FLOW_LIMIT_CEILINGS = {
  monthlyRunsPerOwner: 1_000_000,
  monthlyRunsPerFlow: 100_000,
  aiTokensPerRun: 1_000_000,
} as const;

export type FlowLimitKey = keyof typeof FLOW_LIMIT_DEFAULTS;
export const FLOW_LIMIT_KEYS = Object.keys(FLOW_LIMIT_DEFAULTS) as FlowLimitKey[];

const limitField = (ceiling: number) => z.number().int().min(1).max(ceiling).optional();

/** Stored under `flows` in `partners.settings` / `organizations.settings`. */
export const flowLimitsSettingsSchema = z.object({
  monthlyRunsPerOwner: limitField(FLOW_LIMIT_CEILINGS.monthlyRunsPerOwner),
  monthlyRunsPerFlow: limitField(FLOW_LIMIT_CEILINGS.monthlyRunsPerFlow),
  aiTokensPerRun: limitField(FLOW_LIMIT_CEILINGS.aiTokensPerRun),
}).strict();
export type FlowLimitsSettings = z.infer<typeof flowLimitsSettingsSchema>;

export type FlowLimitSource = 'default' | 'partner' | 'org';

export interface FlowLimitsDto {
  effective: Record<FlowLimitKey, number>;
  source: Record<FlowLimitKey, FlowLimitSource>;
  /** The partner's values an org override may not exceed; null when the owner is the partner. */
  partnerCeiling: Record<FlowLimitKey, number> | null;
}

export interface FlowUsageDto {
  periodKey: string;
  flowRuns: number;
  flowCap: number;
  ownerRuns: number;
  ownerCap: number;
}

export const FLOW_USAGE_PERIOD_KEY_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/** UTC calendar month, `YYYY-MM`. */
export function flowUsagePeriodKey(d: Date): string {
  return `${d.getUTCFullYear().toString().padStart(4, '0')}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}`;
}
