/**
 * Daily hard purge of parked devices that expired more than
 * PARKED_PURGE_AFTER_EXPIRY_DAYS ago. It exists because the general
 * removed-device purge (jobs/removedDevicePurge.ts) never touches an org
 * without a device-lifecycle policy, and a holding org never has one.
 *
 * Each device goes through services/unassignedPool/parkedExpiry.ts
 * `purgeExpiredParkedDevice`: its own system transaction, the per-partner
 * holding-area lock, the device row lock, holding-org membership and the
 * window re-checked, then the same `purgeRemovedDevice` the Permanently
 * Delete button uses (which refuses while the agent's uninstall is still
 * collectable) and a `purged` ledger row. The ledger outlives the device.
 */
import { Queue, Worker } from 'bullmq';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, organizations } from '../db/schema';
import { getBullMQConnection, getRedis } from '../services/redis';
import { captureException } from '../services/sentry';
import { createAuditLog } from '../services/auditService';
import { ANONYMOUS_ACTOR_ID } from '../services/auditEvents';
import { invalidateOrgDeviceCount } from '../services/agentOrgRateLimit';
import { UNASSIGNED_POOL_ORG_TYPE } from '../services/unassignedPool/orgType';
import { PARKED_PURGE_AFTER_EXPIRY_DAYS } from '../services/unassignedPool/limits';
import { purgeExpiredParkedDevice } from '../services/unassignedPool/parkedExpiry';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const LOG_PREFIX = '[ParkedDevicePurge]';
const QUEUE_NAME = 'parked-device-purge';

export const PARKED_DEVICE_PURGE_MAX_PER_RUN = 500;

export interface ParkedDevicePurgeSummary {
  candidates: number;
  purged: number;
  /** The agent's uninstall is still collectable; picked up on a later run. */
  skippedUninstallPending: number;
  /** Restored, assigned, re-dated or refused between the SELECT and the lock. */
  skippedOther: number;
  failed: number;
  durationMs: number;
}

let purgeQueue: Queue | null = null;
let purgeWorker: Worker | null = null;

export function getParkedDevicePurgeQueue(): Queue {
  if (!purgeQueue) purgeQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return purgeQueue;
}

export async function runParkedDevicePurgeOnce(now: Date = new Date()): Promise<ParkedDevicePurgeSummary> {
  const startedAt = Date.now();
  const cutoff = new Date(now.getTime() - PARKED_PURGE_AFTER_EXPIRY_DAYS * 86_400_000);

  const candidates = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ deviceId: devices.id, partnerId: organizations.partnerId, decommissionedAt: devices.decommissionedAt })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(and(
      eq(organizations.type, UNASSIGNED_POOL_ORG_TYPE),
      eq(devices.status, 'decommissioned'),
      isNotNull(devices.decommissionedAt),
      lt(devices.decommissionedAt, cutoff),
    ))
    .orderBy(asc(devices.decommissionedAt))
    .limit(PARKED_DEVICE_PURGE_MAX_PER_RUN)));

  const summary: ParkedDevicePurgeSummary = {
    candidates: candidates.length, purged: 0, skippedUninstallPending: 0, skippedOther: 0, failed: 0, durationMs: 0,
  };
  const touchedOrgs = new Set<string>();

  for (const candidate of candidates) {
    let outcome: Awaited<ReturnType<typeof purgeExpiredParkedDevice>>;
    try {
      outcome = await purgeExpiredParkedDevice({ partnerId: candidate.partnerId, deviceId: candidate.deviceId, cutoff });
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to purge parked device ${candidate.deviceId}:`, err);
      captureException(err);
      summary.failed += 1;
      continue;
    }
    if (!outcome.purged) {
      if (outcome.reason === 'UNINSTALL_PENDING') summary.skippedUninstallPending += 1;
      else summary.skippedOther += 1;
      continue;
    }
    summary.purged += 1;
    touchedOrgs.add(outcome.holdingOrgId);
    try {
      // The device row is gone; this and the ledger row are the record.
      await createAuditLog({
        orgId: outcome.holdingOrgId,
        actorType: 'system',
        actorId: ANONYMOUS_ACTOR_ID,
        action: 'device.permanent_delete',
        resourceType: 'device',
        resourceId: outcome.deviceId,
        resourceName: outcome.hostname,
        details: {
          job: 'parked-device-purge',
          partnerId: candidate.partnerId,
          purgeAfterExpiryDays: PARKED_PURGE_AFTER_EXPIRY_DAYS,
          decommissionedAt: candidate.decommissionedAt?.toISOString() ?? null,
        },
        result: 'success',
        initiatedBy: 'schedule',
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} audit write failed for purged device ${outcome.deviceId}:`, err);
      captureException(err);
    }
  }

  for (const orgId of touchedOrgs) {
    try {
      await invalidateOrgDeviceCount(getRedis(), orgId);
    } catch (err) {
      console.error(`${LOG_PREFIX} device-count cache invalidation failed for org ${orgId}:`, err);
    }
  }

  summary.durationMs = Date.now() - startedAt;
  if (summary.candidates > 0) {
    console.log(`${LOG_PREFIX} purged ${summary.purged}/${summary.candidates} expired parked devices (uninstall-pending=${summary.skippedUninstallPending}, other=${summary.skippedOther}, failed=${summary.failed}) in ${summary.durationMs}ms`);
  }
  return summary;
}

export async function initializeParkedDevicePurge(): Promise<void> {
  try {
    purgeWorker = new Worker(QUEUE_NAME, () => runParkedDevicePurgeOnce(), {
      connection: getBullMQConnection(),
      concurrency: 1,
    });
    attachWorkerObservability(purgeWorker, 'parkedDevicePurge');
    purgeWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });

    const queue = getParkedDevicePurgeQueue();
    for (const job of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(job.key);
    await queue.add('purge', {}, {
      repeat: { pattern: jobSchedule('parked-device-purge') },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    });
    console.log(`${LOG_PREFIX} worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownParkedDevicePurge(): Promise<void> {
  if (purgeWorker) {
    await purgeWorker.close();
    purgeWorker = null;
  }
  if (purgeQueue) {
    await purgeQueue.close();
    purgeQueue = null;
  }
}
