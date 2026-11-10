/**
 * device_sessions retention (#4342 W1). REPORT-ONLY until
 * DEVICE_SESSION_RETENTION_ENFORCE=true (see retentionTarget.ts).
 *
 * One row per OS login session the agent reports, never removed. A daily
 * sweep deletes CLOSED sessions (`is_active = false`) whose logout (falling
 * back to `updated_at` when the agent never reported one) is older than the
 * window. An active session is never eligible, whatever its age. User risk
 * scoring reads only active sessions; the device sessions list and its total
 * page back only as far as the window once this enforces.
 *
 * `device_sessions_closed_age_idx` (W1 migration) serves the age scan. No
 * inbound FKs. Each batch runs in its own system transaction
 * (retentionBatch.ts); do not wrap this job in a DB context.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';

import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  parsePositiveIntEnv,
  resolveRetentionDays,
  retentionEnforceFromEnv,
  utcWallTime,
} from './retentionBatch';
import { runRetentionTarget, type RetentionTarget, type RetentionTargetResult } from './retentionTarget';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[DeviceSessionRetention]';
const QUEUE_NAME = 'device-session-retention';
const TABLE = 'device_sessions';
const ENFORCE_VAR = 'DEVICE_SESSION_RETENTION_ENFORCE';

const MAX_RETENTION_DAYS = 1095;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(
  process.env.DEVICE_SESSION_RETENTION_DAYS, 365, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'DEVICE_SESSION_RETENTION_BATCH_SIZE', 1000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'DEVICE_SESSION_RETENTION_MAX_BATCHES', 100);
const ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'DEVICE_SESSION_RETENTION_ENFORCE', false);

export const DEVICE_SESSION_RETENTION_TARGET: RetentionTarget = {
  metricName: 'device_session_retention',
  table: TABLE,
  action: { kind: 'delete' },
  // The bare outer name is required (retentionBatch selects FROM it unaliased).
  where: (cutoffIso) => sql`is_active = false
    AND COALESCE(logout_at, updated_at) < ${utcWallTime(cutoffIso)}`,
};

export interface DeviceSessionRetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
  /** The only payload switch: it can turn enforcement OFF, never on. */
  forceReport?: boolean;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<DeviceSessionRetentionJobData> | null = null;

export function getDeviceSessionRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function runDeviceSessionRetention(
  job: DeviceSessionRetentionJobData = {},
): Promise<RetentionTargetResult> {
  return runRetentionTarget(
    DEVICE_SESSION_RETENTION_TARGET,
    {
      retentionDays: resolveRetentionDays(job.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS),
      batchSize: Math.max(1, job.batchSize ?? BATCH_SIZE),
      maxBatches: Math.max(1, job.maxBatches ?? MAX_BATCHES),
      enforce: ENFORCE && !job.forceReport,
    },
    { logPrefix: LOG_PREFIX, label: 'deviceSessionRetention', enforceVar: ENFORCE_VAR },
  );
}

export function createDeviceSessionRetentionWorker(): Worker<DeviceSessionRetentionJobData> {
  return new Worker<DeviceSessionRetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<DeviceSessionRetentionJobData>) => runDeviceSessionRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeDeviceSessionRetention(): Promise<void> {
  try {
    retentionWorker = createDeviceSessionRetentionWorker();
    attachWorkerObservability(retentionWorker, 'deviceSessionRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getDeviceSessionRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('device-session-retention') },
      {
        name: 'sweep',
        data: { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized (${ENFORCE ? 'ENFORCING' : 'report-only'})`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownDeviceSessionRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
  ENFORCE,
};
