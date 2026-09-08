// AI Operator operation rows (#5205 W04, sub-issue #5209).
//
// WHY THIS FILE EXISTS, in one sentence: the truth about an effect survives at
// the execution reference and is destroyed at the intent, so the operation row
// must be written from the reference on its own schedule and must never be
// gated on winning the intent's status CAS (baseline §4, spec §6.3).
//
// Two guards, deliberately different shapes (baseline C7/H2):
//   - `action_intents_org_idem_uniq` is PARTIAL over live statuses and guards
//     CONCURRENT duplication. A `completed` intent leaves that set and frees
//     its key while the device command may still be running.
//   - `ai_operator_operations_org_task_op_uq` is PERMANENT with no status
//     predicate and guards SEQUENTIAL replay. `reserveOperation` below is the
//     only writer that can trip it, and it turns the 23505 into a typed
//     refusal rather than letting a second intent be minted for an operation
//     whose effect may already have landed.
//
// Every function here runs under system scope. The rows are Shape-1 org-scoped
// with forced RLS, and the callers (the release worker, the expiry reaper, the
// creation transaction) hold either no ambient context or a system one.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  aiOperatorOperations,
  type AiOperatorExecutionRefKind,
} from '../../db/schema/aiOperatorTasks';
import { captureException } from '../sentry';

/** Mirrors `ai_operator_operations_result_size_chk` (pg_column_size <= 64 KiB). */
const MAX_OPERATION_RESULT_BYTES = 48 * 1024;

export type OperationResultState = 'pending' | 'succeeded' | 'failed' | 'unknown' | 'superseded';

/**
 * Definite outcomes outrank `unknown`, which outranks `pending`. This is what
 * makes the writers order-independent, which they have to be: the stale-
 * executing reaper (20 min) and a late device-command result race each other by
 * construction (baseline §2.6, the three clocks). A real outcome may therefore
 * arrive AFTER the reaper wrote `unknown` and must still land; `unknown` must
 * never overwrite a recorded outcome.
 */
const RESULT_STATE_RANK: Record<OperationResultState, number> = {
  pending: 0,
  unknown: 1,
  superseded: 1,
  succeeded: 2,
  failed: 2,
};

/** The subset of drizzle's `db` these helpers need — lets them join a caller's transaction. */
type DbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

export class OperationReplayError extends Error {
  readonly code = 'operation_replay';
  constructor(message: string) {
    super(message);
    this.name = 'OperationReplayError';
  }
}

export interface ReserveOperationInput {
  orgId: string;
  taskId: string;
  taskStepKey: string;
  operationKey: string;
  attemptOrdinal: number;
  intentId: string;
  originatingRunId: string | null;
  argumentDigest: string;
  /** `ai_operator_tasks.revision` read in the same transaction. */
  planRevision: number;
}

/**
 * Reserves the operation row in the SAME transaction as the intent insert
 * (spec §6.5: "bind an intent atomically during intent creation"; attaching
 * after the intent commits is explicitly insufficient).
 *
 * Pass the caller's transaction handle as `dbh` — this function opens no
 * context of its own precisely so a throw rolls the intent back with it.
 *
 * A conflict on `(org_id, task_id, operation_key)` means an operation with this
 * identity has ALREADY been reserved. Two cases:
 *   - it points at this same intent: a redelivery of the creation call, no-op.
 *   - it points at a different intent (the sequential-replay case: the first
 *     intent terminalized, freeing the live idempotency key, and a continuation
 *     run re-proposed the same operation): refuse. The first effect may still
 *     be in flight and confirmed effects are never blindly replayed (spec §6.5).
 */
export async function reserveOperation(
  dbh: DbHandle,
  input: ReserveOperationInput,
): Promise<void> {
  const [inserted] = await dbh
    .insert(aiOperatorOperations)
    .values({
      orgId: input.orgId,
      taskId: input.taskId,
      taskStepKey: input.taskStepKey,
      operationKey: input.operationKey,
      attemptOrdinal: input.attemptOrdinal,
      intentId: input.intentId,
      originatingRunId: input.originatingRunId,
      argumentDigest: input.argumentDigest,
      planRevision: input.planRevision,
      dispatchState: 'reserved',
      resultState: 'pending',
    })
    .onConflictDoNothing({
      target: [
        aiOperatorOperations.orgId,
        aiOperatorOperations.taskId,
        aiOperatorOperations.operationKey,
      ],
    })
    .returning({ id: aiOperatorOperations.id });

  if (inserted) return;

  const [existing] = await dbh
    .select({ id: aiOperatorOperations.id, intentId: aiOperatorOperations.intentId })
    .from(aiOperatorOperations)
    .where(
      and(
        eq(aiOperatorOperations.orgId, input.orgId),
        eq(aiOperatorOperations.taskId, input.taskId),
        eq(aiOperatorOperations.operationKey, input.operationKey),
      ),
    )
    .limit(1);

  if (existing && existing.intentId === input.intentId) return;

  throw new OperationReplayError(
    `Operation ${input.operationKey} on task ${input.taskId} is already reserved`
      + `${existing?.intentId ? ` by intent ${existing.intentId}` : ''}`
      + ' — a confirmed effect is never replayed (spec §6.5)',
  );
}

/**
 * Marks the operation dispatched. Called from INSIDE the dispatch-claim
 * transaction, so it shares the claim's atomicity: a won claim and an
 * `in flight` operation commit together or not at all. `claimedLeaseEpoch` is
 * the epoch OBSERVED at claim time, recorded so W06 can recognise a result
 * produced by a superseded epoch's operation and accept it under its original
 * identity (spec §6.3).
 */
export async function markOperationDispatched(
  dbh: DbHandle,
  intentId: string,
  claimedLeaseEpoch: number | null,
): Promise<void> {
  const rows = await dbh
    .update(aiOperatorOperations)
    .set({
      dispatchState: 'dispatched',
      dispatchedAt: new Date(),
      claimedLeaseEpoch,
      dispatchDetail: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiOperatorOperations.intentId, intentId),
        eq(aiOperatorOperations.dispatchState, 'reserved'),
      ),
    )
    .returning({ id: aiOperatorOperations.id });

  // Exactly one, or the claim it belongs to must not commit. The caller took
  // the operation row FOR UPDATE and checked `reserved` first, so zero rows
  // here means a genuinely broken invariant (a missing row, a concurrent writer
  // that bypassed the lock order), never an ordinary race. Throwing rolls the
  // intent claim back with it rather than leaving an `executing` intent whose
  // operation still reads `reserved`.
  if (rows.length !== 1) {
    throw new Error(
      `[aiOperator] dispatch claim for intent ${intentId} matched ${rows.length} reserved operations, expected 1`,
    );
  }
}

/**
 * A claim that was never won, or a revalidation stop that refused to dispatch.
 * Terminal for the operation: nothing was sent, so there is no effect to
 * reconcile. `detail` is the reason a reader needs — a revalidation error code,
 * `claim_refused`, `policy_denied`.
 */
export async function markOperationDispatchFailed(
  intentId: string,
  detail: string,
): Promise<void> {
  await runOperationWrite('markOperationDispatchFailed', intentId, async () => {
    await db
      .update(aiOperatorOperations)
      .set({
        dispatchState: 'dispatch_failed',
        dispatchDetail: boundedDetail(detail),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiOperatorOperations.intentId, intentId),
          inArray(aiOperatorOperations.dispatchState, ['reserved', 'dispatched']),
          // `dispatched` is allowed here for one narrow, real case: the claim is
          // won BEFORE revalidation runs (that ordering is what makes the claim
          // the single-use fence), so a revalidation stop terminalizes an intent
          // whose operation already reads `dispatched` even though nothing was
          // ever sent. `execution_ref_id IS NULL` is the proof that nothing was:
          // the reference is written the moment dispatch returns one. Once a
          // reference exists the effect is real and only a RESULT may settle the
          // operation — never a dispatch failure.
          isNull(aiOperatorOperations.executionRefId),
        ),
      );
  });
}

/**
 * The kill-switch reversal (`executing -> approved`). The operation goes back to
 * `reserved` because the intent is claimable again by the next delivery — it is
 * NOT a dispatch failure, and calling it one would make the reconciler treat a
 * pausable, still-live operation as settled.
 *
 * Shares the reversal's transaction handle for the same reason
 * `markOperationDispatched` shares the claim's.
 */
export async function revertOperationToReserved(
  dbh: DbHandle,
  intentId: string,
  detail: string,
): Promise<void> {
  await dbh
    .update(aiOperatorOperations)
    .set({
      dispatchState: 'reserved',
      dispatchedAt: null,
      dispatchDetail: boundedDetail(detail),
      updatedAt: new Date(),
    })
    .where(eq(aiOperatorOperations.intentId, intentId));
}

/**
 * A task-linked intent cancelled from `pending_approval` / `approved`: nothing
 * was ever dispatched, so the operation is terminally `cancelled` (distinct
 * from `abandoned`, which is a leaked reservation — the reconciler's
 * "terminal task with an unsettled operation" scan needs to tell them apart).
 * Shares the cancel CAS's transaction.
 */
export async function markOperationCancelled(dbh: DbHandle, intentId: string): Promise<void> {
  await dbh
    .update(aiOperatorOperations)
    .set({
      dispatchState: 'cancelled',
      cancelRequestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(aiOperatorOperations.intentId, intentId));
}

/**
 * A task-linked intent cancelled while already `executing`. The intent stays
 * `executing` and `dispatch_state` stays `dispatched`: the effect is in flight
 * and cancellation is not rollback (spec §7.3). This records that a human asked
 * for it to stop so the caller can honestly answer "in flight, will be
 * reconciled" instead of the silent no-op the pre-W04 code returned.
 */
export async function markOperationCancelRequested(
  dbh: DbHandle,
  intentId: string,
): Promise<boolean> {
  const rows = await dbh
    .update(aiOperatorOperations)
    .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(aiOperatorOperations.intentId, intentId), isNull(aiOperatorOperations.cancelRequestedAt)))
    .returning({ id: aiOperatorOperations.id });
  return rows.length > 0;
}

export interface RecordOperationResultInput {
  intentId: string;
  resultState: Exclude<OperationResultState, 'pending'>;
  result: Record<string, unknown>;
  executionRef?: { kind: AiOperatorExecutionRefKind; id: string } | null;
}

/**
 * Persists the execution reference and the bounded result on the operation row
 * in ITS OWN statement, independent of the intent's status CAS — the whole
 * point of the row (baseline §4). Callers invoke it BEFORE attempting the
 * intent CAS and again on the losing-CAS path, so a lost race no longer
 * discards the result.
 *
 * Monotonic in `RESULT_STATE_RANK`: a definite outcome overwrites `unknown`,
 * `unknown` overwrites only `pending`, and nothing overwrites a definite
 * outcome. Without this the 20-minute reaper's `unknown` and a late device
 * result would clobber each other depending on arrival order.
 *
 * Never throws: this runs after a real-world side effect has already happened,
 * and failing the caller at that point would be strictly worse than a logged,
 * captured write failure that the reconciler picks up from the source rows.
 */
export async function recordOperationResult(input: RecordOperationResultInput): Promise<void> {
  await runOperationWrite('recordOperationResult', input.intentId, async () => {
    const incomingRank = RESULT_STATE_RANK[input.resultState];
    await db
      .update(aiOperatorOperations)
      .set({
        resultState: input.resultState,
        result: boundedResult(input.result),
        resultAt: new Date(),
        ...(input.executionRef
          ? { executionRefKind: input.executionRef.kind, executionRefId: input.executionRef.id }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiOperatorOperations.intentId, input.intentId),
          // Rank comparison in SQL, not in JS: two writers race here by
          // construction and a read-then-write would lose one of them.
          sql`CASE ${aiOperatorOperations.resultState}
                WHEN 'pending' THEN 0
                WHEN 'unknown' THEN 1
                WHEN 'superseded' THEN 1
                ELSE 2
              END < ${incomingRank}`,
        ),
      );
  });
}

/**
 * Attaches the execution reference alone, the moment dispatch returns it and
 * before any result exists. Separate from `recordOperationResult` because the
 * reference is what makes an UNKNOWN effect reconcilable at all: if the process
 * dies between dispatch and result, the reference is the only thing that can
 * find the device command again.
 */
export async function recordOperationExecutionRef(
  intentId: string,
  ref: { kind: AiOperatorExecutionRefKind; id: string },
): Promise<void> {
  await runOperationWrite('recordOperationExecutionRef', intentId, async () => {
    await db
      .update(aiOperatorOperations)
      .set({ executionRefKind: ref.kind, executionRefId: ref.id, updatedAt: new Date() })
      .where(
        and(
          eq(aiOperatorOperations.intentId, intentId),
          isNull(aiOperatorOperations.executionRefId),
        ),
      );
  });
}

/** True when the intent carries a full task linkage. */
export function isTaskLinkedIntent(intent: {
  taskId?: string | null;
  taskStepKey?: string | null;
  operationKey?: string | null;
}): boolean {
  // `!= null` on purpose, not `!== null`: callers hand this partially-projected
  // rows and test doubles where an absent column is `undefined`, and
  // `undefined !== null` is TRUE — which would classify every legacy intent as
  // task-linked and send it down the operation-write path. Treat absent and
  // null identically.
  return intent.taskId != null && intent.taskStepKey != null && intent.operationKey != null;
}

// ---------------------------------------------------------------------------

function boundedDetail(detail: string): string {
  return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
}

function boundedResult(result: Record<string, unknown>): Record<string, unknown> {
  try {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_OPERATION_RESULT_BYTES) {
      return result;
    }
  } catch {
    return { truncated: true, reason: 'unserializable' };
  }
  return { truncated: true };
}

/**
 * Standalone operation writes run in their own system-scoped context and
 * swallow failures. Every caller is post-effect (a result arrived, a claim was
 * lost, the reaper gave up); throwing would convert a bookkeeping failure into
 * a failed action that already happened. The failure is logged and captured so
 * it is visible, and the reconciler re-derives the same fact from the
 * authoritative source row.
 */
async function runOperationWrite(
  label: string,
  intentId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await withSystemDbAccessContext(fn);
  } catch (err) {
    console.error(`[aiOperator] ${label} failed for intent ${intentId}:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
