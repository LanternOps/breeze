import { and, eq, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { webhookDeliveries } from '../db/schema';
import type { BreezeEvent } from './eventBus';
import type {
  WebhookConfig,
  WebhookDeliveryJob,
  WebhookDeliveryRecordOutcome
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
 * Win the delivery row before POSTing. `false` means another copy of this job
 * already owns it (or it has already resolved) and this copy must be dropped.
 */
export async function claimDeliveryForExecution(job: WebhookDeliveryJob): Promise<boolean> {
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

    return claimed.length > 0;
  });
}
