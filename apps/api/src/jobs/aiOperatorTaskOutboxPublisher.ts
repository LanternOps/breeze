import { Job, Queue, Worker } from 'bullmq';
import { inArray, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { aiOperatorTaskOutbox } from '../db/schema/aiOperatorTasks';
import { getBullMQConnection } from '../services/redis';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { captureException } from '../services/sentry';
import { recordAiOperatorOutboxBacklog } from '../services/aiOperatorOutboxMetrics';
import {
  AI_OPERATOR_COORDINATOR_QUEUE_NAME,
  AI_OPERATOR_COORDINATOR_WAKE_JOB_NAME,
  type AiOperatorTaskWakeJobData,
} from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';

/**
 * Drains the `ai_operator_task_outbox` transactional outbox (spec §6.3, §11.2)
 * into the `ai-operator-coordinator` BullMQ queue the AI Operator task
 * coordinator (W06, not built yet) consumes. This module only creates the
 * queue and publishes to it; it never processes coordinator wake jobs itself.
 *
 * WHY SYSTEM DB CONTEXT: unlike a request handler or a per-org worker,
 * this publisher's whole job is to drain a table across EVERY org in one
 * pass — `ai_operator_task_outbox` is Shape-1 org-scoped RLS (deliberately,
 * baseline C20, unlike `intent_outbox`'s INTENTIONAL_UNSCOPED shape), so an
 * ordinary tenant-scoped context would see nothing outside its own org.
 * `withSystemDbAccessContext` is the sanctioned cross-org read/write path for
 * exactly this kind of system-wide sweep (same posture as
 * `intentOutboxPublisher.ts`'s `intent_outbox` drain, `intentExpiryReaper.ts`,
 * and every other coarse background reaper in this codebase).
 *
 * Each pass, closely mirroring `intentOutboxPublisher.ts`'s three-phase shape:
 *  1. CLAIM (DB-only, short `withSystemDbAccessContext`): atomically claim up
 *     to MAX_PUBLISH_PER_RUN rows (`published_at IS NULL`, `ORDER BY due_at,
 *     id`, `FOR UPDATE SKIP LOCKED`) and bump `attempts` in the same
 *     statement, so a crash between claim and enqueue still counts as a used
 *     attempt. Also scans (read-only, unlocked) the full unpublished set for
 *     the two backlog gauges (§11.2) — count and the oldest row's age.
 *  2. ENQUEUE (no DB context, `runOutsideDbContext`): one `ai-operator-coordinator`
 *     job per claimed row, with a dedupe-stable jobId encoding the row's wake
 *     identity (org, task, source kind, source id, transition) — BullMQ's
 *     jobId dedupe collapses a re-publish of the same wake to a no-op on the
 *     queue side, on top of the outbox row's own identity unique. Job data
 *     carries the TYPED REFERENCE only (`{ orgId, taskId, sourceKind,
 *     sourceId, transitionSeq }`), never a payload — the consumer always
 *     re-reads the authoritative source row (spec §6.3).
 *  3. MARK PUBLISHED (DB-only, short `withSystemDbAccessContext`): rows that
 *     failed to enqueue keep `published_at IS NULL` and retry next pass
 *     (their attempt was already counted in step 1).
 *
 * Runs every 5 seconds — sub-hourly, deliberately outside
 * `jobs/scheduleRegistry.ts` (below `COARSE_REPEAT_INTERVAL_MS`, same
 * precedent as `intentOutboxPublisher.ts`'s own 5s tick).
 */

const QUEUE_NAME = 'ai-operator-task-outbox-publisher';
const PUBLISH_INTERVAL_MS = 5 * 1000; // every 5s
const MAX_PUBLISH_PER_RUN = 50;

type PublisherJobData = { type: 'publish-ai-operator-task-outbox'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[AiOperatorTaskOutboxPublisher] withSystemDbAccessContext not available — publisher cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

// #1105 — explicitly exits any DB access context before running `fn`, so a
// Redis round-trip per row never runs while a pooled connection is pinned
// idle-in-transaction.
const runOutsideDbContext = <T>(fn: () => Promise<T>): Promise<T> => {
  const runOutside = dbModule.runOutsideDbContext;
  if (typeof runOutside !== 'function') {
    return fn();
  }
  return runOutside(fn);
};

let publisherQueue: Queue<PublisherJobData> | null = null;
let publisherWorker: Worker<PublisherJobData> | null = null;
let coordinatorQueue: Queue<AiOperatorTaskWakeJobData> | null = null;

function getQueue(): Queue<PublisherJobData> {
  if (!publisherQueue) {
    publisherQueue = new Queue<PublisherJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return publisherQueue;
}

function getCoordinatorQueue(): Queue<AiOperatorTaskWakeJobData> {
  if (!coordinatorQueue) {
    coordinatorQueue = createInstrumentedQueue<AiOperatorTaskWakeJobData>(AI_OPERATOR_COORDINATOR_QUEUE_NAME);
  }
  return coordinatorQueue;
}

// `type` (not `interface`) for the same reason intentOutboxPublisher.ts's
// row types are — `db.execute<T>`'s constraint is `Record<string, unknown>`,
// which a plain `interface` does not structurally satisfy.
type ClaimedOutboxRow = {
  id: number;
  org_id: string;
  task_id: string;
  source_kind: string;
  source_id: string;
  transition_seq: number;
};

type BacklogRow = { unpublished_count: number; oldest_age_seconds: number };

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

interface ClaimResult {
  claimedRows: ClaimedOutboxRow[];
  backlog: BacklogRow;
}

/**
 * Phase 1 (CLAIM + BACKLOG SCAN) — DB-only. Runs inside its own short
 * `withSystemDbAccessContext` transaction (opened by the caller) so the held
 * connection covers only these statements, never the enqueue loop.
 */
async function scanAndClaimOutboxRows(): Promise<ClaimResult> {
  // Read-only backlog scan (spec §11.2) — never locked, never mutated. Runs
  // BEFORE the claim below so the count/oldest-age reflect the state prior to
  // this pass's own claim (a claimed-but-not-yet-published row is still
  // "unpublished" either way; ordering only matters for consistency, not
  // correctness).
  const backlogResult = await db.execute<BacklogRow>(sql`
    SELECT
      count(*)::int AS unpublished_count,
      COALESCE(EXTRACT(EPOCH FROM (now() - min(${aiOperatorTaskOutbox.createdAt})))::int, 0) AS oldest_age_seconds
    FROM ${aiOperatorTaskOutbox}
    WHERE ${aiOperatorTaskOutbox.publishedAt} IS NULL
  `);
  const backlog = extractRows<BacklogRow>(backlogResult)[0] ?? { unpublished_count: 0, oldest_age_seconds: 0 };

  const claimed = await db.execute<ClaimedOutboxRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${aiOperatorTaskOutbox}
      WHERE ${aiOperatorTaskOutbox.publishedAt} IS NULL
      ORDER BY ${aiOperatorTaskOutbox.dueAt} ASC, ${aiOperatorTaskOutbox.id} ASC
      LIMIT ${MAX_PUBLISH_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${aiOperatorTaskOutbox} AS o
    SET attempts = o.attempts + 1
    FROM due
    WHERE o.id = due.id
    RETURNING o.id, o.org_id, o.task_id, o.source_kind, o.source_id, o.transition_seq;
  `);
  const claimedRows = extractRows<ClaimedOutboxRow>(claimed);

  return { claimedRows, backlog };
}

/**
 * Phase 2 (ENQUEUE) — no DB context. Caller must invoke this via
 * `runOutsideDbContext` so `queue.add()` (instrumented by
 * `createInstrumentedQueue`) never runs while a pooled connection is pinned
 * idle-in-transaction (#1105).
 */
async function enqueueClaimedRows(rows: ClaimedOutboxRow[]): Promise<number[]> {
  const publishedIds: number[] = [];
  for (const row of rows) {
    try {
      // Hyphen-only, dedupe-stable — colons collide with BullMQ's own key
      // delimiter (same rule intentOutboxPublisher.ts's jobId follows).
      const jobId = `task-wake-${row.org_id}-${row.task_id}-${row.source_kind}-${row.source_id}-${row.transition_seq}`;
      await getCoordinatorQueue().add(
        AI_OPERATOR_COORDINATOR_WAKE_JOB_NAME,
        {
          v: 1,
          orgId: row.org_id,
          taskId: row.task_id,
          // The four remaining source kinds (run/execution/verification/
          // user_answer/target/cancellation) have no writer yet in this wave
          // — only 'intent' is produced today — but the cast keeps this
          // publisher generic over whatever a future writer enqueues rather
          // than hard-coding a narrower union than the schema allows.
          sourceKind: row.source_kind as AiOperatorTaskWakeJobData['sourceKind'],
          sourceId: row.source_id,
          transitionSeq: row.transition_seq,
        },
        {
          jobId,
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 500 },
        },
      );
      publishedIds.push(row.id);
    } catch (err) {
      console.error(`[AiOperatorTaskOutboxPublisher] Failed to enqueue outbox row ${row.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      // Leave published_at NULL — next pass retries; attempt already counted above.
    }
  }
  return publishedIds;
}

/**
 * Phase 3 (MARK PUBLISHED) — DB-only, its own short
 * `withSystemDbAccessContext` transaction, entirely separate from the claim
 * transaction so it never overlaps the enqueue loop.
 */
async function markOutboxRowsPublished(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(aiOperatorTaskOutbox)
    .set({ publishedAt: sql`now()` })
    .where(inArray(aiOperatorTaskOutbox.id, ids));
}

export interface PublishAiOperatorTaskOutboxResult {
  published: number;
}

/**
 * Single pass over `ai_operator_task_outbox`. Orchestrates its own DB-context
 * boundaries (claim → enqueue → mark published) so no caller may accidentally
 * hold a DB transaction open across the enqueue loop (#1105). Callers must
 * invoke this directly, never wrapped in an outer `withSystemDbAccessContext`.
 */
export async function publishAiOperatorTaskOutbox(): Promise<PublishAiOperatorTaskOutboxResult> {
  const { claimedRows, backlog } = await runWithSystemDbAccess(scanAndClaimOutboxRows);
  recordAiOperatorOutboxBacklog(backlog.unpublished_count, backlog.oldest_age_seconds);

  if (claimedRows.length === 0) {
    return { published: 0 };
  }

  const publishedIds = await runOutsideDbContext(() => enqueueClaimedRows(claimedRows));

  if (publishedIds.length > 0) {
    await runWithSystemDbAccess(() => markOutboxRowsPublished(publishedIds));
  }

  if (claimedRows.length === MAX_PUBLISH_PER_RUN) {
    console.warn(`[AiOperatorTaskOutboxPublisher] Hit ${MAX_PUBLISH_PER_RUN}-item cap — backlog may be growing`);
  }

  return { published: publishedIds.length };
}

function createWorker(): Worker<PublisherJobData> {
  return new Worker<PublisherJobData>(
    QUEUE_NAME,
    async (_job: Job<PublisherJobData>) => {
      try {
        const { published } = await publishAiOperatorTaskOutbox();
        if (published > 0) {
          console.log(`[AiOperatorTaskOutboxPublisher] Published ${published} outbox row(s)`);
        }
        return { published };
      } catch (err) {
        console.error('[AiOperatorTaskOutboxPublisher] Run failed:', err);
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
    if (job.name === 'publish-ai-operator-task-outbox') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'publish-ai-operator-task-outbox',
    { type: 'publish-ai-operator-task-outbox', queuedAt: new Date().toISOString() },
    {
      jobId: 'ai-operator-task-outbox-publisher',
      repeat: { every: PUBLISH_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeAiOperatorTaskOutboxPublisher(): Promise<void> {
  if (publisherWorker) return;

  publisherWorker = createWorker();
  attachWorkerObservability(publisherWorker, 'aiOperatorTaskOutboxPublisher');
  publisherWorker.on('error', (error) => {
    console.error('[AiOperatorTaskOutboxPublisher] Worker error:', error);
    captureException(error);
  });
  publisherWorker.on('failed', (job, error) => {
    console.error(`[AiOperatorTaskOutboxPublisher] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await publisherWorker.close();
    publisherWorker = null;
    throw err;
  }

  console.log('[AiOperatorTaskOutboxPublisher] Initialized');
}

export async function shutdownAiOperatorTaskOutboxPublisher(): Promise<void> {
  const worker = publisherWorker;
  const queue = publisherQueue;
  const targetQueue = coordinatorQueue;
  publisherWorker = null;
  publisherQueue = null;
  coordinatorQueue = null;

  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[AiOperatorTaskOutboxPublisher] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[AiOperatorTaskOutboxPublisher] Error closing queue:', err);
    }
  }
  if (targetQueue) {
    try {
      await targetQueue.close();
    } catch (err) {
      console.error('[AiOperatorTaskOutboxPublisher] Error closing ai-operator-coordinator queue:', err);
    }
  }
}
