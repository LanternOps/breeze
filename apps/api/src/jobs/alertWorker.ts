/**
 * Alert Evaluation Worker
 *
 * BullMQ worker that evaluates device metrics against alert rules.
 * Runs on a schedule and processes devices in batches.
 */

import { Queue, Worker, Job } from 'bullmq';
import { db } from '../db';
import { devices, deviceMetrics, organizations } from '../db/schema';
import { eq, and, gte, desc, inArray } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { evaluateDeviceAlerts, checkAllAutoResolve } from '../services/alertService';

// Queue name
const ALERT_QUEUE = 'alert-evaluation';

// Singleton queue instance
let alertQueue: Queue | null = null;

/**
 * Get or create the alert evaluation queue
 */
export function getAlertQueue(): Queue {
  if (!alertQueue) {
    alertQueue = new Queue(ALERT_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return alertQueue;
}

// Job data types
interface EvaluateAllJobData {
  type: 'evaluate-all';
  batchSize?: number;
}

interface EvaluateDeviceJobData {
  type: 'evaluate-device';
  deviceId: string;
  orgId: string;
}

interface AutoResolveJobData {
  type: 'auto-resolve';
  orgId?: string;
}

type AlertJobData = EvaluateAllJobData | EvaluateDeviceJobData | AutoResolveJobData;

/**
 * Create the alert evaluation worker
 */
export function createAlertWorker(): Worker<AlertJobData> {
  return new Worker<AlertJobData>(
    ALERT_QUEUE,
    async (job: Job<AlertJobData>) => {
      const startTime = Date.now();

      switch (job.data.type) {
        case 'evaluate-all':
          return await processEvaluateAll(job.data);

        case 'evaluate-device':
          return await processEvaluateDevice(job.data);

        case 'auto-resolve':
          return await processAutoResolve(job.data);

        default:
          throw new Error(`Unknown job type: ${(job.data as { type: string }).type}`);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 10 // Process up to 10 device evaluations in parallel
    }
  );
}

/**
 * Process evaluate-all job
 * Fetches devices with recent metrics and queues individual device evaluations
 */
async function processEvaluateAll(data: EvaluateAllJobData): Promise<{
  queued: number;
  skipped: number;
  durationMs: number;
}> {
  const startTime = Date.now();
  const batchSize = data.batchSize || 100;

  // Get all active organizations
  const orgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.status, 'active'));

  if (orgs.length === 0) {
    return { queued: 0, skipped: 0, durationMs: Date.now() - startTime };
  }

  const orgIds = orgs.map(o => o.id);

  // Get devices with recent metrics (within last 5 minutes)
  const recentThreshold = new Date(Date.now() - 5 * 60 * 1000);

  // Get devices that are online and have recent activity
  const activeDevices = await db
    .select({
      id: devices.id,
      orgId: devices.orgId
    })
    .from(devices)
    .where(
      and(
        inArray(devices.orgId, orgIds),
        eq(devices.status, 'online'),
        gte(devices.lastSeenAt, recentThreshold)
      )
    )
    .limit(batchSize);

  if (activeDevices.length === 0) {
    console.log('[AlertWorker] No active devices with recent metrics');
    return { queued: 0, skipped: 0, durationMs: Date.now() - startTime };
  }

  // Queue individual device evaluation jobs
  const queue = getAlertQueue();
  const jobs = activeDevices.map(device => ({
    name: 'evaluate-device',
    data: {
      type: 'evaluate-device' as const,
      deviceId: device.id,
      orgId: device.orgId
    }
  }));

  await queue.addBulk(jobs);

  console.log(`[AlertWorker] Queued ${jobs.length} device evaluations`);

  return {
    queued: jobs.length,
    skipped: 0,
    durationMs: Date.now() - startTime
  };
}

/**
 * Process evaluate-device job
 * Evaluates all applicable rules for a single device
 */
async function processEvaluateDevice(data: EvaluateDeviceJobData): Promise<{
  deviceId: string;
  alertsCreated: number;
  durationMs: number;
}> {
  const startTime = Date.now();

  try {
    const alertIds = await evaluateDeviceAlerts(data.deviceId);

    if (alertIds.length > 0) {
      console.log(`[AlertWorker] Created ${alertIds.length} alerts for device ${data.deviceId}`);
    }

    return {
      deviceId: data.deviceId,
      alertsCreated: alertIds.length,
      durationMs: Date.now() - startTime
    };
  } catch (error) {
    console.error(`[AlertWorker] Error evaluating device ${data.deviceId}:`, error);
    throw error;
  }
}

/**
 * Process auto-resolve job
 * Checks all active alerts for auto-resolution
 */
async function processAutoResolve(data: AutoResolveJobData): Promise<{
  resolved: number;
  durationMs: number;
}> {
  const startTime = Date.now();

  try {
    const resolvedCount = await checkAllAutoResolve(data.orgId);

    if (resolvedCount > 0) {
      console.log(`[AlertWorker] Auto-resolved ${resolvedCount} alerts`);
    }

    return {
      resolved: resolvedCount,
      durationMs: Date.now() - startTime
    };
  } catch (error) {
    console.error('[AlertWorker] Error in auto-resolve:', error);
    throw error;
  }
}

/**
 * Schedule repeatable jobs for alert evaluation
 */
async function scheduleAlertJobs(): Promise<void> {
  const queue = getAlertQueue();

  // Remove any existing repeatable jobs first
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Schedule evaluate-all every 60 seconds
  await queue.add(
    'evaluate-all',
    { type: 'evaluate-all' },
    {
      repeat: {
        every: 60 * 1000 // Every 60 seconds
      },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 }
    }
  );

  // Schedule auto-resolve check every 2 minutes
  await queue.add(
    'auto-resolve',
    { type: 'auto-resolve' },
    {
      repeat: {
        every: 2 * 60 * 1000 // Every 2 minutes
      },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 }
    }
  );

  console.log('[AlertWorker] Scheduled repeatable alert evaluation jobs');
}

/**
 * Manually trigger evaluation for a specific device
 * Useful for testing or immediate evaluation after rule changes
 */
export async function triggerDeviceEvaluation(deviceId: string, orgId: string): Promise<string> {
  const queue = getAlertQueue();

  const job = await queue.add(
    'evaluate-device',
    {
      type: 'evaluate-device',
      deviceId,
      orgId
    },
    {
      removeOnComplete: true,
      removeOnFail: false
    }
  );

  return job.id!;
}

/**
 * Manually trigger evaluation for all devices
 * Useful for testing or after bulk rule changes
 */
export async function triggerFullEvaluation(): Promise<string> {
  const queue = getAlertQueue();

  const job = await queue.add(
    'evaluate-all',
    { type: 'evaluate-all' },
    {
      removeOnComplete: true,
      removeOnFail: false
    }
  );

  return job.id!;
}

/**
 * Get queue status for monitoring
 */
export async function getAlertQueueStatus(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getAlertQueue();

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount()
  ]);

  return { waiting, active, completed, failed, delayed };
}

// Worker instance (kept for cleanup)
let alertWorker: Worker<AlertJobData> | null = null;

/**
 * Initialize alert workers and schedule jobs
 * Call this during app startup
 */
export async function initializeAlertWorkers(): Promise<void> {
  try {
    // Create worker
    alertWorker = createAlertWorker();

    // Set up error handler
    alertWorker.on('error', (error) => {
      console.error('[AlertWorker] Worker error:', error);
    });

    alertWorker.on('failed', (job, error) => {
      console.error(`[AlertWorker] Job ${job?.id} failed:`, error);
    });

    alertWorker.on('completed', (job, result) => {
      // Only log significant completions
      if (job.data.type === 'evaluate-all' && result && typeof result === 'object' && 'queued' in result) {
        const r = result as { queued: number };
        if (r.queued > 0) {
          console.log(`[AlertWorker] Evaluate-all completed: ${r.queued} devices queued`);
        }
      }
    });

    // Schedule repeatable jobs
    await scheduleAlertJobs();

    console.log('[AlertWorker] Alert workers initialized');
  } catch (error) {
    console.error('[AlertWorker] Failed to initialize:', error);
    throw error;
  }
}

/**
 * Shutdown alert workers gracefully
 */
export async function shutdownAlertWorkers(): Promise<void> {
  if (alertWorker) {
    await alertWorker.close();
    alertWorker = null;
  }

  if (alertQueue) {
    await alertQueue.close();
    alertQueue = null;
  }

  console.log('[AlertWorker] Alert workers shut down');
}
