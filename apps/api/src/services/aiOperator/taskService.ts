/**
 * AI Operator task admission and inspection (#5205 W06), spec §5.1, §7.1.
 *
 * INTERNAL API ONLY. There is deliberately no HTTP route here: W07 shipped the
 * read routes and W08 owns the POST admission surface. Everything in this file
 * is called by the coordinator, the recipe, or a test.
 *
 * WHAT ADMISSION FREEZES (spec §7.1: "Admission pins agent identity, task
 * origin, target scope, workflow version, and an effective authorization
 * ceiling"). The frozen values live in NOT NULL columns on the task row rather
 * than only inside the checkpoint jsonb, for two reasons: a later policy
 * change must not be able to rewrite what the task was reviewed as, and every
 * frozen value that a customer must be able to export has to live in a bounded
 * `text` column (spec §11 — every jsonb column is `excludedOpen`).
 *
 *  - `agent_id` + `agent_kind` + `agent_name`: the agent as it was. A
 *    replacement same-kind agent cannot inherit the task (enforced again at
 *    every run admission, in `runService.ts`).
 *  - `workflow_key` + `workflow_version`: the recipe as released.
 *  - `device_id` + `target_label`: the target, plus a frozen display label that
 *    survives the device being moved or deleted.
 *  - `deadline_at`: NOT NULL by contract, because `dispatchClaim.ts`'s
 *    `evaluateTaskClaimPredicate` FAILS CLOSED on a null deadline ("absence of
 *    a bound is not permission"). A task admitted without one could never
 *    dispatch anything.
 *  - `checkpoint`: the recipe input and the criterion, both parsed.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiAgents } from '../../db/schema/aiAgents';
import { devices } from '../../db/schema/devices';
import {
  taskCheckpointSchema,
  TASK_CHECKPOINT_VERSION,
  type TaskCheckpoint,
  type ServiceRecoveryInput,
} from '@breeze/shared';
import {
  SERVICE_RECOVERY_BOUNDS,
  SERVICE_RECOVERY_WORKFLOW_KEY,
  SERVICE_RECOVERY_WORKFLOW_VERSION,
  buildServiceRecoveryCriterion,
  parseServiceRecoveryInput,
} from './recipes/serviceRecovery';
import { aiOperatorServiceRecoveryEnabled, aiOperatorTasksEnabled } from '../../config/env';
import { admissionFenced } from './taskTransitions';

export type AdmitTaskRefusal =
  | 'tasks_disabled'
  | 'recipe_disabled'
  | 'agent_not_found'
  | 'device_not_in_org'
  | 'invalid_input';

export type AdmitTaskResult =
  | { ok: true; taskId: string }
  | { ok: false; refusal: AdmitTaskRefusal; detail: string };

export interface AdmitServiceRecoveryTaskInput {
  orgId: string;
  agentId: string;
  objective: string;
  originKind: 'manual' | 'alert' | 'ticket' | 'schedule' | 'anomaly' | 'sweep' | 'chat';
  requesterUserId: string | null;
  recipeInput: unknown;
  /** Override for tests; defaults to the recipe's own bound. */
  deadlineMs?: number;
  now?: Date;
}

/**
 * Admit one service-recovery task.
 *
 * Both feature flags are checked here and NOT in the coordinator's
 * reconciliation path, which is the whole distinction spec §11.2 draws: "the
 * existing AI kill switches fence new admissions and dispatch claims; the
 * publisher and reconciler keep running so late results still land." Turning
 * the recipe off must stop new tasks, never abandon a task whose restart
 * command is already on a device.
 */
export async function admitServiceRecoveryTask(
  input: AdmitServiceRecoveryTaskInput,
): Promise<AdmitTaskResult> {
  if (!aiOperatorTasksEnabled()) {
    return { ok: false, refusal: 'tasks_disabled', detail: 'AI_OPERATOR_TASKS_ENABLED is off' };
  }
  if (!aiOperatorServiceRecoveryEnabled()) {
    return {
      ok: false,
      refusal: 'recipe_disabled',
      detail: 'AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED is off',
    };
  }

  let recipeInput: ServiceRecoveryInput;
  try {
    recipeInput = parseServiceRecoveryInput(input.recipeInput);
  } catch (error) {
    return {
      ok: false,
      refusal: 'invalid_input',
      detail: error instanceof Error ? error.message.slice(0, 400) : 'invalid recipe input',
    };
  }

  const now = input.now ?? new Date();
  const criterion = buildServiceRecoveryCriterion(recipeInput);

  const checkpoint: TaskCheckpoint = taskCheckpointSchema.parse({
    version: TASK_CHECKPOINT_VERSION,
    recipeInput,
    criterion,
    findings: [],
    satisfiedCriteria: [],
    unsatisfiedCriteria: ['service_running'],
    mutationAttempts: 0,
    lastVerification: null,
    lastOperationKey: null,
    fixWatchId: null,
  });

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      // The agent must exist AND be in this org. `ai_operator_tasks.agent_id`
      // is a plain FK with no composite same-org key on purpose (spec §11.3 —
      // `ai_agents` rows are REPOINTED to the survivor on org merge while a
      // task's `org_id` is immutable, so a composite FK would abort the
      // merge). That makes this check the only thing standing between a task
      // and an agent in another tenant.
      const [agent] = await db
        .select({ id: aiAgents.id, kind: aiAgents.kind, name: aiAgents.name, orgId: aiAgents.orgId })
        .from(aiAgents)
        .where(eq(aiAgents.id, input.agentId))
        .limit(1);
      if (!agent || (agent.orgId !== null && agent.orgId !== input.orgId)) {
        return {
          ok: false as const,
          refusal: 'agent_not_found' as const,
          detail: `agent ${input.agentId} is not available to org ${input.orgId}`,
        };
      }

      const [device] = await db
        .select({ id: devices.id, hostname: devices.hostname })
        .from(devices)
        .where(and(eq(devices.id, recipeInput.deviceId), eq(devices.orgId, input.orgId)))
        .limit(1);
      if (!device) {
        return {
          ok: false as const,
          refusal: 'device_not_in_org' as const,
          detail: `device ${recipeInput.deviceId} is not in org ${input.orgId}`,
        };
      }

      const taskId = randomUUID();
      const deadlineMs = input.deadlineMs ?? SERVICE_RECOVERY_BOUNDS.deadlineMs;

      await db.insert(aiOperatorTasks).values({
        id: taskId,
        orgId: input.orgId,
        agentId: agent.id,
        agentKind: agent.kind,
        agentName: agent.name,
        workflowKey: SERVICE_RECOVERY_WORKFLOW_KEY,
        workflowVersion: SERVICE_RECOVERY_WORKFLOW_VERSION,
        mode: 'live',
        originKind: input.originKind,
        requesterUserId: input.requesterUserId,
        objective: input.objective.slice(0, 4000),
        deviceId: device.id,
        targetLabel: (device.hostname ?? recipeInput.deviceId).slice(0, 255),
        state: 'queued',
        phase: 'investigate',
        revision: 1,
        leaseEpoch: 0,
        attemptOrdinal: 0,
        currentStepKey: 'investigate',
        checkpoint: checkpoint as unknown as Record<string, unknown>,
        // ±10% jitter (spec §11.2) so a burst of tasks admitted together does
        // not create an expiry wave 24 hours later.
        deadlineAt: new Date(now.getTime() + Math.round(deadlineMs * (0.9 + Math.random() * 0.2))),
        // Due immediately. The coordinator's `queued_past_wake` scan is what
        // picks it up — admission does NOT enqueue a wake job, because a queued
        // task has no authoritative source row to re-derive a wake FROM, which
        // is the property spec §6.3 requires of every outbox row.
        nextWakeAt: now,
        // The root of its own accounting tree (spec §6.1: "root has no root
        // pointer"), left null rather than self-referencing.
        accountingRootTaskId: null,
      });

      return { ok: true as const, taskId };
    }));
}

/** The task-row fields a fence check needs. */
export interface TaskFence {
  state: string;
  revision: number;
  leaseEpoch: number;
  deadlineAt: Date | null;
  targetDetachedAt: Date | null;
  /** True when NEW reasoning or NEW effects must be refused (spec §7.3). */
  fenced: boolean;
}

/**
 * Read the fence state of a task.
 *
 * Used by the run loop's pre-tool hook: spec §7.3 says a cancelled task
 * "fences its in-flight run at the next tool call and lets it finish", because
 * there is no run-level cancel in this codebase at all (baseline C17 —
 * `cancelled`/`expired` are valid `ai_agent_runs` statuses with zero
 * production writers and no route). The fence IS the cancel.
 *
 * Deliberately a plain read with no lock: the pre-hook is on the model's
 * critical path, and a task that transitions to `stopping` one microsecond
 * after this read is handled by the DISPATCH claim, which does take the row
 * `FOR UPDATE`. This check is an early, cheap refusal, not the linearization
 * point — spec §7.3 is explicit that the claim is the linearization point.
 */
export async function loadTaskFence(orgId: string, taskId: string): Promise<TaskFence | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({
          state: aiOperatorTasks.state,
          revision: aiOperatorTasks.revision,
          leaseEpoch: aiOperatorTasks.leaseEpoch,
          deadlineAt: aiOperatorTasks.deadlineAt,
          targetDetachedAt: aiOperatorTasks.targetDetachedAt,
        })
        .from(aiOperatorTasks)
        .where(and(eq(aiOperatorTasks.id, taskId), eq(aiOperatorTasks.orgId, orgId)))
        .limit(1);
      if (!row) return null;
      const state = row.state as string;
      return {
        state,
        revision: row.revision,
        leaseEpoch: row.leaseEpoch,
        deadlineAt: row.deadlineAt ?? null,
        targetDetachedAt: row.targetDetachedAt ?? null,
        fenced:
          admissionFenced(state)
          || row.targetDetachedAt !== null
          // A passed deadline fences immediately, without waiting for the
          // reconciler to move the row to `stopping`. Expiry "stops new
          // effects like cancellation" (spec §7.3) from the instant it
          // passes, not from the instant a poller notices.
          || (row.deadlineAt !== null && row.deadlineAt.getTime() <= Date.now()),
      };
    }));
}

/** Parse a stored checkpoint, or null when it does not conform. */
export function parseTaskCheckpoint(value: unknown): TaskCheckpoint | null {
  const parsed = taskCheckpointSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
