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
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[PlaybookRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const QUEUE_NAME = 'playbook-execution-retention';
const DEFAULT_RETENTION_DAYS = 90;
const STALE_EXECUTION_HOURS = 2;

let retentionQueue: Queue | null = null;

export function getPlaybookRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection()
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
        let pruneError: unknown;
        try {
          await db
            .delete(playbookExecutions)
            .where(and(
              inArray(playbookExecutions.status, [...TERMINAL_STATUSES]),
              lt(playbookExecutions.createdAt, cutoff),
            ));
        } catch (err) {
          pruneError = err;
          console.error('[PlaybookRetention] Failed to prune old executions:', err);
          captureException(err);
        }

        // 2. Mark stale non-terminal executions as cancelled
        const staleCutoff = new Date(Date.now() - STALE_EXECUTION_HOURS * 60 * 60 * 1000);
        let staleError: unknown;
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
          staleError = err;
          console.error('[PlaybookRetention] Failed to cancel stale executions:', err);
          captureException(err);
        }

        // If both operations failed, throw so BullMQ retries
        if (pruneError && staleError) {
          throw new Error('[PlaybookRetention] Both prune and stale-cancel operations failed');
        }

        const durationMs = Date.now() - startTime;
        console.log(`[PlaybookRetention] Completed in ${durationMs}ms`);

        // Both operations discard their row counts, so no rows-deleted signal.
        // Reached only when at least one of the two halves succeeded (the
        // both-failed case throws above) — so `incomplete` is what distinguishes
        // a fully healthy run from the half-broken one that still returns here.
        recordRetentionRun('playbook_retention', {
          incomplete: Boolean(pruneError || staleError),
        });
        return { durationMs };
      });
    },
    {
      connection: getBullMQConnection(),
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
      captureException(error);
    });

    retentionWorker.on('failed', (job, error) => {
      console.error(`[PlaybookRetention] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    const queue = getPlaybookRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Daily at a registry-allocated slot (jobs/scheduleRegistry.ts).
    await queue.add(
      'cleanup',
      {},
      {
        // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
        // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
        // together (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('playbook-execution-retention') },
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
