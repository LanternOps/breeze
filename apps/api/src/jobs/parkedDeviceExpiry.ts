/**
 * Hourly expiry of parked devices: any device that has waited in its
 * partner's holding org longer than PARKED_DEVICE_TTL_DAYS (from
 * `devices.created_at`) is removed — status `decommissioned`, a
 * `self_uninstall` queued through the uninstall drain, an `expired` ledger
 * row and a `device.parked.expired` audit event.
 *
 * The candidate SELECT is unlocked; each device is then expired in its own
 * system transaction that takes the per-partner holding-area lock and the
 * device row lock and re-checks holding-org membership and the window
 * (services/unassignedPool/parkedExpiry.ts). A device assigned between the
 * SELECT and its turn is skipped, never expired under its new org.
 */
import { Queue, Worker } from 'bullmq';
import { and, asc, eq, lt, ne } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, organizations } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { UNASSIGNED_POOL_ORG_TYPE } from '../services/unassignedPool/orgType';
import { PARKED_DEVICE_TTL_DAYS } from '../services/unassignedPool/limits';
import { expireParkedDevice } from '../services/unassignedPool/parkedExpiry';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const LOG_PREFIX = '[ParkedDeviceExpiry]';
const QUEUE_NAME = 'parked-device-expiry';

/** Upper bound on one run. Each partner holds at most 50 parked devices. */
export const PARKED_DEVICE_EXPIRY_MAX_PER_RUN = 2_000;

export interface ParkedDeviceExpirySummary {
  candidates: number;
  expired: number;
  /** Assigned, removed or re-dated between the SELECT and the lock — not an error. */
  skippedRaced: number;
  failed: number;
  durationMs: number;
}

let expiryQueue: Queue | null = null;
let expiryWorker: Worker | null = null;

export function getParkedDeviceExpiryQueue(): Queue {
  if (!expiryQueue) expiryQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return expiryQueue;
}

export async function runParkedDeviceExpiryOnce(now: Date = new Date()): Promise<ParkedDeviceExpirySummary> {
  const startedAt = Date.now();
  const cutoff = new Date(now.getTime() - PARKED_DEVICE_TTL_DAYS * 86_400_000);

  const candidates = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ deviceId: devices.id, partnerId: organizations.partnerId })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(and(
      eq(organizations.type, UNASSIGNED_POOL_ORG_TYPE),
      ne(devices.status, 'decommissioned'),
      lt(devices.createdAt, cutoff),
    ))
    .orderBy(asc(devices.createdAt))
    .limit(PARKED_DEVICE_EXPIRY_MAX_PER_RUN)));

  const summary: ParkedDeviceExpirySummary = { candidates: candidates.length, expired: 0, skippedRaced: 0, failed: 0, durationMs: 0 };
  for (const candidate of candidates) {
    try {
      const outcome = await expireParkedDevice({
        partnerId: candidate.partnerId,
        deviceId: candidate.deviceId,
        actorUserId: null,
        reason: 'parking_window',
        // The SAME cutoff the SELECT used, re-applied under the lock.
        cutoff,
      });
      if (outcome.expired) summary.expired += 1;
      else summary.skippedRaced += 1;
    } catch (err) {
      // One device's failure must not stop the sweep.
      console.error(`${LOG_PREFIX} failed to expire parked device ${candidate.deviceId}:`, err);
      captureException(err);
      summary.failed += 1;
    }
  }

  summary.durationMs = Date.now() - startedAt;
  if (summary.candidates > 0) {
    console.log(`${LOG_PREFIX} expired ${summary.expired}/${summary.candidates} parked devices (raced=${summary.skippedRaced}, failed=${summary.failed}) in ${summary.durationMs}ms`);
  }
  return summary;
}

export async function initializeParkedDeviceExpiry(): Promise<void> {
  try {
    expiryWorker = new Worker(QUEUE_NAME, () => runParkedDeviceExpiryOnce(), {
      connection: getBullMQConnection(),
      concurrency: 1,
    });
    attachWorkerObservability(expiryWorker, 'parkedDeviceExpiry');
    expiryWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });

    const queue = getParkedDeviceExpiryQueue();
    for (const job of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(job.key);
    await queue.add('expire', {}, {
      repeat: { pattern: jobSchedule('parked-device-expiry') },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    });
    console.log(`${LOG_PREFIX} worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownParkedDeviceExpiry(): Promise<void> {
  if (expiryWorker) {
    await expiryWorker.close();
    expiryWorker = null;
  }
  if (expiryQueue) {
    await expiryQueue.close();
    expiryQueue = null;
  }
}
