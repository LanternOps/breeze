/**
 * Alert Evaluation Worker
 *
 * BullMQ worker that evaluates device metrics against alert rules.
 * Runs on a schedule and processes devices in batches.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { devices, deviceMetrics, organizations, alerts } from '../db/schema';
import { eq, ne, and, gte, gt, desc, asc, inArray, isNotNull } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import {
  evaluateDeviceAlerts,
  checkAllAutoResolve,
  evaluateDeviceAlertsFromPolicy,
  checkAutoResolveFromConfigPolicy,
} from '../services/alertService';
import { isReusableState } from '../services/bullmqUtils';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { attachWorkerObservability } from './workerObservability';
import { envInt } from '../utils/envInt';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

/** Check if a Drizzle/Postgres error is "relation does not exist" (42P01). */
function isRelationNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const cause = (error as { cause?: { code?: string } }).cause;
  // eslint-disable-next-line breeze/no-direct-sqlstate -- Existing guard explicitly reads the Drizzle driver cause.
  return cause?.code === '42P01';
}

let _configPolicyTableWarningLogged = false;

// Queue name
const ALERT_QUEUE = 'alert-evaluation';
const ON_DEMAND_ALERT_DEDUPE_WINDOW_MS = 30 * 1000;

// Singleton queue instance
let alertQueue: Queue | null = null;

/**
 * Get or create the alert evaluation queue
 */
export function getAlertQueue(): Queue {
  if (!alertQueue) {
    // Instrumented so an enqueue made from inside a held DB context trips the
    // #1105 tripwire instead of silently pinning a pooled connection. The bare
    // `new Queue` that used to be here left this queue outside the tripwire's
    // (still incrementally adopted) coverage, so the evaluate-all addBulk hold
    // — BREEZE-9, ~5s every 60s — had to be found by hand from Sentry (#3216).
    alertQueue = createInstrumentedQueue(ALERT_QUEUE);
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
      const data = job.data;

      switch (data.type) {
        case 'evaluate-all':
          // Deliberately NOT wrapped. `processEvaluateAll` self-manages its DB
          // context: it reads each fleet page inside a SHORT system context that
          // closes before that page's Redis fan-out. A blanket wrap here pinned a
          // pooled connection idle-in-transaction for the entire ~5s enqueue loop
          // on every 60s cycle (#1105 / BREEZE-9, #3216). Mirrors
          // monitorWorker's `monitor-scheduler` and securityPostureWorker's
          // `scan-orgs`, which are structurally the same fan-out job.
          return await processEvaluateAll(data);

        case 'evaluate-device':
          return await runWithSystemDbAccess(() => processEvaluateDevice(data));

        case 'auto-resolve':
          return await runWithSystemDbAccess(() => processAutoResolve(data));

        default:
          throw new Error(`Unknown job type: ${(data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 10,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

/**
 * Process evaluate-all job
 * Fetches devices with recent metrics and queues individual device evaluations.
 *
 * #1105 CONTRACT (BREEZE-9 / #3216): this function must be called with NO DB
 * context open — the worker handler intentionally does not wrap it. It opens one
 * short-lived system context per DB read and lets each close before the Redis
 * fan-out for that page runs, so no pooled connection is ever held
 * idle-in-transaction across `queue.addBulk`. Wrapping the whole call in
 * `withSystemDbAccessContext` re-creates the original bug: nested
 * `withDbAccessContext` calls short-circuit to the ambient transaction, so every
 * read below would silently rejoin the outer context and the enqueue loop would
 * again pin a connection for the full ~5s sweep.
 *
 * Pagination therefore spans transactions. That is intentional and safe: the
 * keyset cursor (`devices.id` ascending) stays stable, `recentThreshold` is
 * computed once so the eligibility window does not drift between pages, and a
 * device whose status flips mid-sweep is simply picked up on the next 60s cycle.
 */
export async function processEvaluateAll(data: EvaluateAllJobData): Promise<{
  queued: number;
  skipped: number;
  durationMs: number;
}> {
  const startTime = Date.now();

  // Caller-supplied batchSize takes precedence (back-compat). Otherwise read the
  // env override; default 5000. Setting the env to 0 means "unlimited per run".
  const cap = data.batchSize ?? envInt('ALERT_WORKER_MAX_DEVICES_PER_RUN', 5000);
  const chunkSize = Math.max(1, envInt('ALERT_WORKER_CHUNK_SIZE', 500));

  // Get all active organizations.
  //
  // Quick Support exclusion: the hidden per-partner 'quick_support' org and the
  // ephemeral devices inside it are a stranger's personal machine borrowed for a
  // single ~20-minute session. That org stays inside technicians' accessibleOrgIds
  // for RLS reasons, so it is NOT filtered out for us — every fleet sweep has to
  // exclude it explicitly. Alert evaluation is the path that pages on-call staff,
  // so ephemeral devices are excluded at both the org and the device level.
  const orgs = await runWithSystemDbAccess(async () =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(
        eq(organizations.status, 'active'),
        ne(organizations.type, 'quick_support')
      ))
  );

  if (orgs.length === 0) {
    return { queued: 0, skipped: 0, durationMs: Date.now() - startTime };
  }

  const orgIds = orgs.map(o => o.id);

  // Devices considered "active" for evaluation: online + reported metrics in the last 5 min
  const recentThreshold = new Date(Date.now() - 5 * 60 * 1000);

  // Paginate through eligible devices using id as a stable cursor. This avoids the
  // silent 100-device truncation that was the prior shape and lets the worker
  // cover the whole fleet on each run when env caps allow.
  const queue = getAlertQueue();
  let totalQueued = 0;
  let cursor: string | null = null;

  while (true) {
    const remaining = cap > 0 ? Math.max(0, cap - totalQueued) : chunkSize;
    if (cap > 0 && remaining === 0) {
      console.warn(`[AlertWorker] Hit ALERT_WORKER_MAX_DEVICES_PER_RUN=${cap}; remainder will be picked up next run`);
      break;
    }

    const limit = Math.min(chunkSize, remaining || chunkSize);

    const conditions = [
      inArray(devices.orgId, orgIds),
      eq(devices.isEphemeral, false),
      eq(devices.status, 'online'),
      gte(devices.lastSeenAt, recentThreshold)
    ];
    if (cursor) conditions.push(gt(devices.id, cursor));

    // Page read inside its own system context, which CLOSES before the addBulk
    // below (#1105).
    const chunk = await runWithSystemDbAccess(async () =>
      db
        .select({ id: devices.id, orgId: devices.orgId })
        .from(devices)
        .where(and(...conditions))
        .orderBy(asc(devices.id))
        .limit(limit)
    );

    if (chunk.length === 0) break;

    const jobs = chunk.map(device => ({
      name: 'evaluate-device',
      data: {
        type: 'evaluate-device' as const,
        deviceId: device.id,
        orgId: device.orgId
      }
    }));

    await queue.addBulk(jobs);
    totalQueued += jobs.length;
    cursor = chunk[chunk.length - 1]!.id;

    if (chunk.length < limit) break; // last partial chunk
  }

  if (totalQueued === 0) {
    console.log('[AlertWorker] No active devices with recent metrics');
  } else {
    console.log(`[AlertWorker] Queued ${totalQueued} device evaluations`);
  }

  return {
    queued: totalQueued,
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
    const legacyAlertIds = await evaluateDeviceAlerts(data.deviceId);

    let configPolicyAlertIds: string[] = [];
    try {
      configPolicyAlertIds = await evaluateDeviceAlertsFromPolicy(data.deviceId);
    } catch (cpError: unknown) {
      if (isRelationNotFoundError(cpError)) {
        if (!_configPolicyTableWarningLogged) {
          _configPolicyTableWarningLogged = true;
          console.warn('[AlertWorker] Config policy tables not found — run "pnpm db:migrate" to create them. Skipping config policy alert evaluation.');
        }
      } else {
        throw cpError;
      }
    }

    const alertIds = [...legacyAlertIds, ...configPolicyAlertIds];

    if (alertIds.length > 0) {
      console.log(`[AlertWorker] Created ${alertIds.length} alerts for device ${data.deviceId} (legacy=${legacyAlertIds.length}, configPolicy=${configPolicyAlertIds.length})`);
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
    // Legacy auto-resolve: checks per-alert against standalone alert rules
    const legacyResolvedCount = await checkAllAutoResolve(data.orgId);

    // Config policy auto-resolve: checks per-device against config policy alert rules
    let configPolicyResolvedCount = 0;
    try {
      const orgConditions = [
        eq(alerts.status, 'active'),
        isNotNull(alerts.configPolicyId)
      ];
      if (data.orgId) {
        orgConditions.push(eq(alerts.orgId, data.orgId));
      }

      const configPolicyAlerts = await db
        .select({ deviceId: alerts.deviceId })
        .from(alerts)
        .where(and(...orgConditions));

      const uniqueDeviceIds = [...new Set(configPolicyAlerts.map(a => a.deviceId))];

      for (const deviceId of uniqueDeviceIds) {
        try {
          configPolicyResolvedCount += await checkAutoResolveFromConfigPolicy(deviceId);
        } catch (error) {
          console.error(`[AlertWorker] Error in config policy auto-resolve for device ${deviceId}:`, error);
        }
      }
    } catch (error) {
      console.error('[AlertWorker] Error querying config policy alerts for auto-resolve:', error);
    }

    const resolvedCount = legacyResolvedCount + configPolicyResolvedCount;

    if (resolvedCount > 0) {
      console.log(`[AlertWorker] Auto-resolved ${resolvedCount} alerts (legacy=${legacyResolvedCount}, configPolicy=${configPolicyResolvedCount})`);
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
  const slot = Math.floor(Date.now() / ON_DEMAND_ALERT_DEDUPE_WINDOW_MS).toString(36);
  const jobId = `alert-evaluate-device:${deviceId}:${slot}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[AlertWorker] Failed to remove stale device evaluation job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'evaluate-device',
    {
      type: 'evaluate-device',
      deviceId,
      orgId
    },
    {
      jobId,
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
  const slot = Math.floor(Date.now() / ON_DEMAND_ALERT_DEDUPE_WINDOW_MS).toString(36);
  const jobId = `alert-evaluate-all-${slot}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[AlertWorker] Failed to remove stale full evaluation job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'evaluate-all',
    { type: 'evaluate-all' },
    {
      jobId,
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
    attachWorkerObservability(alertWorker, 'alertWorker');

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
