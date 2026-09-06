/**
 * Bulk permanent delete of REMOVED devices (#2787).
 *
 * ASYNC ON PURPOSE. `deleteDeviceCascade` touches ~40 tables per device; 500 of
 * them inside one request would pin a pooled connection for minutes (the auth
 * middleware wraps every handler in a transaction — #1105), and one bad row
 * would abort them all. The route validates cheaply, enqueues, and returns
 * `202 { jobId }`; the web polls `GET /devices/bulk/purge-runs/:jobId`.
 *
 * AUTHORISATION IS RE-DERIVED PER DEVICE, UNDER THE LOCK. The payload carries
 * the org each device belonged to when the operator confirmed. This worker runs
 * in a SYSTEM db context — the cascade must see tables a tenant context
 * deliberately hides (`services/deviceDeletion.ts`) — so RLS is not a backstop
 * here and nothing else would catch a device that moved orgs between confirm
 * and execution. Such a device is SKIPPED (`ORG_CHANGED`), never deleted under
 * stale authorisation. A device that was restored in the same window is refused
 * by `purgeRemovedDevice`'s own status re-check (`NOT_REMOVED`), and one whose
 * agent uninstall is still collectable by its `UNINSTALL_PENDING` refusal.
 *
 * Module shape mirrors `jobs/orgMerge.ts`: lazy Queue/Worker singletons,
 * `enqueueOrReplaceStale` (a bare `queue.add` under a dedup'd jobId silently
 * DROPS the request when a spent record is still in the failed set), and
 * `attempts: 1` — a retry would re-run a half-finished purge list against
 * devices whose state has moved on since the first pass.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { captureException } from '../services/sentry';
import { getBullMQConnection, getRedis } from '../services/redis';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { createAuditLog } from '../services/auditService';
import { invalidateOrgDeviceCount } from '../services/agentOrgRateLimit';
import { purgeRemovedDevice, DeviceLifecycleError } from '../services/deviceLifecycle';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'device-bulk-purge';
const JOB_NAME = 'device-bulk-purge';

/**
 * Re-applied here as well as in `bulkDeviceIdsSchema`. The job payload outlives
 * the request that wrote it and is executed by a different process, possibly a
 * different build — a validator-only ceiling is enforced by whoever enqueued,
 * not by whoever deletes.
 */
export const DEVICE_BULK_PURGE_MAX_TARGETS = 500;

export interface DeviceBulkPurgeTarget {
  deviceId: string;
  /** The org the device belonged to at confirm time. Re-checked under the lock. */
  orgId: string;
  /** Snapshotted for the audit row: the devices row is gone by the time it's written. */
  hostname: string;
}

export interface DeviceBulkPurgeJobPayload {
  /** uuid; also the BullMQ jobId suffix and what the status route is polled with. */
  jobId: string;
  targets: DeviceBulkPurgeTarget[];
  actorUserId: string;
  actorEmail?: string;
  /** Ownership for the status route's partner-scope check. */
  partnerId: string | null;
}

export type BulkPurgeSkipCode =
  | 'NOT_FOUND'
  | 'NOT_REMOVED'
  | 'UNINSTALL_PENDING'
  | 'ORG_CHANGED'
  | 'ERROR';

export interface DeviceBulkPurgeResult {
  purged: string[];
  skipped: Array<{ deviceId: string; code: BulkPurgeSkipCode }>;
}

let purgeQueue: Queue | null = null;
let purgeWorker: Worker | null = null;

export function getDeviceBulkPurgeQueue(): Queue {
  if (!purgeQueue) {
    purgeQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return purgeQueue;
}

export async function enqueueDeviceBulkPurge(
  payload: DeviceBulkPurgeJobPayload,
): Promise<{ id: string }> {
  return enqueueOrReplaceStale(
    getDeviceBulkPurgeQueue(),
    JOB_NAME,
    `${JOB_NAME}-${payload.jobId}`,
    payload,
    { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    '[DeviceBulkPurge]',
  );
}

/** What one device's purge attempt produced. `code === null` means purged. */
interface PurgeOneOutcome {
  code: BulkPurgeSkipCode | null;
  /** From `PurgeResult` — read under the lock. Null when nothing was purged. */
  linkGroupId: string | null;
  linkGroupDissolved: boolean;
}

/**
 * Purge ONE device, or report why it was skipped.
 *
 * `runOutsideDbContext` first: a worker handler can already be inside a context
 * on some paths, and this must open its own SYSTEM one. The extra
 * `SELECT org_id ... FOR UPDATE` before `purgeRemovedDevice` is the ownership
 * re-check; the second FOR UPDATE the service then takes on the same row in the
 * same transaction is a no-op on a lock we already hold.
 *
 * Returns the service's `PurgeResult` fields rather than discarding them: a
 * purge that dissolves a link group unlinks SIBLING devices that were never in
 * this selection, and the audit entry below is the only place that can record
 * it. Discarding it is how a 200-device run silently re-shapes groups nobody
 * asked it to touch.
 */
async function purgeOne(target: DeviceBulkPurgeTarget): Promise<PurgeOneOutcome> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () =>
        db.transaction(async (tx): Promise<PurgeOneOutcome> => {
          const rows = (await tx.execute(
            sql`SELECT org_id FROM devices WHERE id = ${target.deviceId} FOR UPDATE`,
          )) as unknown as Array<{ org_id: string }>;
          const row = Array.isArray(rows) ? rows[0] : undefined;
          if (!row) return { code: 'NOT_FOUND', linkGroupId: null, linkGroupDissolved: false };
          if (row.org_id !== target.orgId) {
            return { code: 'ORG_CHANGED', linkGroupId: null, linkGroupDissolved: false };
          }

          try {
            const purged = await purgeRemovedDevice(tx, target.deviceId);
            return {
              code: null,
              linkGroupId: purged.linkGroupId,
              linkGroupDissolved: purged.linkGroupDissolved,
            };
          } catch (err) {
            if (err instanceof DeviceLifecycleError) {
              return { code: err.code, linkGroupId: null, linkGroupDissolved: false };
            }
            throw err;
          }
        }),
      'deviceBulkPurge.purgeOne',
    ),
  );
}

/**
 * The Worker's processor, exported so the integration suite can drive it
 * against real Postgres without a Redis round-trip.
 */
export async function processDeviceBulkPurgeJob(
  job: Job<DeviceBulkPurgeJobPayload>,
): Promise<DeviceBulkPurgeResult | { skipped: true }> {
  if (job.name !== JOB_NAME) {
    console.warn(`[DeviceBulkPurge] Ignoring unknown job name: ${job.name}`);
    return { skipped: true };
  }

  const payload = job.data;
  const targets = payload.targets.slice(0, DEVICE_BULK_PURGE_MAX_TARGETS);
  const result: DeviceBulkPurgeResult = { purged: [], skipped: [] };
  const touchedOrgs = new Set<string>();

  for (const [index, target] of targets.entries()) {
    let outcome: PurgeOneOutcome;
    try {
      outcome = await purgeOne(target);
    } catch (err) {
      // One device's failure must not abort the other 499 — but it must not be
      // silent either: the operator was told the whole selection was accepted.
      console.error(
        `[DeviceBulkPurge] ${payload.jobId}: unexpected error purging ${target.deviceId}:`,
        err,
      );
      captureException(err);
      outcome = { code: 'ERROR', linkGroupId: null, linkGroupDissolved: false };
    }

    const { code } = outcome;
    if (code) {
      result.skipped.push({ deviceId: target.deviceId, code });
    } else {
      result.purged.push(target.deviceId);
      touchedOrgs.add(target.orgId);
      try {
        // The devices row is permanently gone, so this audit entry is the ONLY
        // durable record that the deletion happened.
        await createAuditLog({
          orgId: target.orgId,
          actorType: 'user',
          actorId: payload.actorUserId,
          actorEmail: payload.actorEmail,
          action: 'device.permanent_delete',
          resourceType: 'device',
          resourceId: target.deviceId,
          resourceName: target.hostname,
          details: {
            bulkJobId: payload.jobId,
            bulk: true,
            // #2138/#2308 — present only when the device WAS in a group, so
            // the field means something wherever it appears.
            ...(outcome.linkGroupId
              ? {
                  linkGroupId: outcome.linkGroupId,
                  linkGroupDissolved: outcome.linkGroupDissolved,
                }
              : {}),
          },
          result: 'success',
        });
      } catch (err) {
        console.error('[DeviceBulkPurge] audit write failed:', err);
      }
    }

    await job.updateProgress({ done: index + 1, total: targets.length });
  }

  // #2728 — the per-org agent rate limit is sized from a cached enrolled device
  // count. Once per touched ORG, not per device: the cache key is the org's.
  // Fully guarded; the deletions have already committed and nothing here may
  // turn a completed destructive operation into a failed job.
  for (const orgId of touchedOrgs) {
    try {
      void invalidateOrgDeviceCount(getRedis(), orgId);
    } catch (err) {
      console.error('[DeviceBulkPurge] device-count cache invalidation failed', err);
    }
  }

  return result;
}

export function createDeviceBulkPurgeWorker(): Worker {
  return new Worker(QUEUE_NAME, (job: Job<DeviceBulkPurgeJobPayload>) => processDeviceBulkPurgeJob(job), {
    connection: getBullMQConnection(),
    // The cascade takes wide row locks across ~40 tables; two of these racing
    // on the same org is contention for no throughput win.
    concurrency: 1,
  });
}

export async function initializeDeviceBulkPurgeWorker(): Promise<void> {
  try {
    purgeWorker = createDeviceBulkPurgeWorker();
    attachWorkerObservability(purgeWorker, 'deviceBulkPurge');
    purgeWorker.on('error', (error) => {
      console.error('[DeviceBulkPurge] Worker error:', error);
      captureException(error);
    });
    purgeWorker.on('failed', (job, error) => {
      console.error(`[DeviceBulkPurge] Job ${job?.id} failed:`, error);
      captureException(error);
    });
    console.log('[DeviceBulkPurge] Worker initialized');
  } catch (error) {
    console.error('[DeviceBulkPurge] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownDeviceBulkPurgeWorker(): Promise<void> {
  if (purgeWorker) {
    await purgeWorker.close();
    purgeWorker = null;
  }
  if (purgeQueue) {
    await purgeQueue.close();
    purgeQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = { QUEUE_NAME, JOB_NAME };
