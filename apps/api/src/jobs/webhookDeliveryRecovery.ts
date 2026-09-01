import { Queue, Worker, type Job } from 'bullmq';
import { and, asc, eq, inArray, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { webhookDeliveries, webhooks } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { toWebhookConfig } from '../services/webhookConfig';
import { getWebhookWorker } from '../workers/webhookDelivery';
import { attachWorkerObservability } from './workerObservability';
import type { BreezeEvent, EventType } from '../services/eventBus';

const { db } = dbModule;

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const QUEUE_NAME = 'webhook-delivery-recovery';

/**
 * How long an unresolved row may sit before the sweep considers it.
 *
 * This threshold is a COST control, not the correctness boundary. Re-queueing a
 * delivery that was merely backlogged is harmless because the worker's
 * execution claim lets only one copy of a job POST (see
 * `setDeliveryClaimCallback`); without that claim no threshold would be safe,
 * since BRPOP's 5s is only its empty-queue wait and the FIFO backlog ahead of a
 * job is unbounded. Fifteen minutes simply keeps the sweep from manufacturing
 * duplicate queue entries during an ordinary traffic spike.
 */
export const STALE_PENDING_MS = 15 * 60 * 1000;

/**
 * Gap enforced between recovery attempts on one row. Doubles as the sweep's
 * lease: a claimed row is invisible to the next tick, and to every other API
 * instance, until it expires.
 */
export const RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Recovery attempts before a row is abandoned. Reached only when the row keeps
 * landing back in `pending` — i.e. the delivery worker never even claimed it.
 */
export const MAX_RECOVERY_ATTEMPTS = 5;

/**
 * Rows examined per sweep. Bounded on purpose: `webhook_deliveries` has no
 * retention job anywhere, so the table grows without limit, and a backlog after
 * a long Redis outage must not turn one tick into an unbounded fan-out of
 * outbound POSTs.
 */
export const RECOVERY_BATCH_SIZE = 200;

/**
 * Age past which a delivery is too stale to send at all.
 *
 * Deliberately NOT expressed as a lower bound on the scan: filtering ancient
 * rows out of the candidate set would leave them unresolved forever, which is
 * the bug this file exists to fix. They stay in scope and are resolved
 * TERMINALLY instead, so they are visible and hand-retryable.
 *
 * This matters most on the very first deploy of the sweep, which is the one
 * moment it can encounter rows that predate it by an unbounded margin: POSTing
 * a months-old payload to a customer's endpoint is its own incident. Prod holds
 * 0 rows today, so this is insurance rather than a live concern.
 */
export const MAX_RECOVERABLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Five minutes. Deliberately sub-hourly so it needs no `scheduleRegistry` slot:
 * BullMQ anchors `repeat: { every: N }` to the Unix epoch, which is why coarse
 * intervals must go through the cron registry, and `scheduleRegistry.contract.test.ts`
 * rejects only intervals of an hour or more.
 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The two unresolved statuses, and why they are handled differently.
 *
 * `pending`  — recorded, never claimed by any delivery worker. Nothing was
 *              sent, so re-driving it cannot duplicate a POST.
 * `retrying` — claimed by a worker that then died. The POST may or may not have
 *              reached the customer, so this is resolved TERMINALLY rather than
 *              re-sent; auto-repeating a possibly-delivered POST is the one
 *              failure this system treats as worse than a missed one.
 */
const UNRESOLVED_STATUSES = ['pending', 'retrying'] as const;

/**
 * Candidate scope: unresolved, aged out, and not currently leased.
 *
 * `next_retry_at IS NULL OR next_retry_at <= now` is spelled as an explicit
 * OR-with-IS-NULL rather than a negation. `NOT (next_retry_at > now)` over a
 * NULLable column evaluates to NULL for every never-leased row and silently
 * drops exactly the rows this sweep exists to find.
 */
export function buildUnresolvedScope(now: Date): SQL {
  return and(
    inArray(webhookDeliveries.status, [...UNRESOLVED_STATUSES]),
    lt(webhookDeliveries.createdAt, new Date(now.getTime() - STALE_PENDING_MS)),
    or(
      isNull(webhookDeliveries.nextRetryAt),
      lte(webhookDeliveries.nextRetryAt, now)
    )
  )!;
}

/**
 * Compare-and-swap that claims one row for the sweep.
 *
 * Re-asserts the ENTIRE candidate scope against this id rather than trusting
 * the preceding SELECT: the row can change in the gap between the two
 * statements, and only predicates inside the UPDATE are evaluated atomically.
 * Of the N API instances sweeping concurrently, only the one whose UPDATE
 * returns a row proceeds.
 *
 * Note WHICH conjunct defends WHICH race. Against another SWEEPER, the status
 * test does nothing — it admits both unresolved statuses, and a rival sweeper
 * leaves the row unresolved too. It is the LEASE predicate that serialises
 * them: the winner stamps `next_retry_at = now + RECOVERY_COOLDOWN_MS`, which
 * is in the future relative to every concurrent sweeper's `now`.
 *
 * The same lease is what defends the gap against a DELIVERY WORKER: a worker
 * claiming the row between our SELECT and our CAS writes
 * `next_retry_at = now + EXECUTION_LEASE_MS`, so our `next_retry_at <= now`
 * fails and we correctly leave the row to the worker that is about to POST it.
 * Drop the lease conjunct and both races reopen even though the status test
 * still reads as if it were guarding them.
 */
export function buildRecoveryClaimCas(deliveryId: string, now: Date): SQL {
  return and(
    eq(webhookDeliveries.id, deliveryId),
    inArray(webhookDeliveries.status, [...UNRESOLVED_STATUSES]),
    lt(webhookDeliveries.createdAt, new Date(now.getTime() - STALE_PENDING_MS)),
    or(
      isNull(webhookDeliveries.nextRetryAt),
      lte(webhookDeliveries.nextRetryAt, now)
    )
  )!;
}

/**
 * "I still hold the lease I just took."
 *
 * Used for the terminal write, which happens AFTER the claim has stamped
 * `next_retry_at = leaseUntil`. Re-running the claim predicate there would fail
 * its own `next_retry_at <= now` test; matching the exact lease instant instead
 * additionally proves no other instance re-leased the row in between.
 */
export function buildLeaseHeldCas(deliveryId: string, leaseUntil: Date): SQL {
  return and(
    eq(webhookDeliveries.id, deliveryId),
    inArray(webhookDeliveries.status, [...UNRESOLVED_STATUSES]),
    eq(webhookDeliveries.nextRetryAt, leaseUntil)
  )!;
}

export interface WebhookRecoverySweepSummary {
  scanned: number;
  requeued: number;
  /** `pending` rows abandoned after MAX_RECOVERY_ATTEMPTS. */
  exhausted: number;
  /** `retrying` rows whose worker died — resolved terminally, never re-sent. */
  abandonedInFlight: number;
  /** Lost the CAS to another instance, or the row moved on mid-sweep. */
  raced: number;
  /** Webhook no longer active, or its credentials would not decrypt. */
  undeliverable: number;
  /** Claimed but the enqueue still failed — stays unresolved for the next window. */
  enqueueFailed: number;
  /** Older than MAX_RECOVERABLE_AGE_MS — resolved terminally, never sent. */
  tooOld: number;
  /**
   * A terminal write that matched no row: the lease was lost between the claim
   * and the write (a delivery worker's execution claim only tests `status`, so
   * it can still take a row this sweep has leased). Counted separately because
   * folding it into `exhausted`/`undeliverable` would report a resolution that
   * never happened.
   */
  terminalWriteLost: number;
}

/**
 * Terminal state for a row this sweep will not drive again.
 *
 * `failed` rather than a bespoke status on purpose: it is the one status the
 * existing per-delivery retry endpoint (`routes/webhooks.ts`) accepts, so an
 * operator can still drive it by hand from the UI. Leaving it unresolved
 * forever is what #4095 is about.
 */
async function markUnrecoverable(
  deliveryId: string,
  leaseUntil: Date,
  errorMessage: string
): Promise<boolean> {
  const rows = await db
    .update(webhookDeliveries)
    .set({ status: 'failed', errorMessage, nextRetryAt: null })
    .where(buildLeaseHeldCas(deliveryId, leaseUntil))
    .returning({ id: webhookDeliveries.id });

  return rows.length > 0;
}

/**
 * Apply a terminal write and report whether it actually landed.
 *
 * `markUnrecoverable` matches the EXACT lease instant, so it writes nothing if
 * the row was re-leased in between — which a delivery worker's execution claim
 * can do, since that CAS only tests `status`. Swallowing the `false` would log
 * "abandoned" and increment a resolution counter for a row that is still
 * unresolved: precisely the kind of quiet miscount #4095 is about.
 */
async function resolveTerminally(
  summary: WebhookRecoverySweepSummary,
  candidate: { id: string; webhookId: string },
  leaseUntil: Date,
  errorMessage: string,
  onLanded: () => void
): Promise<void> {
  const landed = await runWithSystemDbAccess(() =>
    markUnrecoverable(candidate.id, leaseUntil, errorMessage)
  );

  if (!landed) {
    summary.terminalWriteLost += 1;
    console.warn(`[WebhookDeliveryRecovery] terminal-write-lost ${JSON.stringify({
      errorId: 'WEBHOOK_DELIVERY_RECOVERY_TERMINAL_WRITE_LOST',
      deliveryId: candidate.id,
      webhookId: candidate.webhookId,
      intendedMessage: errorMessage
    })}`);
    return;
  }

  onLanded();
}

/**
 * Reclaim `webhook_deliveries` rows that were committed but never delivered.
 *
 * The row is written to Postgres BEFORE `queueDelivery`, which is a bare
 * `redis.lpush` onto a non-durable list. If that LPUSH throws, or the process
 * dies between the commit and the LPUSH, the row sits at `status = 'pending'`
 * with no job anywhere and nothing ever looks at it again (#4095).
 *
 * This sweep is the SINGLE owner of re-queueing. The '*' subscriber only
 * reports its dedupe skips: if it also re-queued stale rows, a redelivered
 * event and this sweep could both drive the same row.
 */
export async function runWebhookDeliveryRecoverySweep(
  now: Date = new Date()
): Promise<WebhookRecoverySweepSummary> {
  const summary: WebhookRecoverySweepSummary = {
    scanned: 0,
    requeued: 0,
    exhausted: 0,
    abandonedInFlight: 0,
    raced: 0,
    undeliverable: 0,
    enqueueFailed: 0,
    tooOld: 0,
    terminalWriteLost: 0
  };

  const candidates = await runWithSystemDbAccess(async () =>
    db
      .select({
        id: webhookDeliveries.id,
        webhookId: webhookDeliveries.webhookId,
        eventId: webhookDeliveries.eventId,
        eventType: webhookDeliveries.eventType,
        payload: webhookDeliveries.payload,
        status: webhookDeliveries.status,
        recoveryAttempts: webhookDeliveries.recoveryAttempts,
        createdAt: webhookDeliveries.createdAt,
        webhookOrgId: webhooks.orgId,
        webhookName: webhooks.name,
        webhookStatus: webhooks.status,
        webhookUrl: webhooks.url,
        webhookSecret: webhooks.secret,
        webhookEvents: webhooks.events,
        webhookHeaders: webhooks.headers,
        webhookRetryPolicy: webhooks.retryPolicy
      })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .where(buildUnresolvedScope(now))
      .orderBy(asc(webhookDeliveries.createdAt))
      .limit(RECOVERY_BATCH_SIZE)
  );

  summary.scanned = candidates.length;

  for (const candidate of candidates) {
    const leaseUntil = new Date(now.getTime() + RECOVERY_COOLDOWN_MS);

    try {
      // Claim FIRST. Everything past this point has won the row, so a second
      // instance cannot duplicate the work.
      const [claimed] = await runWithSystemDbAccess(async () =>
        db
          .update(webhookDeliveries)
          .set({
            recoveryAttempts: candidate.recoveryAttempts + 1,
            nextRetryAt: leaseUntil
          })
          .where(buildRecoveryClaimCas(candidate.id, now))
          .returning({
            id: webhookDeliveries.id,
            recoveryAttempts: webhookDeliveries.recoveryAttempts
          })
      );

      if (!claimed) {
        summary.raced += 1;
        continue;
      }

      // A `retrying` row was claimed by a delivery worker that then died. We
      // cannot know whether the customer's endpoint was reached, so it is
      // resolved terminally and never re-sent.
      if (candidate.status === 'retrying') {
        await resolveTerminally(
          summary,
          candidate,
          leaseUntil,
          'Delivery was claimed by a worker that stopped before reporting a result; outcome unknown',
          () => {
            summary.abandonedInFlight += 1;
            console.warn(`[WebhookDeliveryRecovery] in-flight-abandoned ${JSON.stringify({
              errorId: 'WEBHOOK_DELIVERY_RECOVERY_IN_FLIGHT_ABANDONED',
              deliveryId: candidate.id,
              webhookId: candidate.webhookId,
              orgId: candidate.webhookOrgId,
              eventId: candidate.eventId,
              eventType: candidate.eventType
            })}`);
          }
        );
        continue;
      }

      if (now.getTime() - candidate.createdAt.getTime() > MAX_RECOVERABLE_AGE_MS) {
        await resolveTerminally(
          summary,
          candidate,
          leaseUntil,
          'Never claimed by a delivery worker and now too old to send; abandoned without delivery',
          () => {
            summary.tooOld += 1;
            console.warn(`[WebhookDeliveryRecovery] too-old-to-deliver ${JSON.stringify({
              errorId: 'WEBHOOK_DELIVERY_RECOVERY_TOO_OLD',
              deliveryId: candidate.id,
              webhookId: candidate.webhookId,
              orgId: candidate.webhookOrgId,
              eventId: candidate.eventId,
              ageMs: now.getTime() - candidate.createdAt.getTime()
            })}`);
          }
        );
        continue;
      }

      if (claimed.recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
        await resolveTerminally(
          summary,
          candidate,
          leaseUntil,
          `Never claimed by a delivery worker; abandoned after ${MAX_RECOVERY_ATTEMPTS} recovery attempts`,
          () => {
            summary.exhausted += 1;
            console.warn(`[WebhookDeliveryRecovery] recovery-exhausted ${JSON.stringify({
              errorId: 'WEBHOOK_DELIVERY_RECOVERY_EXHAUSTED',
              deliveryId: candidate.id,
              webhookId: candidate.webhookId,
              orgId: candidate.webhookOrgId,
              eventId: candidate.eventId,
              eventType: candidate.eventType,
              recoveryAttempts: claimed.recoveryAttempts
            })}`);
          }
        );
        continue;
      }

      // A webhook the customer has since disabled must not receive a late POST,
      // but the row cannot just be dropped either — mark it terminal so it stays
      // visible and hand-retryable rather than unresolved forever.
      if (candidate.webhookStatus !== 'active') {
        await resolveTerminally(
          summary,
          candidate,
          leaseUntil,
          // "Never CLAIMED", not "never enqueued": an unclaimed row proves only
          // that no worker took it. It may well have been LPUSHed and then sat
          // in a backlog, or been lost by a Redis restart. Naming the wrong
          // subsystem sends the on-call engineer to the wrong place.
          `Never claimed by a delivery worker; webhook is ${candidate.webhookStatus}`,
          () => {
            summary.undeliverable += 1;
            console.warn(`[WebhookDeliveryRecovery] webhook-inactive ${JSON.stringify({
              errorId: 'WEBHOOK_DELIVERY_RECOVERY_WEBHOOK_INACTIVE',
              deliveryId: candidate.id,
              webhookId: candidate.webhookId,
              orgId: candidate.webhookOrgId,
              webhookStatus: candidate.webhookStatus
            })}`);
          }
        );
        continue;
      }

      let config;
      try {
        config = toWebhookConfig({
          id: candidate.webhookId,
          orgId: candidate.webhookOrgId,
          name: candidate.webhookName,
          url: candidate.webhookUrl,
          secret: candidate.webhookSecret,
          events: candidate.webhookEvents,
          headers: candidate.webhookHeaders,
          retryPolicy: candidate.webhookRetryPolicy
        });
      } catch (decryptError) {
        // Delivering with unusable credentials is worse than not delivering.
        captureException(decryptError instanceof Error ? decryptError : new Error(String(decryptError)));
        await resolveTerminally(
          summary,
          candidate,
          leaseUntil,
          'Never claimed by a delivery worker; webhook credentials could not be decrypted',
          () => {
            summary.undeliverable += 1;
            console.error(`[WebhookDeliveryRecovery] decrypt-failed ${JSON.stringify({
              errorId: 'WEBHOOK_DELIVERY_RECOVERY_DECRYPT_FAILED',
              deliveryId: candidate.id,
              webhookId: candidate.webhookId,
              orgId: candidate.webhookOrgId
            })}`);
          }
        );
        continue;
      }

      // The original event, reconstructed from the row. `id` MUST stay the
      // original `event_id`: it goes out as `X-Breeze-Event-Id`, which is the
      // customer's own idempotency key, and it is what the unique index dedupes
      // on. `metadata.timestamp` is NOT stored per delivery, so the row's
      // `created_at` — the instant the delivery was recorded — stands in for it;
      // it is the closest recorded approximation of the original event time.
      const event: BreezeEvent = {
        id: candidate.eventId,
        type: candidate.eventType as EventType,
        orgId: candidate.webhookOrgId,
        source: 'webhook.recovery',
        priority: 'normal',
        payload: (candidate.payload ?? {}) as Record<string, unknown>,
        metadata: { timestamp: candidate.createdAt.toISOString() }
      };

      try {
        // Outside any DB context: this is a Redis LPUSH, and holding a pooled
        // Postgres connection across it is the pattern that exhausts the pool.
        await getWebhookWorker().queueDelivery(config, event, candidate.id);
      } catch (enqueueError) {
        // Still no job. Hand the attempt BACK: the claim charged one before the
        // enqueue, but this enqueue never used it. Without the refund a Redis
        // outage spends the whole budget on itself — six consecutive failures,
        // about 75 minutes of downtime, would terminally fail a delivery that
        // was never actually attempted, charging infrastructure downtime
        // against the customer's delivery. The lease is deliberately LEFT in
        // place so the next window still waits out the cooldown instead of
        // hot-looping against a dead Redis.
        await runWithSystemDbAccess(async () =>
          db
            .update(webhookDeliveries)
            .set({ recoveryAttempts: candidate.recoveryAttempts })
            .where(buildLeaseHeldCas(candidate.id, leaseUntil))
            .returning({ id: webhookDeliveries.id })
        );
        summary.enqueueFailed += 1;
        captureException(enqueueError instanceof Error ? enqueueError : new Error(String(enqueueError)));
        console.error(`[WebhookDeliveryRecovery] requeue-failed ${JSON.stringify({
          errorId: 'WEBHOOK_DELIVERY_RECOVERY_REQUEUE_FAILED',
          deliveryId: candidate.id,
          webhookId: candidate.webhookId,
          orgId: candidate.webhookOrgId,
          error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError)
        })}`);
        continue;
      }

      summary.requeued += 1;
      console.warn(`[WebhookDeliveryRecovery] delivery-recovered ${JSON.stringify({
        errorId: 'WEBHOOK_DELIVERY_RECOVERED',
        deliveryId: candidate.id,
        webhookId: candidate.webhookId,
        orgId: candidate.webhookOrgId,
        eventId: candidate.eventId,
        eventType: candidate.eventType,
        recoveryAttempt: claimed.recoveryAttempts,
        unresolvedForMs: now.getTime() - candidate.createdAt.getTime()
      })}`);
    } catch (error) {
      // One bad row must not abort the batch — that would be the same
      // fan-out-aborting bug #4095 fixes in the subscriber.
      captureException(error instanceof Error ? error : new Error(String(error)));
      console.error(`[WebhookDeliveryRecovery] candidate-failed ${JSON.stringify({
        errorId: 'WEBHOOK_DELIVERY_RECOVERY_CANDIDATE_FAILED',
        deliveryId: candidate.id,
        webhookId: candidate.webhookId,
        error: error instanceof Error ? error.message : String(error)
      })}`);
    }
  }

  if (summary.scanned > 0) {
    console.warn(`[WebhookDeliveryRecovery] sweep-complete ${JSON.stringify({
      errorId: 'WEBHOOK_DELIVERY_RECOVERY_SWEEP',
      ...summary
    })}`);
  }

  return summary;
}

let recoveryQueue: Queue | null = null;
let recoveryWorker: Worker | null = null;

export function getWebhookDeliveryRecoveryQueue(): Queue {
  if (!recoveryQueue) {
    recoveryQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return recoveryQueue;
}

export function createWebhookDeliveryRecoveryWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => runWebhookDeliveryRecoverySweep(),
    { connection: getBullMQConnection(), concurrency: 1 }
  );
}

export async function initializeWebhookDeliveryRecovery(): Promise<void> {
  try {
    recoveryWorker = createWebhookDeliveryRecoveryWorker();
    attachWorkerObservability(recoveryWorker, 'webhookDeliveryRecovery');
    recoveryWorker.on('error', (err) => {
      console.error('[WebhookDeliveryRecovery] Worker error:', err);
    });

    const queue = getWebhookDeliveryRecoveryQueue();
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add('sweep', {}, {
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 }
    });

    console.log('[WebhookDeliveryRecovery] Initialized unresolved-delivery sweep');
  } catch (error) {
    // Close what we already opened. Without this a throw from `queue.add` (or
    // the repeatable-job cleanup above) leaves a live BullMQ Worker holding a
    // Redis connection and polling forever, with no handle left to stop it —
    // `shutdownWebhookDeliveryRecovery` only sees what the module variable
    // still points at.
    if (recoveryWorker) {
      await recoveryWorker.close().catch(() => {});
      recoveryWorker = null;
    }
    if (recoveryQueue) {
      await recoveryQueue.close().catch(() => {});
      recoveryQueue = null;
    }
    console.error('[WebhookDeliveryRecovery] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownWebhookDeliveryRecovery(): Promise<void> {
  if (recoveryWorker) {
    await recoveryWorker.close();
    recoveryWorker = null;
  }
  if (recoveryQueue) {
    await recoveryQueue.close();
    recoveryQueue = null;
  }
}
