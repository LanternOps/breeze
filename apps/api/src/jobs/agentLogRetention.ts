/**
 * Agent Log Retention Worker
 *
 * BullMQ worker that prunes old agent diagnostic logs.
 * Default retention: 7 days (configurable via AGENT_LOG_RETENTION_DAYS env var).
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { extractRowCount } from '../db/rowCount';
import { agentLogs } from '../db/schema';
import { lt } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    console.error('[AgentLogRetention] withSystemDbAccessContext is not available — running without access context');
  }
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const QUEUE_NAME = 'agent-log-retention';
const DEFAULT_RETENTION_DAYS = parseInt(process.env.AGENT_LOG_RETENTION_DAYS || '7', 10);

let retentionQueue: Queue | null = null;

export function getAgentLogRetentionQueue(): Queue {
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

export function createAgentLogRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const startTime = Date.now();
        const retentionDays = Math.max(1, job.data.retentionDays ?? DEFAULT_RETENTION_DAYS);
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const result = await db
          .delete(agentLogs)
          .where(lt(agentLogs.timestamp, cutoff));

        const deletedCount = extractRowCount(result);

        const durationMs = Date.now() - startTime;
        console.log(`[AgentLogRetention] Pruned ${deletedCount} agent logs older than ${retentionDays} days in ${durationMs}ms`);

        return { durationMs, deletedCount };
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeAgentLogRetention(): Promise<void> {
  try {
    retentionWorker = createAgentLogRetentionWorker();
    attachWorkerObservability(retentionWorker, 'agentLogRetention');

    retentionWorker.on('error', (error) => {
      console.error('[AgentLogRetention] Worker error:', error);
    });

    const queue = getAgentLogRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Daily at a registry-allocated slot (jobs/scheduleRegistry.ts).
    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS },
      {
        // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
        // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
        // together (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('agent-log-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[AgentLogRetention] Retention worker initialized');
  } catch (error) {
    console.error('[AgentLogRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAgentLogRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}
