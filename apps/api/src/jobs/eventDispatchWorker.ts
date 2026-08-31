import { Worker, Queue, type Job } from 'bullmq';
import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { eventDeliveryReceipts } from '../db/schema';
import { extractRowCount } from '../db/rowCount';
import { eventDispatchMode } from '../config/env';
import { getBullMQConnection, getRedisConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { getSubscriberById } from '../services/eventSubscriberRegistry';
import { EVENT_SUBSCRIBER_IDS, type SubscriberId } from '../services/eventSubscriberIds';
import type { BreezeEvent } from '../services/eventBus';
import {
  EVENT_DISPATCH_QUEUE,
  getEventDispatchQueue,
  isShadowSampledEvent,
  SHADOW_COUNT_PREFIX,
  SHADOW_LOCAL_PREFIX,
  SHADOW_LOCAL_TTL_SECONDS,
  type RouteEventJobData,
  type DeliverEventJobData
} from '../services/eventDispatchQueue';
import { routeEventJobDataSchema, deliverEventJobDataSchema } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const { db } = dbModule;

/**
 * Consumes the `event-dispatch` BullMQ queue (wave 3.5c, #4085): a `route-event`
 * job snapshots a publisher's routing plan (services/eventDispatchQueue.ts) and
 * is trusted VERBATIM here — this worker never recomputes
 * `partitionSubscribersForEvent` itself (codex D3/Q3). A `deliver-event` job is
 * one durable delivery to ONE subscriber.
 *
 * Delivery is AT-LEAST-ONCE, not exactly-once: two concurrent claim attempts
 * for the same (event, subscriber) can both match the claim CAS (the second
 * blocks on the row lock, then re-evaluates against `status <> 'delivered'`
 * and still matches `delivering`), so both can invoke the handler. Subscriber
 * handlers MUST therefore be idempotent. The ONLY terminal dedupe this table
 * provides is a `delivered` receipt — once a receipt reaches `delivered`, the
 * claim CAS permanently excludes it and no further attempt can re-invoke that
 * handler for that event.
 *
 * This file also owns two maintenance repeatables (Task 7, #4085) that run on
 * a SEPARATE dedicated queue (`EVENT_DISPATCH_MAINTENANCE_QUEUE` — see its own
 * comment for why not this queue): `receipt-retention` (daily batched-delete
 * pruning of `event_delivery_receipts`) and `shadow-compare` (5-minute parity
 * check between shadow-mode routing and local delivery, the evidence gate for
 * flipping to enforce). Both are registered on EVERY boot (#4124),
 * independently of whether the MAIN worker above starts — retention is
 * exactly the job that must keep running once a rollout ends and the queue
 * drains, and shadow-compare re-checks the mode at run time. See
 * `registerEventDispatchMaintenanceRepeatables`'s docstring.
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
    // forever chasing a handler that no longer exists. CAS the receipt
    // straight to `failed` (claim-free — we never invoked a handler, so there
    // is no `delivering` claim to hold) rather than leaving it at `planned`
    // forever: a `planned` row is invisible to the retention sweep's partial
    // index (`WHERE status IN ('delivered','failed')`) and would never be
    // cleaned up. Reuses the claim CAS shape (PK + `status <> 'delivered'`)
    // since a `delivered` row must never be overwritten by this path either.
    const message =
      `[EventDispatchWorker] deliver-event for unknown subscriber "${subscriberId}" `
      + `(event ${event.id}); marking receipt failed`;
    console.error(message);
    captureException(new Error(message));
    await runWithSystemDbAccess(() =>
      db
        .update(eventDeliveryReceipts)
        .set({ status: 'failed', lastError: 'unknown subscriber', updatedAt: sql`now()` })
        .where(buildReceiptClaimCas(event.id, subscriberId))
    );
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

/**
 * `deliver-event` schema-validation failures only (final-review fix, #4085):
 * a `route-event` job that fails parse never got as far as inserting a
 * receipt (`processRouteEvent` does that), so there is nothing to CAS. A
 * `deliver-event` job, by contrast, only ever exists because `processRouteEvent`
 * already inserted its receipt — dropping the job here without touching the
 * receipt would leave it stuck at `planned`/`delivering` forever (invisible to
 * the retention sweep's partial index, per `buildReceiptClaimCas`'s docstring)
 * and, worse, silently drop delivery with no terminal record.
 *
 * `breezeEventEnvelopeSchema` is `.strict()` (queueSchemas.ts) specifically so
 * a future `BreezeEvent` field lands HERE — this is that failure mode's
 * recovery path, not just a defensive nicety. `job.data` is read loosely
 * (schema validation already failed, so it cannot be trusted as
 * `DeliverEventJobData`) — if `subscriberId`/`event.id` cannot even be read as
 * strings, the payload is too malformed to identify a receipt and this is a
 * silent no-op beyond the log/capture above.
 */
async function markDeliverEventReceiptFailedOnParseError(job: Job): Promise<void> {
  const raw = job.data as { subscriberId?: unknown; event?: { id?: unknown } } | null | undefined;
  const subscriberId = typeof raw?.subscriberId === 'string' ? raw.subscriberId : undefined;
  const eventId = typeof raw?.event?.id === 'string' ? raw.event.id : undefined;
  if (!subscriberId || !eventId) return;

  await runWithSystemDbAccess(() =>
    db
      .update(eventDeliveryReceipts)
      .set({ status: 'failed', lastError: 'schema validation', updatedAt: sql`now()` })
      .where(buildReceiptClaimCas(eventId, subscriberId))
  );
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
      await markDeliverEventReceiptFailedOnParseError(job);
      return;
    }
    await processDeliverEvent(data);
    return;
  }

  const message = `[EventDispatchWorker] unrecognized job name "${job.name}" on ${EVENT_DISPATCH_QUEUE}`;
  console.error(message);
  captureException(new Error(message));
}

// ---------------------------------------------------------------------------
// Receipt retention (Task 7, #4085)
// ---------------------------------------------------------------------------

const RETENTION_BATCH_SIZE = 5000;

/**
 * Pass 1: `delivered` receipts older than 7 days — the workload the partial
 * index (`event_delivery_receipts_retention_idx`) exists for.
 */
export function buildDeliveredRetentionDeleteQuery(): SQL {
  return sql`
    DELETE FROM event_delivery_receipts
    WHERE ctid IN (
      SELECT ctid FROM event_delivery_receipts
      WHERE status = 'delivered' AND created_at < now() - interval '7 days'
      LIMIT ${RETENTION_BATCH_SIZE}
    )
  `;
}

/**
 * Pass 2: ALL shadow-mode receipts older than 48 HOURS, regardless of status.
 * `processRouteEvent` stops after the receipt insert in shadow mode (see its
 * own docstring) — a shadow receipt terminates at `planned` by design, so
 * this pass, not the `(delivered|failed)` partial index above, is what bounds
 * table growth while shadow mode runs. Covered by
 * `event_delivery_receipts_mode_created_idx`.
 *
 * Deliberately shorter than pass 1's 7-day window (final-review cost trim,
 * #4085): shadow receipts are comparison scaffolding for the enforce-mode
 * evidence gate (`runShadowComparisonSweep`), not a delivery record anyone
 * needs to audit days later — the 5-minute shadow-compare sweep has long
 * since consumed them, and `SHADOW_LOCAL_TTL_SECONDS` (2h) already bounds how
 * far back that comparison ever looks. Holding a full week of shadow rows on
 * a table sized for delivery traffic was pure storage cost with no consumer.
 */
export function buildShadowRetentionDeleteQuery(): SQL {
  return sql`
    DELETE FROM event_delivery_receipts
    WHERE ctid IN (
      SELECT ctid FROM event_delivery_receipts
      WHERE mode = 'shadow' AND created_at < now() - interval '48 hours'
      LIMIT ${RETENTION_BATCH_SIZE}
    )
  `;
}

/**
 * Pass 3: residual `failed`/`planned`/`delivering` receipts older than 30
 * days, across BOTH modes. `failed` is kept longer than `delivered` for
 * forensics; a `planned`/`delivering` row this old is a lost job (a
 * route-event job whose deliver-event insert never landed, or a worker that
 * crashed mid-claim and was never retried) — see
 * `buildResidualRetentionCountQuery`, which MUST run first and warn, since
 * deleting these destroys the only evidence they ever existed. Small
 * expected volume; a seq scan here is acceptable (no dedicated index).
 */
export function buildResidualRetentionDeleteQuery(): SQL {
  return sql`
    DELETE FROM event_delivery_receipts
    WHERE ctid IN (
      SELECT ctid FROM event_delivery_receipts
      WHERE status IN ('failed', 'planned', 'delivering') AND created_at < now() - interval '30 days'
      LIMIT ${RETENTION_BATCH_SIZE}
    )
  `;
}

/** Counts what pass 3 is about to delete, so the deletion can be warned about first. */
export function buildResidualRetentionCountQuery(): SQL {
  return sql`
    SELECT COUNT(*)::int AS count FROM event_delivery_receipts
    WHERE status IN ('failed', 'planned', 'delivering') AND created_at < now() - interval '30 days'
  `;
}

async function deleteBatchedUntilEmpty(buildQuery: () => SQL): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await db.execute(buildQuery());
    const n = extractRowCount(result);
    deleted += n;
    if (n < RETENTION_BATCH_SIZE) break;
  }
  return deleted;
}

export interface ReceiptRetentionSummary {
  delivered: number;
  shadow: number;
  residual: number;
  abandonedResidualCount: number;
}

/**
 * The `receipt-retention` job body: three independent batched-delete passes
 * over `event_delivery_receipts`, run under system DB context. See the three
 * `build*RetentionDeleteQuery` docstrings above for what each pass targets
 * and why.
 */
export async function runReceiptRetentionSweep(): Promise<ReceiptRetentionSummary> {
  return runWithSystemDbAccess(async () => {
    const delivered = await deleteBatchedUntilEmpty(buildDeliveredRetentionDeleteQuery);
    const shadow = await deleteBatchedUntilEmpty(buildShadowRetentionDeleteQuery);

    const countRows = (await db.execute(buildResidualRetentionCountQuery())) as unknown as Array<{
      count: number;
    }>;
    const abandonedResidualCount = countRows[0]?.count ?? 0;
    if (abandonedResidualCount > 0) {
      console.warn(
        `[EventDispatchWorker] receipts-abandoned ${JSON.stringify({
          errorId: 'EVENT_DISPATCH_RECEIPTS_ABANDONED',
          count: abandonedResidualCount
        })}`
      );
    }
    const residual = await deleteBatchedUntilEmpty(buildResidualRetentionDeleteQuery);

    const summary: ReceiptRetentionSummary = { delivered, shadow, residual, abandonedResidualCount };
    console.log(`[EventDispatchWorker] retention-complete ${JSON.stringify(summary)}`);
    return summary;
  });
}

// ---------------------------------------------------------------------------
// Shadow-mode comparison (Task 7, #4085)
// ---------------------------------------------------------------------------

const SHADOW_COMPARE_MAX_SAMPLES = 200;
const SHADOW_COMPARE_LAST_RUN_KEY = 'breeze:event-shadow:compare-last-run';
const SHADOW_COMPARE_SNAPSHOT_PREFIX = 'breeze:event-shadow:count-snapshot';
const SHADOW_MISMATCH_LIST_KEY = 'breeze:event-shadow:mismatches';
const SHADOW_MISMATCH_LIST_MAX = 999;
// Only used to pick a window on the very first run (no stored watermark yet);
// every subsequent run's window is `[last run, now]`, matching the
// repeatable's own 5-minute cadence.
const SHADOW_COMPARE_FALLBACK_WINDOW_MS = 5 * 60 * 1000;

interface ShadowWindowRow {
  event_id: string;
  event_type: string;
  subscriber_id: string;
}

/** Receipts routed in shadow mode since `windowStart` — the router's-eye view. */
export function buildShadowWindowQuery(windowStart: Date): SQL {
  return sql`
    SELECT event_id, event_type, subscriber_id
    FROM event_delivery_receipts
    WHERE mode = 'shadow' AND created_at >= ${windowStart.toISOString()}
  `;
}

/**
 * Heuristic tolerance for the AGGREGATE counter comparison: local-invocation
 * counters are process-local-ish (a request can land on any API replica)
 * while receipts are the single global router record, so some drift between
 * them is expected even with zero real bugs. This only guards the VOLUME
 * signal; the per-event SAMPLE diff below is the exact signal and has zero
 * tolerance — see its own comment.
 */
function withinShadowCountTolerance(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  return diff <= Math.max(5, Math.ceil(0.1 * Math.max(a, b)));
}

export interface ShadowComparisonSummary {
  windowStart: string;
  subscriberDeltas: Record<string, { localDelta: number; receiptCount: number; withinTolerance: boolean }>;
  samplesChecked: number;
  mismatches: number;
}

/**
 * The `shadow-compare` job body — the parity evidence gate for flipping to
 * enforce. No-ops (returns `{ skipped: true }`) outside shadow mode; checked
 * here at RUN time (not just once at registration), because mode can flip
 * between ticks without a worker restart.
 *
 * (a) COUNTS: per subscriber, diffs the delta of the local-invocation counter
 *     (since the LAST run's snapshot — the counter itself accumulates
 *     forever, see `SHADOW_COMPARE_SNAPSHOT_PREFIX`) against receipts created
 *     in the same window. Logged as one summary line per run.
 * (b) SAMPLES: for up to 200 sampled receipts in the window, diffs the
 *     router-planned subscriber set (this table) against the locally-invoked
 *     subscriber set (`breeze:event-shadow:local:<eventId>`) both ways. This
 *     is the exact signal — any mismatch is always retained
 *     (`SHADOW_MISMATCH_LIST_KEY`), regardless of sampling.
 */
export async function runShadowComparisonSweep(): Promise<ShadowComparisonSummary | { skipped: true }> {
  if (eventDispatchMode() !== 'shadow') {
    return { skipped: true };
  }

  const redis = getRedisConnection();
  const now = new Date();

  const lastRunRaw = await redis.get(SHADOW_COMPARE_LAST_RUN_KEY);
  const requestedWindowStart = lastRunRaw
    ? new Date(lastRunRaw)
    : new Date(now.getTime() - SHADOW_COMPARE_FALLBACK_WINDOW_MS);

  // Clamp to SHADOW_LOCAL_TTL_SECONDS: `breeze:event-shadow:local:<eventId>`
  // expires after that TTL, so after any gap longer than it (an outage, or
  // shadow mode toggled off then back on), every sampled event older than the
  // TTL has an expired/empty local hash — scanning that far back would only
  // manufacture spurious `routedButNotLocal` mismatches, not real ones.
  const ttlFloor = new Date(now.getTime() - SHADOW_LOCAL_TTL_SECONDS * 1000);
  const windowStart = requestedWindowStart.getTime() < ttlFloor.getTime() ? ttlFloor : requestedWindowStart;
  if (windowStart.getTime() > requestedWindowStart.getTime()) {
    console.warn(
      `[EventDispatchWorker] shadow-compare-window-clamped ${JSON.stringify({
        requestedWindowStart: requestedWindowStart.toISOString(),
        clampedWindowStart: windowStart.toISOString(),
        skippedMs: windowStart.getTime() - requestedWindowStart.getTime()
      })}`
    );
  }

  const rows = (await runWithSystemDbAccess(() =>
    db.execute(buildShadowWindowQuery(windowStart))
  )) as unknown as ShadowWindowRow[];

  // ---- (a) aggregate counts: per-subscriber local-invocation delta vs receipt volume
  const receiptsByEvent = new Map<string, { eventType: string; subscriberIds: Set<string> }>();
  const receiptCountsBySubscriber = new Map<string, number>();
  for (const row of rows) {
    receiptCountsBySubscriber.set(
      row.subscriber_id,
      (receiptCountsBySubscriber.get(row.subscriber_id) ?? 0) + 1
    );
    const entry = receiptsByEvent.get(row.event_id) ?? { eventType: row.event_type, subscriberIds: new Set<string>() };
    entry.subscriberIds.add(row.subscriber_id);
    receiptsByEvent.set(row.event_id, entry);
  }

  const subscriberDeltas: ShadowComparisonSummary['subscriberDeltas'] = {};
  let anyOutOfTolerance = false;
  for (const subscriberId of EVENT_SUBSCRIBER_IDS) {
    const countHash = (await redis.hgetall(`${SHADOW_COUNT_PREFIX}:${subscriberId}`)) as Record<string, string>;
    const currentTotal = (parseInt(countHash.ok ?? '0', 10) || 0) + (parseInt(countHash.error ?? '0', 10) || 0);

    const snapshotKey = `${SHADOW_COMPARE_SNAPSHOT_PREFIX}:${subscriberId}`;
    const previousRaw = await redis.get(snapshotKey);
    // First run for this subscriber (no snapshot yet): baseline to the
    // current absolute rather than diffing against 0 — the counter
    // accumulates FOREVER, so treating "no snapshot" as "previous = 0" would
    // report the subscriber's entire lifetime volume as this run's delta.
    const previousTotal = previousRaw !== null ? parseInt(previousRaw, 10) || 0 : currentTotal;
    const localDelta = Math.max(0, currentTotal - previousTotal);
    await redis.set(snapshotKey, String(currentTotal));

    const receiptCount = receiptCountsBySubscriber.get(subscriberId) ?? 0;
    const withinTolerance = withinShadowCountTolerance(localDelta, receiptCount);
    if (!withinTolerance) anyOutOfTolerance = true;
    subscriberDeltas[subscriberId] = { localDelta, receiptCount, withinTolerance };
  }

  const countsLogLine = `[EventDispatchWorker] shadow-compare-counts ${JSON.stringify({
    windowStart: windowStart.toISOString(),
    subscriberDeltas
  })}`;
  if (anyOutOfTolerance) console.warn(countsLogLine);
  else console.log(countsLogLine);

  // ---- (b) per-event sample diff: the exact signal
  const sampledEventIds = [...receiptsByEvent.entries()]
    .filter(([eventId, entry]) => isShadowSampledEvent({ id: eventId, type: entry.eventType } as BreezeEvent))
    .map(([eventId]) => eventId)
    .slice(0, SHADOW_COMPARE_MAX_SAMPLES);

  let mismatches = 0;
  for (const eventId of sampledEventIds) {
    const routedSubscriberIds = receiptsByEvent.get(eventId)!.subscriberIds;
    const localHash = (await redis.hgetall(`${SHADOW_LOCAL_PREFIX}:${eventId}`)) as Record<string, string>;
    const locallyInvokedIds = new Set(Object.keys(localHash));

    const routedButNotLocal = [...routedSubscriberIds].filter((id) => !locallyInvokedIds.has(id));
    const localButNotRouted = [...locallyInvokedIds].filter((id) => !routedSubscriberIds.has(id));

    if (routedButNotLocal.length > 0 || localButNotRouted.length > 0) {
      mismatches += 1;
      const detail = {
        errorId: 'EVENT_DISPATCH_SHADOW_MISMATCH',
        eventId,
        eventType: receiptsByEvent.get(eventId)!.eventType,
        routedButNotLocal,
        localButNotRouted
      };
      const message = `[EventDispatchWorker] shadow-mismatch ${JSON.stringify(detail)}`;
      console.error(message);
      captureException(new Error(message));
      await redis.lpush(SHADOW_MISMATCH_LIST_KEY, JSON.stringify({ ...detail, detectedAt: now.toISOString() }));
      await redis.ltrim(SHADOW_MISMATCH_LIST_KEY, 0, SHADOW_MISMATCH_LIST_MAX);
    }
  }

  await redis.set(SHADOW_COMPARE_LAST_RUN_KEY, now.toISOString());

  return { windowStart: windowStart.toISOString(), subscriberDeltas, samplesChecked: sampledEventIds.length, mismatches };
}

// ---------------------------------------------------------------------------
// Maintenance queue (receipt-retention + shadow-compare)
// ---------------------------------------------------------------------------

export const EVENT_DISPATCH_MAINTENANCE_QUEUE = 'event-dispatch-maintenance';

/**
 * Queue-shape choice (Task 7, #4085): retention and shadow-compare get their
 * OWN queue/worker rather than riding `EVENT_DISPATCH_QUEUE` as two more job
 * names on `eventDispatchProcessor`. That worker's concurrency (5) is tuned
 * for fan-out delivery latency (see `createEventDispatchWorker`'s comment); a
 * multi-minute batched-DELETE retention pass or a Redis-heavy shadow-compare
 * run sharing that pool would steal one of five concurrent delivery slots
 * from real event traffic. A dedicated concurrency-1 worker — mirroring
 * `deviceMetricsRetention.ts` / `webhookDeliveryRecovery.ts` — keeps that
 * contention out of the delivery path entirely, at the cost of one more
 * BullMQ queue name to know about.
 */
async function eventDispatchMaintenanceProcessor(job: Job): Promise<void> {
  if (job.name === 'receipt-retention') {
    await runReceiptRetentionSweep();
    return;
  }
  if (job.name === 'shadow-compare') {
    await runShadowComparisonSweep();
    return;
  }
  const message = `[EventDispatchWorker] unrecognized maintenance job name "${job.name}" on ${EVENT_DISPATCH_MAINTENANCE_QUEUE}`;
  console.error(message);
  captureException(new Error(message));
}

let maintenanceQueue: Queue | null = null;
let maintenanceWorker: Worker | null = null;

export function getEventDispatchMaintenanceQueue(): Queue {
  if (!maintenanceQueue) {
    maintenanceQueue = new Queue(EVENT_DISPATCH_MAINTENANCE_QUEUE, { connection: getBullMQConnection() });
  }
  return maintenanceQueue;
}

export function createEventDispatchMaintenanceWorker(): Worker {
  return new Worker(EVENT_DISPATCH_MAINTENANCE_QUEUE, eventDispatchMaintenanceProcessor, {
    connection: getBullMQConnection(),
    concurrency: 1
  });
}

/**
 * Registers both maintenance repeatables. Called from
 * `initializeEventDispatchWorker` on EVERY boot (#4124) — including
 * `mode='off'` with an empty queue, when the main worker deliberately does
 * not start. Both job bodies are cheap and self-gating, so there is nothing
 * to gate the registration on:
 *
 *  - retention: MUST run while mode='off' — that is exactly when residual
 *    `event_delivery_receipts` from a completed rollout need to age out. The
 *    original wave-3.5c shape tied registration to the main worker starting,
 *    which meant those rows only aged out the next time the worker happened
 *    to start (mode re-enabled, or a backlog reappeared). Running it always
 *    costs three index-driven DELETE passes plus one COUNT per day; on an
 *    empty table that is nothing, and it needs no boot-time DB probe to
 *    decide whether it is worth scheduling.
 *  - shadow-compare: it re-checks `eventDispatchMode() === 'shadow'` on every
 *    RUN, not just here at registration (see `runShadowComparisonSweep`), and
 *    returns `{ skipped: true }` outside shadow mode — so a tick under
 *    mode='off' is a single function call, and mode can flip between
 *    5-minute ticks without a worker restart.
 *
 * Registration idiom (remove existing repeatables then add) mirrors
 * `webhookDeliveryRecovery.ts`.
 */
async function registerEventDispatchMaintenanceRepeatables(): Promise<void> {
  const queue = getEventDispatchMaintenanceQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    'receipt-retention',
    {},
    {
      // Coarse (daily) — MUST use the scheduleRegistry cron lane, never
      // `every:` (epoch-stampede rule, see jobs/scheduleRegistry.ts).
      repeat: { pattern: jobSchedule('receipt-retention') },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 }
    }
  );

  await queue.add(
    'shadow-compare',
    {},
    {
      // Sub-hourly — `every:` is correct here; the scheduleRegistry only
      // manages >= hourly schedules (see its module docstring).
      repeat: { every: 5 * 60 * 1000 },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 }
    }
  );
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
 * Starts the MAIN worker whenever `eventDispatchMode() !== 'off'`, OR the
 * queue already holds jobs — so flipping the mode back to `off` still drains
 * whatever is in flight rather than abandoning it.
 *
 * The MAINTENANCE worker and its two repeatables, by contrast, are registered
 * on every boot regardless of mode or backlog (#4124) — see
 * `registerEventDispatchMaintenanceRepeatables`. Retention is precisely the
 * job that has to keep running once a rollout ends, and shadow-compare
 * self-gates at run time.
 *
 * Called from index.ts's `initializeWorkers()` AFTER its `Promise.allSettled`
 * block completes — by then `registerAllEventSubscribers()` (synchronous, run
 * before `initializeWorkers()` in bootstrap()) has already fully installed
 * the durable subscriber registry, so this worker can never see a
 * partially-installed registry (codex Q3 hole #2, #4085).
 */
export async function initializeEventDispatchWorker(): Promise<void> {
  const mode = eventDispatchMode();
  let startMainWorker = mode !== 'off';

  if (!startMainWorker) {
    // A throw here (e.g. Redis unreachable while constructing the queue) must
    // NEVER propagate: `EVENT_DISPATCH_MODE=off` is the default, so an
    // unguarded probe failure would set `workerStatus['eventDispatch'] =
    // false` on every boot for a feature that is deliberately disabled,
    // permanently pinning `/ready` to not-ready with no self-heal. Treat a
    // failed probe as "no backlog, don't start" — the worst case is a
    // pre-existing queued job waits for the next successful boot, not an
    // instance stuck 503ing forever.
    let backlog = 0;
    try {
      const counts = await getEventDispatchQueue().getJobCounts('waiting', 'delayed', 'active', 'paused');
      backlog = Object.values(counts).reduce((sum, n) => sum + n, 0);
    } catch (error) {
      console.error('[EventDispatchWorker] backlog probe failed while mode=off; treating as no backlog', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      backlog = 0;
    }
    if (backlog === 0) {
      console.log(
        '[EventDispatchWorker] mode=off and queue empty — main worker not started (maintenance repeatables still register)'
      );
    } else {
      console.warn(
        `[EventDispatchWorker] mode=off but ${backlog} job(s) remain queued — starting worker to drain them`
      );
      startMainWorker = true;
    }
  }

  if (startMainWorker) {
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

  try {
    maintenanceWorker = createEventDispatchMaintenanceWorker();
    attachWorkerObservability(maintenanceWorker, 'eventDispatchMaintenance');
    await registerEventDispatchMaintenanceRepeatables();
    console.log('[EventDispatchWorker] Maintenance repeatables registered (receipt-retention, shadow-compare)');
  } catch (error) {
    // ISOLATED failure domain, deliberately NOT rethrown: whatever the main
    // worker is doing (running and serving real event traffic, or
    // deliberately not started because mode='off') is unaffected, and this
    // function's caller (index.ts's initializeWorkers) sets
    // `workerStatus['eventDispatch'] = true` only if this promise resolves —
    // the exact off-mode-backlog-probe lesson a few lines up applies here
    // too, and applies HARDER now that this block runs on the default
    // mode='off' boot as well. Maintenance registration does 3+ fresh Redis
    // round-trips (getRepeatableJobs, 2x removeRepeatableByKey/add), so a
    // transient Redis blip during boot must degrade to "retention/
    // shadow-compare didn't get scheduled this boot" rather than pinning
    // `/ready` to not-ready for the process lifetime over a housekeeping
    // job. Close ONLY what THIS try block opened (maintenance worker/queue);
    // the main worker/queue are untouched.
    if (maintenanceWorker) {
      await maintenanceWorker.close().catch(() => {});
      maintenanceWorker = null;
    }
    if (maintenanceQueue) {
      await maintenanceQueue.close().catch(() => {});
      maintenanceQueue = null;
    }
    // Because the error IS swallowed, this report is the only visible trace
    // that retention never got scheduled — `workerStatus` deliberately gets no
    // `eventDispatchMaintenance` key, since `readiness.ts` fails readiness on
    // `outcomes.every(Boolean)` and a `false` there would pin `/ready` exactly
    // as this block exists to prevent. So it has to be findable on its own:
    // a greppable `errorId` in the log line (the convention this file already
    // uses for EVENT_DISPATCH_RECEIPTS_ABANDONED / _SHADOW_MISMATCH) and the
    // `worker` Sentry tag — the same triage axis `attachWorkerObservability`
    // puts on every job-level failure from this worker, and one of the few
    // tag names that survives the sentry.ts scrubber allowlist.
    console.error(
      `[EventDispatchWorker] maintenance-registration-failed ${JSON.stringify({
        errorId: 'EVENT_DISPATCH_MAINTENANCE_REGISTRATION_FAILED',
        mainWorkerStarted: startMainWorker,
        mode
      })}`,
      error
    );
    captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
      worker: 'eventDispatchMaintenance'
    });
  }
}

export async function shutdownEventDispatchWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (maintenanceWorker) {
    await maintenanceWorker.close();
    maintenanceWorker = null;
  }
  if (maintenanceQueue) {
    await maintenanceQueue.close();
    maintenanceQueue = null;
  }
}
