// The ONE durable dispatch claim for a task-linked action intent
// (#5205 W04, sub-issue #5209; spec §7.3, baseline C8/H3).
//
// Spec §7.3 is explicit that for intents this claim **is** the existing
// `approved -> executing` CAS with the task checks folded in — not a second
// claim taken afterwards. That is what this module implements, and it lives
// here rather than inline in `intentReleaseWorker.ts` so W06 can reuse the same
// linearization point for direct act.
//
// ONE TRANSACTION, THREE ROWS, ONE LOCK ORDER: task -> operation -> intent.
// The task row is taken `FOR UPDATE` first, and the intent CAS then re-states
// the whole task predicate as an `EXISTS` over that same locked row.
//
// EVERY path that touches both an operation and its intent must take them in
// that relative order — operation before intent — or it forms an AB-BA cycle
// with this claim and deadlocks (40P01) under ordinary concurrency. The two
// other such paths are `revertTaskLinkedDispatchClaim` below and
// `cancelActionIntent`'s task-linked branch in intentService.ts; both take an
// explicit `FOR UPDATE` on the operation row before touching the intent for
// exactly this reason. If you add a third, do the same.
//
// Why the lock and not just the join (the Codex quorum's one substantive
// disagreement, adopted): under READ COMMITTED an `UPDATE action_intents ...
// FROM ai_operator_tasks` re-reads and re-checks only the row it is UPDATING
// when a concurrent writer touches it. The JOINED task row is read from the
// statement's snapshot and is never locked, so a concurrent `stopping` /
// revision bump / detach committing between snapshot and update is invisible
// and the claim wins anyway. Locking the task first makes the predicate
// evaluate against the committed-latest task and holds it that way until the
// claim commits. The predicate is ALSO kept in the UPDATE's own WHERE so the
// SQL states the invariant rather than relying on a lock the next reader has to
// know about.
//
// Fail-closed on a NULL deadline (also adopted from the quorum). `deadline_at`
// is nullable in the W03 schema, but spec §7.3 gives every task a bounded
// deadline and "expiry stops new effects like cancellation". A runnable task
// with no deadline is an admission bug, and an authority predicate must refuse
// on missing authority rather than treat absence as permission. Task admission
// (W06) MUST populate `deadline_at`.

import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiOperatorOperations, aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { markOperationDispatched, revertOperationToReserved } from './operationService';

/**
 * Why a claim was refused. These land verbatim in
 * `ai_operator_operations.dispatch_detail`, so they are part of the operator-
 * facing contract, not just log text.
 */
export type DispatchClaimRefusal =
  /**
   * No `ai_operator_operations` row exists for this intent at all. A BROKEN
   * INVARIANT, not a race: `reserveOperation` runs in the same transaction as
   * the intent insert, so a task-linked intent without an operation row should
   * be unreachable. Kept distinct from `operation_already_claimed` so the
   * caller can raise it to Sentry instead of logging it like an ordinary lost
   * race — otherwise an intent would sit `approved` until an unrelated deadline
   * reaper noticed, up to 24 h later for an `mcp_api` source, with no error
   * code naming what went wrong.
   */
  | 'operation_missing'
  /**
   * The operation row exists but is no longer `reserved` — another claimant
   * already owns it. An ordinary, healthy race. The caller must NOT overwrite
   * the winner's bookkeeping, and must not page anyone.
   */
  | 'operation_already_claimed'
  /** The task is not in a state that may admit a new effect, or its plan moved on. */
  | 'task_not_claimable'
  /** The intent itself was not `approved`, or its release lease had passed. */
  | 'intent_not_claimable';

export type DispatchClaimResult =
  | { won: true; leaseEpoch: number }
  | { won: false; refusal: DispatchClaimRefusal; detail: string };

export interface TaskLinkedIntentRef {
  id: string;
  orgId: string;
  taskId: string;
}

export interface DispatchClaimOptions {
  /**
   * Fence the claim on the caller's own scheduler lease epoch. Supplied by a
   * LEASE HOLDER (W06's direct-act path). Omitted on the intent-release path,
   * which holds no lease: its fencing is the intent's own single-use
   * `approved -> executing` CAS, and spec §6.3 requires a result from an
   * operation a superseded epoch dispatched to be accepted under its ORIGINAL
   * identity — so refusing an approval merely because the coordinator was
   * reclaimed while a human was deciding would strand the task, not protect it.
   * The observed epoch is recorded on the operation either way.
   */
  expectedLeaseEpoch?: number | null;
}

/** Task states that may still admit a NEW effect. */
export const CLAIMABLE_TASK_STATES = ['running', 'waiting'] as const;

export interface ClaimTaskSnapshot {
  state: string | null;
  revision: number;
  leaseEpoch: number;
  deadlineAt: Date | null;
  targetDetachedAt: Date | null;
}

/**
 * The claim's task-side predicate as a PURE function, so every refusal branch
 * is unit-testable without a database. `claimTaskLinkedIntentForDispatch`
 * evaluates this against the row it holds `FOR UPDATE`, and the intent CAS then
 * re-states the same predicate in SQL.
 *
 * Returns null when the claim may proceed, or the refusal detail when it may
 * not. Order matters only for which reason a reader sees first.
 */
export function evaluateTaskClaimPredicate(
  task: ClaimTaskSnapshot,
  planRevision: number | null,
  opts: { now: Date; expectedLeaseEpoch?: number | null },
): string | null {
  if (!(CLAIMABLE_TASK_STATES as readonly string[]).includes(task.state ?? '')) {
    return `task state '${task.state}' cannot admit a new effect`;
  }
  if (planRevision === null || planRevision !== task.revision) {
    return `plan revision moved: approved ${planRevision}, task now ${task.revision}`;
  }
  // Fail closed on a missing deadline: absence of a bound is not permission.
  if (task.deadlineAt === null) {
    return 'task has no deadline_at — admission did not bound it';
  }
  if (task.deadlineAt.getTime() <= opts.now.getTime()) {
    return 'task deadline has passed';
  }
  if (task.targetDetachedAt !== null) {
    return 'task target is detached';
  }
  const expectedEpoch = opts.expectedLeaseEpoch ?? null;
  if (expectedEpoch !== null && task.leaseEpoch !== expectedEpoch) {
    return `lease epoch moved: claimant ${expectedEpoch}, task now ${task.leaseEpoch}`;
  }
  return null;
}

/**
 * Wins (or refuses) the single dispatch claim for a task-linked intent.
 *
 * On a win the intent is `executing` and the operation is `dispatched` with
 * `dispatched_at` and the observed `claimed_lease_epoch` — atomically. A lost
 * claim writes nothing at all and dispatches nothing.
 */
export async function claimTaskLinkedIntentForDispatch(
  intent: TaskLinkedIntentRef,
  options: DispatchClaimOptions = {},
): Promise<DispatchClaimResult> {
  return withSystemDbAccessContext(async () => {
    // Lock order 1/3 — the task. FOR UPDATE, so every predicate below reads the
    // committed-latest row and holds it until this transaction commits.
    const [task] = await db
      .select({
        id: aiOperatorTasks.id,
        state: aiOperatorTasks.state,
        revision: aiOperatorTasks.revision,
        leaseEpoch: aiOperatorTasks.leaseEpoch,
        deadlineAt: aiOperatorTasks.deadlineAt,
        targetDetachedAt: aiOperatorTasks.targetDetachedAt,
      })
      .from(aiOperatorTasks)
      .where(and(eq(aiOperatorTasks.id, intent.taskId), eq(aiOperatorTasks.orgId, intent.orgId)))
      .for('update')
      .limit(1);

    if (!task) {
      return refuse('task_not_claimable', `task ${intent.taskId} not found in org ${intent.orgId}`);
    }

    // Lock order 2/3 — the operation. Locked before the intent so the reversal,
    // cancel and stop paths can take the same order and never deadlock.
    const [operation] = await db
      .select({
        id: aiOperatorOperations.id,
        planRevision: aiOperatorOperations.planRevision,
        dispatchState: aiOperatorOperations.dispatchState,
      })
      .from(aiOperatorOperations)
      .where(eq(aiOperatorOperations.intentId, intent.id))
      .for('update')
      .limit(1);

    if (!operation) {
      return refuse('operation_missing', `no operation row reserved for intent ${intent.id}`);
    }
    if (operation.dispatchState !== 'reserved') {
      return refuse(
        'operation_already_claimed',
        `operation ${operation.id} is '${operation.dispatchState}', not 'reserved'`,
      );
    }

    // `plan_revision` was pinned when the operation was reserved, i.e. by the
    // admission that the approval covers. A revised plan means a new operation
    // and a new approval (spec §7.1), so a stale one must not dispatch.
    const refusalDetail = evaluateTaskClaimPredicate(task, operation.planRevision, {
      now: new Date(),
      expectedLeaseEpoch: options.expectedLeaseEpoch,
    });
    if (refusalDetail) {
      return refuse('task_not_claimable', refusalDetail);
    }

    // Lock order 3/3 — the intent CAS. Deliberately re-states the whole task
    // predicate as an EXISTS over the row already locked above: the checks
    // belong in the claim's own SQL (spec §7.3), and this is also what makes
    // the claim correct for a reader who arrives without taking the lock.
    const claimed = await db
      .update(actionIntents)
      .set({ status: 'executing', executedAt: null, executionStartedAt: new Date() })
      .where(
        and(
          eq(actionIntents.id, intent.id),
          eq(actionIntents.status, 'approved'),
          sql`COALESCE(${actionIntents.releaseBy}, ${actionIntents.expiresAt}) > now()`,
          sql`EXISTS (
                SELECT 1 FROM ai_operator_tasks t
                 WHERE t.id = ${actionIntents.taskId}
                   AND t.org_id = ${actionIntents.orgId}
                   AND t.state IN ('running', 'waiting')
                   AND t.revision = ${operation.planRevision}
                   AND t.deadline_at IS NOT NULL
                   AND t.deadline_at > now()
                   AND t.target_detached_at IS NULL
              )`,
        ),
      )
      .returning({ id: actionIntents.id });

    if (claimed.length === 0) {
      return refuse(
        'intent_not_claimable',
        `intent ${intent.id} was not 'approved' within its release lease`,
      );
    }

    // Same transaction as the claim — a won claim and an in-flight operation
    // commit together or not at all. `markOperationDispatched` writes through
    // the ambient `db`, which IS this transaction.
    await markOperationDispatched(db, intent.id, task.leaseEpoch);
    return { won: true, leaseEpoch: task.leaseEpoch };
  });
}

/**
 * The kill-switch reversal (`executing -> approved`, `pauseIntentForKillSwitch`
 * in intentReleaseWorker.ts) extended for a task-linked intent: the operation
 * goes back to `reserved` in the SAME transaction, so the row never claims a
 * dispatch that was undone. Returns whether the reversal CAS was won — a lost
 * CAS means something else (a reaper, a duplicate delivery) already moved the
 * row and there is nothing to revert.
 *
 * LOCK ORDER — operation BEFORE intent, matching the claim. This `FOR UPDATE`
 * is not decorative. `claimTaskLinkedIntentForDispatch` takes
 * task -> operation -> intent; without this line the reversal would take
 * intent -> operation, and the two paths would form an AB-BA cycle on
 * {operation, intent}. That is reachable in ordinary operation: a kill switch
 * engaging mid-release while a redelivered `intent_approved` job claims the
 * same intent (a redelivery this worker is explicitly designed to tolerate)
 * would deadlock, and Postgres would abort one side with 40P01. Take the
 * operation lock first and the cycle cannot form.
 */
export async function revertTaskLinkedDispatchClaim(
  intentId: string,
  detail: string,
): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    await db
      .select({ id: aiOperatorOperations.id })
      .from(aiOperatorOperations)
      .where(eq(aiOperatorOperations.intentId, intentId))
      .for('update')
      .limit(1);
    const rows = await db
      .update(actionIntents)
      .set({ status: 'approved' })
      .where(and(eq(actionIntents.id, intentId), eq(actionIntents.status, 'executing')))
      .returning({ id: actionIntents.id });
    if (rows.length === 0) return false;
    await revertOperationToReserved(db, intentId, detail);
    return true;
  });
}

function refuse(refusal: DispatchClaimRefusal, detail: string): DispatchClaimResult {
  return { won: false, refusal, detail };
}
