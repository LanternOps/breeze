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
import { and, eq, sql } from 'drizzle-orm';
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
  /**
   * `replayed` is true when `clientIdempotencyKey` matched a task this org had
   * already admitted, so NOTHING was created by this call (W08, #5246). The
   * caller must still answer 202 with this id — a replay is a success, not a
   * conflict — but it must not treat the call as having produced new work.
   */
  | { ok: true; taskId: string; replayed: boolean }
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
  /**
   * Client-supplied admission idempotency key (spec §12), W08 (#5246).
   *
   * Unique per org via the PARTIAL unique index
   * `ai_operator_tasks_client_idempotency_uq`. Re-admitting with a key this
   * org has already used returns that task's id and inserts nothing, which is
   * what stops a double-clicked "Delegate to Operator" from dispatching two
   * service restarts to the same machine. Null (the default) means "no
   * idempotency" and is what every internal admission passes.
   */
  clientIdempotencyKey?: string | null;
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

      const clientIdempotencyKey = input.clientIdempotencyKey ?? null;

      const inserted = await db
        .insert(aiOperatorTasks)
        .values({
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
        clientIdempotencyKey,
        })
        // W08 (#5246). `DO NOTHING` rather than catching 23505: a unique
        // violation ABORTS the surrounding transaction, so the read-back
        // needed to answer with the winner's id could not run in it. Letting
        // Postgres swallow the conflict keeps the transaction alive and makes
        // the replay read a plain follow-up statement. The conflict target
        // must repeat the index's WHERE clause, or Postgres cannot match the
        // PARTIAL index and raises 42P10 instead of deduplicating.
        .onConflictDoNothing({
          target: [aiOperatorTasks.orgId, aiOperatorTasks.clientIdempotencyKey],
          where: sql`client_idempotency_key IS NOT NULL`,
        })
        .returning({ id: aiOperatorTasks.id });

      if (inserted.length > 0) {
        return { ok: true as const, taskId, replayed: false };
      }

      // Nothing inserted => the partial unique index rejected it, which can
      // only happen when this org already holds a task under this key. Read
      // the winner. Scoped by BOTH org and key: the index is org-scoped, and
      // a key-only lookup would hand one tenant another tenant's task id.
      const [existing] = await db
        .select({ id: aiOperatorTasks.id })
        .from(aiOperatorTasks)
        .where(
          and(
            eq(aiOperatorTasks.orgId, input.orgId),
            eq(aiOperatorTasks.clientIdempotencyKey, clientIdempotencyKey as string),
          ),
        )
        .limit(1);

      if (!existing) {
        // Structurally unreachable: DO NOTHING with a non-null key fires only
        // on that index. Refusing beats inventing a task id.
        return {
          ok: false as const,
          refusal: 'invalid_input' as const,
          detail: 'admission conflicted but no existing task was found for the idempotency key',
        };
      }

      return { ok: true as const, taskId: existing.id, replayed: true };
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
 * Whether a task in this shape must refuse NEW reasoning and NEW effects
 * (spec §7.3), as a PURE function.
 *
 * Extracted from `loadTaskFence` so the predicate is exhaustively testable
 * without a database — it is the check the run loop's pre-tool hook makes on
 * every single tool call, and the consequence of getting it wrong is a
 * cancelled or expired task whose in-flight run keeps proposing effects.
 * Three independent reasons, any one of which fences:
 *
 *  1. the state itself (`paused`, `stopping`, or any terminal state);
 *  2. the target is detached — the device moved org or was deleted, so the
 *     frozen scope no longer resolves to anything this task may touch;
 *  3. the deadline has passed. Fenced from the INSTANT it passes, not from
 *     the instant a poller notices: spec §7.3 says expiry "stops new effects
 *     like cancellation", and a reconciler tick is up to 15 seconds away.
 *
 * A null `deadlineAt` does NOT fence here, deliberately: admission always sets
 * one, and the place that fails closed on its absence is the dispatch claim
 * (`evaluateTaskClaimPredicate`, "absence of a bound is not permission"),
 * which is the linearization point. Fencing on it here as well would only
 * change which of the two refuses first.
 */
export function isTaskFenced(
  task: { state: string; targetDetachedAt: Date | null; deadlineAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (admissionFenced(task.state)) return true;
  if (task.targetDetachedAt !== null) return true;
  return task.deadlineAt !== null && task.deadlineAt.getTime() <= now.getTime();
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
        fenced: isTaskFenced({
          state,
          targetDetachedAt: row.targetDetachedAt ?? null,
          deadlineAt: row.deadlineAt ?? null,
        }),
      };
    }));
}

/**
 * Parse a stored checkpoint.
 *
 * Returns the reason on failure rather than a bare `null`: the only caller
 * TERMINALIZES the task on a parse failure, and doing that with the detail
 * `'task checkpoint does not conform to the current schema'` and nothing else
 * leaves whoever has to debug it with no field, no value and no way to tell a
 * schema migration from a corrupt write.
 */
export function parseTaskCheckpointResult(
  value: unknown,
): { ok: true; checkpoint: TaskCheckpoint } | { ok: false; detail: string } {
  const parsed = taskCheckpointSchema.safeParse(value);
  if (parsed.success) return { ok: true, checkpoint: parsed.data };
  return {
    ok: false,
    detail: parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
      .slice(0, 400),
  };
}

/** Convenience wrapper for callers that only need the value. */
export function parseTaskCheckpoint(value: unknown): TaskCheckpoint | null {
  const parsed = parseTaskCheckpointResult(value);
  return parsed.ok ? parsed.checkpoint : null;
}
