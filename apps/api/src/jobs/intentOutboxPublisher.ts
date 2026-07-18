import { Job, Queue, Worker } from 'bullmq';
import { inArray, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { intentOutbox } from '../db/schema/actionIntents';
import { getBullMQConnection } from '../services/redis';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { captureException } from '../services/sentry';

/**
 * Drains the `intent_outbox` transactional outbox (spec
 * docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md
 * §5) into the `action-intents` BullMQ queue that `jobs/intentReleaseWorker.ts`
 * (Task 7 — not built here) consumes. This module only creates the queue and
 * publishes to it; it never processes `action-intents` jobs itself.
 *
 * Each pass:
 *  1. Read-only alarm scan for rows already stuck past MAX_PUBLISH_ATTEMPTS —
 *     logged + Sentry-captured, left untouched (no lock, no enqueue, no further
 *     attempts increment) so they stay visible for manual inspection.
 *  2. Atomically claim up to MAX_PUBLISH_PER_RUN live rows (`published_at IS
 *     NULL`, `publish_attempts <= MAX_PUBLISH_ATTEMPTS`, `FOR UPDATE SKIP
 *     LOCKED`) and bump `publish_attempts` in the same statement — so a crash
 *     between claim and enqueue still counts as a used attempt. Steps 1-2 run
 *     inside a short `withSystemDbAccessContext` call that closes (commits)
 *     before step 3 starts.
 *  3. For each claimed row, enqueue an `action-intents` job with a
 *     hyphen-only, dedupe-stable jobId (`intent-<eventType>-<intentId>` — see
 *     BullMQ jobId rule: colons collide with BullMQ's own key delimiter).
 *     This step runs explicitly OUTSIDE any DB access context
 *     (`runOutsideDbContext`) so a Redis round-trip per row never pins a
 *     pooled DB connection idle-in-transaction (#1105) — `queue.add()` is
 *     instrumented (`createInstrumentedQueue`) to warn/throw if it ever runs
 *     while a context is still held.
 *  4. Mark `published_at = now()` for whichever rows actually enqueued
 *     successfully, in a SECOND short `withSystemDbAccessContext` call. Rows
 *     that failed to enqueue keep `published_at IS NULL` and are naturally
 *     retried next pass (their attempt was already counted in step 2).
 *     Re-publishing is harmless: `intentReleaseWorker` consumers are
 *     CAS-idempotent and BullMQ's jobId dedupe collapses duplicate enqueues
 *     of the same event for the same intent.
 *
 * Runs every 5 seconds. `publishOutboxRows` itself opens and closes the two
 * short `withSystemDbAccessContext` transactions (claim, then mark-published)
 * around the enqueue step — the worker processor must NOT wrap the whole
 * function in a single outer context, or the enqueue loop would run inside a
 * held transaction (the exact #1105 anti-pattern this module exists to
 * avoid). `intent_outbox` has RLS disabled entirely (system-scoped, workers
 * only; same precedent as `device_commands`), but the DB-context helper is
 * used uniformly across background jobs regardless of RLS status.
 */

const REAPER_QUEUE_NAME = 'intent-outbox-publisher';
const ACTION_INTENTS_QUEUE_NAME = 'action-intents';
const PUBLISH_INTERVAL_MS = 5 * 1000; // every 5s
const MAX_PUBLISH_PER_RUN = 200;
// Rows with publish_attempts > this are considered stuck: logged as an alarm
// and left alone rather than retried forever.
const MAX_PUBLISH_ATTEMPTS = 5;

type PublisherJobData = { type: 'publish-intent-outbox'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[IntentOutboxPublisher] withSystemDbAccessContext not available — publisher cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

// #1105 — explicitly exits any DB access context before running `fn`. Used to
// wrap the enqueue loop so a Redis round-trip per row can never run while a
// pooled connection is pinned idle-in-transaction, even if a future caller
// mistakenly invokes `publishOutboxRows` from inside an existing context.
const runOutsideDbContext = <T>(fn: () => Promise<T>): Promise<T> => {
  const runOutside = dbModule.runOutsideDbContext;
  if (typeof runOutside !== 'function') {
    return fn();
  }
  return runOutside(fn);
};

let reaperQueue: Queue<PublisherJobData> | null = null;
let reaperWorker: Worker<PublisherJobData> | null = null;
let actionIntentsQueue: Queue | null = null;

function getQueue(): Queue<PublisherJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<PublisherJobData>(REAPER_QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return reaperQueue;
}

function getActionIntentsQueue(): Queue {
  if (!actionIntentsQueue) {
    actionIntentsQueue = createInstrumentedQueue(ACTION_INTENTS_QUEUE_NAME);
  }
  return actionIntentsQueue;
}

// `type` (not `interface`) so TS's implicit index signature for object type
// literals applies — `db.execute<T>`'s constraint is `Record<string,
// unknown>`, which a plain `interface` declaration does not structurally
// satisfy without an explicit `[key: string]: unknown` member (TS2344).
type StuckOutboxRow = {
  id: number;
  intent_id: string;
  event_type: string;
  publish_attempts: number;
};

type ClaimedOutboxRow = {
  id: number;
  intent_id: string;
  event_type: string;
  publish_attempts: number;
};

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

export interface PublishOutboxResult {
  published: number;
  skipped: number;
}

interface ClaimResult {
  stuckRows: StuckOutboxRow[];
  claimedRows: ClaimedOutboxRow[];
}

/**
 * Phase 1 (CLAIM) — DB-only work. Runs inside its own short
 * `withSystemDbAccessContext` transaction (opened by the caller) so the held
 * connection covers only these two statements, never the enqueue loop.
 */
async function scanAndClaimOutboxRows(): Promise<ClaimResult> {
  // Read-only alarm scan — never locked, never mutated.
  const stuck = await db.execute<StuckOutboxRow>(sql`
    SELECT id, intent_id, event_type, publish_attempts
    FROM ${intentOutbox}
    WHERE ${intentOutbox.publishedAt} IS NULL
      AND ${intentOutbox.publishAttempts} > ${MAX_PUBLISH_ATTEMPTS}
    ORDER BY ${intentOutbox.createdAt} ASC
    LIMIT ${MAX_PUBLISH_PER_RUN}
  `);
  const stuckRows = extractRows<StuckOutboxRow>(stuck);
  for (const row of stuckRows) {
    const message =
      `[IntentOutboxPublisher] intent_outbox row ${row.id} (intent ${row.intent_id}, `
      + `event ${row.event_type}) stuck at ${row.publish_attempts} publish attempts — skipping`;
    console.error(message);
    captureException(new Error(message));
  }

  // Atomically claim live rows and bump publish_attempts.
  const claimed = await db.execute<ClaimedOutboxRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${intentOutbox}
      WHERE ${intentOutbox.publishedAt} IS NULL
        AND ${intentOutbox.publishAttempts} <= ${MAX_PUBLISH_ATTEMPTS}
      ORDER BY ${intentOutbox.createdAt} ASC
      LIMIT ${MAX_PUBLISH_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${intentOutbox} AS o
    SET publish_attempts = o.publish_attempts + 1
    FROM due
    WHERE o.id = due.id
    RETURNING o.id, o.intent_id, o.event_type, o.publish_attempts;
  `);
  const claimedRows = extractRows<ClaimedOutboxRow>(claimed);

  return { stuckRows, claimedRows };
}

/**
 * Phase 2 (ENQUEUE) — no DB context. Caller must invoke this via
 * `runOutsideDbContext` so `queue.add()` (instrumented by
 * `createInstrumentedQueue`) never runs while a pooled connection is pinned
 * idle-in-transaction (#1105).
 */
async function enqueueClaimedRows(rows: ClaimedOutboxRow[]): Promise<number[]> {
  const queue = getActionIntentsQueue();
  const publishedIds: number[] = [];
  for (const row of rows) {
    try {
      await queue.add(
        row.event_type,
        { intentId: row.intent_id, eventType: row.event_type },
        {
          jobId: `intent-${row.event_type}-${row.intent_id}`,
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 500 },
        },
      );
      publishedIds.push(row.id);
    } catch (err) {
      console.error(`[IntentOutboxPublisher] Failed to enqueue outbox row ${row.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      // Leave published_at NULL — next pass retries; attempt already counted above.
    }
  }
  return publishedIds;
}

/**
 * Phase 3 (MARK PUBLISHED) — DB-only work, its own short
 * `withSystemDbAccessContext` transaction opened by the caller, entirely
 * separate from the claim transaction so it never overlaps the enqueue loop.
 */
async function markOutboxRowsPublished(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(intentOutbox)
    .set({ publishedAt: sql`now()` })
    .where(inArray(intentOutbox.id, ids));
}

/**
 * Single pass over `intent_outbox`. Returns the number of rows successfully
 * published and the number of rows skipped as permanently stuck.
 *
 * Orchestrates its own DB-context boundaries (claim → enqueue → mark
 * published) so no caller may accidentally hold a DB transaction open across
 * the enqueue loop (#1105). Callers must invoke this directly, never wrapped
 * in an outer `withSystemDbAccessContext`.
 */
export async function publishOutboxRows(): Promise<PublishOutboxResult> {
  // Phase 1: claim, inside a short DB context that closes before we return.
  const { stuckRows, claimedRows } = await runWithSystemDbAccess(scanAndClaimOutboxRows);

  if (claimedRows.length === 0) {
    return { published: 0, skipped: stuckRows.length };
  }

  // Phase 2: enqueue, explicitly outside any DB context — the claiming
  // transaction from phase 1 has already committed, but we exit defensively
  // in case a future caller nests `publishOutboxRows` inside its own context.
  const publishedIds = await runOutsideDbContext(() => enqueueClaimedRows(claimedRows));

  // Phase 3: mark successfully-enqueued rows published, in a second short
  // DB context that never overlaps the enqueue loop above.
  if (publishedIds.length > 0) {
    await runWithSystemDbAccess(() => markOutboxRowsPublished(publishedIds));
  }

  if (claimedRows.length === MAX_PUBLISH_PER_RUN) {
    console.warn(
      `[IntentOutboxPublisher] Hit ${MAX_PUBLISH_PER_RUN}-item cap — backlog may be growing`,
    );
  }

  return { published: publishedIds.length, skipped: stuckRows.length };
}

function createWorker(): Worker<PublisherJobData> {
  return new Worker<PublisherJobData>(
    REAPER_QUEUE_NAME,
    async (_job: Job<PublisherJobData>) => {
      try {
        // publishOutboxRows manages its own DB-context boundaries internally
        // (claim → enqueue → mark-published) — it must NOT be wrapped in an
        // outer withSystemDbAccessContext here, or the enqueue loop would run
        // inside a held transaction (#1105).
        const { published, skipped } = await publishOutboxRows();
        if (published > 0 || skipped > 0) {
          console.log(
            `[IntentOutboxPublisher] Published ${published} outbox row(s), ${skipped} stuck`,
          );
        }
        return { published, skipped };
      } catch (err) {
        console.error('[IntentOutboxPublisher] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();

  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'publish-intent-outbox') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'publish-intent-outbox',
    { type: 'publish-intent-outbox', queuedAt: new Date().toISOString() },
    {
      jobId: 'intent-outbox-publisher',
      repeat: { every: PUBLISH_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeIntentOutboxPublisher(): Promise<void> {
  if (reaperWorker) return;

  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[IntentOutboxPublisher] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[IntentOutboxPublisher] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }

  console.log('[IntentOutboxPublisher] Initialized');
}

export async function shutdownIntentOutboxPublisher(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  const targetQueue = actionIntentsQueue;
  reaperWorker = null;
  reaperQueue = null;
  actionIntentsQueue = null;

  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[IntentOutboxPublisher] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[IntentOutboxPublisher] Error closing queue:', err);
    }
  }
  if (targetQueue) {
    try {
      await targetQueue.close();
    } catch (err) {
      console.error('[IntentOutboxPublisher] Error closing action-intents queue:', err);
    }
  }
}
