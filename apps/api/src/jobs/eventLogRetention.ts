/**
 * Event Log Retention Worker
 *
 * BullMQ worker that prunes old event log entries.
 * Resolves per-org retention from event_log configuration policies.
 * Skips orgs on failure to avoid premature data deletion.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { deviceEventLogs } from '../db/schema';
import { and, eq, lt } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { getOrgEventLogRetentionDays } from '../routes/agents/helpers';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const QUEUE_NAME = 'event-log-retention';

let retentionQueue: Queue | null = null;

export function getEventLogRetentionQueue(): Queue {
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

export function createEventLogRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const startTime = Date.now();

        // Get distinct org IDs from event logs
        const orgRows = await db
          .selectDistinct({ orgId: deviceEventLogs.orgId })
          .from(deviceEventLogs);

        for (const { orgId } of orgRows) {
          let retentionDays: number;
          try {
            retentionDays = await getOrgEventLogRetentionDays(orgId);
          } catch (err) {
            console.error(`[EventLogRetention] Failed to resolve retention for org ${orgId}, SKIPPING org to avoid premature data deletion:`, err);
            continue; // Skip this org — better to retain too much than too little
          }

          const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
          try {
            await db
              .delete(deviceEventLogs)
              .where(and(
                eq(deviceEventLogs.orgId, orgId),
                lt(deviceEventLogs.timestamp, cutoff),
              ));
          } catch (err) {
            console.error(`[EventLogRetention] Failed to prune events for org ${orgId}:`, err);
          }
        }

        const durationMs = Date.now() - startTime;
        console.log(`[EventLogRetention] Processed ${orgRows.length} orgs with per-org retention in ${durationMs}ms`);

        return { durationMs, orgsProcessed: orgRows.length };
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeEventLogRetention(): Promise<void> {
  try {
    retentionWorker = createEventLogRetentionWorker();

    retentionWorker.on('error', (error) => {
      console.error('[EventLogRetention] Worker error:', error);
    });

    const queue = getEventLogRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Schedule daily cleanup at midnight
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

    console.log('[EventLogRetention] Retention worker initialized');
  } catch (error) {
    console.error('[EventLogRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownEventLogRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}
