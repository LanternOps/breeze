/**
 * device_filesystem_snapshots retention (#4342 W1). REPORT-ONLY until
 * FILESYSTEM_SNAPSHOT_RETENTION_ENFORCE=true (see retentionTarget.ts).
 *
 * One row per disk-usage scan (largest files/dirs, temp and download
 * findings as jsonb, ~200 KB a row), never removed. A daily sweep deletes
 * snapshots older than the window that have a NEWER snapshot of the same
 * `(device_id, scan_path)`. The newest snapshot of each scan path is kept
 * whatever its age: services/filesystemAnalysis.ts reads the newest snapshot
 * of a path, and a volume scanned once a year must not lose its only scan.
 *
 * `idx_device_filesystem_snapshots_device_path_captured` serves the newer-row
 * probe. Small batches (100 x 50) because the rows are large. No inbound FKs.
 * Each batch runs in its own system transaction (retentionBatch.ts); do not
 * wrap this job in a DB context.
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

const LOG_PREFIX = '[FilesystemSnapshotRetention]';
const QUEUE_NAME = 'filesystem-snapshot-retention';
const TABLE = 'device_filesystem_snapshots';
const ENFORCE_VAR = 'FILESYSTEM_SNAPSHOT_RETENTION_ENFORCE';

const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(
  process.env.FILESYSTEM_SNAPSHOT_RETENTION_DAYS, 7, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'FILESYSTEM_SNAPSHOT_RETENTION_BATCH_SIZE', 100);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'FILESYSTEM_SNAPSHOT_RETENTION_MAX_BATCHES', 50);
const ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'FILESYSTEM_SNAPSHOT_RETENTION_ENFORCE', false);

export const FILESYSTEM_SNAPSHOT_RETENTION_TARGET: RetentionTarget = {
  metricName: 'filesystem_snapshot_retention',
  table: TABLE,
  action: { kind: 'delete' },
  // The bare outer name is required (retentionBatch selects FROM it unaliased).
  where: (cutoffIso) => sql`captured_at < ${utcWallTime(cutoffIso)}
    AND EXISTS (
      SELECT 1 FROM device_filesystem_snapshots n
      WHERE n.device_id = device_filesystem_snapshots.device_id
        AND n.scan_path = device_filesystem_snapshots.scan_path
        AND n.captured_at > device_filesystem_snapshots.captured_at
    )`,
};

export interface FilesystemSnapshotRetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
  /** The only payload switch: it can turn enforcement OFF, never on. */
  forceReport?: boolean;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<FilesystemSnapshotRetentionJobData> | null = null;

export function getFilesystemSnapshotRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function runFilesystemSnapshotRetention(
  job: FilesystemSnapshotRetentionJobData = {},
): Promise<RetentionTargetResult> {
  return runRetentionTarget(
    FILESYSTEM_SNAPSHOT_RETENTION_TARGET,
    {
      retentionDays: resolveRetentionDays(job.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS),
      batchSize: Math.max(1, job.batchSize ?? BATCH_SIZE),
      maxBatches: Math.max(1, job.maxBatches ?? MAX_BATCHES),
      enforce: ENFORCE && !job.forceReport,
    },
    { logPrefix: LOG_PREFIX, label: 'filesystemSnapshotRetention', enforceVar: ENFORCE_VAR },
  );
}

export function createFilesystemSnapshotRetentionWorker(): Worker<FilesystemSnapshotRetentionJobData> {
  return new Worker<FilesystemSnapshotRetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<FilesystemSnapshotRetentionJobData>) => runFilesystemSnapshotRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeFilesystemSnapshotRetention(): Promise<void> {
  try {
    retentionWorker = createFilesystemSnapshotRetentionWorker();
    attachWorkerObservability(retentionWorker, 'filesystemSnapshotRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getFilesystemSnapshotRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('filesystem-snapshot-retention') },
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

export async function shutdownFilesystemSnapshotRetention(): Promise<void> {
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
