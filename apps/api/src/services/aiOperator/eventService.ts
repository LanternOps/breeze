// AI Operator task event timeline (Recipe Library wave E2).
//
// WHY THIS FILE EXISTS: `ai_operator_task_events` is append-only evidence with
// a unique (task_id, transition_seq), and spec §6.2 requires "a monotonic
// transition sequence" persisted with the transition it describes. This is the
// ONE writer, so every caller converges on the same allocation and the same
// atomicity contract instead of each inventing one.
//
// ALLOCATION. `transition_seq` comes from `UPDATE ai_operator_tasks SET
// event_seq = event_seq + 1 … RETURNING event_seq`, never from
// `MAX(transition_seq) + 1`. The UPDATE takes the task's own row lock, so two
// writers for the same task serialise and neither ever sees a conflict. A
// MAX()+1 read would instead race to a 23505 — and a 23505 raised inside the
// request transaction ABORTS it, so an ordinary concurrent event would surface
// as a 500 and the only repair would be a SAVEPOINT retry loop.
//
// ATOMICITY. Callers MUST pass their own handle (`dbh`) — a bare `db` proxy
// that joins the caller's ambient withDbAccessContext/withSystemDbAccessContext
// transaction, or an explicit `tx` — so the event lands in the SAME Postgres
// transaction as the transition it announces. Same contract, and same wording,
// as `enqueueTaskOutbox` (taskOutbox.ts) and `reserveOperation`
// (operationService.ts). An event written in a later statement is not evidence
// of a transition; it is a claim about one.
//
// NOT THE OUTBOX. `ai_operator_task_outbox.transition_seq` is a FIXED terminal
// status ordinal (taskOutbox.ts:92, :127) chosen so a redelivered wake collapses
// onto one row. This counter is the opposite: strictly increasing, one per
// recorded transition. Do not unify them.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import {
  aiOperatorTaskEvents,
  type AiOperatorEventActorKind,
  type AiOperatorTaskEventType,
} from '../../db/schema/aiOperatorTaskGraph';

/** Mirrors `ai_operator_task_events_detail_len_chk`. */
const MAX_EVENT_DETAIL_CHARS = 4000;
/** Mirrors `ai_operator_task_events_step_key_len_chk`. */
const MAX_EVENT_STEP_KEY_CHARS = 128;

/** The subset of drizzle's `db` this helper needs — lets it join a caller's transaction. */
export type EventDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

/**
 * Who did it. A union rather than two loose fields, because
 * `ai_operator_task_events_actor_chk` requires `actor_user_id` to be non-null
 * for `user` and null for everything else — spec §7.1's "database context has
 * no synthetic human user ID" made structural. Passing a user id with a
 * machine kind is unrepresentable here, so it cannot reach the CHECK.
 */
export type TaskEventActor =
  | { kind: 'user'; userId: string }
  | { kind: Exclude<AiOperatorEventActorKind, 'user'> };

export interface AppendTaskEventInput {
  orgId: string;
  taskId: string;
  eventType: AiOperatorTaskEventType;
  actor: TaskEventActor;
  stepKey?: string | null;
  /** `ai_operator_task_targets.id`. A typed reference with NO FK — see the
   *  table's schema comment for why an append-only row cannot carry one. */
  targetId?: string | null;
  detail?: string | null;
}

/**
 * Append one event. Returns the allocated `transition_seq`, or `null` if the
 * task row is gone.
 *
 * A vanished task is a NO-OP, not a throw: the reconciler and the erasure path
 * can both race an event write against a deleted task, and turning that into an
 * exception would abort the caller's whole transaction to record something
 * nobody can ever read.
 */
export async function appendTaskEvent(
  dbh: EventDbHandle,
  input: AppendTaskEventInput,
): Promise<number | null> {
  const [allocated] = await dbh
    .update(aiOperatorTasks)
    .set({ eventSeq: sql`${aiOperatorTasks.eventSeq} + 1` })
    .where(and(eq(aiOperatorTasks.id, input.taskId), eq(aiOperatorTasks.orgId, input.orgId)))
    .returning({ eventSeq: aiOperatorTasks.eventSeq });

  if (!allocated) return null;

  await dbh.insert(aiOperatorTaskEvents).values({
    orgId: input.orgId,
    taskId: input.taskId,
    transitionSeq: allocated.eventSeq,
    eventType: input.eventType,
    actorKind: input.actor.kind,
    actorUserId: input.actor.kind === 'user' ? input.actor.userId : null,
    stepKey: input.stepKey ? input.stepKey.slice(0, MAX_EVENT_STEP_KEY_CHARS) : null,
    targetId: input.targetId ?? null,
    // Truncate rather than let the CHECK raise: an over-long detail is a
    // logging mistake, and aborting a real state transition to punish it would
    // trade a cosmetic bug for a stuck task.
    detail: input.detail ? input.detail.slice(0, MAX_EVENT_DETAIL_CHARS) : null,
  });

  return allocated.eventSeq;
}
