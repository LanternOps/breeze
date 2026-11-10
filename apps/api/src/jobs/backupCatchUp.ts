/**
 * Missed-schedule catch-up for scheduled backups (#11013).
 *
 * A scheduled job whose dispatch finds the device offline is not failed: it
 * stays `pending` with `catch_up_until` set, and runs when the agent connects.
 * Lifecycle of the column:
 *
 *   set     processDispatchBackup, when the agent is offline at the schedule
 *   read    the connect hook (routes/agentWs.ts) and the check-schedules safety
 *           net below, which queue a catch-up dispatch for rows inside the window
 *   cleared prepareBackupDispatchTargets, which claims the row just before it
 *           sends, in the same transaction that builds the commands
 *   expired by the scheduler when it creates the next job for that link, and by
 *           the stale reaper once the window lapses — both with
 *           BACKUP_MISSED_ERROR, so reporting can tell "device was off" from
 *           "backup broke"
 */

import { and, asc, eq, gt, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { backupJobs, devices } from '../db/schema';
import { isAgentConnectedAnywhere } from '../services/agentCommandRelay';
import { captureException } from '../services/sentry';
import { notParkedDeviceCondition } from '../services/unassignedPool/selectorPredicate';
import { getNextRun } from '../routes/backup/helpers';
import type { BackupPolicySchedule } from '../routes/backup/types';
import { enqueueBackupCatchUpDispatch } from './backupEnqueue';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

/** How long after its schedule a missed backup may still run. */
export const BACKUP_CATCH_UP_WINDOW_MS = 20 * 60 * 60 * 1000;

/** The terminal reason of a job whose device never came back in time. */
export const BACKUP_MISSED_ERROR = 'Missed: device was offline for the whole catch-up window';

/**
 * The terminal reason of a job whose device DID come back but whose catch-up
 * never started (an enqueue that kept failing, a helper that never reported).
 * Kept apart from BACKUP_MISSED_ERROR: reporting reads that one as "the device
 * was off", and this is a backup that broke.
 */
export const BACKUP_CATCH_UP_NOT_STARTED_ERROR =
  'Catch-up did not start: the device came online during the catch-up window, but the backup could not be dispatched';

/** Devices checked per check-schedules tick by the safety net. */
const CONNECTED_CATCH_UP_SWEEP_LIMIT = 200;

/** `runMissedBackupsOnConnect` lives in the link's schedule JSON and defaults on. */
export function isBackupCatchUpEnabled(schedule: unknown): boolean {
  return (schedule as { runMissedBackupsOnConnect?: unknown } | null)?.runMissedBackupsOnConnect !== false;
}

/**
 * The earlier of (schedule + 20 h) and the policy's next run, as ISO 8601. A
 * policy with no computable next run (getNextRun returns null when the time
 * falls outside its backup window) gets the 20 h.
 */
export function computeBackupCatchUpUntil(
  schedule: unknown,
  scheduledAt: Date,
  fallbackTimezone?: string,
): string {
  const capMs = scheduledAt.getTime() + BACKUP_CATCH_UP_WINDOW_MS;
  const nextRun = getNextRun(schedule as BackupPolicySchedule, fallbackTimezone);
  const nextRunMs = nextRun ? Date.parse(nextRun) : Number.NaN;
  return new Date(Number.isFinite(nextRunMs) ? Math.min(capMs, nextRunMs) : capMs).toISOString();
}

/**
 * Why a job that waited for its device ends unrun: the device was seen after
 * the job was scheduled, or it was not. The JS form is for the reaper, which
 * already holds both values.
 */
export function catchUpExpiryReason(deviceLastSeenAt: Date | null | undefined, jobCreatedAt: Date): string {
  return deviceLastSeenAt && deviceLastSeenAt.getTime() > jobCreatedAt.getTime()
    ? BACKUP_CATCH_UP_NOT_STARTED_ERROR
    : BACKUP_MISSED_ERROR;
}

/** The same decision, in SQL, for an UPDATE of `backup_jobs`. */
function catchUpExpiryReasonSql(): SQL<string> {
  return sql<string>`CASE WHEN EXISTS (
      SELECT 1 FROM devices
      WHERE devices.id = backup_jobs.device_id
        AND devices.last_seen_at > backup_jobs.created_at
    ) THEN ${BACKUP_CATCH_UP_NOT_STARTED_ERROR}::text ELSE ${BACKUP_MISSED_ERROR}::text END`;
}

/**
 * Whether a device has a job waiting for it, as a column of a select on
 * `devices`: the agent websocket reads it on the row it already loads, so a
 * connect with no missed backup pays no extra query. Served by the partial index
 * backup_jobs_catch_up_device_idx.
 *
 * `devices.id` is written out on purpose. In a single-table select Drizzle renders
 * an interpolated column unqualified, and an unqualified "id" here would bind to
 * backup_jobs.id, leaving a predicate that is always false.
 */
export function deviceHasBackupCatchUp(): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM backup_jobs
    WHERE backup_jobs.device_id = devices.id
      AND backup_jobs.status = 'pending'
      AND backup_jobs.catch_up_until IS NOT NULL
      AND backup_jobs.catch_up_until > now()
  )`;
}

/**
 * What a catch-up dispatch needs from a deferred row. Built per call, not at
 * module load: route tests that mock `../db/schema` with a partial export set
 * import this module transitively (routes → backupWorker → here), and a
 * top-level `backupJobs.id` would throw before their own setup runs.
 */
const deferredJobColumns = () => ({
  jobId: backupJobs.id,
  configId: backupJobs.configId,
  orgId: backupJobs.orgId,
  deviceId: backupJobs.deviceId,
  catchUpUntil: backupJobs.catchUpUntil,
  configGeneration: backupJobs.catchUpConfigGeneration,
});

const insideCatchUpWindow = () => and(
  eq(backupJobs.status, 'pending'),
  isNotNull(backupJobs.catchUpUntil),
  gt(backupJobs.catchUpUntil, sql`now()`),
);

type DeferredJob = {
  jobId: string;
  configId: string;
  orgId: string;
  deviceId: string;
  catchUpUntil: Date | null;
  configGeneration: number | null;
};

/**
 * Queue a catch-up dispatch for each row. A failure is reported and the row
 * stays deferred, so the next check-schedules tick retries it.
 */
async function enqueueDeferredJobs(jobs: DeferredJob[]): Promise<number> {
  let enqueued = 0;
  for (const job of jobs) {
    if (!job.catchUpUntil) continue;
    const catchUpUntil = job.catchUpUntil;
    try {
      // enqueueBackupCatchUpDispatch makes no DB read: the config generation it
      // carries is the one stamped on the row when the job started waiting.
      await enqueueBackupCatchUpDispatch({
        jobId: job.jobId,
        configId: job.configId,
        orgId: job.orgId,
        deviceId: job.deviceId,
        catchUpUntil,
        configGeneration: job.configGeneration ?? undefined,
      });
      enqueued++;
    } catch (err) {
      console.error(`[BackupCatchUp] Failed to queue catch-up dispatch for job ${job.jobId} (device ${job.deviceId}):`, err);
      // The ids stay in the console line: the Sentry scrubber keeps only
      // allow-listed tags (services/sentry.ts).
      captureException(err, undefined, { backup_dispatch_issue: 'catch-up-enqueue-failed' });
    }
  }
  return enqueued;
}

/**
 * Queue the catch-up dispatch of every deferred job of one device. Called when
 * its agent connects, with no DB context open.
 */
export async function dispatchBackupCatchUpJobs(deviceId: string): Promise<number> {
  const jobs = await runWithSystemDbAccess(() => db
    .select(deferredJobColumns())
    .from(backupJobs)
    .where(and(eq(backupJobs.deviceId, deviceId), insideCatchUpWindow())));
  return enqueueDeferredJobs(jobs);
}

/**
 * Safety net, run on each check-schedules tick: an agent that is connected but
 * still has deferred work. A connect can leave work behind when its enqueue
 * failed, when the dispatch it queued found the helper unreported, or when it
 * landed in the instant the previous dispatch still held the BullMQ id. The
 * failure this feature exists to fix is a device online all day with no backup,
 * so none of those may wait for the next reconnect.
 */
export async function dispatchCatchUpsForConnectedDevices(): Promise<number> {
  const rows = await runWithSystemDbAccess(() => db
    .select({ ...deferredJobColumns(), agentId: devices.agentId })
    .from(backupJobs)
    .innerJoin(devices, eq(backupJobs.deviceId, devices.id))
    .where(and(
      insideCatchUpWindow(),
      eq(devices.status, 'online'),
      isNotNull(devices.agentId),
      notParkedDeviceCondition(),
    ))
    .orderBy(asc(backupJobs.catchUpUntil))
    .limit(CONNECTED_CATCH_UP_SWEEP_LIMIT));
  if (rows.length >= CONNECTED_CATCH_UP_SWEEP_LIMIT) {
    // Ordered by the window's end, so the rows left out are the ones with the
    // most time left; still worth knowing when it happens.
    console.warn(`[BackupCatchUp] Catch-up sweep hit its limit of ${CONNECTED_CATCH_UP_SWEEP_LIMIT} rows; the rest wait for the next tick`);
  }

  // Redis I/O: no DB context open here (#1105).
  const connected = new Map<string, boolean>();
  const due: DeferredJob[] = [];
  for (const row of rows) {
    if (!row.agentId) continue;
    let isConnected = connected.get(row.agentId);
    if (isConnected === undefined) {
      isConnected = await isAgentConnectedAnywhere(row.agentId);
      connected.set(row.agentId, isConnected);
    }
    if (isConnected) due.push(row);
  }
  return enqueueDeferredJobs(due);
}

/**
 * The scheduler created the next job for this link and device, so catch-ups of
 * the earlier occurrences are over, whether or not their window has lapsed.
 * Only jobs created before `occurrenceStart` (the start of the new occurrence's
 * dedupe window) count as earlier: a job of THIS occurrence, created on an
 * earlier tick for another profile selection, is still current. Runs in the
 * caller's context.
 */
export async function expireSupersededBackupCatchUps(params: {
  deviceId: string;
  featureLinkId: string;
  occurrenceStart: Date;
}): Promise<void> {
  const now = new Date();
  await db
    .update(backupJobs)
    .set({ status: 'failed', completedAt: now, updatedAt: now, errorLog: catchUpExpiryReasonSql() })
    .where(and(
      eq(backupJobs.deviceId, params.deviceId),
      eq(backupJobs.featureLinkId, params.featureLinkId),
      eq(backupJobs.status, 'pending'),
      isNotNull(backupJobs.catchUpUntil),
      lt(backupJobs.createdAt, params.occurrenceStart),
    ));
}
