/**
 * Daily purge of removed devices past their org's `device_lifecycle` retention
 * window (#2787 item 4) — "permanently delete removed devices N days after
 * removal", the thing the original reporter actually asked for.
 *
 * THIS JOB PERMANENTLY DELETES CUSTOMER DATA WITHOUT A HUMAN IN THE LOOP. Every
 * design choice below is downstream of that:
 *
 *  - FAIL CLOSED, TWICE. An org with no `device_lifecycle` policy is never even
 *    queried (`getOrgPurgeRemovedAfterDays` returns null → `continue`), and a
 *    policy lookup that THROWS skips that org entirely rather than falling back
 *    to a default window. There is no default. Retaining too much is a cost;
 *    deleting too much is unrecoverable.
 *
 *  - ONE TRANSACTION PER DEVICE. `deleteDeviceCascade` touches ~40 tables; a
 *    shared transaction would hold those locks across the whole sweep and let
 *    one bad row roll back every successful deletion before it. Same reasoning
 *    as `retentionBatch.ts`'s per-batch contexts and `deviceBulkPurge`'s
 *    per-device ones.
 *
 *  - THE SAME HARDENED PATH AS THE BUTTON. It calls `purgeRemovedDevice`, so it
 *    inherits the lock-first status re-check (a device restored between this
 *    job's SELECT and its lock is refused, not deleted under a stale read) and
 *    the `UNINSTALL_PENDING` refusal (purging while a `device_remove` uninstall
 *    is still collectable destroys the only thing that will ever clean the
 *    endpoint). Neither is re-implemented here; both are counted and skipped.
 *
 *  - ONE AUDIT ROW PER DELETION. The devices row is gone afterwards, so the
 *    audit entry is the ONLY durable record that this happened. It carries
 *    `retentionPolicy: true` and the window that authorised it, so an operator
 *    reading the trail can tell a policy-driven deletion from a human one.
 *
 * Structure mirrors `jobs/eventLogRetention.ts` (lazy Queue/Worker singletons,
 * short-lived system contexts, per-org loop, `recordRetentionRun`).
 */
import { Queue, Worker, type Job } from 'bullmq';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, organizations } from '../db/schema';
import { getBullMQConnection, getRedis } from '../services/redis';
import { createAuditLog } from '../services/auditService';
import { invalidateOrgDeviceCount } from '../services/agentOrgRateLimit';
import { captureException } from '../services/sentry';
import { recordRetentionRun } from '../services/retentionMetrics';
import { getOrgPurgeRemovedAfterDays } from '../services/deviceLifecyclePolicy';
import { DeviceLifecycleError, purgeRemovedDevice } from '../services/deviceLifecycle';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import { parsePositiveIntEnv } from './retentionBatch';

const LOG_PREFIX = '[RemovedDevicePurge]';
const QUEUE_NAME = 'removed-device-purge';

/**
 * How many devices one org may lose in a single run.
 *
 * A cap rather than an unbounded drain because each device is a ~40-table
 * cascade: an org that switches the feature on with 10,000 removed devices
 * would otherwise spend hours holding pooled connections on the first night.
 * The remainder is picked up by the next run, and a capped run reports
 * `incomplete` so the backlog is visible rather than silently indefinite.
 */
export const REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN = parsePositiveIntEnv(
  LOG_PREFIX,
  'REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN',
  200,
);

export interface RemovedDevicePurgeSummary {
  orgsChecked: number;
  orgsWithPolicy: number;
  /** Orgs skipped because their policy could not be resolved. Nothing deleted. */
  orgsFailed: number;
  /** Orgs that filled the per-run cap, i.e. probably have more waiting. */
  orgsCapped: number;
  purged: number;
  /** Refused because a `device_remove` agent uninstall is still collectable. */
  skippedUninstallPending: number;
  /** Restored or already gone between the SELECT and the lock — not an error. */
  skippedRaced: number;
  failed: number;
  durationMs: number;
}

/**
 * Short-lived system context for ONE statement.
 *
 * Deliberately not wrapped around the whole sweep: `withDbAccessContext` opens
 * a transaction, so one outer context would hold a single connection across
 * every org and every cascade — the failure `eventLogRetention.ts` was fixed
 * for. `runOutsideDbContext` first because a worker handler may already be
 * inside a context on some paths and this must open its own.
 */
const inSystemContext = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

let purgeQueue: Queue | null = null;
let purgeWorker: Worker | null = null;

export function getRemovedDevicePurgeQueue(): Queue {
  if (!purgeQueue) {
    purgeQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return purgeQueue;
}

interface EligibleDevice {
  id: string;
  hostname: string | null;
  decommissionedAt: Date | null;
}

/**
 * One device, in its own system-scoped transaction.
 *
 * Returns the skip code, or `null` when the device was purged. Only
 * `DeviceLifecycleError` is translated; anything else propagates so the caller
 * can count it as a failure and report it — a deadlock or a constraint
 * violation is not a "skip".
 */
async function purgeOne(deviceId: string): Promise<DeviceLifecycleError['code'] | null> {
  try {
    await inSystemContext('removedDevicePurge.purgeOne', () =>
      db.transaction((tx) => purgeRemovedDevice(tx, deviceId)));
    return null;
  } catch (err) {
    if (err instanceof DeviceLifecycleError) return err.code;
    throw err;
  }
}

/**
 * Run the sweep once. Exported so the integration suite can drive it against
 * real Postgres without a Redis round trip.
 *
 * `now` is injectable so a test can assert the cutoff arithmetic rather than
 * the fact that some date was computed.
 */
export async function runRemovedDevicePurgeOnce(now: Date = new Date()): Promise<RemovedDevicePurgeSummary> {
  const startedAt = Date.now();

  // The org list comes from `organizations`, not a DISTINCT scan over
  // `devices` — same reasoning as eventLogRetention (#4343). Orgs are NOT
  // filtered by status: an archived org's removed devices still fall under its
  // retention policy.
  const orgRows = await inSystemContext('removedDevicePurge.orgList', () =>
    db.select({ orgId: organizations.id }).from(organizations));

  const summary: RemovedDevicePurgeSummary = {
    orgsChecked: orgRows.length,
    orgsWithPolicy: 0,
    orgsFailed: 0,
    orgsCapped: 0,
    purged: 0,
    skippedUninstallPending: 0,
    skippedRaced: 0,
    failed: 0,
    durationMs: 0,
  };

  for (const { orgId } of orgRows) {
    let days: number | null;
    try {
      days = await inSystemContext('removedDevicePurge.resolvePolicy', () =>
        getOrgPurgeRemovedAfterDays(orgId));
    } catch (err) {
      // Skip the org outright. Falling back to a default window here would
      // delete devices under a policy nobody could read — the one outcome this
      // job must never produce.
      console.error(
        `${LOG_PREFIX} Failed to resolve the device_lifecycle policy for org ${orgId}; SKIPPING the org — no devices will be purged for it this run:`,
        err,
      );
      captureException(err);
      summary.orgsFailed += 1;
      continue;
    }

    if (days === null) continue; // No policy, or explicitly off. Never purge.
    summary.orgsWithPolicy += 1;

    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    let candidates: EligibleDevice[];
    try {
      candidates = await inSystemContext('removedDevicePurge.selectEligible', () =>
        db
          .select({
            id: devices.id,
            hostname: devices.hostname,
            decommissionedAt: devices.decommissionedAt,
          })
          .from(devices)
          .where(and(
            eq(devices.orgId, orgId),
            eq(devices.status, 'decommissioned'),
            // Explicit even though `NULL < cutoff` is already NULL: a device
            // whose removal time is unknown must never be purged, and that has
            // to survive a future rewrite of the comparison.
            isNotNull(devices.decommissionedAt),
            lt(devices.decommissionedAt, cutoff),
          ))
          // Oldest first: a capped org drains deterministically instead of
          // re-picking an arbitrary slice every night.
          .orderBy(asc(devices.decommissionedAt))
          .limit(REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN));
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to select eligible devices for org ${orgId}:`, err);
      captureException(err);
      summary.orgsFailed += 1;
      continue;
    }

    if (candidates.length === REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN) {
      summary.orgsCapped += 1;
      console.warn(
        `${LOG_PREFIX} org ${orgId} filled the per-run cap of ${REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN}; more removed devices remain past its ${days}-day window and will be purged on subsequent runs.`,
      );
    }

    let purgedThisOrg = 0;

    for (const candidate of candidates) {
      let code: DeviceLifecycleError['code'] | null;
      try {
        code = await purgeOne(candidate.id);
      } catch (err) {
        // One device's failure must not abort the org, let alone the run.
        console.error(`${LOG_PREFIX} Unexpected error purging device ${candidate.id} (org ${orgId}):`, err);
        captureException(err);
        summary.failed += 1;
        continue;
      }

      if (code === 'UNINSTALL_PENDING') {
        // Expected and self-healing: the agent uninstall is still collectable,
        // so the device comes back around on a later run once it completes.
        summary.skippedUninstallPending += 1;
        continue;
      }
      if (code !== null) {
        // NOT_REMOVED / NOT_FOUND — restored or already deleted between the
        // SELECT and the lock. The operator's action beat the job; not an error.
        summary.skippedRaced += 1;
        continue;
      }

      summary.purged += 1;
      purgedThisOrg += 1;

      try {
        await createAuditLog({
          orgId,
          actorType: 'system',
          actorId: 'removed-device-purge',
          action: 'device.permanent_delete',
          resourceType: 'device',
          resourceId: candidate.id,
          resourceName: candidate.hostname ?? candidate.id,
          details: {
            retentionPolicy: true,
            purgeRemovedAfterDays: days,
            decommissionedAt: candidate.decommissionedAt?.toISOString() ?? null,
          },
          result: 'success',
        });
      } catch (err) {
        // The deletion has already committed. Nothing here may turn a completed
        // destructive operation into a failed one — but it must be loud, since
        // this row was the only record of it.
        console.error(`${LOG_PREFIX} audit write failed for purged device ${candidate.id}:`, err);
        captureException(err);
      }
    }

    if (purgedThisOrg > 0) {
      // #2728 — the per-org agent rate limit is sized from a cached enrolled
      // device count. Once per org, not per device: the cache key is the org's.
      try {
        await invalidateOrgDeviceCount(getRedis(), orgId);
      } catch (err) {
        console.error(`${LOG_PREFIX} device-count cache invalidation failed for org ${orgId}:`, err);
      }
    }
  }

  summary.durationMs = Date.now() - startedAt;

  console.log(
    `${LOG_PREFIX} Purged ${summary.purged} removed devices across ${summary.orgsWithPolicy}/${summary.orgsChecked} orgs ` +
    `(uninstall-pending=${summary.skippedUninstallPending}, raced=${summary.skippedRaced}, ` +
    `failed=${summary.failed}, orgs-skipped=${summary.orgsFailed}, orgs-capped=${summary.orgsCapped}) in ${summary.durationMs}ms`,
  );

  // A capped, failed or skipped org certainly still has eligible devices, so
  // all three count as an incomplete drain — otherwise a run in which every
  // policy lookup threw publishes a fresh last-run stamp and a clean 0.
  const incomplete =
    summary.orgsCapped > 0 || summary.orgsFailed > 0 || summary.failed > 0;
  recordRetentionRun('removed_device_purge', { rowsDeleted: summary.purged, incomplete });

  return summary;
}

export function createRemovedDevicePurgeWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (_job: Job) => runRemovedDevicePurgeOnce(),
    {
      connection: getBullMQConnection(),
      // The cascade takes wide row locks across ~40 tables; two of these racing
      // is contention for no throughput win.
      concurrency: 1,
    },
  );
}

export async function initializeRemovedDevicePurge(): Promise<void> {
  try {
    purgeWorker = createRemovedDevicePurgeWorker();
    attachWorkerObservability(purgeWorker, 'removedDevicePurge');

    purgeWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });

    const queue = getRemovedDevicePurgeQueue();

    // Drop stale repeatable entries first: a changed cadence would otherwise
    // leave BOTH registrations live and run the sweep twice a day.
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'purge',
      {},
      {
        // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
        // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
        // together (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('removed-device-purge') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownRemovedDevicePurge(): Promise<void> {
  if (purgeWorker) {
    await purgeWorker.close();
    purgeWorker = null;
  }
  if (purgeQueue) {
    await purgeQueue.close();
    purgeQueue = null;
  }
}

export const __testOnly = { QUEUE_NAME };
