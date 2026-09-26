// Task deadline resolution (Recipe Library wave E2, #6167).
//
// `taskDeadlineHours` is one of the six v15 task-wide budgets; the other five
// are checked in taskLimits.ts (#6590). Operator spec §7.2 / recipe spec §6.7: a recipe's own bound may
// be STRICTER than the agent policy's ceiling and never looser, and a caller-
// requested deadline is bounded by the same ceiling. The narrowest wins.
//
// Pure, so the precedence is unit-testable without a database.

import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits } from '@breeze/shared';

const HOUR_MS = 3_600_000;

export interface ResolveTaskDeadlineInput {
  /** A caller-requested deadline, if any (admission input). */
  requestedMs: number | undefined;
  /** The recipe's own `bounds.deadlineMs`. */
  recipeDeadlineMs: number;
  /**
   * The effective agent policy's limits. `null` when no effective policy
   * could be resolved; `{}`-shaped (field absent) for a pre-v15 snapshot.
   * Both fall back to `AI_AGENT_LIMIT_DEFAULTS.taskDeadlineHours` — a missing
   * ceiling is the DEFAULT ceiling, never "unbounded".
   */
  policyLimits: Partial<Pick<AiAgentLimits, 'taskDeadlineHours'>> | null;
  /**
   * Multiplier for the ±10% anti-thundering-herd spread (spec §11.2), so a
   * burst of tasks admitted together does not expire together. Injected for
   * tests; production passes `() => 0.9 + Math.random() * 0.2`.
   */
  jitter: () => number;
}

/** Milliseconds from admission until the task's deadline. */
export function resolveTaskDeadlineMs(input: ResolveTaskDeadlineInput): number {
  const ceilingMs =
    (input.policyLimits?.taskDeadlineHours ?? AI_AGENT_LIMIT_DEFAULTS.taskDeadlineHours) * HOUR_MS;
  const baseMs = Math.min(input.requestedMs ?? input.recipeDeadlineMs, ceilingMs);
  // The jitter spreads deadlines; it must never push one past the policy
  // ceiling, or the ceiling would be a suggestion with a 10% overdraft.
  return Math.min(Math.round(baseMs * input.jitter()), ceilingMs);
}
