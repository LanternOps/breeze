/**
 * Offline Detection Worker
 *
 * Detects devices that have stopped sending heartbeats and marks them offline.
 * Also triggers offline-type alert rules for those devices.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { devices, alertRules, alertTemplates, alerts } from '../db/schema';
import { eq, and, lt, inArray, or } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { publishEvent } from '../services/eventBus';
import { createAlert } from '../services/alertService';
import { interpolateTemplate } from '../services/alertConditions';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// Queue name
const OFFLINE_QUEUE = 'offline-detection';

// Singleton queue instance
let offlineQueue: Queue | null = null;

// Default offline threshold in minutes
const DEFAULT_OFFLINE_THRESHOLD_MINUTES = 5;

/**
 * Get or create the offline detection queue
 */
export function getOfflineQueue(): Queue {
  if (!offlineQueue) {
    offlineQueue = new Queue(OFFLINE_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return offlineQueue;
}

// Job data types
interface DetectOfflineJobData {
  type: 'detect-offline';
  thresholdMinutes?: number;
}

interface MarkOfflineJobData {
  type: 'mark-offline';
  deviceId: string;
  orgId: string;
  lastSeenAt: string;
}

type OfflineJobData = DetectOfflineJobData | MarkOfflineJobData;

/**
 * Create the offline detection worker
 */
export function createOfflineWorker(): Worker<OfflineJobData> {
  return new Worker<OfflineJobData>(
    OFFLINE_QUEUE,
    async (job: Job<OfflineJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'detect-offline':
            return await processDetectOffline(job.data);

          case 'mark-offline':
            return await processMarkOffline(job.data);

          default:
            throw new Error(`Unknown job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 5
    }
  );
}

/**
 * Process detect-offline job
 * Finds devices that haven't sent heartbeats within threshold
 */
async function processDetectOffline(data: DetectOfflineJobData): Promise<{
  detected: number;
  durationMs: number;
}> {
  const startTime = Date.now();
  const thresholdMinutes = data.thresholdMinutes || DEFAULT_OFFLINE_THRESHOLD_MINUTES;
  const thresholdTime = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  // Find devices that are marked online but haven't been seen recently
  const staleDevices = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      displayName: devices.displayName,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(
      and(
        eq(devices.status, 'online'),
        lt(devices.lastSeenAt, thresholdTime)
      )
    )
    .limit(100);

  if (staleDevices.length === 0) {
    return { detected: 0, durationMs: Date.now() - startTime };
  }

  // Queue individual mark-offline jobs
  const queue = getOfflineQueue();
  const jobs = staleDevices.map(device => ({
    name: 'mark-offline',
    data: {
      type: 'mark-offline' as const,
      deviceId: device.id,
      orgId: device.orgId,
      lastSeenAt: device.lastSeenAt?.toISOString() || ''
    }
  }));

  await queue.addBulk(jobs);

  console.log(`[OfflineDetector] Detected ${staleDevices.length} stale devices`);

  return {
    detected: staleDevices.length,
    durationMs: Date.now() - startTime
  };
}

/**
 * Process mark-offline job
 * Marks a device as offline and triggers alerts
 */
async function processMarkOffline(data: MarkOfflineJobData): Promise<{
  deviceId: string;
  alertCreated: boolean;
  durationMs: number;
}> {
  const startTime = Date.now();

  // Verify device is still online in DB (might have reconnected)
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, data.deviceId))
    .limit(1);

  if (!device) {
    return {
      deviceId: data.deviceId,
      alertCreated: false,
      durationMs: Date.now() - startTime
    };
  }

  // Check if device has reconnected since job was queued
  const thresholdTime = new Date(Date.now() - DEFAULT_OFFLINE_THRESHOLD_MINUTES * 60 * 1000);
  if (device.status !== 'online' || (device.lastSeenAt && device.lastSeenAt >= thresholdTime)) {
    // Device is no longer stale
    return {
      deviceId: data.deviceId,
      alertCreated: false,
      durationMs: Date.now() - startTime
    };
  }

  // Mark device as offline
  await db
    .update(devices)
    .set({ status: 'offline' })
    .where(eq(devices.id, data.deviceId));

  // Publish device.offline event
  await publishEvent(
    'device.offline',
    data.orgId,
    {
      deviceId: data.deviceId,
      hostname: device.hostname,
      displayName: device.displayName,
      lastSeenAt: data.lastSeenAt
    },
    'offline-detector'
  );

  console.log(`[OfflineDetector] Marked device ${data.deviceId} as offline`);

  // Check for offline-type alert rules and create alerts
  const alertCreated = await triggerOfflineAlerts(device);

  return {
    deviceId: data.deviceId,
    alertCreated,
    durationMs: Date.now() - startTime
  };
}

/**
 * Find and trigger offline-type alert rules for a device
 */
async function triggerOfflineAlerts(
  device: typeof devices.$inferSelect
): Promise<boolean> {
  // Find alert rules that have offline conditions
  // We need to find rules where the template conditions include type: 'offline'

  // Get all active rules for this device's org
  const rules = await db
    .select()
    .from(alertRules)
    .where(
      and(
        eq(alertRules.orgId, device.orgId),
        eq(alertRules.isActive, true),
        or(
          eq(alertRules.targetType, 'all'),
          and(eq(alertRules.targetType, 'org'), eq(alertRules.targetId, device.orgId)),
          and(eq(alertRules.targetType, 'site'), eq(alertRules.targetId, device.siteId)),
          and(eq(alertRules.targetType, 'device'), eq(alertRules.targetId, device.id))
        )
      )
    );

  if (rules.length === 0) {
    return false;
  }

  // Get templates for all rules
  const templateIds = [...new Set(rules.map(r => r.templateId))];
  const templates = await db
    .select()
    .from(alertTemplates)
    .where(inArray(alertTemplates.id, templateIds));

  const templateMap = new Map(templates.map(t => [t.id, t]));

  let alertCreated = false;

  for (const rule of rules) {
    const template = templateMap.get(rule.templateId);
    if (!template) continue;

    // Check if conditions include offline type
    const overrides = rule.overrideSettings as Record<string, unknown> | null;
    const conditions = (overrides?.conditions ?? template.conditions) as unknown;

    if (!hasOfflineCondition(conditions)) {
      continue;
    }

    // Build template context
    const context: Record<string, unknown> = {
      deviceName: device.displayName || device.hostname,
      hostname: device.hostname,
      osType: device.osType,
      osVersion: device.osVersion,
      ruleName: rule.name,
      severity: (overrides?.severity as string) ?? template.severity,
      lastSeenAt: device.lastSeenAt?.toISOString()
    };

    // Interpolate title and message
    const title = interpolateTemplate(template.titleTemplate, context);
    const message = interpolateTemplate(template.messageTemplate, context);
    const severity = (overrides?.severity as 'critical' | 'high' | 'medium' | 'low' | 'info') ?? template.severity;

    // Create alert
    const alertId = await createAlert({
      ruleId: rule.id,
      deviceId: device.id,
      orgId: device.orgId,
      severity,
      title,
      message,
      context: {
        ...context,
        conditionsMet: ['Device offline'],
        templateId: template.id
      }
    });

    if (alertId) {
      alertCreated = true;
      console.log(`[OfflineDetector] Created offline alert ${alertId} for device ${device.id}`);
    }
  }

  return alertCreated;
}

/**
 * Check if conditions include an offline type condition
 */
function hasOfflineCondition(conditions: unknown): boolean {
  if (!conditions) return false;

  if (Array.isArray(conditions)) {
    return conditions.some(c => hasOfflineCondition(c));
  }

  if (typeof conditions === 'object') {
    const c = conditions as Record<string, unknown>;

    // Check if this is an offline condition
    if (c.type === 'offline') {
      return true;
    }

    // Check nested conditions in a group
    if ('conditions' in c && Array.isArray(c.conditions)) {
      return c.conditions.some((sub: unknown) => hasOfflineCondition(sub));
    }
  }

  return false;
}

/**
 * Schedule repeatable offline detection jobs
 */
async function scheduleOfflineJobs(): Promise<void> {
  const queue = getOfflineQueue();

  // Remove any existing repeatable jobs first
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Schedule detect-offline every 30 seconds
  await queue.add(
    'detect-offline',
    { type: 'detect-offline' },
    {
      repeat: {
        every: 30 * 1000 // Every 30 seconds
      },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 }
    }
  );

  console.log('[OfflineDetector] Scheduled repeatable offline detection jobs');
}

/**
 * Manually trigger offline detection
 * Useful for testing
 */
export async function triggerOfflineDetection(thresholdMinutes?: number): Promise<string> {
  const queue = getOfflineQueue();

  const job = await queue.add(
    'detect-offline',
    {
      type: 'detect-offline',
      thresholdMinutes
    },
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
export async function getOfflineQueueStatus(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}> {
  const queue = getOfflineQueue();

  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount()
  ]);

  return { waiting, active, completed, failed };
}

// Worker instance (kept for cleanup)
let offlineWorker: Worker<OfflineJobData> | null = null;

/**
 * Initialize offline detector and schedule jobs
 * Call this during app startup
 */
export async function initializeOfflineDetector(): Promise<void> {
  try {
    // Create worker
    offlineWorker = createOfflineWorker();

    // Set up error handler
    offlineWorker.on('error', (error) => {
      console.error('[OfflineDetector] Worker error:', error);
    });

    offlineWorker.on('failed', (job, error) => {
      console.error(`[OfflineDetector] Job ${job?.id} failed:`, error);
    });

    offlineWorker.on('completed', (job, result) => {
      if (job.data.type === 'detect-offline' && result && typeof result === 'object' && 'detected' in result) {
        const r = result as { detected: number };
        if (r.detected > 0) {
          console.log(`[OfflineDetector] Detection completed: ${r.detected} devices marked offline`);
        }
      }
    });

    // Schedule repeatable jobs
    await scheduleOfflineJobs();

    console.log('[OfflineDetector] Offline detector initialized');
  } catch (error) {
    console.error('[OfflineDetector] Failed to initialize:', error);
    throw error;
  }
}

/**
 * Shutdown offline detector gracefully
 */
export async function shutdownOfflineDetector(): Promise<void> {
  if (offlineWorker) {
    await offlineWorker.close();
    offlineWorker = null;
  }

  if (offlineQueue) {
    await offlineQueue.close();
    offlineQueue = null;
  }

  console.log('[OfflineDetector] Offline detector shut down');
}
