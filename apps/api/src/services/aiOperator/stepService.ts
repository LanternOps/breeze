// AI Operator task step rows (Recipe Library wave E2).
//
// One row per (task, step key, target, attempt). Identity is enforced by TWO
// partial uniques rather than one — see the migration header — because a NULL
// target_id makes a plain unique index enforce nothing for task-wide steps.
//
// Same transaction contract as eventService.ts and taskOutbox.ts: the caller
// supplies the handle, so a step row and the task CAS that produced it commit
// together.
//
// EVERY WRITE IS IDEMPOTENT ON THAT IDENTITY. A lease reclaim re-runs the
// coordinator's step function from the top (taskCoordinator.ts: results from a
// superseded epoch are accepted under their original identity), so a plain
// INSERT would raise 23505 and abort the reclaiming coordinator's transaction —
// turning an ordinary, expected race into a stuck task.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  aiOperatorTaskSteps,
  type AiOperatorStepKind,
  type AiOperatorStepState,
} from '../../db/schema/aiOperatorTaskGraph';
import { appendTaskEvent, type TaskEventActor } from './eventService';
import { getRecipe } from './recipes';

/** Mirrors `ai_operator_task_steps_criterion_len_chk`. */
const MAX_CRITERION_CHARS = 2000;
/** Mirrors `ai_operator_task_steps_detail_len_chk`. */
const MAX_STEP_DETAIL_CHARS = 4000;

export type StepDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

/**
 * Which `step_kind` a recipe's step key is.
 *
 * Reads E1's registry when it can (`getRecipe(workflowKey, workflowVersion)`
 * → `steps[stepKey].kind`, recipe spec §6.1), because the recipe owns this
 * fact and a second hand-maintained table would drift from it the first time a
 * recipe adds a step.
 *
 * The fallback is `'reason'`, deliberately, and it never throws: a step row is
 * EVIDENCE of a transition that has already happened, and refusing to record
 * one because its kind could not be classified would lose the transition
 * outright. A mis-kinded row is visible and fixable; a missing row is not.
 */
export function resolveStepKind(
  workflowKey: string,
  workflowVersion: number,
  stepKey: string,
): AiOperatorStepKind {
  const recipe = getRecipe(workflowKey, workflowVersion);
  const kind = recipe?.steps?.[stepKey]?.kind;
  return (kind as AiOperatorStepKind | undefined) ?? 'reason';
}

export interface OpenStepInput {
  orgId: string;
  taskId: string;
  stepKey: string;
  stepKind: AiOperatorStepKind;
  targetId?: string | null;
  attemptOrdinal: number;
  /** `ai_operator_tasks.revision` at the moment the step opened. */
  planRevision: number;
  expectedCriterion?: string | null;
  checkpoint?: Record<string, unknown>;
  actor?: TaskEventActor;
}

export async function openStep(
  dbh: StepDbHandle,
  input: OpenStepInput,
): Promise<{ id: string }> {
  const now = new Date();
  const [row] = await dbh
    .insert(aiOperatorTaskSteps)
    .values({
      orgId: input.orgId,
      taskId: input.taskId,
      stepKey: input.stepKey,
      stepKind: input.stepKind,
      targetId: input.targetId ?? null,
      attemptOrdinal: input.attemptOrdinal,
      state: 'running',
      planRevision: input.planRevision,
      expectedCriterion: input.expectedCriterion
        ? input.expectedCriterion.slice(0, MAX_CRITERION_CHARS)
        : null,
      checkpoint: input.checkpoint ?? {},
      startedAt: now,
    })
    // The conflict target must repeat the PARTIAL index's predicate, or
    // Postgres cannot match the partial index and raises 42P10 instead of
    // deduplicating — the same trap taskService.ts:224-227 documents for
    // `ai_operator_tasks_client_idempotency_uq`.
    .onConflictDoUpdate({
      target: input.targetId
        ? [
            aiOperatorTaskSteps.orgId, aiOperatorTaskSteps.taskId,
            aiOperatorTaskSteps.stepKey, aiOperatorTaskSteps.targetId,
            aiOperatorTaskSteps.attemptOrdinal,
          ]
        : [
            aiOperatorTaskSteps.orgId, aiOperatorTaskSteps.taskId,
            aiOperatorTaskSteps.stepKey, aiOperatorTaskSteps.attemptOrdinal,
          ],
      targetWhere: input.targetId ? sql`target_id IS NOT NULL` : sql`target_id IS NULL`,
      set: {
        // A reclaim re-opens the same step: refresh what the new epoch knows,
        // never the identity columns and never `started_at`.
        stepKind: input.stepKind,
        planRevision: input.planRevision,
        state: 'running',
        updatedAt: now,
      },
    })
    .returning({ id: aiOperatorTaskSteps.id });
  if (!row) {
    // ON CONFLICT DO UPDATE always returns the inserted-or-updated row.
    throw new Error('[aiOperator] openStep: upsert returned no row');
  }

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId,
      taskId: input.taskId,
      eventType: 'step_opened',
      actor: input.actor,
      stepKey: input.stepKey,
      targetId: input.targetId ?? null,
      detail: `${input.stepKind} step '${input.stepKey}' opened at attempt ${input.attemptOrdinal}`,
    });
  }

  return row;
}

export interface StepIdentity {
  orgId: string;
  taskId: string;
  stepKey: string;
  targetId?: string | null;
  attemptOrdinal: number;
}

function identityWhere(id: StepIdentity) {
  return and(
    eq(aiOperatorTaskSteps.orgId, id.orgId),
    eq(aiOperatorTaskSteps.taskId, id.taskId),
    eq(aiOperatorTaskSteps.stepKey, id.stepKey),
    eq(aiOperatorTaskSteps.attemptOrdinal, id.attemptOrdinal),
    id.targetId
      ? eq(aiOperatorTaskSteps.targetId, id.targetId)
      : isNull(aiOperatorTaskSteps.targetId),
  );
}

export interface MarkStepWaitingInput extends StepIdentity {
  dependencyKind: 'intent' | 'operation' | 'run' | 'device_command' | 'user_answer' | 'verification' | null;
  dependencyId: string | null;
  actor?: TaskEventActor;
  detail?: string;
}

/** The step's half of a typed wait. Mirrors the task's `wait_reason` /
 *  `wait_dependency_*` columns onto the step, so a reader can see WHICH step
 *  is waiting without replaying the timeline.
 *
 *  Returns the number of step rows updated (0 or 1). Zero means no row with
 *  this identity exists — e.g. a task admitted before this wave whose current
 *  step predates the backfill — and is NOT an error: the task row remains the
 *  authority, and the caller decides whether a missing step row matters. */
export async function markStepWaiting(
  dbh: StepDbHandle,
  input: MarkStepWaitingInput,
): Promise<number> {
  const rows = await dbh
    .update(aiOperatorTaskSteps)
    .set({
      state: 'waiting',
      dependencyKind: input.dependencyKind,
      dependencyId: input.dependencyId,
      updatedAt: new Date(),
    })
    .where(identityWhere(input))
    .returning({ id: aiOperatorTaskSteps.id });

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId, taskId: input.taskId,
      eventType: 'wait_entered', actor: input.actor,
      stepKey: input.stepKey, targetId: input.targetId ?? null,
      detail: input.detail
        ?? `step '${input.stepKey}' waiting on ${input.dependencyKind ?? 'a timer'}`,
    });
  }
  return rows.length;
}

export interface SettleStepInput extends StepIdentity {
  state: Extract<AiOperatorStepState, 'succeeded' | 'failed' | 'skipped'>;
  detail?: string | null;
  actor?: TaskEventActor;
}

/** Settle a step. Returns the number of step rows updated (0 or 1) — same
 *  zero-is-not-an-error contract as {@link markStepWaiting}. */
export async function settleStep(
  dbh: StepDbHandle,
  input: SettleStepInput,
): Promise<number> {
  const now = new Date();
  const rows = await dbh
    .update(aiOperatorTaskSteps)
    .set({
      state: input.state,
      detail: input.detail ? input.detail.slice(0, MAX_STEP_DETAIL_CHARS) : null,
      // The dependency is discharged the moment the step settles; leaving it
      // set would make a settled step look like it is still waiting.
      dependencyKind: null,
      dependencyId: null,
      settledAt: now,
      updatedAt: now,
    })
    .where(identityWhere(input))
    .returning({ id: aiOperatorTaskSteps.id });

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId, taskId: input.taskId,
      eventType: 'step_settled', actor: input.actor,
      stepKey: input.stepKey, targetId: input.targetId ?? null,
      detail: input.detail ?? `step '${input.stepKey}' ${input.state}`,
    });
  }
  return rows.length;
}
