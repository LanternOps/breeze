// AI Operator task outbox writer (#5205 W05, sub-issue #5210).
//
// WHY THIS FILE EXISTS: spec §6.3 requires "a task outbox record atomically
// with each task-affecting authoritative transition", deduplicated "by org,
// task, source kind, source ID, and transition identity" — this is the ONE
// helper every writer calls to do that, so every writer converges on the
// identical dedupe/atomicity contract instead of each reinventing it.
//
// `ai_operator_task_outbox` is DELIBERATELY RLS-scoped (baseline C20,
// db/schema/aiOperatorTasks.ts's header) — the opposite of `intent_outbox`,
// which is INTENTIONAL_UNSCOPED because the agent WS path drains it. Never
// add this table to that allowlist.
//
// Callers MUST pass their own transaction handle (`dbh` — a bare `db` proxy
// that joins the caller's ambient `withDbAccessContext`/`withSystemDbAccessContext`
// scope, or an explicit `tx`) so the enqueue lands in the SAME Postgres
// transaction as the terminal status write it announces. A row written in a
// separate, later statement is not atomic with the transition it describes: a
// crash between the two would leave a committed terminal state with no wake
// ever raised, stranding the task in `waiting` until its deadline.

import { db } from '../../db';
import {
  aiOperatorTaskOutbox,
  type AiOperatorOutboxSourceKind,
} from '../../db/schema/aiOperatorTasks';
import { intentOutbox } from '../../db/schema/actionIntents';

/** The subset of drizzle's `db` these helpers need — lets them join a caller's transaction. */
type DbHandle = Pick<typeof db, 'insert'>;

export interface EnqueueTaskOutboxInput {
  orgId: string;
  taskId: string;
  sourceKind: AiOperatorOutboxSourceKind;
  sourceId: string;
  transitionSeq: number;
}

/**
 * THE one helper every writer calls to enqueue an `ai_operator_task_outbox`
 * row, in the caller's own transaction. `ON CONFLICT DO NOTHING` on the row's
 * identity unique (`org_id, task_id, source_kind, source_id, transition_seq`
 * — `ai_operator_task_outbox_identity_uq`) so redelivery of the same
 * terminalization (a retried writer, a duplicate CAS attempt that somehow
 * re-entered) converges on one row rather than erroring or double-waking the
 * coordinator (spec §6.3's "Deduplicate by org, task, source kind, source ID,
 * and transition identity").
 */
export async function enqueueTaskOutbox(
  dbh: DbHandle,
  input: EnqueueTaskOutboxInput,
): Promise<void> {
  await dbh
    .insert(aiOperatorTaskOutbox)
    .values({
      orgId: input.orgId,
      taskId: input.taskId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      transitionSeq: input.transitionSeq,
    })
    .onConflictDoNothing({
      target: [
        aiOperatorTaskOutbox.orgId,
        aiOperatorTaskOutbox.taskId,
        aiOperatorTaskOutbox.sourceKind,
        aiOperatorTaskOutbox.sourceId,
        aiOperatorTaskOutbox.transitionSeq,
      ],
    });
}

/**
 * `intent_outbox.event_type` values a task-linked intent's TERMINAL write can
 * publish. Widened by migration 2026-10-14-100300-ai-operator-intent-terminal-events.sql
 * to add `intent_completed`/`intent_failed` (there was no way to say either
 * before this wave — baseline §3.3).
 */
export type IntentTerminalOutboxEvent =
  | 'intent_completed'
  | 'intent_failed'
  | 'intent_rejected'
  | 'intent_expired'
  | 'intent_cancelled';

/**
 * `transitionSeq` for an intent's task-outbox row (`sourceKind: 'intent'`,
 * `sourceId: intentId`). `action_intents.status` reaches AT MOST ONE terminal
 * value ever — once terminal, a status is final; nothing transitions an
 * intent out of a terminal status (`transitionIntent`'s CAS `from` list is
 * always a LIVE status). So each intent produces at most one task-outbox row
 * per possible terminal event, and these fixed ordinals only need to be
 * MUTUALLY DISTINCT, not a running per-intent counter — "the terminal status
 * ordinal" scheme spec §6.3 asks for ("use the terminal status ordinal or a
 * sequence; document it"). A retried/duplicate delivery of the SAME
 * terminalization reuses the SAME ordinal, which is exactly what makes the
 * identity unique's `ON CONFLICT DO NOTHING` collapse it to one row.
 */
export const INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ: Record<IntentTerminalOutboxEvent, number> = {
  intent_completed: 1,
  intent_failed: 2,
  intent_rejected: 3,
  intent_expired: 4,
  intent_cancelled: 5,
};

/**
 * The combo every intent terminal writer calls (baseline §3.2's inventory is
 * the enumeration; `aiOperatorTerminalWriters.integration.test.ts` pins it):
 *
 *  (a) an `intent_outbox` row — UNCONDITIONAL, ids-only payload, matching the
 *      shape every existing writer already uses (`{ intentId, orgId }`); and
 *  (b) — only when the intent is task-linked (`taskId` non-null) — an
 *      `ai_operator_task_outbox` row via `enqueueTaskOutbox` above.
 *
 * MUST be called inside the SAME transaction as the terminal status write
 * (spec §6.3: "Add a task outbox record atomically with each task-affecting
 * authoritative transition") — pass the caller's own `db`/`tx` handle as
 * `dbh`, never a fresh `db` reference opened outside that transaction's
 * context.
 */
export async function publishIntentTerminalOutbox(
  dbh: DbHandle,
  intent: { id: string; orgId: string; taskId: string | null },
  event: IntentTerminalOutboxEvent,
): Promise<void> {
  await dbh.insert(intentOutbox).values({
    intentId: intent.id,
    eventType: event,
    // Ids only, no argument content (spec §3.2) — matches every existing
    // intent_created/intent_approved/intent_rejected/intent_expired/intent_cancelled row.
    payload: { intentId: intent.id, orgId: intent.orgId },
  });

  if (intent.taskId) {
    await enqueueTaskOutbox(dbh, {
      orgId: intent.orgId,
      taskId: intent.taskId,
      sourceKind: 'intent',
      sourceId: intent.id,
      transitionSeq: INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ[event],
    });
  }
}
