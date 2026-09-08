/**
 * The AI Operator task coordinator (#5205 W06), spec §6.2 and §6.3.
 *
 * This is the only process that advances `ai_operator_tasks`. It does three
 * things and nothing else: take a lease, advance one step, release.
 *
 * THREE INVARIANTS, each of which is a bug this design is built to avoid:
 *
 *  1. IT HOLDS NOTHING WHILE WAITING. No SDK process, no DB connection, no
 *     queue worker survives a `waiting` transition (spec §6.2). Every wait
 *     writes `next_wake_at` and returns. It also never calls a model to check
 *     a timestamp (spec §7.2) — every wake decision here is made from rows.
 *
 *  2. IT NEVER TRUSTS THE WAKE PAYLOAD. A wake job carries `{orgId, taskId,
 *     sourceKind, sourceId, transitionSeq}` and that is a REFERENCE, not
 *     data. Every decision re-reads the authoritative row: the operation's
 *     `result_state`, the intent's status, the device command through the
 *     authorized adapter. That is what makes duplicate and out-of-order wakes
 *     converge instead of diverging (spec §6.3), and it is why the publisher
 *     deliberately puts no payload on the wire.
 *
 *  3. `revision` IS THE PLAN REVISION, NOT A CAS COUNTER (quorum finding,
 *     2026-09-08, independently confirmed by Codex). The shipped dispatch
 *     claim refuses a dispatch whose `plan_revision` no longer matches the
 *     task's `revision`. If taking a lease bumped `revision`, then any
 *     approval decided while the coordinator happened to tick would become
 *     permanently undispatchable — which is acceptance scenario 3 itself, the
 *     "approve after the browser closed" path this whole wave exists to make
 *     work. So the lease CAS GUARDS on `revision` and never increments it.
 *     Optimistic concurrency is `lease_epoch`. `revision` moves only in
 *     `bumpPlanRevision`, when a genuinely new plan is admitted, and moving it
 *     there is the point: it invalidates the previous plan's stale approval.
 *
 * LEASE VS ATTEMPT. Reclaiming a lease advances `lease_epoch` ONLY. It never
 * advances `attempt_ordinal`, which moves only when an explicit next reasoning
 * attempt is admitted (spec §6.2). And results produced by operations a
 * SUPERSEDED epoch dispatched are accepted under their original identity
 * (spec §6.3) — this module never rejects a result for carrying an old epoch,
 * only new ADMISSIONS are epoch-fenced.
 */

import { and, eq, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  aiOperatorOperations,
  aiOperatorTasks,
  type AiOperatorTaskOutcome,
  type AiOperatorTaskRow,
  type AiOperatorWaitReason,
} from '../../db/schema/aiOperatorTasks';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { actionIntents } from '../../db/schema/actionIntents';
import { createAndEnqueueAgentRun } from '../aiAgents/runService';
import { taskCheckpointSchema, type TaskCheckpoint } from '@breeze/shared';
import {
  SERVICE_RECOVERY_BOUNDS,
  SERVICE_RECOVERY_PROMPT_VERSION,
  taskRunDedupeKey,
  validateNextStep,
} from './recipes/serviceRecovery';
import { parseTaskCheckpointResult } from './taskService';
import { evaluateCriterion } from './verification';
import {
  classifyDeviceCommandEvidence,
  readDeviceCommandEvidence,
} from './deviceCommandEvidence';
import { nextTaskState, type TaskTransitionEvent } from './taskTransitions';
import {
  recordAiOperatorLeaseReclaim,
  recordAiOperatorUnknownEffectHandoff,
} from '../aiOperatorCoordinatorMetrics';
import { aiOperatorTasksEnabled } from '../../config/env';

/** How long a lease is good for. Spec §11.2's short lease. */
export const TASK_LEASE_MS = 60_000;

/** Identifies this process in `lease_owner`, for a human reading a stuck row. */
export const COORDINATOR_OWNER_ID = `coordinator:${process.pid}:${randomUUID().slice(0, 8)}`;

export type LeaseClaim =
  | { won: true; task: AiOperatorTaskRow; leaseEpoch: number }
  | { won: false; reason: 'not_found' | 'not_claimable' | 'lost_race' };

/**
 * Take the lease.
 *
 * `requireWakeDue` is the difference between the two entry points, and it is
 * load-bearing (quorum finding Q1b):
 *
 *  - The POLLER passes `true`. A `waiting` task it has no event for may only
 *    be claimed once `next_wake_at` has actually passed, or the poller would
 *    spin on every waiting task every 15 seconds.
 *  - The WAKE HANDLER passes `false`. An outbox wake means an authoritative
 *    source row CHANGED, and it routinely arrives long before the polling
 *    deadline — an approval granted 20 minutes into a 1-hour fallback window
 *    is the normal case, not an edge case. Requiring `next_wake_at <= now()`
 *    there would delay every event-driven continuation to its polling
 *    fallback, which is exactly the latency the outbox exists to remove.
 */
export async function claimTaskLease(args: {
  orgId: string;
  taskId: string;
  requireWakeDue: boolean;
  owner?: string;
  now?: Date;
}): Promise<LeaseClaim> {
  const now = args.now ?? new Date();
  const owner = args.owner ?? COORDINATOR_OWNER_ID;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [current] = await db
        .select()
        .from(aiOperatorTasks)
        .where(and(eq(aiOperatorTasks.id, args.taskId), eq(aiOperatorTasks.orgId, args.orgId)))
        .for('update', { skipLocked: true })
        .limit(1);

      if (!current) return { won: false as const, reason: 'not_found' as const };

      const state = current.state as string;
      const leaseExpired =
        current.leaseExpiresAt === null || current.leaseExpiresAt.getTime() <= now.getTime();
      const wakeDue =
        current.nextWakeAt !== null && current.nextWakeAt.getTime() <= now.getTime();

      const door =
        (state === 'queued' && (leaseExpired || wakeDue))
        || (state === 'running' && leaseExpired)
        || (state === 'stopping' && leaseExpired)
        || (state === 'waiting' && (!args.requireWakeDue || wakeDue));

      if (!door) return { won: false as const, reason: 'not_claimable' as const };

      const reclaimed = state === 'running' && current.leaseOwner !== null;

      const [updated] = await db
        .update(aiOperatorTasks)
        .set({
          // `queued`/`waiting` become `running`; a reclaim of `running` or
          // `stopping` stays where it is (see `TASK_TRANSITIONS`).
          state: nextTaskState(state, 'claim'),
          leaseOwner: owner,
          leaseEpoch: sql`${aiOperatorTasks.leaseEpoch} + 1`,
          leaseExpiresAt: new Date(now.getTime() + TASK_LEASE_MS),
          updatedAt: now,
          // NOTE: `revision` is deliberately absent. See invariant 3.
        })
        .where(and(
          eq(aiOperatorTasks.id, args.taskId),
          eq(aiOperatorTasks.orgId, args.orgId),
          // The plan must not have moved under us between the SELECT and here.
          eq(aiOperatorTasks.revision, current.revision),
          eq(aiOperatorTasks.leaseEpoch, current.leaseEpoch),
        ))
        .returning();

      if (!updated) return { won: false as const, reason: 'lost_race' as const };
      if (reclaimed) recordAiOperatorLeaseReclaim();
      return { won: true as const, task: updated, leaseEpoch: updated.leaseEpoch };
    }));
}

/**
 * Every write the coordinator makes to a leased task goes through here.
 *
 * The CAS is `(id, org_id, revision, lease_epoch)`: the plan must not have
 * moved AND this coordinator must still hold the lease. A stale coordinator —
 * one whose lease expired and was reclaimed while it was mid-step — cannot
 * commit anything, which is spec §6.2's "stale coordinators cannot commit"
 * stated as SQL rather than as a convention.
 */
async function writeLeased(args: {
  orgId: string;
  taskId: string;
  revision: number;
  leaseEpoch: number;
  patch: Partial<typeof aiOperatorTasks.$inferInsert>;
}): Promise<boolean> {
  const committed = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const rows = await db
        .update(aiOperatorTasks)
        .set({ ...args.patch, updatedAt: new Date() })
        .where(and(
          eq(aiOperatorTasks.id, args.taskId),
          eq(aiOperatorTasks.orgId, args.orgId),
          eq(aiOperatorTasks.revision, args.revision),
          eq(aiOperatorTasks.leaseEpoch, args.leaseEpoch),
        ))
        .returning({ id: aiOperatorTasks.id });
      return rows.length === 1;
    }));

  // A lost CAS is EXPECTED and self-healing — another coordinator reclaimed
  // the lease and is advancing this task instead, and the reconciler's
  // `running_past_lease` scan is a second backstop. It is NOT an error.
  //
  // But it must not be invisible either. The step functions below deliberately
  // do not branch on the return value (there is nothing useful for a stale
  // coordinator to DO except stop, which it does by returning), so without
  // this line a genuinely stuck case — a reclaimer that died between taking
  // the lease and following through — would be indistinguishable from the
  // healthy race, and the only symptom would be the waiting-age gauge drifting
  // up with no explanation anywhere.
  if (!committed) {
    console.warn('[aiOperator] stale coordinator lost its lease CAS; another holder owns this task', {
      taskId: args.taskId, orgId: args.orgId, revision: args.revision, leaseEpoch: args.leaseEpoch,
    });
  }
  return committed;
}

/** Move the task to a typed wait and release. */
async function yieldToWait(args: {
  task: AiOperatorTaskRow;
  leaseEpoch: number;
  reason: AiOperatorWaitReason;
  dependency: { kind: 'intent' | 'operation' | 'run' | 'device_command' | 'user_answer' | 'verification'; id: string } | null;
  wakeAfterMs: number;
  stepKey?: string;
  checkpoint?: TaskCheckpoint;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  return writeLeased({
    orgId: args.task.orgId,
    taskId: args.task.id,
    revision: args.task.revision,
    leaseEpoch: args.leaseEpoch,
    patch: {
      state: nextTaskState(args.task.state as string, 'wait'),
      waitReason: args.reason,
      waitDependencyKind: args.dependency?.kind ?? null,
      waitDependencyId: args.dependency?.id ?? null,
      nextWakeAt: new Date(now.getTime() + args.wakeAfterMs),
      // The lease is RELEASED on a wait. Holding it would make the waiting-age
      // metric lie and would stop any other coordinator from reconciling this
      // task for the whole wait, which can be 72 hours.
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(args.stepKey ? { currentStepKey: args.stepKey } : {}),
      ...(args.checkpoint ? { checkpoint: args.checkpoint as unknown as Record<string, unknown> } : {}),
    },
  });
}

/** Terminalize. `event` must be a transition the table allows from the task's state. */
async function settle(args: {
  task: AiOperatorTaskRow;
  leaseEpoch: number;
  event: Extract<TaskTransitionEvent, 'complete' | 'partial' | 'hand_off' | 'fail'>;
  outcome: AiOperatorTaskOutcome;
  detail: string;
  handoffSummary?: string;
  checkpoint?: TaskCheckpoint;
}): Promise<boolean> {
  const committed = await writeLeased({
    orgId: args.task.orgId,
    taskId: args.task.id,
    revision: args.task.revision,
    leaseEpoch: args.leaseEpoch,
    patch: {
      state: nextTaskState(args.task.state as string, args.event),
      outcome: args.outcome,
      outcomeDetail: args.detail.slice(0, 4000),
      ...(args.handoffSummary ? { handoffSummary: args.handoffSummary.slice(0, 4000) } : {}),
      ...(args.checkpoint ? { checkpoint: args.checkpoint as unknown as Record<string, unknown> } : {}),
      phase: 'document',
      waitReason: null,
      waitDependencyKind: null,
      waitDependencyId: null,
      nextWakeAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });

  // AFTER the write, never before. `ai_operator_unknown_effect_handoffs_total`
  // is described in its own registration as "the metric that says the system
  // is refusing to guess, and it should be rare enough to alert on" — so it
  // has to count handoffs that actually happened. Incrementing ahead of the
  // CAS counted a transition that may have lost its lease and written
  // nothing, and double-counted whenever the reclaiming coordinator
  // independently re-derived the same verdict. An alerting metric that
  // over-reports is worse than none: it trains the reader to ignore it.
  if (committed && args.outcome === 'unknown_effect') recordAiOperatorUnknownEffectHandoff();
  return committed;
}

/**
 * Admit the next reasoning attempt.
 *
 * `bumpPlanRevision` is folded in here and NOWHERE else, because "a new
 * reasoning attempt after a failed criterion" is the only plan change the thin
 * slice has. Bumping the revision invalidates any approved-but-undispatched
 * intent from the previous plan — which is correct: that approval was granted
 * for a plan the system has now abandoned (spec §7.1, "revising plan arguments
 * creates a new operation and approval").
 */
async function admitReasoningRun(args: {
  task: AiOperatorTaskRow;
  leaseEpoch: number;
  checkpoint: TaskCheckpoint;
  stepKey: string;
  bumpPlanRevision: boolean;
}): Promise<{ admitted: boolean; detail: string }> {
  const { task, checkpoint } = args;

  if (!aiOperatorTasksEnabled()) {
    return { admitted: false, detail: 'AI_OPERATOR_TASKS_ENABLED is off' };
  }

  const attemptOrdinal = args.bumpPlanRevision ? task.attemptOrdinal + 1 : task.attemptOrdinal;
  if (attemptOrdinal >= SERVICE_RECOVERY_BOUNDS.maxReasoningRuns) {
    return {
      admitted: false,
      detail: `reasoning-run limit reached (${SERVICE_RECOVERY_BOUNDS.maxReasoningRuns})`,
    };
  }

  const nextRevision = args.bumpPlanRevision ? task.revision + 1 : task.revision;

  // Stamp the new attempt/revision FIRST, under the lease CAS. If the run
  // admission then fails, the task is left at the new attempt ordinal with no
  // run — which the reconciler retries — rather than at the old one with a run
  // whose admission identity has already been consumed.
  const stamped = await writeLeased({
    orgId: task.orgId,
    taskId: task.id,
    revision: task.revision,
    leaseEpoch: args.leaseEpoch,
    patch: {
      revision: nextRevision,
      attemptOrdinal,
      currentStepKey: args.stepKey,
      phase: 'investigate',
      checkpoint: checkpoint as unknown as Record<string, unknown>,
    },
  });
  if (!stamped) return { admitted: false, detail: 'lost the lease before admitting a run' };

  const result = await createAndEnqueueAgentRun({
    orgId: task.orgId,
    kind: task.agentKind as never,
    triggerKind: task.originKind === 'alert' ? 'alert' : 'manual',
    deviceId: task.deviceId,
    alertId: checkpoint.recipeInput.triggeringAlertId ?? null,
    // Derived from the task admission identity, so a retried or
    // lease-recovered admission converges on the SAME row rather than minting
    // a second attempt (`ai_agent_runs_task_admission_uq` says the same thing
    // from the other side).
    dedupeKey: taskRunDedupeKey(task.id, args.stepKey, attemptOrdinal),
    task: {
      taskId: task.id,
      taskStepKey: args.stepKey,
      attemptOrdinal,
      agentId: task.agentId,
      promptVersion: SERVICE_RECOVERY_PROMPT_VERSION,
    },
  });

  if (!result.created) {
    return { admitted: false, detail: `run admission skipped: ${result.skipped}` };
  }

  // The task now waits on the run. `information` is the wait reason because
  // what it is waiting for IS information — a proposal. The polling fallback
  // is generous: the outbox row `transitionRunStatus` writes inside the run's
  // own terminal transaction is the real wake, and this only fires if that
  // wake was lost.
  const waited = await yieldToWait({
    task: { ...task, revision: nextRevision, attemptOrdinal, state: 'running' },
    leaseEpoch: args.leaseEpoch,
    reason: 'information',
    dependency: { kind: 'run', id: result.run.id },
    wakeAfterMs: 30 * 60 * 1000,
    stepKey: args.stepKey,
  });

  return waited
    ? { admitted: true, detail: `admitted run ${result.run.id} attempt ${attemptOrdinal}` }
    : { admitted: false, detail: 'lost the lease after admitting a run' };
}

/**
 * Advance one leased task by exactly one step.
 *
 * Returns a short description of what it did, for the tick log. Every branch
 * either yields to a wait, settles, or releases the lease — none of them can
 * return holding it.
 */
export async function advanceTask(task: AiOperatorTaskRow, leaseEpoch: number): Promise<string> {
  const parsedCheckpoint = parseTaskCheckpointResult(task.checkpoint);
  if (!parsedCheckpoint.ok) {
    await settle({
      task, leaseEpoch, event: 'fail', outcome: 'unresolved',
      // The zod issues, not just "it did not conform" — this terminalizes the
      // task, so the message is the only forensic trail there will ever be.
      detail: `task checkpoint does not conform to the current schema: ${parsedCheckpoint.detail}`,
    });
    return 'failed: unparseable checkpoint';
  }
  const checkpoint = parsedCheckpoint.checkpoint;

  const now = new Date();

  // Deadline first, before anything can admit. Spec §7.3: expiry "stops new
  // effects like cancellation and preserves observation of in-flight work" —
  // so a task with an UNSETTLED operation is not expired here; it hands off
  // with `unknown_effect` instead of claiming nothing happened.
  if (task.deadlineAt && task.deadlineAt.getTime() <= now.getTime()) {
    const unsettled = await hasUnsettledOperation(task.orgId, task.id);
    if (unsettled) {
      await settle({
        task, leaseEpoch, event: 'hand_off', outcome: 'unknown_effect',
        detail: 'task deadline passed while an operation was still in flight',
        handoffSummary:
          'The task deadline passed while a device operation had not reported a result. '
          + 'The operation may still complete. Confirm the service state on the device before retrying.',
        checkpoint,
      });
      return 'handed off: deadline with in-flight effect';
    }
    await settle({
      task, leaseEpoch, event: 'fail', outcome: 'unresolved',
      detail: 'task deadline passed', checkpoint,
    });
    return 'failed: deadline';
  }

  const stepKey = task.currentStepKey ?? 'investigate';

  switch (stepKey) {
    case 'investigate':
      return advanceInvestigate(task, leaseEpoch, checkpoint);
    case 'execute':
      return advanceExecute(task, leaseEpoch, checkpoint);
    case 'observe':
      return advanceObserve(task, leaseEpoch, checkpoint, now);
    case 'verify':
      return advanceVerify(task, leaseEpoch, checkpoint);
    default:
      await settle({
        task, leaseEpoch, event: 'fail', outcome: 'unresolved',
        detail: `unknown step '${stepKey}'`, checkpoint,
      });
      return `failed: unknown step ${stepKey}`;
  }
}

/**
 * `investigate` — admit a bounded reasoning run, or read the one that just
 * finished and act on its proposal.
 */
async function advanceInvestigate(
  task: AiOperatorTaskRow,
  leaseEpoch: number,
  checkpoint: TaskCheckpoint,
): Promise<string> {
  const run = await readLatestTaskRun(task.orgId, task.id, 'investigate');

  // Nothing admitted yet, or the previous attempt is still live.
  if (!run) {
    const admitted = await admitReasoningRun({
      task, leaseEpoch, checkpoint, stepKey: 'investigate', bumpPlanRevision: false,
    });
    if (admitted.admitted) return admitted.detail;
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
      detail: admitted.detail, checkpoint,
      handoffSummary: `Operator could not start an investigation: ${admitted.detail}`,
    });
    return `handed off: ${admitted.detail}`;
  }

  if (run.status === 'queued' || run.status === 'running') {
    // Still reasoning. Re-arm the wait; the run's own terminal outbox row is
    // the real wake.
    await yieldToWait({
      task, leaseEpoch, reason: 'information',
      dependency: { kind: 'run', id: run.id },
      wakeAfterMs: 10 * 60 * 1000,
    });
    return 'waiting: reasoning run in flight';
  }

  if (run.status === 'awaiting_approval') {
    // The run proposed a Tier-3 action and `createActionIntent` left an intent
    // pending. The operation row was reserved in that same transaction, so it
    // is authoritative — read it rather than the run's `intentIds` array.
    const operation = await readLatestOperation(task.orgId, task.id);
    if (!operation) {
      await settle({
        task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
        detail: 'run reached awaiting_approval with no reserved operation',
        checkpoint,
        handoffSummary: 'Operator proposed an action but no operation was reserved for it.',
      });
      return 'handed off: awaiting_approval with no operation';
    }
    const next: TaskCheckpoint = taskCheckpointSchema.parse({
      ...checkpoint,
      findings: mergeFindings(checkpoint, run.outcome),
      lastOperationKey: operation.operationKey,
    });
    await yieldToWait({
      task, leaseEpoch, reason: 'approval',
      dependency: operation.intentId ? { kind: 'intent', id: operation.intentId } : null,
      // Polling fallback only — the intent's terminal outbox row (W05) is the
      // real wake, and an approval can legitimately take days.
      wakeAfterMs: 60 * 60 * 1000,
      stepKey: 'execute',
      checkpoint: next,
    });
    return 'waiting: approval';
  }

  // Terminal without an approval: the run either proposed a handoff/question,
  // proposed nothing, or failed.
  const proposal = run.outcome?.taskStep;
  const withFindings: TaskCheckpoint = taskCheckpointSchema.parse({
    ...checkpoint,
    findings: mergeFindings(checkpoint, run.outcome),
  });

  if (!proposal) {
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
      detail: `run ${run.id} ended '${run.status}' without submitting a task step`,
      checkpoint: withFindings,
      handoffSummary:
        'Operator finished an investigation without proposing a next step. Review the linked run.',
    });
    return 'handed off: no task step submitted';
  }

  if (proposal.nextStep.kind === 'handoff') {
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
      detail: proposal.nextStep.reason, checkpoint: withFindings,
      handoffSummary: proposal.nextStep.summary,
    });
    return 'handed off: model requested handoff';
  }

  if (proposal.nextStep.kind === 'question') {
    // A question is a wait on a HUMAN, not a terminal state. Nothing in the
    // thin slice can answer it (the answer surface is W08), so the wait's
    // polling fallback is the task deadline — it will expire rather than spin.
    await yieldToWait({
      task, leaseEpoch, reason: 'information',
      dependency: null,
      wakeAfterMs: 6 * 60 * 60 * 1000,
      checkpoint: withFindings,
    });
    return 'waiting: question for a human';
  }

  // A proposed step. The recipe — not the model — decides if it is reachable.
  const validated = validateNextStep(
    'investigate',
    { key: proposal.nextStep.key, inputs: proposal.nextStep.inputs },
    checkpoint.recipeInput,
  );
  if (!validated.ok) {
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
      detail: `${validated.reason}: ${validated.detail}`,
      checkpoint: withFindings,
      handoffSummary:
        `Operator proposed a next step this workflow does not permit (${validated.reason}). `
        + 'No action was taken.',
    });
    return `handed off: ${validated.reason}`;
  }

  // The model proposed `execute` but did NOT create an intent (its Tier-3 call
  // would have left the run `awaiting_approval`, handled above). So there is
  // nothing reserved and nothing to wait for — hand off rather than invent an
  // effect the model never actually requested.
  await settle({
    task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
    detail: 'the proposed execute step produced no action intent',
    checkpoint: withFindings,
    handoffSummary:
      'Operator proposed restarting the service but never submitted it for approval. '
      + 'Restart the service manually or retry the task.',
  });
  return 'handed off: execute proposed without an intent';
}

/** `execute` — the approval is pending or has been decided. */
async function advanceExecute(
  task: AiOperatorTaskRow,
  leaseEpoch: number,
  checkpoint: TaskCheckpoint,
): Promise<string> {
  const operation = await readLatestOperation(task.orgId, task.id);
  if (!operation) {
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
      detail: 'no operation is reserved for this task', checkpoint,
      handoffSummary: 'Operator has no reserved operation to execute.',
    });
    return 'handed off: no operation';
  }

  const intentStatus = operation.intentId
    ? await readIntentStatus(task.orgId, operation.intentId)
    : null;

  // Still with a human.
  if (intentStatus === 'pending_approval' || intentStatus === 'approved') {
    await yieldToWait({
      task, leaseEpoch, reason: 'approval',
      dependency: { kind: 'intent', id: operation.intentId! },
      wakeAfterMs: 60 * 60 * 1000,
      checkpoint,
    });
    return `waiting: approval (${intentStatus})`;
  }

  if (intentStatus === 'rejected' || intentStatus === 'expired' || intentStatus === 'cancelled') {
    // Spec §7.3: "Rejected/expired proposals become an explicit
    // blocked/handoff outcome; do not repeatedly request approval for the same
    // rejected action."
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
      detail: `the proposed restart was ${intentStatus}`, checkpoint,
      handoffSummary:
        `The proposed service restart was ${intentStatus}. Operator did not retry it and took no action.`,
    });
    return `handed off: intent ${intentStatus}`;
  }

  // Dispatched (or terminal): move to observation. `execution_ref_id` is
  // written the moment dispatch returns one, independently of the intent's
  // status CAS (baseline §4), so it is the authoritative signal that something
  // was actually sent.
  if (operation.executionRefId) {
    const next: TaskCheckpoint = taskCheckpointSchema.parse({
      ...checkpoint,
      mutationAttempts: checkpoint.mutationAttempts + 1,
    });
    await yieldToWait({
      task, leaseEpoch, reason: 'execution',
      dependency: { kind: 'device_command', id: operation.executionRefId },
      wakeAfterMs: SERVICE_RECOVERY_BOUNDS.observeWakeAfterMs,
      stepKey: 'observe',
      checkpoint: next,
    });
    return 'waiting: execution';
  }

  if (operation.dispatchState === 'dispatch_failed' || operation.dispatchState === 'cancelled') {
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
      detail: `dispatch ${operation.dispatchState}: ${operation.dispatchDetail ?? 'no detail'}`,
      checkpoint,
      handoffSummary: 'The service restart was never dispatched. Nothing was changed on the device.',
    });
    return `handed off: dispatch ${operation.dispatchState}`;
  }

  // Claimed but no reference yet — the release worker is mid-flight.
  await yieldToWait({
    task, leaseEpoch, reason: 'execution',
    dependency: operation.intentId ? { kind: 'intent', id: operation.intentId } : null,
    wakeAfterMs: 60_000,
    checkpoint,
  });
  return 'waiting: dispatch in flight';
}

/** `observe` — read the device command through the authorized adapter. */
async function advanceObserve(
  task: AiOperatorTaskRow,
  leaseEpoch: number,
  checkpoint: TaskCheckpoint,
  now: Date,
): Promise<string> {
  const operation = await readLatestOperation(task.orgId, task.id);
  if (!operation?.executionRefId || operation.executionRefKind !== 'device_command') {
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unknown_effect',
      detail: 'the task reached observation with no device-command reference', checkpoint,
      handoffSummary:
        'Operator cannot confirm whether the restart was sent. Check the device before retrying.',
    });
    return 'handed off: no execution reference';
  }

  const read = await readDeviceCommandEvidence({
    orgId: task.orgId,
    deviceId: checkpoint.recipeInput.deviceId,
    commandId: operation.executionRefId,
  });

  if (!read.ok) {
    // `device_not_in_org` means the device moved or was deleted between
    // dispatch and now; `evidence_erased` means the row is gone. Neither
    // proves the effect did NOT happen, so neither may be reported as "nothing
    // happened" (spec §7.3's last line).
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unknown_effect',
      detail: `device command evidence unavailable: ${read.reason}`, checkpoint,
      handoffSummary:
        'Operator dispatched a service restart but can no longer read its result '
        + `(${read.reason}). The restart may have happened. Confirm on the device.`,
    });
    return `handed off: ${read.reason}`;
  }

  const classified = classifyDeviceCommandEvidence(read.evidence);

  if (classified.state === 'finished') {
    // Either outcome moves to verification. A `failed` restart is NOT the
    // task's verdict — the service may have been brought up by something else,
    // and only the independent read decides (C10).
    await writeLeasedStep(task, leaseEpoch, 'verify', 'verify', checkpoint);
    return `observed: command ${classified.outcome}`;
  }

  const ageMs = now.getTime() - read.evidence.createdAt.getTime();
  if (ageMs > SERVICE_RECOVERY_BOUNDS.unknownEffectHorizonMs) {
    // Past the horizon and still not settled. Spec §6.5: "an effect with lost
    // acknowledgement, timeout, or unknown result requires authoritative
    // reconciliation; if its absence cannot be proved and the provider lacks
    // idempotency, hand off." A device command has no idempotency guarantee,
    // so this hands off rather than retrying.
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unknown_effect',
      detail: classified.state === 'unknown' ? classified.reason : 'command never reported a result',
      checkpoint,
      handoffSummary:
        'Operator dispatched a service restart that never reported a result. It may still have run. '
        + 'Confirm the service state on the device; do not assume nothing happened.',
    });
    return 'handed off: unknown effect';
  }

  await yieldToWait({
    task, leaseEpoch, reason: 'execution',
    dependency: { kind: 'device_command', id: operation.executionRefId },
    wakeAfterMs: 60_000,
    checkpoint,
    now,
  });
  return `waiting: command ${classified.state}`;
}

/** `verify` — the typed criterion. */
async function advanceVerify(
  task: AiOperatorTaskRow,
  leaseEpoch: number,
  checkpoint: TaskCheckpoint,
): Promise<string> {
  const operation = await readLatestOperation(task.orgId, task.id);

  const evaluation = await evaluateCriterion({
    orgId: task.orgId,
    criterion: checkpoint.criterion,
    // The ai_agent principal's user id IS the agent id: `buildAgentAuthContext`
    // (`agentAuthContext.ts:82`) sets `user.id = agent.id` and documents it as
    // attribution only — never RBAC, never copied into `breeze.user_id`. Using
    // the task's FROZEN `agent_id` rather than re-resolving the current
    // effective agent is deliberate: the verification read must be attributed
    // to the agent the task was admitted under, even if the org has since
    // replaced it (spec §7.1's frozen agent identity).
    agentUserId: task.agentId,
    intentId: operation?.intentId ?? null,
  });

  const next: TaskCheckpoint = taskCheckpointSchema.parse({
    ...checkpoint,
    lastVerification: {
      result: evaluation.result,
      detail: evaluation.detail.slice(0, 500),
      at: evaluation.observedAt.toISOString(),
    },
    satisfiedCriteria: evaluation.result === 'passed' ? ['service_running'] : [],
    unsatisfiedCriteria: evaluation.result === 'passed' ? [] : ['service_running'],
  });

  if (evaluation.result === 'passed' && evaluation.outcome) {
    await settle({
      task, leaseEpoch, event: 'complete', outcome: evaluation.outcome,
      detail: evaluation.detail, checkpoint: next,
    });
    return `completed: ${evaluation.outcome}`;
  }

  if (evaluation.awaitingWindow) {
    await yieldToWait({
      task, leaseEpoch, reason: 'verification_window',
      dependency: { kind: 'verification', id: task.id },
      wakeAfterMs: SERVICE_RECOVERY_BOUNDS.verificationWakeAfterMs,
      checkpoint: next,
    });
    return 'waiting: verification window';
  }

  if (evaluation.result === 'failed') {
    // ONE more reasoning attempt from the checkpoint, per spec §6.3's
    // "admit new run from checkpoint (attempt_ordinal + 1)". The mutation-
    // attempt cap is checked separately from the reasoning-run cap: a second
    // reasoning attempt that is only allowed to investigate is still useful.
    if (checkpoint.mutationAttempts < SERVICE_RECOVERY_BOUNDS.maxMutationAttempts) {
      const admitted = await admitReasoningRun({
        task, leaseEpoch, checkpoint: next, stepKey: 'investigate', bumpPlanRevision: true,
      });
      if (admitted.admitted) return `verification failed; ${admitted.detail}`;
      await settle({
        task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
        detail: `verification failed and no further attempt could be admitted: ${admitted.detail}`,
        checkpoint: next,
        handoffSummary: `The service is still not running. ${evaluation.detail}`,
      });
      return 'handed off: verification failed, no attempts left';
    }
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
      detail: `verification failed after ${checkpoint.mutationAttempts} attempts`,
      checkpoint: next,
      handoffSummary: `The service is still not running after ${checkpoint.mutationAttempts} restart `
        + `attempt(s). ${evaluation.detail}`,
    });
    return 'handed off: mutation attempts exhausted';
  }

  // `inconclusive` / `not_applicable`. Spec §13 acceptance scenario 7:
  // inconclusive can never produce "Resolved". Hand off with what was seen.
  await settle({
    task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
    detail: evaluation.detail, checkpoint: next,
    handoffSummary:
      `Operator could not confirm the outcome: ${evaluation.detail}. `
      + 'Nothing is being claimed as resolved.',
  });
  return 'handed off: inconclusive verification';
}

/** Move to the next step, keeping the task `running` under the same lease. */
async function writeLeasedStep(
  task: AiOperatorTaskRow,
  leaseEpoch: number,
  stepKey: string,
  phase: 'investigate' | 'plan' | 'execute' | 'verify' | 'document',
  checkpoint: TaskCheckpoint,
): Promise<void> {
  await writeLeased({
    orgId: task.orgId,
    taskId: task.id,
    revision: task.revision,
    leaseEpoch,
    patch: {
      currentStepKey: stepKey,
      phase,
      checkpoint: checkpoint as unknown as Record<string, unknown>,
      waitReason: null,
      waitDependencyKind: null,
      waitDependencyId: null,
      // Due immediately: the very next tick continues from the new step.
      nextWakeAt: new Date(),
      leaseOwner: null,
      // AN ALREADY-EXPIRED LEASE, NOT A NULL ONE. This is load-bearing and it
      // was a real bug: the task stays `running` here (it has more work to do
      // this instant, it is not waiting on anything), and the ONLY recovery
      // scan that selects a `running` task is set 3, whose predicate is
      // `lease_expires_at IS NOT NULL AND lease_expires_at <= now()`. Nulling
      // the lease therefore made the row invisible to all four scans and to
      // the poll path — a task stranded in `running` forever, with no error
      // anywhere. Leaving an expired lease says exactly what is true: nobody
      // holds this, and it is due now.
      leaseExpiresAt: new Date(Date.now() - 1),
    },
  });
}

// ---------------------------------------------------------------------------
// Authoritative reads. Every one of these exists so that no decision above is
// ever made from a wake payload (invariant 2).
// ---------------------------------------------------------------------------

interface TaskRunRow {
  id: string;
  status: string;
  outcome: { taskStep?: import('@breeze/shared').SubmitTaskStepPayload } | null;
}

async function readLatestTaskRun(
  orgId: string,
  taskId: string,
  stepKey: string,
): Promise<TaskRunRow | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ id: aiAgentRuns.id, status: aiAgentRuns.status, outcome: aiAgentRuns.outcome })
        .from(aiAgentRuns)
        .where(and(
          eq(aiAgentRuns.orgId, orgId),
          eq(aiAgentRuns.taskId, taskId),
          eq(aiAgentRuns.taskStepKey, stepKey),
        ))
        .orderBy(sql`${aiAgentRuns.taskAttemptOrdinal} DESC NULLS LAST`)
        .limit(1);
      return row
        ? { id: row.id, status: row.status as string, outcome: row.outcome as TaskRunRow['outcome'] }
        : null;
    }));
}

interface OperationRow {
  operationKey: string;
  intentId: string | null;
  dispatchState: string;
  dispatchDetail: string | null;
  resultState: string;
  executionRefKind: string | null;
  executionRefId: string | null;
}

async function readLatestOperation(orgId: string, taskId: string): Promise<OperationRow | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({
          operationKey: aiOperatorOperations.operationKey,
          intentId: aiOperatorOperations.intentId,
          dispatchState: aiOperatorOperations.dispatchState,
          dispatchDetail: aiOperatorOperations.dispatchDetail,
          resultState: aiOperatorOperations.resultState,
          executionRefKind: aiOperatorOperations.executionRefKind,
          executionRefId: aiOperatorOperations.executionRefId,
        })
        .from(aiOperatorOperations)
        .where(and(
          eq(aiOperatorOperations.orgId, orgId),
          eq(aiOperatorOperations.taskId, taskId),
        ))
        .orderBy(sql`${aiOperatorOperations.createdAt} DESC`)
        .limit(1);
      return row
        ? {
          operationKey: row.operationKey,
          intentId: row.intentId,
          dispatchState: row.dispatchState as string,
          dispatchDetail: row.dispatchDetail,
          resultState: row.resultState as string,
          executionRefKind: row.executionRefKind as string | null,
          executionRefId: row.executionRefId,
        }
        : null;
    }));
}

async function readIntentStatus(orgId: string, intentId: string): Promise<string | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ status: actionIntents.status })
        .from(actionIntents)
        .where(and(eq(actionIntents.id, intentId), eq(actionIntents.orgId, orgId)))
        .limit(1);
      return (row?.status as string | undefined) ?? null;
    }));
}

/** True when any operation on this task could still produce a real effect. */
export async function hasUnsettledOperation(orgId: string, taskId: string): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const rows = await db
        .select({ id: aiOperatorOperations.id })
        .from(aiOperatorOperations)
        .where(and(
          eq(aiOperatorOperations.orgId, orgId),
          eq(aiOperatorOperations.taskId, taskId),
          or(
            eq(aiOperatorOperations.resultState, 'pending'),
            eq(aiOperatorOperations.resultState, 'unknown'),
          ),
          // An operation with no execution reference produced no effect that
          // could still land, so it is not "unsettled" in the sense that
          // matters — nothing external is outstanding.
          sql`${aiOperatorOperations.executionRefId} IS NOT NULL`,
        ))
        .limit(1);
      return rows.length > 0;
    }));
}

/** Fold a finished run's submitted findings into the checkpoint, bounded. */
function mergeFindings(
  checkpoint: TaskCheckpoint,
  outcome: TaskRunRow['outcome'],
): TaskCheckpoint['findings'] {
  const submitted = outcome?.taskStep?.findings ?? [];
  // Newest last, oldest dropped first — the schema caps the array at 50 and a
  // parse failure here would fail the whole checkpoint write.
  return [...checkpoint.findings, ...submitted].slice(-50);
}

/**
 * Handle one wake job.
 *
 * The wake is acknowledged (the job completes) ONLY after the transition it
 * caused has committed — which is what returning normally from here means.
 * A throw leaves the BullMQ job to retry AND leaves the outbox row eligible
 * for the reconciler, which is spec §6.3's third rule.
 */
export async function handleTaskWake(args: {
  orgId: string;
  taskId: string;
  sourceKind: string;
  sourceId: string;
}): Promise<string> {
  // `requireWakeDue: false` — this is the EVENT path. See `claimTaskLease`.
  const claim = await claimTaskLease({
    orgId: args.orgId, taskId: args.taskId, requireWakeDue: false,
  });

  if (!claim.won) {
    // Not an error, and deliberately not a retry: a duplicate wake for a task
    // another coordinator is already advancing, or a wake for a task that has
    // since gone terminal, is exactly the convergence spec §6.3 asks for.
    return `skipped (${claim.reason})`;
  }

  return advanceTask(claim.task, claim.leaseEpoch);
}
