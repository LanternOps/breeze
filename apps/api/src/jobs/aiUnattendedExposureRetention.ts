/**
 * AI Unattended-Exposure Ledger Retention Worker (wave 5B, #3827 Task 4).
 *
 * `ai_unattended_exposure` is the org-wide blast-cap ledger both the act
 * lane (`actRevalidation.ts`) and the policy-decide lane (`policyDecide.ts`)
 * write to and read from — every fleet-percent check reads only the
 * TRAILING 24 HOURS of rows (`gt(reservedAt, now() - interval '24 hours')`),
 * so nothing outside that window is ever consulted again. This sweep prunes
 * rows older than 48h — double the live-read window, not the window itself
 * — so a row is never deleted while any in-flight cap check could still be
 * reading it, without needing to reason precisely about clock skew or a
 * check that started just before the boundary.
 *
 * Retention is a FIXED 48h, not an operator-configurable knob (unlike the
 * data-retention-policy jobs this file's shape otherwise mirrors, e.g.
 * `ipHistoryRetention.ts`): the window is load-bearing for the safety
 * contract's cap math, not a storage/compliance choice an operator should be
 * able to widen or narrow.
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { extractRowCount } from '../db/rowCount';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[AiUnattendedExposureRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const QUEUE_NAME = 'ai-unattended-exposure-retention';
const JOB_NAME = 'ai-unattended-exposure-retention';
const REPEAT_JOB_ID = 'ai-unattended-exposure-retention';

/** Fixed — see module header. Not env-configurable. */
export const RETENTION_HOURS = 48;

type RetentionJobResult = { deletedCount: number; durationMs: number };

export async function pruneAiUnattendedExposure(): Promise<RetentionJobResult> {
  const startedAt = Date.now();
  // postgres-js does not coerce JS Date in template-literal params; pass an
  // ISO string, same convention every sibling retention worker follows.
  const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  const result = await db.execute(sql`
    DELETE FROM ai_unattended_exposure
    WHERE reserved_at < ${cutoff}::timestamptz
  `);
  const deletedCount = extractRowCount(result);
  const durationMs = Date.now() - startedAt;

  console.log(`[AiUnattendedExposureRetention] Pruned ${deletedCount} exposure-ledger rows older than ${RETENTION_HOURS}h in ${durationMs}ms`);
  recordRetentionRun('ai_unattended_exposure_retention', { rowsDeleted: deletedCount });
  return { deletedCount, durationMs };
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker | null = null;

export function getAiUnattendedExposureRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export function createAiUnattendedExposureRetentionWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => runWithSystemDbAccess(() => pruneAiUnattendedExposure()),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeAiUnattendedExposureRetention(): Promise<void> {
  retentionWorker = createAiUnattendedExposureRetentionWorker();
  // attachWorkerObservability already routes 'error'/'failed' to Sentry
  // (#1379) — no separate console-only handlers needed (mlOutputRetention.ts's
  // convention).
  attachWorkerObservability(retentionWorker, 'aiUnattendedExposureRetention');

  const queue = getAiUnattendedExposureRetentionQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    JOB_NAME,
    {},
    {
      jobId: REPEAT_JOB_ID,
      // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ
      // anchors `every` to the Unix epoch, so every 24h job fires at
      // 00:00:00.000 UTC together (see jobs/scheduleRegistry.ts).
      repeat: { pattern: jobSchedule('ai-unattended-exposure-retention') },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    },
  );

  console.log('[AiUnattendedExposureRetention] Retention worker initialized');
}

export async function shutdownAiUnattendedExposureRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}
