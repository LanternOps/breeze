/**
 * SNMP Metrics Retention Worker
 *
 * BullMQ worker that prunes old SNMP metric entries.
 * Default retention: 7 days.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { snmpMetrics } from '../db/schema';
import { lt } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const QUEUE_NAME = 'snmp-retention';
const DEFAULT_RETENTION_DAYS = 7;

let retentionQueue: Queue | null = null;

export function getSnmpRetentionQueue(): Queue {
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

function createSnmpRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const startTime = Date.now();
        const retentionDays = job.data.retentionDays || DEFAULT_RETENTION_DAYS;
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        await db
          .delete(snmpMetrics)
          .where(lt(snmpMetrics.timestamp, cutoff));

        const durationMs = Date.now() - startTime;
        console.log(`[SnmpRetention] Pruned metrics older than ${retentionDays} days in ${durationMs}ms`);
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

export async function initializeSnmpRetention(): Promise<void> {
  try {
    retentionWorker = createSnmpRetentionWorker();

    retentionWorker.on('error', (error) => {
      console.error('[SnmpRetention] Worker error:', error);
    });

    const queue = getSnmpRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Schedule every 6 hours
    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS },
      {
        repeat: {
          every: 6 * 60 * 60 * 1000
        },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[SnmpRetention] Retention worker initialized');
  } catch (error) {
    console.error('[SnmpRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownSnmpRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}
