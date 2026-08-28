import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { webhookDeliveries, webhooks as webhooksTable } from '../db/schema';
import type { BreezeEvent } from './eventBus';
import type {
  WebhookConfig,
  WebhookDeliveryJob,
  WebhookDeliveryRecordOutcome,
  WebhookDeliveryResult,
  DeliveryClaimOutcome
} from '../workers/webhookDelivery';

const { db } = dbModule;

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

/**
 * Lease a delivery worker holds while executing a claimed delivery. Must
 * comfortably exceed one attempt (`WEBHOOK_TIMEOUT_MS`, 30s) so a live delivery
 * is never declared abandoned underneath itself; the recovery sweep will not
 * reconsider a claimed row until it expires.
 */
export const EXECUTION_LEASE_MS = 5 * 60 * 1000;

/**
 * The dedupe read-back: find the row that already owns a (webhook, event) pair.
 *
 * BOTH conjuncts are load-bearing. `event_id` alone is not unique across
 * webhooks — one event fans out to every webhook subscribed to it — so dropping
 * `webhook_id` would report another webhook's delivery status as this one's.
 */
export function buildExistingDeliveryLookup(webhookId: string, eventId: string): SQL {
  return and(
    eq(webhookDeliveries.webhookId, webhookId),
    eq(webhookDeliveries.eventId, eventId)
  )!;
}

/**
 * The EXECUTION CLAIM predicate: `pending` and this id, nothing else.
 *
 * Narrow on purpose. The queue is a plain Redis list with no job identity, so
 * one delivery can legitimately appear on it twice (the recovery sweep
 * re-queues any row that still looks unresolved, and a merely backlogged job is
 * indistinguishable from a lost one). This CAS is what makes that safe: of N
 * popped copies exactly one flips `pending` -> `retrying` and POSTs.
 *
 * It deliberately does NOT test the lease. A row is claimable whenever it is
 * still `pending`, whoever queued it — the sweep's own lease exists to stop two
 * SWEEPERS colliding, not to keep a delivery worker away from work it was
 * handed.
 */
export function buildExecutionClaimCas(deliveryId: string): SQL {
  return and(
    eq(webhookDeliveries.id, deliveryId),
    eq(webhookDeliveries.status, 'pending')
  )!;
}

/**
 * The OUTCOME WRITE predicate: this row, unless it already succeeded.
 *
 * Keying on `id` alone was safe while the delivery callback was the ONLY
 * writer. It no longer is: the recovery sweep also writes terminal outcomes,
 * and `deliverWebhook` clears its abort timeout once response HEADERS arrive,
 * so a slow response body can keep an attempt in flight past the execution
 * lease and land here after the sweep has already resolved the row. Without
 * `ne(status, 'delivered')` a late-arriving FAILURE would overwrite a recorded
 * success and the customer's delivery history would lie.
 *
 * `status` is NOT NULL, so `<>` cannot silently drop rows the way a negation
 * over a nullable column would.
 */
export function buildOutcomeWriteCas(deliveryId: string): SQL {
  return and(
    eq(webhookDeliveries.id, deliveryId),
    ne(webhookDeliveries.status, 'delivered')
  )!;
}

/**
 * Record a delivery, or report the row that already owns the pair.
 *
 * The insert IS the dedupe. An empty `returning()` means this (webhook, event)
 * pair is already recorded, and the caller reads that as "already handled" and
 * skips the outbound POST. DO NOTHING rather than catching 23505: a unique
 * violation caught inside the transaction that raised it is a documented trap
 * in this repo — postgres.js latches the failed statement and rethrows after
 * the callback returns.
 */
export async function recordWebhookDelivery(
  webhook: WebhookConfig,
  event: BreezeEvent
): Promise<WebhookDeliveryRecordOutcome> {
  return runWithSystemDbAccess(async () => {
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        webhookId: webhook.id,
        eventType: event.type,
        eventId: event.id,
        payload: event.payload,
        status: 'pending',
        attempts: 0
      })
      .onConflictDoNothing({
        target: [webhookDeliveries.webhookId, webhookDeliveries.eventId]
      })
      .returning({ id: webhookDeliveries.id });

    if (delivery) return { created: true, deliveryId: delivery.id };

    // Read back the row that won, so the skip can be REPORTED rather than being
    // a bare `continue` (#4095). One extra statement, and only on the rare
    // dedupe path; it seeks the same unique index the insert conflicted on.
    // `existing` stays null if the row has since been erased — the subscriber
    // reports that case too rather than staying silent.
    const [existing] = await db
      .select({
        id: webhookDeliveries.id,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        createdAt: webhookDeliveries.createdAt
      })
      .from(webhookDeliveries)
      .where(buildExistingDeliveryLookup(webhook.id, event.id))
      .limit(1);

    return { created: false, existing: existing ?? null };
  });
}

/**
 * Win the delivery row before POSTing.
 *
 * Returns the OBSERVED STATUS on failure rather than a bare `false`, because
 * the three ways to lose are operationally different and the worker's log has
 * to name the right one: `retrying` = another copy of this job is delivering it
 * right now; `delivered`/`failed` = it already resolved; `null` = there is no
 * row under this id at all, which is a bug or a hand-crafted job rather than a
 * race. Collapsing them to "duplicate" mislabels two of the three.
 */
export async function claimDeliveryForExecution(
  job: WebhookDeliveryJob
): Promise<DeliveryClaimOutcome> {
  return runWithSystemDbAccess(async () => {
    const claimed = await db
      .update(webhookDeliveries)
      .set({
        status: 'retrying',
        // Doubles as the abandonment lease: if this worker dies mid-POST the
        // sweep can only reconsider the row once this has expired.
        nextRetryAt: new Date(Date.now() + EXECUTION_LEASE_MS)
      })
      .where(buildExecutionClaimCas(job.id))
      .returning({ id: webhookDeliveries.id });

    if (claimed.length > 0) return { claimed: true };

    const [row] = await db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, job.id))
      .limit(1);

    return { claimed: false, observedStatus: row?.status ?? null };
  });
}

/**
 * Persist the outcome of one delivery attempt and move the webhook aggregates.
 *
 * Extracted from `index.ts` (#4095) so the CAS above is reachable by a test:
 * as an anonymous closure in a coverage-excluded file, deleting its
 * `ne(status, 'delivered')` conjunct passed everywhere.
 */
export async function recordDeliveryOutcome(result: WebhookDeliveryResult): Promise<void> {
  await runWithSystemDbAccess(async () => {
    const deliveryStatus = result.success ? 'delivered' : 'failed';
    const deliveredAt = result.success
      ? new Date(result.deliveredAt ?? new Date().toISOString())
      : null;
    const responseTimeMs = typeof result.responseTimeMs === 'number'
      ? Math.max(0, Math.round(result.responseTimeMs))
      : null;

    // A DLQ replay carries a delivery id that was minted by `retryFromDLQ` and
    // has NO `webhook_deliveries` row behind it. Attempting the write anyway
    // would match zero rows and fire the zero-row warning on EVERY routine
    // replay, with a stated cause ("someone else resolved it first") that is
    // simply untrue — which would void that warning for the real race it exists
    // to catch. The POST still happened, so the aggregates below still move.
    if (result.hasDeliveryRow === false) {
      console.log(`[WebhookDelivery] dlq-replay-completed ${JSON.stringify({
        errorId: 'WEBHOOK_DLQ_REPLAY_COMPLETED',
        deliveryId: result.deliveryId,
        webhookId: result.webhookId,
        eventId: result.eventId,
        delivered: result.success,
        responseStatus: result.responseStatus ?? null,
        attempts: result.attempts
      })}`);
    } else {
      const written = await db
        .update(webhookDeliveries)
        .set({
          status: deliveryStatus,
          attempts: result.attempts,
          responseStatus: result.responseStatus ?? null,
          responseBody: result.responseBody ?? null,
          responseTimeMs,
          errorMessage: result.errorMessage ?? null,
          deliveredAt,
          // Release the execution lease taken by the claim. The row is leaving
          // the unresolved statuses anyway, but a stale lease would otherwise
          // surface in the UI as a `nextAttemptAt` that never comes.
          nextRetryAt: null
        })
        .where(buildOutcomeWriteCas(result.deliveryId))
        .returning({ id: webhookDeliveries.id });

      if (written.length === 0) {
        // Genuinely surprising now that DLQ replays are routed away: it means
        // the row was already `delivered` by someone else, or has vanished.
        console.warn(`[WebhookDelivery] outcome-write-skipped ${JSON.stringify({
          errorId: 'WEBHOOK_DELIVERY_OUTCOME_WRITE_SKIPPED',
          deliveryId: result.deliveryId,
          webhookId: result.webhookId,
          attemptedStatus: deliveryStatus
        })}`);
      }
    }

    const aggregateUpdate = result.success
      ? {
        successCount: sql`${webhooksTable.successCount} + 1`,
        lastSuccessAt: new Date(),
        lastDeliveryAt: new Date()
      }
      : {
        failureCount: sql`${webhooksTable.failureCount} + 1`,
        lastDeliveryAt: new Date()
      };

    await db
      .update(webhooksTable)
      .set(aggregateUpdate)
      .where(eq(webhooksTable.id, result.webhookId));
  });
}
