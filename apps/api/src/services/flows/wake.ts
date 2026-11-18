/**
 * Tool catalog W04 (#5219), plan Task A5 — the terminal-intent wake.
 *
 * Every terminal transition of a flow-origin action intent wakes the run that
 * parked on it, so the runner can map the intent's outcome onto the step
 * (Task A8 step 4). Called INSIDE the transaction that wrote the terminal
 * status (publishIntentTerminalOutbox, the expiry reaper's direct inserts);
 * the enqueue itself runs only after that transaction COMMITS
 * (`runAfterDbContextCommit`, #7277) — a rolled-back transition never wakes a
 * run, and the queue round trip never holds the transaction's connection
 * (#1105). Outside any DB context it starts immediately.
 *
 * Fire-and-forget: a failed enqueue is reported under the per-run label
 * `flow-run-wake:<runId>` by db/index.ts (the label is only a log string); the run reconciler (Task A8, clause b) re-enqueues
 * any `awaiting_approval` run whose intent is terminal, so a lost wake delays
 * a run rather than stranding it.
 *
 * The queue module is imported lazily: this file is reached from
 * services/aiOperator/taskOutbox.ts, which nearly every intent writer
 * imports, and the BullMQ producer is needed only when a flow run exists.
 */
import { runAfterDbContextCommit } from '../../db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scheduleFlowRunWake(runId: string): void {
  if (!UUID_RE.test(runId)) {
    throw new Error(`scheduleFlowRunWake: runId must be a uuid (got '${runId}')`);
  }
  runAfterDbContextCommit(`flow-run-wake:${runId}`, async () => {
    const { enqueueFlowRunSlice } = await import('../../jobs/flowRunQueue');
    await enqueueFlowRunSlice(runId);
  });
}
