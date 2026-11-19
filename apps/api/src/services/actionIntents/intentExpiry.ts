import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents, intentOutbox } from '../../db/schema/actionIntents';
import type { ActionIntentSource, ActionIntentStatus } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { captureException } from '../sentry';
import { recordActionIntentEvent } from './metrics';
import { scheduleFlowRunWake } from '../flows/wake';
import { enqueueTaskOutbox, INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ } from '../aiOperator/taskOutbox';

/**
 * Expiring an action intent: the writes that go with `-> expired`, shared by
 * the 30 s sweep (`jobs/intentExpiryReaper.ts`) and the chat's own close-out
 * of a wait that reached the deadline undecided (#12098), so both leave the
 * same rows behind.
 */

// `type` (not `interface`) so TS's implicit index signature for object type
// literals applies — `db.execute<T>`'s constraint is `Record<string,
// unknown>`, which a plain `interface` declaration does not structurally
// satisfy without an explicit `[key: string]: unknown` member (TS2344).
export type ExpiredIntentRow = {
  id: string;
  org_id: string;
  action_name: string;
  argument_digest: string;
  source: string;
  requested_by_user_id: string | null;
  expires_at: Date;
  /** #5205 W05 (#5210): non-null iff this is an AI Operator task-linked intent. */
  task_id: string | null;
  /** Tool catalog W04 (#5219): non-null iff this is a flow-origin intent. */
  requesting_flow_run_id: string | null;
};

export function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

/**
 * The side effects of intents that were just moved to `expired`: their
 * still-`pending` approval rows expire, an `intent_expired` outbox row (plus
 * the task-outbox wake and the parked flow-run wake) is written, and one
 * `action_intent.expired` audit event per intent is recorded.
 *
 * MUST run in the same transaction as the UPDATE that expired `rows`, and the
 * database statements here PROPAGATE their errors: catching a database error
 * in JS does not un-abort the transaction (the backend is left in 25P02 and
 * the COMMIT silently becomes a ROLLBACK), so a swallowed failure would throw
 * away the expiry while the caller believes it landed. Failing the whole
 * transaction is the honest outcome. The audit event is deferred until the
 * transaction commits, and only its own failure is caught.
 */
export async function recordIntentExpiries(rows: ExpiredIntentRow[]): Promise<void> {
  if (rows.length === 0) return;
  const intentIds = rows.map((r) => r.id);

  // Approval does not stop the clock, so an approved intent can still have
  // sibling rows sitting `pending` when it times out. Expiring them is also
  // what makes a late Approve click lose its own CAS ("already decided").
  await db
    .update(approvalRequests)
    .set({ status: 'expired', decidedAt: new Date() })
    .where(and(eq(approvalRequests.status, 'pending'), inArray(approvalRequests.intentId, intentIds)));

  // Record the outcome so the requester can be told. Atomic with the expiry:
  // an expiry that commits without its outbox row is an intent nobody is ever
  // told about, and nothing will see the row again (it is no longer
  // pending_approval/approved).
  await db.insert(intentOutbox).values(
    rows.map((row) => ({
      intentId: row.id,
      eventType: 'intent_expired' as const,
      // Ids only, matching the approve/deny rows — no argument content.
      payload: { intentId: row.id, orgId: row.org_id },
    })),
  );

  for (const row of rows) {
    // #5205 W05 (#5210), spec §6.3: task-linked rows also need the task_outbox
    // wake, atomically with the expiry.
    if (row.task_id) {
      await enqueueTaskOutbox(db, {
        orgId: row.org_id,
        taskId: row.task_id,
        sourceKind: 'intent',
        sourceId: row.id,
        transitionSeq: INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ.intent_expired,
      });
    }
    // Tool catalog W04 (#5219): this writer bypasses publishIntentTerminalOutbox,
    // so it wakes a parked flow run itself — registered in THIS transaction,
    // run only after it commits (services/flows/wake.ts).
    if (row.requesting_flow_run_id) scheduleFlowRunWake(row.requesting_flow_run_id);
  }

  // The audit event and metric only once the expiry has committed: the audit
  // write runs on its own connection, so emitted here it would record an
  // expiry that a failed COMMIT (or a retried close-out attempt) never kept.
  for (const row of rows) {
    runAfterDbContextCommit(`intent-expired-audit:${row.id}`, () => {
      try {
        recordActionIntentEvent({
          orgId: row.org_id,
          intentId: row.id,
          actionName: row.action_name,
          argumentDigest: row.argument_digest,
          source: row.source as ActionIntentSource,
          outcome: 'expired',
          details: {
            requestedByUserId: row.requested_by_user_id,
            expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
          },
        });
      } catch (err) {
        console.error('[intentExpiry] Failed to write audit event:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

/**
 * How a chat wait that reached the approval deadline undecided ended (#12098).
 *
 * - `expired`: this close-out expired the intent. It is final: the approve
 *   path needs `pending_approval` (and a `pending` approval row, expired here
 *   too) and the release claim needs `approved`, so it can never run.
 * - `decided`: the intent was no longer `pending_approval` when the
 *   close-out ran (approved, denied, cancelled, already expired by the sweep,
 *   or already executing), or the database clock says the deadline has not
 *   passed yet (`pending_approval`). `status` is a fresh read taken after the
 *   close-out lost, so it includes any decision that committed first.
 * - `missing`: the intent row no longer exists (e.g. its org was deleted), so
 *   nothing can release it. Not retried.
 * - `unknown`: the close-out failed on every attempt. The intent may still be
 *   pending, and an approval could still land before the sweep expires it.
 */
export type IntentCloseOut =
  | { kind: 'expired' }
  | { kind: 'decided'; status: ActionIntentStatus }
  | { kind: 'missing' }
  | { kind: 'unknown' };

const CLOSE_OUT_ATTEMPTS = 3;
const CLOSE_OUT_RETRY_BASE_MS = 250;

/**
 * #12098: settle a Tier-3 intent whose chat wait ended undecided after its
 * approval deadline, before the chat tells the model anything about it.
 *
 * The chat must never say "expired" for an intent the release worker will
 * still run, so the guarantee lives here, on the database side: one
 * conditional UPDATE moves `pending_approval -> expired` only while the row is
 * still undecided and its approval deadline (`COALESCE(approval_expires_at,
 * expires_at)`, the reaper's own predicate, on the database clock) has passed.
 * The approve path takes the same row lock first (decideApprovalRequest locks
 * the intent FOR UPDATE before touching any approval row), so exactly one of
 * the two commits: either this expires it, or the decision wins and the
 * UPDATE matches nothing. On a loss a fresh read (a new statement, so it sees
 * the committed decision) returns what the intent is now.
 *
 * Each attempt is its own transaction, opened outside any ambient context;
 * the catch sits outside it, so a failed attempt rolls back whole and the
 * next one starts clean.
 */
export async function closeOutUndecidedIntent(intentId: string): Promise<IntentCloseOut> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runOutsideDbContext(() =>
        withSystemDbAccessContext(async (): Promise<IntentCloseOut> => {
          const expired = extractRows<ExpiredIntentRow>(
            await db.execute<ExpiredIntentRow>(sql`
              UPDATE ${actionIntents}
              SET status = 'expired'
              WHERE ${actionIntents.id} = ${intentId}
                AND ${actionIntents.status} = 'pending_approval'
                AND COALESCE(${actionIntents.approvalExpiresAt}, ${actionIntents.expiresAt}) <= now()
              RETURNING
                id,
                org_id,
                action_name,
                argument_digest,
                source,
                requested_by_user_id,
                expires_at,
                task_id,
                requesting_flow_run_id
            `),
          );
          if (expired.length > 0) {
            await recordIntentExpiries(expired);
            return { kind: 'expired' };
          }
          const [row] = await db
            .select({ status: actionIntents.status })
            .from(actionIntents)
            .where(eq(actionIntents.id, intentId))
            .limit(1);
          if (!row) return { kind: 'missing' };
          return { kind: 'decided', status: row.status };
        }),
      );
    } catch (err) {
      console.warn(`[intentExpiry] Close-out attempt ${attempt} failed for intent ${intentId}:`, err);
      if (attempt < CLOSE_OUT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, CLOSE_OUT_RETRY_BASE_MS * attempt));
        continue;
      }
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
        component: 'intent_close_out',
        intentId,
      });
      return { kind: 'unknown' };
    }
  }
}
