// Reads that feed the task-wide budget checks in taskLimits.ts (#6590).
//
// Kept apart from the pure checks so coordinator unit tests can stub the I/O
// without also stubbing the precedence rules they are meant to exercise.

import { and, eq, sql } from 'drizzle-orm';
import type { AiAgentKind } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { resolveEffectiveAgentSystem } from '../aiAgents/effectivePolicy';
import type { TaskLimitPolicy } from './taskLimits';
import { TERMINAL_TASK_STATES } from './taskTransitions';

/**
 * The effective agent policy's limits for a task pinned to `agentId`.
 *
 * `null` (=> every ceiling is the default) when no effective agent resolves or
 * when the org has since replaced the pinned agent: a stranger's policy must
 * not govern this task. Same rule as admission's deadline resolution.
 */
export async function resolveTaskPolicyLimits(
  orgId: string,
  agentId: string,
  agentKind: string,
): Promise<TaskLimitPolicy> {
  const effective = await resolveEffectiveAgentSystem(orgId, agentKind as AiAgentKind);
  return effective && effective.agentId === agentId ? effective.effective.limits : null;
}

/**
 * Total model spend across every run this task has admitted, in cents. Read
 * fresh on every admission — a cached figure would let a burst of admissions
 * overshoot the task budget.
 */
export async function readTaskSpentCents(orgId: string, taskId: string): Promise<number> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ spent: sql<string | number | null>`coalesce(sum(${aiAgentRuns.costCents}), 0)` })
        .from(aiAgentRuns)
        .where(and(eq(aiAgentRuns.orgId, orgId), eq(aiAgentRuns.taskId, taskId)));
      return Number(row?.spent ?? 0);
    }));
}

export interface TaskLimitContext {
  policyLimits: TaskLimitPolicy;
  spentCents: number;
}

/** Everything the coordinator needs to gate a reasoning-run dispatch. */
export async function loadTaskLimitContext(task: {
  id: string;
  orgId: string;
  agentId: string;
  agentKind: string;
}): Promise<TaskLimitContext> {
  // Sequential, not Promise.all: each read opens its own system context, and
  // holding two pooled connections at once per coordinator tick is exactly
  // the pool pressure that has wedged the API before.
  const policyLimits = await resolveTaskPolicyLimits(task.orgId, task.agentId, task.agentKind);
  const spentCents = await readTaskSpentCents(task.orgId, task.id);
  return { policyLimits, spentCents };
}

/**
 * Serialise task admission per org for the rest of the caller's transaction,
 * so the pending-capacity count and the insert that follows it are one
 * decision: without it, N concurrent admissions each read `cap - 1` and all
 * insert. Must be called inside the admission transaction (the bare `db`
 * proxy joins it); `pg_advisory_xact_lock` releases at commit/rollback.
 */
export async function lockOrgTaskAdmission(orgId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('ai-operator-task-admission'), hashtext(${orgId}))`,
  );
}

/**
 * The org's pending Operator tasks: every non-terminal state, because a
 * `paused`, `waiting` or `stopping` task still holds a deadline, a target and
 * a reconciler obligation (spec §7.2 — a waiting task consumes this quota
 * though it holds no active-run concurrency). Counted for the ONE org, never
 * the caller's accessible set. Called inside the admission transaction.
 */
export async function countPendingTasks(orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiOperatorTasks)
    .where(and(
      eq(aiOperatorTasks.orgId, orgId),
      sql`${aiOperatorTasks.state} NOT IN ${TERMINAL_TASK_STATES}`,
    ));
  return Number(row?.count ?? 0);
}
