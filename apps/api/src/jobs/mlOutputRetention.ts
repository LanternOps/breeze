/**
 * ML Output Retention Worker
 *
 * Prunes model output rows while preserving long-lived feedback labels.
 * Default retention: 365 days (configurable via ML_OUTPUT_RETENTION_DAYS).
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;

const QUEUE_NAME = 'ml-output-retention';
const JOB_NAME = 'ml-output-retention';
const REPEAT_JOB_ID = 'ml-output-retention';
const DEFAULT_RETENTION_DAYS = Math.max(30, parsePositiveIntEnv('ML_OUTPUT_RETENTION_DAYS', 365));
const BATCH_SIZE = parsePositiveIntEnv('ML_OUTPUT_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv('ML_OUTPUT_RETENTION_MAX_BATCHES', 50);
const RETENTION_INTERVAL_MS = parsePositiveIntEnv('ML_OUTPUT_RETENTION_INTERVAL_MS', 24 * 60 * 60 * 1000);

type RetentionJobData = {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
};

type PrunedTable = {
  table: 'remediation_suggestions' | 'metric_anomalies';
  deleted: number;
  batches: number;
  hasMore: boolean;
};

let retentionQueue: Queue<RetentionJobData> | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[MlOutputRetention] Invalid ${name}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[MlOutputRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

export function extractMlOutputRetentionRowCount(result: unknown): number {
  const raw = result as { rowCount?: number; count?: number };
  if (typeof raw.rowCount === 'number') return raw.rowCount;
  if (typeof raw.count === 'number') return raw.count;
  return Array.isArray(result) ? result.length : 0;
}

async function pruneRemediationSuggestions(cutoff: string, batchSize: number, maxBatches: number): Promise<PrunedTable> {
  let deleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < maxBatches) {
    const result = await db.execute(sql`
      DELETE FROM remediation_suggestions
      WHERE ctid IN (
        SELECT ctid
        FROM remediation_suggestions
        WHERE created_at < ${cutoff}::timestamptz
        LIMIT ${batchSize}
      )
    `);
    lastBatchDeleted = extractMlOutputRetentionRowCount(result);
    deleted += lastBatchDeleted;
    batches += 1;
    if (lastBatchDeleted < batchSize) break;
  }

  return {
    table: 'remediation_suggestions',
    deleted,
    batches,
    hasMore: batches >= maxBatches && lastBatchDeleted >= batchSize,
  };
}

async function pruneMetricAnomalies(cutoff: string, batchSize: number, maxBatches: number): Promise<PrunedTable> {
  let deleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < maxBatches) {
    const result = await db.execute(sql`
      DELETE FROM metric_anomalies
      WHERE ctid IN (
        SELECT ctid
        FROM metric_anomalies
        WHERE detected_at < ${cutoff}::timestamptz
        LIMIT ${batchSize}
      )
    `);
    lastBatchDeleted = extractMlOutputRetentionRowCount(result);
    deleted += lastBatchDeleted;
    batches += 1;
    if (lastBatchDeleted < batchSize) break;
  }

  return {
    table: 'metric_anomalies',
    deleted,
    batches,
    hasMore: batches >= maxBatches && lastBatchDeleted >= batchSize,
  };
}

export async function pruneMlOutputs(options: {
  retentionDays: number;
  batchSize?: number;
  maxBatches?: number;
}) {
  const retentionDays = Math.max(30, options.retentionDays);
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, options.maxBatches ?? MAX_BATCHES);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const startedAt = Date.now();

  const tables = [
    await pruneRemediationSuggestions(cutoff, batchSize, maxBatches),
    await pruneMetricAnomalies(cutoff, batchSize, maxBatches),
  ];
  const durationMs = Date.now() - startedAt;

  return {
    retentionDays,
    cutoff,
    batchSize,
    maxBatches,
    tables,
    deleted: tables.reduce((sum, table) => sum + table.deleted, 0),
    hasMore: tables.some((table) => table.hasMore),
    durationMs,
  };
}

export function getMlOutputRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return retentionQueue;
}

export function createMlOutputRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const result = await pruneMlOutputs({
          retentionDays: job.data.retentionDays ?? DEFAULT_RETENTION_DAYS,
          batchSize: job.data.batchSize,
          maxBatches: job.data.maxBatches,
        });
        const detail = result.tables
          .map((table) => `${table.table}=${table.deleted}/${table.batches}${table.hasMore ? '+' : ''}`)
          .join(' ');
        console.log(
          `[MlOutputRetention] Pruned ${result.deleted} ML output rows older than ${result.retentionDays} days (${detail}) in ${result.durationMs}ms`,
        );
        return result;
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

export async function initializeMlOutputRetention(): Promise<void> {
  retentionWorker = createMlOutputRetentionWorker();
  // attachWorkerObservability already routes 'error'/'failed' to Sentry
  // (#1379); the handlers below stay console-only to avoid double-reporting (S5).
  attachWorkerObservability(retentionWorker, 'mlOutputRetention');
  retentionWorker.on('error', (error) => {
    console.error('[MlOutputRetention] Worker error:', error);
  });
  retentionWorker.on('failed', (job, error) => {
    console.error(`[MlOutputRetention] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, error);
  });

  const queue = getMlOutputRetentionQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    JOB_NAME,
    { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
    {
      jobId: REPEAT_JOB_ID,
      repeat: { every: RETENTION_INTERVAL_MS },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 20 },
    },
  );

  console.log('[MlOutputRetention] Retention worker initialized');
}

export async function shutdownMlOutputRetention(): Promise<void> {
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
  DEFAULT_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
  RETENTION_INTERVAL_MS,
};
