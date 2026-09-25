// Task-wide budget checks (#6590; Operator spec §7.2 / recipe spec §6.7).
//
// The v15 agent policy snapshot carries six task-wide ceilings. The first,
// `taskDeadlineHours`, is resolved by `taskDeadline.ts`; this module holds the
// other five. All six are CEILINGS: a recipe's own `bounds` may be stricter,
// never looser, so where a recipe bound exists the narrower of the two wins.
//
// A missing ceiling — no effective policy, or a pre-v15 snapshot without the
// field — is the DEFAULT ceiling from `AI_AGENT_LIMIT_DEFAULTS`, never
// "unbounded" (same rule as taskDeadline.ts).
//
// Every refusal names the limit that fired and where it came from, so a
// handoff or a 429 tells the technician whether to change the recipe or the
// agent policy. Nothing here truncates: a check either admits or refuses.
//
// Pure, so the precedence and the under/at/over boundaries are unit-testable
// without a database. The I/O that feeds these lives in taskLimitsLoader.ts.

import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits } from '@breeze/shared';

export type TaskWideLimitKey =
  | 'taskMaxReasoningRuns'
  | 'taskMaxMutationAttemptsPerTarget'
  | 'taskMaxBudgetCents'
  | 'taskMaxActiveTargets'
  | 'taskMaxPendingPerOrg';

/** The effective policy's limits; `null` when no effective policy resolved. */
export type TaskLimitPolicy = Partial<Pick<AiAgentLimits, TaskWideLimitKey>> | null;

export type TaskLimitCheck = { ok: true } | { ok: false; limit: TaskWideLimitKey; detail: string };

function ceiling(policyLimits: TaskLimitPolicy, key: TaskWideLimitKey): number {
  return policyLimits?.[key] ?? AI_AGENT_LIMIT_DEFAULTS[key];
}

/** The narrower of a recipe bound and a policy ceiling, with its provenance. */
function narrower(
  recipeBound: number,
  recipeLabel: string,
  policyLimits: TaskLimitPolicy,
  key: TaskWideLimitKey,
): { cap: number; source: string } {
  const policyCap = ceiling(policyLimits, key);
  // Ties go to the policy: it is the ceiling an admin can actually change.
  return recipeBound < policyCap
    ? { cap: recipeBound, source: `recipe ${recipeLabel}` }
    : { cap: policyCap, source: `agent policy ${key}` };
}

/**
 * May the task admit reasoning attempt `attemptOrdinal` (0-based)?
 * Enforced where the coordinator dispatches a reasoning run.
 */
export function checkTaskReasoningRuns(input: {
  attemptOrdinal: number;
  recipeBound: number;
  policyLimits: TaskLimitPolicy;
}): TaskLimitCheck {
  const { cap, source } = narrower(
    input.recipeBound, 'bounds.maxReasoningRuns', input.policyLimits, 'taskMaxReasoningRuns',
  );
  if (input.attemptOrdinal < cap) return { ok: true };
  return {
    ok: false,
    limit: 'taskMaxReasoningRuns',
    detail: `reasoning-run limit reached (${cap}, ${source})`,
  };
}

/**
 * May the task spend another mutation attempt on its target? `mutationAttempts`
 * is the count already dispatched against the target across all runs.
 */
export function checkTaskMutationAttempts(input: {
  mutationAttempts: number;
  recipeBound: number;
  policyLimits: TaskLimitPolicy;
}): TaskLimitCheck {
  const { cap, source } = narrower(
    input.recipeBound, 'bounds.maxMutationAttempts', input.policyLimits, 'taskMaxMutationAttemptsPerTarget',
  );
  if (input.mutationAttempts < cap) return { ok: true };
  return {
    ok: false,
    limit: 'taskMaxMutationAttemptsPerTarget',
    detail: `mutation-attempt limit reached (${input.mutationAttempts} of ${cap}, ${source})`,
  };
}

/**
 * May the task start another reasoning run given what its runs have already
 * cost? A run already in flight is not interrupted; the per-run and per-day
 * caps still bound each run individually.
 */
export function checkTaskBudget(input: { spentCents: number; policyLimits: TaskLimitPolicy }): TaskLimitCheck {
  const cap = ceiling(input.policyLimits, 'taskMaxBudgetCents');
  if (input.spentCents < cap) return { ok: true };
  return {
    ok: false,
    limit: 'taskMaxBudgetCents',
    detail: `task model budget exhausted (${input.spentCents} of ${cap} cents spent, agent policy taskMaxBudgetCents)`,
  };
}

/**
 * May a task hold `targetCount` executable targets? Reaching the ceiling
 * exactly is allowed; only exceeding it refuses.
 */
export function checkTaskActiveTargets(input: { targetCount: number; policyLimits: TaskLimitPolicy }): TaskLimitCheck {
  const cap = ceiling(input.policyLimits, 'taskMaxActiveTargets');
  if (input.targetCount <= cap) return { ok: true };
  return {
    ok: false,
    limit: 'taskMaxActiveTargets',
    detail: `task would hold ${input.targetCount} active targets, above the limit of ${cap} (agent policy taskMaxActiveTargets)`,
  };
}

/**
 * May the org admit one more task? `pendingCount` is the org's live (not yet
 * terminal) tasks before this admission — a waiting task counts.
 */
export function checkTaskPendingCapacity(input: { pendingCount: number; policyLimits: TaskLimitPolicy }): TaskLimitCheck {
  const cap = ceiling(input.policyLimits, 'taskMaxPendingPerOrg');
  if (input.pendingCount < cap) return { ok: true };
  return {
    ok: false,
    limit: 'taskMaxPendingPerOrg',
    detail: `org already has ${input.pendingCount} pending Operator tasks (limit ${cap}, agent policy taskMaxPendingPerOrg)`,
  };
}
