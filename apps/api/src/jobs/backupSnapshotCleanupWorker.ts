/**
 * Expired-snapshot cleanup worker (#12061).
 *
 * The cleanup run (backupSnapshotCleanup.ts) used to share the 5-slot `backup`
 * worker with backup dispatch, result processing and schedule checks. Runs
 * over large manifests took longer than the 6-hour schedule, later runs
 * stacked up behind them, and once every slot held a cleanup run, backups
 * stopped dispatching for every org until the API restarted.
 *
 * Now:
 *  - cleanup has its own queue and a single-slot worker, so however long a run
 *    takes it never occupies a slot the `backup` queue needs;
 *  - a Redis lease lets only one run proceed at a time across every API
 *    process; a scheduled run that finds the lease held completes as skipped
 *    instead of waiting behind the running one;
 *  - each run has a time budget (BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS) and
 *    stops between orgs / storage identities when it is spent; the next run
 *    resumes where this one stopped (cursors in Redis);
 *  - BACKUP_SNAPSHOT_CLEANUP_CRON overrides the schedule, and `off` removes it.
 */

import { randomUUID } from 'node:crypto';
import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection, getRedis } from '../services/redis';
import { captureException } from '../services/sentry';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { attachWorkerObservability } from './workerObservability';
import { getBackupQueue } from './backupEnqueue';
import { cronFromEnv } from './scheduleRegistry';
import {
  backupSnapshotCleanupQueueJobDataSchema,
  type BackupSnapshotCleanupQueueJobData,
  type QueueActorMeta,
  withQueueMeta,
} from './queueSchemas';
import { processCleanupExpiredSnapshots, type BackupSnapshotCleanupCursors } from './backupSnapshotCleanup';

export const BACKUP_SNAPSHOT_CLEANUP_QUEUE = 'backup-snapshot-cleanup';
const JOB_NAME = 'cleanup-expired-snapshots';

export const BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY = 'backup:snapshot-cleanup:lease';
export const BACKUP_SNAPSHOT_CLEANUP_CURSOR_KEYS = {
  retention: 'backup:snapshot-cleanup:cursor:retention',
  gc: 'backup:snapshot-cleanup:cursor:gc',
} as const;

// The lease outlives a crashed process by at most LEASE_TTL_MS; a live run
// renews it well inside that window.
const LEASE_TTL_MS = 10 * 60_000;
const LEASE_RENEW_EVERY_MS = 2 * 60_000;
// A run stops renewing its lease once it has been going for this many times
// its time budget. A run that hangs (a storage call that never returns) must
// not hold the lease forever and silently turn every later run into a skip;
// past the ceiling the lease lapses and the next scheduled run proceeds.
const LEASE_CEILING_BUDGET_MULTIPLE = 2;
// A cursor older than this is stale (orgs and destinations change); dropping
// it only means the next run starts from the beginning.
const CURSOR_TTL_MS = 7 * 24 * 60 * 60_000;

const DEFAULT_TIME_BUDGET_MS = 4 * 60 * 60_000;

const RENEW_LEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_LEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

const REPEATABLE_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:backup-snapshot-cleanup:repeatable',
};

/**
 * Wall-clock budget for one run, read on every run. Retention gets the first
 * half, the storage sweep runs until the end. The default stays inside the
 * 6-hour schedule. A value that is not a positive whole number keeps the default.
 */
export function resolveBackupSnapshotCleanupTimeBudgetMs(): number {
  const raw = process.env.BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS?.trim();
  if (!raw) return DEFAULT_TIME_BUDGET_MS;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    console.warn(
      `[BackupSnapshotCleanupWorker] BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS='${raw}' is not a positive whole number ` +
      `of milliseconds; using the default ${DEFAULT_TIME_BUDGET_MS}`,
    );
    return DEFAULT_TIME_BUDGET_MS;
  }
  return Number(raw);
}

/** BACKUP_SNAPSHOT_CLEANUP_CRON=off turns the schedule off. */
function cleanupScheduleDisabled(): boolean {
  return process.env.BACKUP_SNAPSHOT_CLEANUP_CRON?.trim().toLowerCase() === 'off';
}

type RedisClient = NonNullable<ReturnType<typeof getRedis>>;

function requireRedis(): RedisClient {
  const redis = getRedis();
  if (!redis) {
    throw new Error('[BackupSnapshotCleanupWorker] Redis is unavailable; the cleanup run lease cannot be taken');
  }
  return redis;
}

async function readCursor(redis: RedisClient, key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch (err) {
    // Without a cursor the run starts from the beginning: slower, never wrong.
    console.warn(`[BackupSnapshotCleanupWorker] Could not read resume cursor ${key}; starting from the beginning:`, err);
    return null;
  }
}

async function saveCursors(redis: RedisClient, cursors: BackupSnapshotCleanupCursors): Promise<void> {
  // Each phase's cursor is saved independently: one failed write must not
  // also leave the other phase's cursor stale.
  const phases = Object.entries(BACKUP_SNAPSHOT_CLEANUP_CURSOR_KEYS) as Array<[keyof BackupSnapshotCleanupCursors, string]>;
  const outcomes = await Promise.allSettled(phases.map(async ([phase, key]) => {
    const value = cursors[phase];
    if (value) await redis.set(key, value, 'PX', CURSOR_TTL_MS);
    else await redis.del(key);
  }));
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failure) throw failure.reason;
}

async function processCleanupJob(
  job: Job<BackupSnapshotCleanupQueueJobData>,
): Promise<Awaited<ReturnType<typeof processCleanupExpiredSnapshots>> | { skipped: 'already-running' }> {
  parseQueueJobData(BACKUP_SNAPSHOT_CLEANUP_QUEUE, job, backupSnapshotCleanupQueueJobDataSchema);
  assertQueueJobName(BACKUP_SNAPSHOT_CLEANUP_QUEUE, job, JOB_NAME);

  const redis = requireRedis();
  const token = randomUUID();
  const acquired = await redis.set(BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY, token, 'PX', LEASE_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    console.warn('[BackupSnapshotCleanupWorker] A cleanup run is still in progress; skipping this one');
    return { skipped: 'already-running' };
  }

  const startedAt = Date.now();
  const budgetMs = resolveBackupSnapshotCleanupTimeBudgetMs();
  const leaseCeilingAt = startedAt + LEASE_CEILING_BUDGET_MULTIPLE * budgetMs;
  const renew = setInterval(() => {
    if (Date.now() > leaseCeilingAt) {
      clearInterval(renew);
      const message =
        `[BackupSnapshotCleanupWorker] A cleanup run has been going for more than ${LEASE_CEILING_BUDGET_MULTIPLE}x ` +
        'its time budget; no longer renewing its lease, so the next scheduled run can start. The run may be hung ' +
        'on a storage or database call.';
      console.error(message);
      captureException(new Error(message));
      return;
    }
    redis.eval(RENEW_LEASE_SCRIPT, 1, BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY, token, String(LEASE_TTL_MS))
      .then((renewed) => {
        if (renewed !== 1) {
          const message =
            '[BackupSnapshotCleanupWorker] Lost the cleanup run lease; another run may start before this one ends';
          console.error(message);
          captureException(new Error(message));
        }
      })
      .catch((err: unknown) => {
        console.error('[BackupSnapshotCleanupWorker] Could not renew the cleanup run lease:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
      });
  }, LEASE_RENEW_EVERY_MS);
  renew.unref?.();

  try {
    const [retentionCursor, gcCursor] = await Promise.all([
      readCursor(redis, BACKUP_SNAPSHOT_CLEANUP_CURSOR_KEYS.retention),
      readCursor(redis, BACKUP_SNAPSHOT_CLEANUP_CURSOR_KEYS.gc),
    ]);
    return await processCleanupExpiredSnapshots({
      retentionDeadlineMs: startedAt + Math.floor(budgetMs / 2),
      gcDeadlineMs: startedAt + budgetMs,
      retentionCursor,
      gcCursor,
      saveCursors: (cursors) => saveCursors(redis, cursors),
    });
  } finally {
    clearInterval(renew);
    try {
      await redis.eval(RELEASE_LEASE_SCRIPT, 1, BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY, token);
    } catch (err) {
      // The lease expires on its own within LEASE_TTL_MS.
      console.error('[BackupSnapshotCleanupWorker] Could not release the cleanup run lease:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

let queue: Queue<BackupSnapshotCleanupQueueJobData> | null = null;
let worker: Worker<BackupSnapshotCleanupQueueJobData> | null = null;

function getQueue(): Queue<BackupSnapshotCleanupQueueJobData> {
  if (!queue) {
    queue = new Queue<BackupSnapshotCleanupQueueJobData>(BACKUP_SNAPSHOT_CLEANUP_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return queue;
}

/** Earlier versions scheduled cleanup on the shared `backup` queue. */
async function removeLegacyBackupQueueSchedule(): Promise<void> {
  const legacyQueue = getBackupQueue();
  for (const repeatable of await legacyQueue.getRepeatableJobs()) {
    if (repeatable.name === JOB_NAME) {
      await legacyQueue.removeRepeatableByKey(repeatable.key);
      console.log('[BackupSnapshotCleanupWorker] Removed the cleanup schedule from the shared backup queue');
    }
  }
}

export async function initializeBackupSnapshotCleanupWorker(): Promise<void> {
  worker = new Worker<BackupSnapshotCleanupQueueJobData>(BACKUP_SNAPSHOT_CLEANUP_QUEUE, processCleanupJob, {
    connection: getBullMQConnection(),
    // One run per process; the lease keeps it to one across processes.
    concurrency: 1,
    lockDuration: 300_000,
    stalledInterval: 60_000,
    maxStalledCount: 1,
  });
  attachWorkerObservability(worker, 'backupSnapshotCleanupWorker');
  worker.on('error', (error) => {
    console.error('[BackupSnapshotCleanupWorker] Worker error:', error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[BackupSnapshotCleanupWorker] Job ${job?.id} failed:`, error);
  });

  const q = getQueue();
  let currentKey: string | undefined;
  if (!cleanupScheduleDisabled()) {
    const scheduled = await q.add(
      JOB_NAME,
      backupSnapshotCleanupQueueJobDataSchema.parse(
        withQueueMeta({ type: 'cleanup-expired-snapshots' as const }, REPEATABLE_META),
      ),
      {
        // Every 6h at a registry-allocated slot (jobs/scheduleRegistry.ts)
        // unless BACKUP_SNAPSHOT_CLEANUP_CRON overrides it.
        repeat: { pattern: cronFromEnv('BACKUP_SNAPSHOT_CLEANUP_CRON', 'backup-expired-snapshot-cleanup') },
        attempts: 1,
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      },
    );
    currentKey = scheduled.repeatJobKey;
  } else {
    console.warn(
      '[BackupSnapshotCleanupWorker] BACKUP_SNAPSHOT_CLEANUP_CRON=off — expired restore points are not removed ' +
      'and backup storage is not reclaimed until it is set back',
    );
  }
  for (const repeatable of await q.getRepeatableJobs()) {
    if (repeatable.name === JOB_NAME && repeatable.key !== currentKey) {
      await q.removeRepeatableByKey(repeatable.key);
    }
  }

  // After the new schedule is in place, so a failure here cannot leave
  // cleanup unscheduled. A leftover legacy schedule only queues no-op jobs on
  // the shared backup queue (backupWorker.ts), and the next start retries.
  try {
    await removeLegacyBackupQueueSchedule();
  } catch (err) {
    console.error('[BackupSnapshotCleanupWorker] Could not remove the cleanup schedule from the shared backup queue:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  console.log('[BackupSnapshotCleanupWorker] Worker initialized');
}

export async function shutdownBackupSnapshotCleanupWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}

export const __testOnly = {
  processCleanupJob,
};
