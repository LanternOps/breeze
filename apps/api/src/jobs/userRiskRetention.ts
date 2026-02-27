/**
 * User Risk Score Retention Worker
 *
 * Keeps dense snapshots for recent data while compacting older data to one
 * snapshot per user per day.
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { getRedisConnection } from '../services/redis';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const QUEUE_NAME = 'user-risk-retention';

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
};

let retentionQueue: Queue<RetentionJobData> | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getUserRiskRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(QUEUE_NAME, {
      connection: getRedisConnection()
    });
  }
  return retentionQueue;
}

export function createUserRiskRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const retentionDays = Math.max(30, job.data.retentionDays ?? DEFAULT_RETENTION_DAYS);
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        const start = Date.now();

        const result = await db.execute(sql`
          WITH ranked AS (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY org_id, user_id, DATE(calculated_at)
                ORDER BY calculated_at DESC
              ) AS rn
            FROM user_risk_scores
            WHERE calculated_at < ${cutoff}
          )
          DELETE FROM user_risk_scores urs
          USING ranked r
          WHERE urs.id = r.id
            AND r.rn > 1
        `);

        const durationMs = Date.now() - start;
        const raw = result as unknown as { rowCount?: number };
        const deleted = typeof raw.rowCount === 'number' ? raw.rowCount : 'unknown';
        console.log(
          `[UserRiskRetention] Compacted user risk snapshots older than ${retentionDays} days (deleted=${deleted}) in ${durationMs}ms`
        );
        return { retentionDays, deleted, durationMs };
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 1
    }
  );
}

export async function initializeUserRiskRetention(): Promise<void> {
  retentionWorker = createUserRiskRetentionWorker();
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
    'cleanup',
    { retentionDays: DEFAULT_RETENTION_DAYS },
    {
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
