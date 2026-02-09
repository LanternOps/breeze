/**
 * Network Monitor Worker
 *
 * BullMQ worker that dispatches network check commands to agents
 * and processes results when they come back via WebSocket.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { networkMonitors, networkMonitorResults, devices } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import { buildMonitorCommand } from '../routes/monitors';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const MONITOR_QUEUE = 'monitors';

let monitorQueue: Queue | null = null;

export function getMonitorQueue(): Queue {
  if (!monitorQueue) {
    monitorQueue = new Queue(MONITOR_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return monitorQueue;
}

// Job data types

interface CheckMonitorJobData {
  type: 'check-monitor';
  monitorId: string;
  orgId: string;
}

export interface MonitorCheckResult {
  monitorId: string;
  status: 'online' | 'offline' | 'degraded';
  responseMs: number;
  statusCode?: number;
  error?: string;
  details?: Record<string, unknown>;
}

interface ProcessCheckResultJobData {
  type: 'process-check-result';
  monitorId: string;
  result: MonitorCheckResult;
}

interface MonitorSchedulerJobData {
  type: 'monitor-scheduler';
}

type MonitorJobData = CheckMonitorJobData | ProcessCheckResultJobData | MonitorSchedulerJobData;

function createMonitorWorker(): Worker<MonitorJobData> {
  return new Worker<MonitorJobData>(
    MONITOR_QUEUE,
    async (job: Job<MonitorJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'monitor-scheduler':
            return await processScheduler();
          case 'check-monitor':
            return await processCheckMonitor(job.data);
          case 'process-check-result':
            return await processCheckResult(job.data);
          default:
            throw new Error(`Unknown job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 10
    }
  );
}

async function processCheckMonitor(data: CheckMonitorJobData): Promise<{
  dispatched: boolean;
  agentId: string | null;
}> {
  const [monitor] = await db
    .select()
    .from(networkMonitors)
    .where(eq(networkMonitors.id, data.monitorId))
    .limit(1);

  if (!monitor) {
    console.error(`[MonitorWorker] Monitor ${data.monitorId} not found`);
    return { dispatched: false, agentId: null };
  }

  if (!monitor.isActive) {
    console.log(`[MonitorWorker] Monitor ${data.monitorId} is inactive, skipping check`);
    return { dispatched: false, agentId: null };
  }

  // Find an online agent for this org
  const [onlineAgent] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(and(eq(devices.orgId, data.orgId), eq(devices.status, 'online')))
    .limit(1);

  const agentId = onlineAgent?.agentId ?? null;

  if (!agentId || !isAgentConnected(agentId)) {
    console.warn(`[MonitorWorker] No online agent for org ${data.orgId}`);
    return { dispatched: false, agentId: null };
  }

  const command = buildMonitorCommand(monitor);
  const sent = sendCommandToAgent(agentId, command);

  if (!sent) {
    console.error(`[MonitorWorker] Failed to send check command to agent ${agentId}`);
    return { dispatched: false, agentId };
  }

  console.log(`[MonitorWorker] Check dispatched to agent ${agentId} for monitor ${data.monitorId}`);
  return { dispatched: true, agentId };
}

async function processCheckResult(data: ProcessCheckResultJobData): Promise<{
  resultWritten: boolean;
}> {
  const now = new Date();
  const result = data.result;

  // Use a transaction to keep results table and monitor state in sync
  await db.transaction(async (tx) => {
    // Write to results table
    await tx.insert(networkMonitorResults).values({
      monitorId: data.monitorId,
      status: result.status,
      responseMs: result.responseMs ?? null,
      statusCode: result.statusCode ?? null,
      error: result.error ?? null,
      details: result.details ?? null,
      timestamp: now
    });

    // Update monitor state
    const isFailure = result.status === 'offline';
    const updateSet: Record<string, unknown> = {
      lastChecked: now,
      lastStatus: result.status,
      lastResponseMs: result.responseMs ?? null,
      lastError: result.error ?? null,
      updatedAt: now
    };

    if (isFailure) {
      updateSet.consecutiveFailures = sql`${networkMonitors.consecutiveFailures} + 1`;
    } else {
      updateSet.consecutiveFailures = 0;
    }

    await tx
      .update(networkMonitors)
      .set(updateSet)
      .where(eq(networkMonitors.id, data.monitorId));
  });

  console.log(`[MonitorWorker] Result recorded for monitor ${data.monitorId}: ${result.status}`);
  return { resultWritten: true };
}

async function processScheduler(): Promise<{ enqueued: number }> {
  const now = new Date();

  const dueMonitors = await db
    .select({
      id: networkMonitors.id,
      orgId: networkMonitors.orgId,
      pollingInterval: networkMonitors.pollingInterval,
      lastChecked: networkMonitors.lastChecked
    })
    .from(networkMonitors)
    .where(
      and(
        eq(networkMonitors.isActive, true),
        sql`(${networkMonitors.lastChecked} IS NULL OR ${networkMonitors.lastChecked} + make_interval(secs => ${networkMonitors.pollingInterval}) <= ${now.toISOString()})`
      )
    );

  if (dueMonitors.length === 0) return { enqueued: 0 };

  let enqueued = 0;
  for (const monitor of dueMonitors) {
    try {
      await enqueueMonitorCheck(monitor.id, monitor.orgId);
      enqueued++;
    } catch (err) {
      console.error(`[MonitorWorker] Failed to enqueue check for monitor ${monitor.id}:`, err);
    }
  }

  if (enqueued > 0) {
    console.log(`[MonitorWorker] Scheduler enqueued ${enqueued} monitor checks`);
  }
  return { enqueued };
}

export async function enqueueMonitorCheck(
  monitorId: string,
  orgId: string
): Promise<string> {
  const queue = getMonitorQueue();
  const job = await queue.add(
    'check-monitor',
    { type: 'check-monitor', monitorId, orgId },
    { removeOnComplete: { count: 100 }, removeOnFail: { count: 200 } }
  );
  return job.id!;
}

export async function enqueueMonitorCheckResult(
  monitorId: string,
  result: MonitorCheckResult
): Promise<string> {
  const queue = getMonitorQueue();
  const job = await queue.add(
    'process-check-result',
    { type: 'process-check-result', monitorId, result },
    { removeOnComplete: { count: 100 }, removeOnFail: { count: 200 } }
  );
  return job.id!;
}

async function scheduleMonitorPolling(): Promise<void> {
  const queue = getMonitorQueue();

  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === 'monitor-scheduler') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'monitor-scheduler',
    { type: 'monitor-scheduler' as const },
    {
      repeat: { every: 30 * 1000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 }
    }
  );

  console.log('[MonitorWorker] Scheduled repeatable monitor scheduler (every 30s)');
}

let monitorWorkerInstance: Worker<MonitorJobData> | null = null;

export async function initializeMonitorWorker(): Promise<void> {
  try {
    monitorWorkerInstance = createMonitorWorker();

    monitorWorkerInstance.on('error', (error) => {
      console.error('[MonitorWorker] Worker error:', error);
    });

    monitorWorkerInstance.on('failed', (job, error) => {
      console.error(`[MonitorWorker] Job ${job?.id} failed:`, error);
    });

    await scheduleMonitorPolling();

    console.log('[MonitorWorker] Monitor worker initialized');
  } catch (error) {
    console.error('[MonitorWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMonitorWorker(): Promise<void> {
  if (monitorWorkerInstance) {
    await monitorWorkerInstance.close();
    monitorWorkerInstance = null;
  }
  if (monitorQueue) {
    await monitorQueue.close();
    monitorQueue = null;
  }
  console.log('[MonitorWorker] Monitor worker shut down');
}
