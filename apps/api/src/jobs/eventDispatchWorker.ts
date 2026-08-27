import { Worker, type Job } from 'bullmq';
import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { eventDeliveryReceipts } from '../db/schema';
import { eventDispatchMode } from '../config/env';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { getSubscriberById } from '../services/eventSubscriberRegistry';
import type { SubscriberId } from '../services/eventSubscriberIds';
import type { BreezeEvent } from '../services/eventBus';
import {
  EVENT_DISPATCH_QUEUE,
  getEventDispatchQueue,
  type RouteEventJobData,
  type DeliverEventJobData
} from '../services/eventDispatchQueue';
import { routeEventJobDataSchema, deliverEventJobDataSchema } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;

/**
 * Consumes the `event-dispatch` BullMQ queue (wave 3.5c, #4085): a `route-event`
 * job snapshots a publisher's routing plan (services/eventDispatchQueue.ts) and
 * is trusted VERBATIM here — this worker never recomputes
 * `partitionSubscribersForEvent` itself (codex D3/Q3). A `deliver-event` job is
 * one durable delivery to ONE subscriber, gated by a compare-and-swap over
 * `event_delivery_receipts` so retries, redeliveries, and a route/deliver race
 * can never double-execute a subscriber's handler for the same event.
 */

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// #1105 — explicitly exits any DB access context before running `fn`. Used to
// wrap the `addBulk` enqueue so a Redis round-trip per deliver job never runs
// while a pooled connection is pinned idle-in-transaction.
const runOutsideDbContext = <T>(fn: () => Promise<T>): Promise<T> => {
  const runOutside = dbModule.runOutsideDbContext;
  return typeof runOutside === 'function' ? runOutside(fn) : fn();
};

/**
 * The CLAIM predicate: this receipt, unless it is already `delivered`.
 *
 * Deliberately admits `planned`, `delivering`, AND `failed` — a row found
 * `delivering` on a retry means a worker crashed mid-handler (outcome
 * unknown) and is correctly re-claimed (at-least-once delivery); a `failed`
 * row is a prior BullMQ attempt that exhausted, and a fresh attempt (a new
 * job, or the same job's own next BullMQ retry) must still be able to claim
 * it. Only `delivered` is terminal — that is the post-retention dedupe this
 * table exists to provide.
 */
export function buildReceiptClaimCas(eventId: string, subscriberId: string): SQL {
  return and(
    eq(eventDeliveryReceipts.eventId, eventId),
    eq(eventDeliveryReceipts.subscriberId, subscriberId),
    ne(eventDeliveryReceipts.status, 'delivered')
  )!;
}

/**
 * The OUTCOME WRITE predicate: this receipt, only while still `delivering`.
 *
 * Used for both the success (`delivered`) and failure (`failed`) terminal
 * writes. Scoping to `delivering` (rather than re-running the claim CAS)
 * means an outcome write only lands if THIS attempt still holds the claim —
 * a lost race (e.g. a concurrent re-claim already moved the row on) writes
 * nothing, rather than clobbering a state some other attempt already set.
 */
export function buildReceiptDeliveringCas(eventId: string, subscriberId: string): SQL {
  return and(
    eq(eventDeliveryReceipts.eventId, eventId),
    eq(eventDeliveryReceipts.subscriberId, subscriberId),
    eq(eventDeliveryReceipts.status, 'delivering')
  )!;
}

/**
 * Route-processing (`route-event` job): trusts `data.queueSubscriberIds`
 * verbatim — never recomputes routing.
 *
 * An EMPTY `queueSubscriberIds` is a successful no-op, not an error: it means
 * this event was published before the current subscriber-registry snapshot
 * routed anyone to the queue for it (Task 5 handoff note).
 */
export async function processRouteEvent(data: RouteEventJobData): Promise<void> {
  const { event, mode, queueSubscriberIds } = data;

  if (queueSubscriberIds.length === 0) {
    return;
  }

  await runWithSystemDbAccess(() =>
    db
      .insert(eventDeliveryReceipts)
      .values(
        queueSubscriberIds.map((subscriberId) => ({
          eventId: event.id,
          subscriberId,
          orgId: event.orgId,
          eventType: event.type,
          mode,
          status: 'planned' as const
        }))
      )
      // Conflict = a route-event job retry re-inserting rows it already
      // planned last attempt. Benign — the rows already exist.
      .onConflictDoNothing()
  );

  // Receipts ARE the shadow mirror; shadow mode stops here and nothing
  // executes via the queue.
  if (mode === 'shadow') {
    return;
  }

  const queue = getEventDispatchQueue();
  await runOutsideDbContext(() =>
    queue.addBulk(
      queueSubscriberIds.map((subscriberId) => {
        // The subscriber may be unregistered by the time this route job
        // runs (or may never come back at delivery time either) — the
        // snapshot is trusted verbatim regardless, so we fall back to the
        // default retry policy rather than skipping the deliver job. An
        // unknown subscriber at delivery time hits its own terminal path.
        const sub = getSubscriberById(subscriberId);
        const jobData: DeliverEventJobData = { v: 1, subscriberId, event };
        return {
          name: 'deliver-event',
          data: jobData,
          opts: {
            jobId: `event-deliver-${subscriberId}-${event.id}`,
            attempts: sub?.retry?.attempts ?? 5,
            backoff: { type: 'exponential' as const, delay: sub?.retry?.backoffMs ?? 10_000 },
            removeOnComplete: { count: 1000 },
            removeOnFail: { age: 7 * 24 * 3600 }
          }
        };
      })
    )
  );
}

type ClaimOutcome = { outcome: 'claimed' } | { outcome: 'already-delivered' };

/**
 * Claim one receipt for delivery. See `buildReceiptClaimCas` for what the CAS
 * admits. The CAS excludes ONLY `status = 'delivered'`, so a zero-row result
 * can only mean one of two things: there is no receipt row at all, or the
 * existing row is already `delivered`.
 */
async function claimReceipt(event: BreezeEvent, subscriberId: SubscriberId): Promise<ClaimOutcome> {
  const claim = () =>
    db
      .update(eventDeliveryReceipts)
      .set({ status: 'delivering', attempts: sql`${eventDeliveryReceipts.attempts} + 1`, updatedAt: sql`now()` })
      .where(buildReceiptClaimCas(event.id, subscriberId))
      .returning({ eventId: eventDeliveryReceipts.eventId });

  const claimed = await claim();
  if (claimed.length > 0) return { outcome: 'claimed' };

  const [existing] = await db
    .select({ status: eventDeliveryReceipts.status })
    .from(eventDeliveryReceipts)
    .where(and(eq(eventDeliveryReceipts.eventId, event.id), eq(eventDeliveryReceipts.subscriberId, subscriberId)))
    .limit(1);

  if (existing) {
    // By construction (see buildReceiptClaimCas) this can only be a
    // `delivered` row — every other status would have been claimed above.
    return { outcome: 'already-delivered' };
  }

  // No receipt at all: a route/deliver race — this deliver-event job reached
  // the worker before (or without) the route-event job's bulk insert
  // landing. `mode: 'enforce'` is safe to hardcode here because only
  // enforce-mode routing ever produces deliver-event jobs in the first
  // place (shadow mode stops after the receipt insert; see
  // processRouteEvent).
  await db
    .insert(eventDeliveryReceipts)
    .values({
      eventId: event.id,
      subscriberId,
      orgId: event.orgId,
      eventType: event.type,
      mode: 'enforce',
      status: 'planned'
    })
    .onConflictDoNothing();

  const reclaimed = await claim();
  if (reclaimed.length > 0) return { outcome: 'claimed' };

  // Lost the reclaim too — another deliver attempt already resolved this
  // receipt to `delivered` in between.
  return { outcome: 'already-delivered' };
}

/**
 * Write a terminal outcome (`delivered`/`failed`) and warn if it lands on
 * zero rows — `buildReceiptDeliveringCas` scopes the write to a receipt this
 * attempt still holds the claim on, so a miss here means some other attempt
 * already moved the row (e.g. a concurrent re-claim) and this write is a
 * no-op rather than a bug, but it must never be silent (mirrors
 * `recordDeliveryOutcome`'s zero-row guard in webhookDeliveryRecord.ts).
 */
async function writeReceiptOutcome(
  eventId: string,
  subscriberId: SubscriberId,
  values: Record<string, unknown>,
  label: 'delivered' | 'failed'
): Promise<void> {
  const written = await db
    .update(eventDeliveryReceipts)
    .set(values)
    .where(buildReceiptDeliveringCas(eventId, subscriberId))
    .returning({ eventId: eventDeliveryReceipts.eventId });

  if (written.length === 0) {
    console.warn(
      `[EventDispatchWorker] outcome-write-skipped ${JSON.stringify({
        errorId: 'EVENT_DISPATCH_OUTCOME_WRITE_SKIPPED',
        eventId,
        subscriberId,
        attemptedStatus: label
      })}`
    );
  }
}

/**
 * Delivery processing (`deliver-event` job): the receipt state machine.
 *
 * A `delivered` receipt proves the subscriber HANDLER completed — usually
 * "downstream job accepted" — not that an email/webhook egress completed.
 */
export async function processDeliverEvent(data: DeliverEventJobData): Promise<void> {
  const { subscriberId, event } = data;

  const sub = getSubscriberById(subscriberId);
  if (!sub) {
    // Terminal: a subscriber removed in a later deploy must not retry
    // forever chasing a handler that no longer exists.
    const message =
      `[EventDispatchWorker] deliver-event for unknown subscriber "${subscriberId}" `
      + `(event ${event.id}); dropping`;
    console.error(message);
    captureException(new Error(message));
    return;
  }

  const claim = await runWithSystemDbAccess(() => claimReceipt(event, subscriberId));
  if (claim.outcome === 'already-delivered') {
    // Idempotent skip — the post-retention dedupe BullMQ retention cannot
    // provide on its own.
    return;
  }

  try {
    // Deliberately no try/catch around the BUSINESS error path to swallow
    // it — this try/catch exists only to record the CAS failure transition
    // before rethrowing. The subscriber handler MUST throw on failure (see
    // DurableEventSubscriber's contract); the rethrow below is what fails
    // the BullMQ job so per-subscriber retry/backoff applies.
    await sub.handler(event);
  } catch (error) {
    const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await runWithSystemDbAccess(() =>
      writeReceiptOutcome(event.id, subscriberId, { status: 'failed', lastError, updatedAt: sql`now()` }, 'failed')
    );
    throw error;
  }

  await runWithSystemDbAccess(() =>
    writeReceiptOutcome(
      event.id,
      subscriberId,
      { status: 'delivered', deliveredAt: sql`now()`, updatedAt: sql`now()` },
      'delivered'
    )
  );
}

function logParseFailure(jobName: string, job: Job, error: unknown): void {
  // Terminal: a malformed payload must never retry forever. Validated at the
  // dequeue boundary rather than trusted from the (already-typed) producer,
  // because BullMQ jobs round-trip through Redis as untyped JSON — an old
  // producer's stale shape, or hand-crafted job, must dead-letter here
  // instead of throwing deep inside route/deliver processing.
  const message = `[EventDispatchWorker] ${jobName} job ${job.id} failed schema validation; dropping`;
  console.error(message, error);
  captureException(error instanceof Error ? error : new Error(String(error)));
}

export async function eventDispatchProcessor(job: Job): Promise<void> {
  if (job.name === 'route-event') {
    let data: RouteEventJobData;
    try {
      // Schema fields intentionally mirror the hand-written RouteEventJobData
      // interface exactly (see queueSchemas.ts's note on why the two are
      // declared separately) — the cast is safe once `.parse()` succeeds.
      data = routeEventJobDataSchema.parse(job.data) as unknown as RouteEventJobData;
    } catch (error) {
      logParseFailure('route-event', job, error);
      return;
    }
    await processRouteEvent(data);
    return;
  }

  if (job.name === 'deliver-event') {
    let data: DeliverEventJobData;
    try {
      data = deliverEventJobDataSchema.parse(job.data) as unknown as DeliverEventJobData;
    } catch (error) {
      logParseFailure('deliver-event', job, error);
      return;
    }
    await processDeliverEvent(data);
    return;
  }

  const message = `[EventDispatchWorker] unrecognized job name "${job.name}" on ${EVENT_DISPATCH_QUEUE}`;
  console.error(message);
  captureException(new Error(message));
}

let worker: Worker | null = null;

export function createEventDispatchWorker(): Worker {
  return new Worker(EVENT_DISPATCH_QUEUE, eventDispatchProcessor, {
    connection: getBullMQConnection(),
    // Conservative concurrency until the order-independence fixes (wave
    // 3.5c Tasks 8-10) have soaked in production — do not raise this ahead
    // of that work landing.
    concurrency: 5
  });
}

/**
 * Starts the worker whenever `eventDispatchMode() !== 'off'`, OR the queue
 * already holds jobs — so flipping the mode back to `off` still drains
 * whatever is in flight rather than abandoning it. No-op (one log line) only
 * when both are false.
 *
 * Called from index.ts's `initializeWorkers()` AFTER its `Promise.allSettled`
 * block completes — by then `registerAllEventSubscribers()` (synchronous, run
 * before `initializeWorkers()` in bootstrap()) has already fully installed
 * the durable subscriber registry, so this worker can never see a
 * partially-installed registry (codex Q3 hole #2, #4085).
 */
export async function initializeEventDispatchWorker(): Promise<void> {
  const mode = eventDispatchMode();

  if (mode === 'off') {
    const counts = await getEventDispatchQueue().getJobCounts('waiting', 'delayed', 'active', 'paused');
    const backlog = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (backlog === 0) {
      console.log('[EventDispatchWorker] mode=off and queue empty — worker not started');
      return;
    }
    console.warn(
      `[EventDispatchWorker] mode=off but ${backlog} job(s) remain queued — starting worker to drain them`
    );
  }

  try {
    worker = createEventDispatchWorker();
    attachWorkerObservability(worker, 'eventDispatch');
    console.log(`[EventDispatchWorker] Initialized (mode=${mode})`);
  } catch (error) {
    if (worker) {
      await worker.close().catch(() => {});
      worker = null;
    }
    throw error;
  }
}

export async function shutdownEventDispatchWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
