import { and, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { webhookDeliveries, webhooks as webhooksTable } from '../db/schema';
import type { BreezeEvent } from './eventBus';
import type {
  WebhookFanoutTarget,
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
 * Claim each persisted attempt once, so duplicate BullMQ wake-ups cannot POST
 * twice. Pending ignores the recovery lease: that lease serializes sweepers,
 * not workers. Scheduled rows must wait for their due time on the DB clock.
 */
export function buildExecutionClaimCas(deliveryId: string, attemptsMade: number): SQL {
  return and(
    eq(webhookDeliveries.id, deliveryId),
    eq(webhookDeliveries.attempts, attemptsMade),
    or(
      eq(webhookDeliveries.status, 'pending'),
      and(
        eq(webhookDeliveries.status, 'scheduled'),
        or(isNull(webhookDeliveries.nextRetryAt), sql`${webhookDeliveries.nextRetryAt} <= (now() AT TIME ZONE 'UTC')`)
      )
    )
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
  webhook: WebhookFanoutTarget,
  event: BreezeEvent
): Promise<WebhookDeliveryRecordOutcome> {
  const timestamp = event.metadata.timestamp;
  const parsedTimestamp = typeof timestamp === 'string' ? new Date(timestamp) : null;
  const eventTimestamp = parsedTimestamp && Number.isFinite(parsedTimestamp.getTime()) ? parsedTimestamp : null;
  if (timestamp !== undefined && eventTimestamp === null) {
    let rawTimestamp: string;
    try {
      rawTimestamp = JSON.stringify(timestamp) ?? String(timestamp);
    } catch {
      rawTimestamp = String(timestamp);
    }
    console.warn(`[WebhookDelivery] event-timestamp-invalid ${JSON.stringify({
      errorId: 'WEBHOOK_DELIVERY_EVENT_TIMESTAMP_INVALID',
      eventId: event.id,
      webhookId: webhook.id,
      timestamp: rawTimestamp.slice(0, 100)
    })}`);
  }
  return runWithSystemDbAccess(async () => {
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        webhookId: webhook.id,
        eventType: event.type,
        eventId: event.id,
        payload: event.payload,
        payloadVersion: webhook.payloadVersion ?? 1,
        eventTimestamp,
        replayRootEventId: null,
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
 * Read back a lost claim once so the worker can distinguish a duplicate, an
 * erased delivery and an early wake. Computing the delay on the DB clock
 * prevents worker clock skew from repeatedly waking the same scheduled row.
 */
export async function claimDeliveryForExecution(
  job: { deliveryId: string; attemptsMade: number }
): Promise<DeliveryClaimOutcome> {
  return runWithSystemDbAccess(async () => {
    const [delivery] = await db
      .update(webhookDeliveries)
      .set({ status: 'retrying', nextRetryAt: new Date(Date.now() + EXECUTION_LEASE_MS) })
      .where(buildExecutionClaimCas(job.deliveryId, job.attemptsMade))
      .returning({
        id: webhookDeliveries.id,
        webhookId: webhookDeliveries.webhookId,
        eventId: webhookDeliveries.eventId,
        eventType: webhookDeliveries.eventType,
        payload: webhookDeliveries.payload,
        payloadVersion: webhookDeliveries.payloadVersion,
        eventTimestamp: webhookDeliveries.eventTimestamp,
        createdAt: webhookDeliveries.createdAt,
        replayRootEventId: webhookDeliveries.replayRootEventId,
        attempts: webhookDeliveries.attempts
      });

    if (delivery) return { claimed: true, delivery: { ...delivery, payloadVersion: delivery.payloadVersion as 1 | 2 } };

    const [row] = await db
      .select({
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        dueInMs: sql<number | null>`CEIL(EXTRACT(EPOCH FROM (${webhookDeliveries.nextRetryAt} - (now() AT TIME ZONE 'UTC'))) * 1000)::float8`
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, job.deliveryId))
      .limit(1);

    return {
      claimed: false,
      observedStatus: row?.status ?? null,
      observedAttempts: row?.attempts ?? null,
      dueInMs: row?.dueInMs == null ? null : Number(row.dueInMs)
    };
  });
}

/**
 * Persist the outcome of one delivery attempt and move the webhook aggregates.
 *
 * Extracted from `index.ts` (#4095) so the CAS above is reachable by a test:
 * as an anonymous closure in a coverage-excluded file, deleting its
 * `ne(status, 'delivered')` conjunct passed everywhere.
 */
export async function recordDeliveryOutcome(result: WebhookDeliveryResult): Promise<boolean> {
  return runWithSystemDbAccess(async () => {
    const deliveryStatus = result.success ? 'delivered' : result.nextAttemptAt ? 'scheduled' : 'failed';
    const deliveredAt = result.success
      ? new Date(result.deliveredAt ?? new Date().toISOString())
      : null;
    const responseTimeMs = typeof result.responseTimeMs === 'number'
      ? Math.max(0, Math.round(result.responseTimeMs))
      : null;

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
        nextRetryAt: result.nextAttemptAt ?? null
      })
      .where(buildOutcomeWriteCas(result.deliveryId))
      .returning({ id: webhookDeliveries.id });

    if (written.length === 0) {
      console.warn(`[WebhookDelivery] outcome-write-skipped ${JSON.stringify({
        errorId: 'WEBHOOK_DELIVERY_OUTCOME_WRITE_SKIPPED',
        deliveryId: result.deliveryId,
        webhookId: result.webhookId,
        attemptedStatus: deliveryStatus
      })}`);
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
    return written.length > 0;
  });
}
