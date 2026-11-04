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

import { and, asc, eq, gt, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { backupJobs, devices } from '../db/schema';
import { isAgentConnectedAnywhere } from '../services/agentCommandRelay';
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

/** What a catch-up dispatch needs from a deferred row. */
const deferredJobColumns = {
  jobId: backupJobs.id,
  configId: backupJobs.configId,
  orgId: backupJobs.orgId,
  deviceId: backupJobs.deviceId,
  catchUpUntil: backupJobs.catchUpUntil,
};

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
};

/**
 * Queue a catch-up dispatch for each row. A failure is logged and the row stays
 * deferred, so the next check-schedules tick retries it.
 */
async function enqueueDeferredJobs(jobs: DeferredJob[]): Promise<number> {
  let enqueued = 0;
  for (const job of jobs) {
    if (!job.catchUpUntil) continue;
    const catchUpUntil = job.catchUpUntil;
    try {
      // Reads the config's approval generation, so it needs a context of its
      // own, closed before the next row.
      await runWithSystemDbAccess(() => enqueueBackupCatchUpDispatch({
        jobId: job.jobId,
        configId: job.configId,
        orgId: job.orgId,
        deviceId: job.deviceId,
        catchUpUntil,
      }));
      enqueued++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[BackupCatchUp] Failed to queue catch-up dispatch for job ${job.jobId}: ${message}`);
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
    .select(deferredJobColumns)
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
    .select({ ...deferredJobColumns, agentId: devices.agentId })
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
 * Runs in the caller's context.
 */
export async function expireSupersededBackupCatchUps(params: {
  deviceId: string;
  featureLinkId: string;
  newJobIds: string[];
}): Promise<void> {
  const now = new Date();
  await db
    .update(backupJobs)
    .set({ status: 'failed', completedAt: now, updatedAt: now, errorLog: BACKUP_MISSED_ERROR })
    .where(and(
      eq(backupJobs.deviceId, params.deviceId),
      eq(backupJobs.featureLinkId, params.featureLinkId),
      eq(backupJobs.status, 'pending'),
      isNotNull(backupJobs.catchUpUntil),
      notInArray(backupJobs.id, params.newJobIds),
    ));
}
