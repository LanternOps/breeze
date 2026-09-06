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
 *  - THAT STATUS RE-CHECK IS NOT SUFFICIENT ON ITS OWN, so the ORG and the
 *    ELIGIBILITY WINDOW are re-read in the same statement that takes the lock
 *    (`purgeOneRemovedDevice`). The candidate SELECT is unlocked and its rows
 *    are purged sequentially, so a device can be moved to another tenant, or
 *    restored and re-removed, long after it was chosen and while `status`
 *    stays `decommissioned`. See that function's own note.
 *
 *  - ONE AUDIT ROW PER DELETION. The devices row is gone afterwards, so the
 *    audit entry is the ONLY durable record that this happened. It carries
 *    `retentionPolicy: true` and the window that authorised it, so an operator
 *    reading the trail can tell a policy-driven deletion from a human one.
 *
 * Structure mirrors `jobs/eventLogRetention.ts` (lazy Queue/Worker singletons,
 * short-lived system contexts, per-org loop, `recordRetentionRun`).
 */
import { Queue, Worker } from 'bullmq';
import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, organizations } from '../db/schema';
import { getBullMQConnection, getRedis } from '../services/redis';
import { createAuditLog } from '../services/auditService';
import { ANONYMOUS_ACTOR_ID } from '../services/auditEvents';
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

/** Why one device was not purged. `null` means it was. */
export type RemovedDevicePurgeSkip =
  | DeviceLifecycleError['code']
  | 'ORG_CHANGED'
  | 'NO_LONGER_ELIGIBLE';

export interface RemovedDevicePurgeCandidate {
  deviceId: string;
  /** The org the device was in when the candidate SELECT chose it. */
  orgId: string;
  /** The cutoff that SELECT applied — re-applied here, under the lock. */
  cutoff: Date;
}

/**
 * One device, in its own system-scoped transaction, with the eligibility facts
 * RE-CHECKED under the row lock.
 *
 * `purgeRemovedDevice` re-checks `status` under its own `FOR UPDATE`, and that
 * alone is not enough. The candidate SELECT is unlocked and its results are
 * purged sequentially, up to 200 per org, so minutes can pass between "this
 * device is eligible" and "this device is being deleted". Two things can change
 * in that window while `status` stays `decommissioned`:
 *
 *   - MOVE-ORG. The device now belongs to a different tenant, whose policy may
 *     say nothing about purging at all. Deleting it here destroys a device
 *     under a window its current owner never agreed to, and writes the audit
 *     row — the only surviving record — against the OLD org.
 *   - RESTORE THEN RE-REMOVE. `decommissioned_at` is refreshed to now, so the
 *     device is freshly removed and nowhere near the window; `status` is
 *     `decommissioned` again, so the status re-check waves it through.
 *
 * So both facts are re-read in the same statement that takes the lock, exactly
 * as `jobs/deviceBulkPurge.ts` re-derives ownership before its own purge. The
 * second `FOR UPDATE` the service then takes on this row in this transaction is
 * a no-op on a lock we already hold.
 *
 * Returns the skip reason, or `null` when the device was purged. Only
 * `DeviceLifecycleError` is translated; anything else propagates so the caller
 * can count it as a failure and report it — a deadlock or a constraint
 * violation is not a "skip".
 *
 * Exported so a test can prove the re-check directly, with a deliberately stale
 * cutoff, rather than trying to win a race against a whole sweep.
 */
export async function purgeOneRemovedDevice(
  candidate: RemovedDevicePurgeCandidate,
): Promise<RemovedDevicePurgeSkip | null> {
  try {
    return await inSystemContext('removedDevicePurge.purgeOne', () =>
      db.transaction(async (tx): Promise<RemovedDevicePurgeSkip | null> => {
        const rows = (await tx.execute(
          sql`SELECT org_id, decommissioned_at FROM devices WHERE id = ${candidate.deviceId} FOR UPDATE`,
        )) as unknown as Array<{ org_id: string; decommissioned_at: Date | string | null }>;
        const row = Array.isArray(rows) ? rows[0] : undefined;

        // Gone already (a concurrent purge, or a cascading org delete). Not an
        // error — the outcome this run wanted is the outcome that happened.
        if (!row) return 'NOT_FOUND';
        if (row.org_id !== candidate.orgId) return 'ORG_CHANGED';

        const stamp = row.decommissioned_at === null ? null : new Date(row.decommissioned_at);
        // `null` here means the removal time became unknown under the lock,
        // which is the same fail-closed answer the candidate query gives it.
        if (stamp === null || Number.isNaN(stamp.getTime())) return 'NO_LONGER_ELIGIBLE';
        if (stamp.getTime() >= candidate.cutoff.getTime()) return 'NO_LONGER_ELIGIBLE';

        await purgeRemovedDevice(tx, candidate.deviceId);
        return null;
      }));
  } catch (err) {
    // Deliberately caught OUTSIDE the transaction so a DeviceLifecycleError
    // still rolls it back, exactly as before.
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
      let code: RemovedDevicePurgeSkip | null;
      try {
        code = await purgeOneRemovedDevice({
          deviceId: candidate.id,
          orgId,
          // The SAME cutoff the candidate query used, re-applied under the
          // lock. Recomputing it from a fresh `now()` would let a long run
          // widen its own window as it goes.
          cutoff,
        });
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
        // NOT_REMOVED / NOT_FOUND / ORG_CHANGED / NO_LONGER_ELIGIBLE — restored,
        // moved, re-removed or already deleted between the SELECT and the lock.
        // Something else beat the job to the row; none of it is an error.
        summary.skippedRaced += 1;
        continue;
      }

      summary.purged += 1;
      purgedThisOrg += 1;

      try {
        await createAuditLog({
          orgId,
          actorType: 'system',
          // `audit_logs.actor_id` is `uuid NOT NULL`, so the job name cannot go
          // here (the plan's `'removed-device-purge'` would fail
          // string_to_uuid). Same convention as every other scheduled writer:
          // the anonymous system actor, with the job named in `details.job`.
          actorId: ANONYMOUS_ACTOR_ID,
          action: 'device.permanent_delete',
          resourceType: 'device',
          resourceId: candidate.id,
          resourceName: candidate.hostname ?? candidate.id,
          details: {
            job: 'removed-device-purge',
            // What distinguishes this row from a human's Permanently Delete.
            retentionPolicy: true,
            purgeRemovedAfterDays: days,
            decommissionedAt: candidate.decommissionedAt?.toISOString() ?? null,
          },
          result: 'success',
          initiatedBy: 'schedule',
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
    // The job carries no payload: the sweep reads every org's policy itself.
    () => runRemovedDevicePurgeOnce(),
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
