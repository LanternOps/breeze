/**
 * User Risk Score Retention Worker
 *
 * Keeps dense snapshots for recent data while compacting older data to one
 * snapshot per user per day.
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const QUEUE_NAME = 'user-risk-retention';
const JOB_NAME = 'user-risk-retention';
const REPEAT_JOB_ID = 'user-risk-retention';
const BATCH_SIZE = parsePositiveIntEnv('USER_RISK_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv('USER_RISK_RETENTION_MAX_BATCHES', 50);

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[UserRiskRetention] Invalid ${name}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

const DEFAULT_RETENTION_DAYS = Math.max(30, parsePositiveIntEnv('USER_RISK_RETENTION_DAYS', 90));
const DEFAULT_RETENTION_INTERVAL_MS = parsePositiveIntEnv('USER_RISK_RETENTION_INTERVAL_MS', 24 * 60 * 60 * 1000);

type RetentionJobData = {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
};

let retentionQueue: Queue<RetentionJobData> | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function extractUserRiskRetentionRowCount(result: unknown): number {
  const raw = result as { rowCount?: number; count?: number };
  if (typeof raw.rowCount === 'number') return raw.rowCount;
  if (typeof raw.count === 'number') return raw.count;
  return Array.isArray(result) ? result.length : 0;
}

export async function compactUserRiskSnapshots(options: {
  retentionDays: number;
  batchSize?: number;
  maxBatches?: number;
}) {
  const retentionDays = Math.max(30, options.retentionDays);
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, options.maxBatches ?? MAX_BATCHES);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const start = Date.now();

  let deleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < maxBatches) {
    const result = await db.execute(sql`
      WITH ranked AS (
        SELECT
          ctid,
          ROW_NUMBER() OVER (
            PARTITION BY org_id, user_id, DATE(calculated_at)
            ORDER BY calculated_at DESC
          ) AS rn
        FROM user_risk_scores
        WHERE calculated_at < ${cutoff}::timestamptz
      ),
      victims AS (
        SELECT ctid
        FROM ranked
        WHERE rn > 1
        LIMIT ${batchSize}
      )
      DELETE FROM user_risk_scores
      WHERE ctid IN (SELECT ctid FROM victims)
    `);
    lastBatchDeleted = extractUserRiskRetentionRowCount(result);
    deleted += lastBatchDeleted;
    batches += 1;
    if (lastBatchDeleted < batchSize) break;
  }

  const durationMs = Date.now() - start;
  return {
    retentionDays,
    deleted,
    batches,
    batchSize,
    maxBatches,
    hasMore: batches >= maxBatches && lastBatchDeleted >= batchSize,
    durationMs,
  };
}

export function getUserRiskRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(QUEUE_NAME, {
      connection: getBullMQConnection()
    });
  }
  return retentionQueue;
}

export function createUserRiskRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const result = await compactUserRiskSnapshots({
          retentionDays: job.data.retentionDays ?? DEFAULT_RETENTION_DAYS,
          batchSize: job.data.batchSize,
          maxBatches: job.data.maxBatches,
        });
        console.log(
          `[UserRiskRetention] Compacted user risk snapshots older than ${result.retentionDays} days (deleted=${result.deleted}, batches=${result.batches}, hasMore=${result.hasMore}) in ${result.durationMs}ms`
        );
        return result;
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

export async function initializeUserRiskRetention(): Promise<void> {
  retentionWorker = createUserRiskRetentionWorker();
  // attachWorkerObservability already routes 'error'/'failed' to Sentry
  // (#1379); the handlers below stay console-only to avoid double-reporting (S5).
  attachWorkerObservability(retentionWorker, 'userRiskRetention');
  retentionWorker.on('error', (error) => {
    console.error('[UserRiskRetention] Worker error:', error);
  });
  retentionWorker.on('failed', (job, error) => {
    console.error(`[UserRiskRetention] Job ${job?.id} failed:`, error);
  });

  const queue = getUserRiskRetentionQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    JOB_NAME,
    { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
    {
      jobId: REPEAT_JOB_ID,
      repeat: { every: DEFAULT_RETENTION_INTERVAL_MS },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 20 }
    }
  );

  console.log('[UserRiskRetention] Retention worker initialized');
}

export async function shutdownUserRiskRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  BATCH_SIZE,
  MAX_BATCHES,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RETENTION_INTERVAL_MS,
};
