/**
 * device_commands retention (#4342 W1). REPORT-ONLY until
 * DEVICE_COMMAND_RETENTION_ENFORCE=true (see retentionTarget.ts).
 *
 * One row per command ever sent to an agent, never removed. A daily sweep
 * removes TERMINAL rows (completed / failed / timeout / cancelled) whose
 * `COALESCE(completed_at, created_at)` is past the window. `pending` and `sent`
 * rows are never eligible, whatever their age: the stale-command reaper owns
 * those, and `status` is an unconstrained varchar, so the list is written out.
 *
 * KEEP NEWEST
 * -----------
 * Some readers take a device's newest command of one type with no lower age
 * bound, and read its absence as "never happened". For each of them the row the
 * reader would return is kept, whatever its age (`KEEP_NEWEST_COMMAND_READERS`).
 * Each entry repeats its reader's own filter and ordering:
 *
 *  - routes/devices/patches.ts — the device's last patch scan.
 *  - services/logsNotArriving.ts — the last log-level change.
 *  - services/deviceUninstallState.ts — the current device-remove uninstall.
 *  - services/oemUpdates/rebootSweep.ts — the OEM run that started a reboot clock.
 *  - services/oemUpdates/releaseSweep.ts — the OEM release history.
 *
 * The two OEM readers are only partly covered: the reboot sweep reads the
 * newest run at or before `reboot_pending_since`, and the release sweep reads
 * the newest ten releases since the last run. Keeping the newest row of each
 * type covers the usual case; an older row still past the window is gone.
 * Both readers' decisions are taken within days of those rows being written.
 *
 * FLOOR
 * -----
 * The window never drops below DEVICE_INSTALL_LOOKBACK_DAYS (90): the patch
 * install-failure overlay reads 90 days of `install_patches` rows as install
 * attempts. A lower env value or job payload is raised to the floor.
 *
 * Inbound FKs: `backup_storage_sessions.command_id` cascades; every other
 * reference is ON DELETE SET NULL. `device_commands` has no `org_id` (system
 * scoped), so this is one global sweep. Each batch runs in its own system
 * transaction (retentionBatch.ts); do not wrap this job in a DB context.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';

import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { DEVICE_INSTALL_LOOKBACK_DAYS } from '../services/patchInstallFailures';
import {
  parsePositiveIntEnv,
  resolveRetentionDays,
  retentionEnforceFromEnv,
  utcWallTime,
} from './retentionBatch';
import { runRetentionTarget, type RetentionTarget, type RetentionTargetResult } from './retentionTarget';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[DeviceCommandRetention]';
const QUEUE_NAME = 'device-command-retention';
const TABLE = 'device_commands';
const ENFORCE_VAR = 'DEVICE_COMMAND_RETENTION_ENFORCE';

const MIN_RETENTION_DAYS = DEVICE_INSTALL_LOOKBACK_DAYS;
const MAX_RETENTION_DAYS = 365;

/** Raise a window below the floor to it, with a warning. */
function floorRetentionDays(days: number, source: string): number {
  if (days >= MIN_RETENTION_DAYS) return days;
  console.warn(
    `${LOG_PREFIX} ${source} retention of ${days} days is below the ${MIN_RETENTION_DAYS}-day floor ` +
    '(patch install-failure lookback); using the floor.',
  );
  return MIN_RETENTION_DAYS;
}

const DEFAULT_RETENTION_DAYS = floorRetentionDays(
  resolveRetentionDays(process.env.DEVICE_COMMAND_RETENTION_DAYS, 120, MAX_RETENTION_DAYS, LOG_PREFIX),
  'DEVICE_COMMAND_RETENTION_DAYS',
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'DEVICE_COMMAND_RETENTION_BATCH_SIZE', 1000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'DEVICE_COMMAND_RETENTION_MAX_BATCHES', 100);
const ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'DEVICE_COMMAND_RETENTION_ENFORCE', false);

export const DEVICE_COMMAND_TERMINAL_STATUSES = ['completed', 'failed', 'timeout', 'cancelled'] as const;

/**
 * A reader that takes a device's newest command of `type`, with no lower age
 * bound. `filter` and `orderKey` render that reader's own predicate and sort
 * key against a table alias; `reader` names its source file (checked to exist).
 */
export interface KeepNewestCommandReader {
  type: string;
  filter: (t: string) => SQL;
  orderKey: (t: string) => SQL;
  reader: string;
}

const col = (t: string, name: string) => sql.raw(`${t}.${name}`);

export const KEEP_NEWEST_COMMAND_READERS: ReadonlyArray<KeepNewestCommandReader> = [
  {
    type: 'patch_scan',
    filter: (t) => sql`${col(t, 'status')} IN ('completed', 'failed', 'timeout')`,
    orderKey: (t) => sql`COALESCE(${col(t, 'completed_at')}, ${col(t, 'created_at')})`,
    reader: 'routes/devices/patches.ts',
  },
  {
    type: 'set_log_level',
    filter: (t) => sql`${col(t, 'completed_at')} IS NOT NULL`,
    orderKey: (t) => col(t, 'completed_at'),
    reader: 'services/logsNotArriving.ts',
  },
  {
    type: 'self_uninstall',
    filter: (t) => sql`${col(t, 'uninstall_reasons')} @> ARRAY['device_remove']::text[]`,
    orderKey: (t) => col(t, 'created_at'),
    reader: 'services/deviceUninstallState.ts',
  },
  {
    type: 'oem_update_run',
    filter: () => sql`TRUE`,
    orderKey: (t) => col(t, 'created_at'),
    reader: 'services/oemUpdates/rebootSweep.ts',
  },
  {
    type: 'oem_update_release',
    filter: () => sql`TRUE`,
    orderKey: (t) => col(t, 'created_at'),
    reader: 'services/oemUpdates/releaseSweep.ts',
  },
];

/**
 * True for the row `reader` would return for this row's device, false
 * otherwise — never NULL. A filter over a NULL column (`uninstall_reasons @>`
 * on a row with no reasons) evaluates to NULL, and `NOT (… OR NULL)` is NULL,
 * which would silently exempt that row forever. The reader's own WHERE drops a
 * NULL the same way, so NULL means "not the reader's row": COALESCE to false.
 */
function isReadersNewest(r: KeepNewestCommandReader): SQL {
  const outer = TABLE;
  return sql`COALESCE((${col(outer, 'type')} = ${sql.raw(`'${r.type}'`)} AND ${r.filter(outer)} AND NOT EXISTS (
    SELECT 1 FROM device_commands n
    WHERE n.device_id = ${col(outer, 'device_id')} AND n.type = ${sql.raw(`'${r.type}'`)}
      AND ${r.filter('n')} AND ${r.orderKey('n')} > ${r.orderKey(outer)}
  )), false)`;
}

export const DEVICE_COMMAND_RETENTION_TARGET: RetentionTarget = {
  metricName: 'device_command_retention',
  table: TABLE,
  action: { kind: 'delete' },
  // The bare outer name is required (retentionBatch selects FROM it unaliased).
  where: (cutoffIso) => sql`status IN ('completed', 'failed', 'timeout', 'cancelled')
    AND COALESCE(completed_at, created_at) < ${utcWallTime(cutoffIso)}
    AND NOT (${sql.join(KEEP_NEWEST_COMMAND_READERS.map(isReadersNewest), sql` OR `)})`,
};

export interface DeviceCommandRetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
  /** The only payload switch: it can turn enforcement OFF, never on. */
  forceReport?: boolean;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<DeviceCommandRetentionJobData> | null = null;

export function getDeviceCommandRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function runDeviceCommandRetention(
  job: DeviceCommandRetentionJobData = {},
): Promise<RetentionTargetResult> {
  const retentionDays = floorRetentionDays(
    resolveRetentionDays(job.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS),
    'Job payload',
  );
  return runRetentionTarget(
    DEVICE_COMMAND_RETENTION_TARGET,
    {
      retentionDays,
      batchSize: Math.max(1, job.batchSize ?? BATCH_SIZE),
      maxBatches: Math.max(1, job.maxBatches ?? MAX_BATCHES),
      enforce: ENFORCE && !job.forceReport,
    },
    { logPrefix: LOG_PREFIX, label: 'deviceCommandRetention', enforceVar: ENFORCE_VAR },
  );
}

export function createDeviceCommandRetentionWorker(): Worker<DeviceCommandRetentionJobData> {
  return new Worker<DeviceCommandRetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<DeviceCommandRetentionJobData>) => runDeviceCommandRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeDeviceCommandRetention(): Promise<void> {
  try {
    retentionWorker = createDeviceCommandRetentionWorker();
    attachWorkerObservability(retentionWorker, 'deviceCommandRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getDeviceCommandRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('device-command-retention') },
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

export async function shutdownDeviceCommandRetention(): Promise<void> {
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
  MIN_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
  ENFORCE,
};
