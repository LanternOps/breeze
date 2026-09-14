/**
 * #4248 W03 (spec OD-8) — claim-before-send state machine for
 * `report_run_deliveries`, the durable per-recipient delivery record of the
 * weekly AI org narrative.
 *
 * State rules (the wave's contract, not implementation detail):
 *
 * | From      | To        | When                                                        |
 * |-----------|-----------|-------------------------------------------------------------|
 * | pending   | claimed   | `claimDelivery` — ONE committed `UPDATE … WHERE state='pending'`; losing the race returns false and the caller sends nothing |
 * | claimed   | sent      | provider accepted                                           |
 * | claimed   | failed    | provider refused, or the authority gate permanently refused |
 * | claimed   | unknown   | ambiguous outcome (timeout, reset, unclassifiable throw), or the reconciler found the claim stale |
 * | unknown   | —         | NOTHING. Never auto-reset. `SendEmailParams` has no idempotency key, so unlimited replay is not safe; replay is a human decision |
 * | pending   | pending   | the gate returned `unverifiable_scope` — transient, so the row stays retryable with `last_error` recorded |
 *
 * Every write here except `createPendingDeliveries` runs in its OWN committed
 * system context (`runOutsideDbContext(() => withSystemDbAccessContext(…))`),
 * so a caller's enclosing transaction can never roll a claim back after the
 * mail has already left. `claimDelivery` refuses outright when called inside
 * an ambient context, for the same reason.
 *
 * `createPendingDeliveries` is the one exception by design: it runs on the
 * caller's handle so the rows are created ATOMICALLY with the narrative
 * artifact inside `persistNarrativeReport`'s transaction.
 */

import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { reportRunDeliveries, type ReportRunDeliveryState } from '../db/schema/reports';

/** A claim older than this with no settle is treated as a crash mid-send. */
export const STALE_CLAIM_MS = 15 * 60 * 1000;

export type DeliveryRow = typeof reportRunDeliveries.$inferSelect;
export type DeliveryChannel = 'email';

export type DeliverySettleOutcome =
  | { state: 'sent' }
  | { state: 'failed'; error: string }
  | { state: 'unknown'; error: string };

export interface DeliverySummary {
  total: number;
  sent: number;
  failed: number;
  unknown: number;
  pending: number;
}

/** The minimal drizzle surface `createPendingDeliveries` needs — `db` itself,
 *  which routes onto the caller's open transaction via the context storage. */
type InsertHandle = Pick<typeof db, 'insert'>;

/**
 * One `pending` row per distinct recipient, on the CALLER's handle so the
 * insert joins the artifact transaction. `onConflictDoNothing` against the
 * (run, recipient, channel) unique index makes a retried persist idempotent;
 * the return value counts rows actually inserted, not rows requested.
 */
export async function createPendingDeliveries(
  handle: InsertHandle,
  reportRunId: string,
  recipientUserIds: readonly string[],
  channel: DeliveryChannel,
): Promise<number> {
  const distinct = [...new Set(recipientUserIds)];
  if (distinct.length === 0) return 0;
  const inserted = await handle
    .insert(reportRunDeliveries)
    .values(distinct.map((recipientUserId) => ({
      reportRunId,
      recipientUserId,
      channel,
      state: 'pending' as const,
    })))
    .onConflictDoNothing({
      target: [reportRunDeliveries.reportRunId, reportRunDeliveries.recipientUserId, reportRunDeliveries.channel],
    })
    .returning({ id: reportRunDeliveries.id });
  return inserted.length;
}

/** Own committed transaction — see the module docstring. */
function inOwnSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * `pending -> claimed`, committed BEFORE any network call. Returns `false`
 * when the row was not pending (someone else claimed it, or it is already
 * settled) — the caller must then send nothing.
 *
 * Throws when called inside an ambient DB context: a claim that joins the
 * caller's transaction can be rolled back after the send, which is exactly
 * the failure mode this table exists to prevent.
 */
export async function claimDelivery(deliveryId: string): Promise<boolean> {
  if (getCurrentDbAccessContext()) {
    throw new Error('claimDelivery must run outside any db context so the claim commits before the send');
  }
  const now = new Date();
  const claimed = await inOwnSystemContext(() =>
    db
      .update(reportRunDeliveries)
      .set({
        state: 'claimed',
        claimedAt: now,
        attempts: sql`${reportRunDeliveries.attempts} + 1`,
        updatedAt: now,
      })
      .where(and(eq(reportRunDeliveries.id, deliveryId), eq(reportRunDeliveries.state, 'pending')))
      .returning({ id: reportRunDeliveries.id }),
  );
  return claimed.length > 0;
}

/**
 * `claimed -> sent | failed | unknown`. Gated on `state = 'claimed'` so a row
 * that was never claimed (or was already settled) is not overwritten; that
 * case is logged rather than thrown because by the time we settle, the send
 * has already happened and there is nothing useful left to abort.
 */
export async function settleDelivery(deliveryId: string, outcome: DeliverySettleOutcome): Promise<void> {
  const now = new Date();
  const settled = await inOwnSystemContext(() =>
    db
      .update(reportRunDeliveries)
      .set(
        outcome.state === 'sent'
          ? { state: 'sent', sentAt: now, lastError: null, updatedAt: now }
          : { state: outcome.state, lastError: outcome.error, updatedAt: now },
      )
      .where(and(eq(reportRunDeliveries.id, deliveryId), eq(reportRunDeliveries.state, 'claimed')))
      .returning({ id: reportRunDeliveries.id }),
  );
  if (settled.length === 0) {
    console.warn('[reportRunDelivery] settle matched no claimed row', { deliveryId, outcome: outcome.state });
  }
}

/**
 * The authority gate answered `unverifiable_scope`: denied-for-NOW, not
 * denied-forever. Records the reason and leaves the row `pending` so the
 * reconciler retries it — a transient DB blip must not silently kill a
 * weekly report.
 *
 * "Transient" here means "do not permanently refuse", not "guaranteed to
 * self-heal": `siteScope.ts` also returns this reason for a user with more
 * than one active membership row, which retrying alone will never fix.
 */
export async function recordTransientGateFailure(deliveryId: string, error: string): Promise<void> {
  await inOwnSystemContext(() =>
    db
      .update(reportRunDeliveries)
      .set({ lastError: error, updatedAt: new Date() })
      .where(and(eq(reportRunDeliveries.id, deliveryId), eq(reportRunDeliveries.state, 'pending'))),
  );
}

/** The rows a delivery pass for ONE run still has to attempt. */
export async function listPendingDeliveriesForRun(reportRunId: string): Promise<DeliveryRow[]> {
  return inOwnSystemContext(() =>
    db
      .select()
      .from(reportRunDeliveries)
      .where(and(eq(reportRunDeliveries.reportRunId, reportRunId), eq(reportRunDeliveries.state, 'pending')))
      .orderBy(reportRunDeliveries.createdAt),
  );
}

const UNSETTLED_STATES: readonly ReportRunDeliveryState[] = ['pending', 'claimed'];

/**
 * Rows the reconciler looks at: `pending` (never reached) or `claimed` (reached,
 * outcome never recorded), whose last state change predates `olderThan`.
 * `unknown` rows are deliberately NOT unsettled — they are settled as "we do
 * not know", and only a human replays them.
 */
export async function listUnsettledDeliveries(olderThan: Date, limit: number): Promise<DeliveryRow[]> {
  return inOwnSystemContext(() =>
    db
      .select()
      .from(reportRunDeliveries)
      .where(and(
        inArray(reportRunDeliveries.state, [...UNSETTLED_STATES]),
        // "last state change" = claimed_at for a claimed row, created_at for a
        // pending one. Typed-column comparisons on purpose: a Date bound
        // inside a raw sql`` fragment throws at bind time under postgres-js.
        or(
          and(isNull(reportRunDeliveries.claimedAt), lt(reportRunDeliveries.createdAt, olderThan)),
          lt(reportRunDeliveries.claimedAt, olderThan),
        ),
      ))
      .orderBy(reportRunDeliveries.createdAt)
      .limit(limit),
  );
}

/**
 * Per-run counts for the run-detail surface (Task 10) and the delivery pass.
 *
 * Inside an ambient context (a request) it reads on THAT handle — under the
 * requester's own RLS context, which the parent-FK-join policy admits for
 * anyone with org access to the report — and never opens a second pooled
 * connection under a held request transaction. With no ambient context (the
 * delivery pass, the reconciler) it opens its own short system context: a
 * bare contextless read is a DENY under forced RLS, not a bypass, and would
 * report every run as undelivered.
 */
export async function summarizeDeliveries(reportRunId: string): Promise<DeliverySummary> {
  const query = () => db
    .select({
      total: sql<number>`count(*)::int`,
      sent: sql<number>`count(*) FILTER (WHERE ${reportRunDeliveries.state} = 'sent')::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${reportRunDeliveries.state} = 'failed')::int`,
      unknown: sql<number>`count(*) FILTER (WHERE ${reportRunDeliveries.state} = 'unknown')::int`,
      pending: sql<number>`count(*) FILTER (WHERE ${reportRunDeliveries.state} IN ('pending', 'claimed'))::int`,
    })
    .from(reportRunDeliveries)
    .where(eq(reportRunDeliveries.reportRunId, reportRunId));
  const [row] = getCurrentDbAccessContext() ? await query() : await inOwnSystemContext(query);
  return {
    total: Number(row?.total ?? 0),
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
    unknown: Number(row?.unknown ?? 0),
    pending: Number(row?.pending ?? 0),
  };
}
