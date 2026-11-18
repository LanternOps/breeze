/**
 * Wisp W05b Task 10 — daily concern retention (w00 "Triage engine (W05)" and
 * Memory block: "concern_outcome 180 days (reaper in W05)").
 *
 * Three passes, each isolated (one throwing is logged and the others run):
 *   1–2. `reapConcerns` (services/wisp/concernReaper.ts): delete closed
 *        concerns past 90 days; resolve live concerns whose subject is gone
 *        with `subject_gone`.
 *   3.   Delete `ai_memory_blocks` of type `concern_outcome` older than 180
 *        days, in bounded batches, each in its own system transaction. This
 *        is a retention delete, not an agent-side write, so it does not go
 *        through the memory broker (allowlisted in
 *        services/wisp/memoryBroker.singleCaller.contract.test.ts).
 *
 * Dark by default: the sweep returns zeros without touching the database while
 * `wispEnabled()` is false, checked on every run so the flag can flip without
 * a restart.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { wispEnabled } from '../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { reapConcerns } from '../services/wisp/concernReaper';
import { warnOnRetentionBacklog } from './retentionBatch';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[WispConcernRetention]';
const QUEUE_NAME = 'wisp-concern-retention';
const JOB_NAME = 'cleanup';
const DAY_MS = 24 * 60 * 60 * 1000;

export const WISP_CONCERN_RESOLVED_RETENTION_DAYS = 90;
export const WISP_CONCERN_OUTCOME_MEMORY_RETENTION_DAYS = 180;
const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

export type WispConcernRetentionResult = { concernsDeleted: number; subjectGone: number; memoryBlocksDeleted: number };

type RetentionJobData = Record<string, never>;

let retentionQueue: Queue<RetentionJobData> | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

function reportFailure(op: string, err: unknown): void {
  console.error(`${LOG_PREFIX} ${op} failed:`, err);
  captureException(err, undefined, { op: `wisp.concernRetention.${op}` });
}

/** Pass 3 — `concern_outcome` memory blocks past 180 days. One transaction per batch. */
async function pruneConcernOutcomeMemory(now: Date): Promise<number> {
  // postgres-js does not coerce a JS Date in template params; pass an ISO string.
  const cutoff = new Date(now.getTime() - WISP_CONCERN_OUTCOME_MEMORY_RETENTION_DAYS * DAY_MS).toISOString();
  let deleted = 0;
  let batches = 0;
  let last = 0;
  while (batches < MAX_BATCHES) {
    // The block type stays a literal so the scan matches W03's partial index
    // `ai_memory_blocks_concern_outcome_created_idx (created_at) WHERE block_type = 'concern_outcome'`.
    const result = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM ai_memory_blocks
      WHERE id IN (
        SELECT id FROM ai_memory_blocks
        WHERE block_type = 'concern_outcome' AND created_at < ${cutoff}::timestamptz
        LIMIT ${BATCH_SIZE}
      )
    `), 'wisp.concernRetention.memory'));
    last = extractRowCount(result);
    deleted += last;
    batches += 1;
    if (last < BATCH_SIZE) break;
  }
  warnOnRetentionBacklog(LOG_PREFIX, 'ai_memory_blocks', {
    deleted,
    batches,
    hasMore: batches >= MAX_BATCHES && last >= BATCH_SIZE,
  });
  return deleted;
}

export async function runWispConcernRetention(now: Date = new Date()): Promise<WispConcernRetentionResult> {
  const result: WispConcernRetentionResult = { concernsDeleted: 0, subjectGone: 0, memoryBlocksDeleted: 0 };
  if (!wispEnabled()) return result;

  try {
    const reaped = await reapConcerns(now, { resolvedRetentionDays: WISP_CONCERN_RESOLVED_RETENTION_DAYS, limit: BATCH_SIZE });
    result.concernsDeleted = reaped.deleted;
    result.subjectGone = reaped.subjectGone;
  } catch (err) {
    reportFailure('reap', err);
  }
  try {
    result.memoryBlocksDeleted = await pruneConcernOutcomeMemory(now);
  } catch (err) {
    reportFailure('memory', err);
  }

  if (result.concernsDeleted || result.subjectGone || result.memoryBlocksDeleted) {
    console.log(
      `${LOG_PREFIX} concernsDeleted=${result.concernsDeleted} subjectGone=${result.subjectGone} `
      + `memoryBlocksDeleted=${result.memoryBlocksDeleted}`,
    );
  }
  return result;
}

export function getWispConcernRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function initializeWispConcernRetention(): Promise<void> {
  try {
    retentionWorker = new Worker<RetentionJobData>(
      QUEUE_NAME,
      async (_job: Job<RetentionJobData>) => runWispConcernRetention(),
      { connection: getBullMQConnection(), concurrency: 1 },
    );
    attachWorkerObservability(retentionWorker, 'wispConcernRetention');
    retentionWorker.on('error', (error) => console.error(`${LOG_PREFIX} Worker error:`, error));

    const queue = getWispConcernRetentionQueue();
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      await queue.removeRepeatableByKey(job.key);
    }
    await queue.add(JOB_NAME, {}, {
      // Daily at a registry-allocated slot (jobs/scheduleRegistry.ts), not `every: 24h`.
      repeat: { pattern: jobSchedule('wisp-concern-retention') },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    });
    console.log(`${LOG_PREFIX} Retention worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownWispConcernRetention(): Promise<void> {
  if (retentionWorker) { await retentionWorker.close(); retentionWorker = null; }
  if (retentionQueue) { await retentionQueue.close(); retentionQueue = null; }
}
