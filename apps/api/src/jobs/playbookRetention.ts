/**
 * Playbook Execution Retention Worker
 *
 * BullMQ worker that:
 * 1. Prunes old playbook executions in terminal states (completed, failed, rolled_back, cancelled)
 * 2. Marks stale running/waiting executions as cancelled (no update for 2+ hours)
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { playbookExecutions } from '../db/schema';
import { and, eq, lt, inArray } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const QUEUE_NAME = 'playbook-execution-retention';
const DEFAULT_RETENTION_DAYS = 90;
const STALE_EXECUTION_HOURS = 2;

let retentionQueue: Queue | null = null;

export function getPlaybookRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, {
      connection: getRedisConnection()
    });
  }
  return retentionQueue;
}

interface RetentionJobData {
  retentionDays?: number;
}

const TERMINAL_STATUSES = ['completed', 'failed', 'rolled_back', 'cancelled'] as const;
const STALE_STATUSES = ['running', 'waiting', 'pending'] as const;

export function createPlaybookRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const startTime = Date.now();
        const retentionDays = job.data.retentionDays ?? DEFAULT_RETENTION_DAYS;

        // 1. Prune terminal executions older than retention period
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        try {
          await db
            .delete(playbookExecutions)
            .where(and(
              inArray(playbookExecutions.status, [...TERMINAL_STATUSES]),
              lt(playbookExecutions.createdAt, cutoff),
            ));
        } catch (err) {
          console.error('[PlaybookRetention] Failed to prune old executions:', err);
        }

        // 2. Mark stale non-terminal executions as cancelled
        const staleCutoff = new Date(Date.now() - STALE_EXECUTION_HOURS * 60 * 60 * 1000);
        try {
          await db
            .update(playbookExecutions)
            .set({
              status: 'cancelled',
              errorMessage: `Automatically cancelled: no update for ${STALE_EXECUTION_HOURS}+ hours`,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(
              inArray(playbookExecutions.status, [...STALE_STATUSES]),
              lt(playbookExecutions.updatedAt, staleCutoff),
            ));
        } catch (err) {
          console.error('[PlaybookRetention] Failed to cancel stale executions:', err);
        }

        const durationMs = Date.now() - startTime;
        console.log(`[PlaybookRetention] Completed in ${durationMs}ms`);

        return { durationMs };
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializePlaybookRetention(): Promise<void> {
  try {
    retentionWorker = createPlaybookRetentionWorker();

    retentionWorker.on('error', (error) => {
      console.error('[PlaybookRetention] Worker error:', error);
    });

    const queue = getPlaybookRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Schedule daily cleanup
    await queue.add(
      'cleanup',
      {},
      {
        repeat: {
          every: 24 * 60 * 60 * 1000 // Every 24 hours
        },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[PlaybookRetention] Retention worker initialized');
  } catch (error) {
    console.error('[PlaybookRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownPlaybookRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}
