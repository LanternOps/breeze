import { createHash } from 'node:crypto';
import { Job, Queue, Worker } from 'bullmq';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { NETWORK_ISOLATION_TTL } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceNetworkIsolations, devices, incidents, type DeviceNetworkIsolation } from '../db/schema';
import { createSourcedAlert } from '../services/alertService';
import { publishEvent } from '../services/eventBus';
import { toEpisodeSnapshot, withEpisodeLock, writeEpisodeSnapshot } from '../services/networkIsolation/episodeStore';
import { synchronizeEpisodeOutcome } from '../services/networkIsolation/outcome';
import { applyEpisodeEvent } from '../services/networkIsolation/stateMachine';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'network-isolation-sweeper';
// Five minutes matches steady-state verification, well within the 12h warning
// window and the 30m delivery grace. This clock never proves rules are absent.
const SWEEP_INTERVAL_MS = 5 * 60_000;
const DELIVERY_GRACE_MS = 30 * 60_000;
const WARNING_WINDOW_MS = NETWORK_ISOLATION_TTL.expiringSoonHours * 3_600_000;
const MAX_SWEEP_PER_RUN = 500;
const PUBLISHER = 'network-isolation-sweeper';
type SweeperJobData = { type: 'sweep-network-isolations'; queuedAt: string };

function isNotDelivered(row: DeviceNetworkIsolation, now: Date): boolean {
  return (row.state === 'requested' || row.state === 'dispatched')
    && row.lastJournalSeq === 0
    && now.getTime() > row.expiresAt.getTime() + DELIVERY_GRACE_MS;
}

function isExpiring(row: DeviceNetworkIsolation, now: Date): boolean {
  return row.state === 'verified'
    && row.expiresAt.getTime() - now.getTime() <= WARNING_WINDOW_MS
    && (row.expiryWarnedAt === null || row.expiryWarnedAt.getTime() < row.expiresAt.getTime() - WARNING_WINDOW_MS);
}

/**
 * Recovery remains live when start is disabled, or a device/tenant is parked.
 * Select only existing episodes; never fan out new isolation commands.
 * Each candidate gets a fresh, short system transaction and an episode lock.
 */
export async function sweepNetworkIsolations(now: Date): Promise<{ warned: number; notDelivered: number }> {
  return runOutsideDbContext(async () => {
    const candidates = await withSystemDbAccessContext(() => db
      .select({ id: deviceNetworkIsolations.id })
      .from(deviceNetworkIsolations)
      .where(or(
        and(
          eq(deviceNetworkIsolations.state, 'verified'),
          or(
            isNull(deviceNetworkIsolations.expiryWarnedAt),
            lt(deviceNetworkIsolations.expiryWarnedAt, sql`${deviceNetworkIsolations.expiresAt} - ${WARNING_WINDOW_MS} * interval '1 millisecond'`),
          ),
          lte(deviceNetworkIsolations.expiresAt, new Date(now.getTime() + WARNING_WINDOW_MS)),
        ),
        and(
          inArray(deviceNetworkIsolations.state, ['requested', 'dispatched']),
          eq(deviceNetworkIsolations.lastJournalSeq, 0),
          lt(deviceNetworkIsolations.expiresAt, new Date(now.getTime() - DELIVERY_GRACE_MS)),
        ),
      ))
      // Both branches use the existing partial active-expiry index.
      .orderBy(asc(deviceNetworkIsolations.expiresAt), asc(deviceNetworkIsolations.id))
      .limit(MAX_SWEEP_PER_RUN));

    const counts = { warned: 0, notDelivered: 0 };
    for (const candidate of candidates) {
      try {
        const result = await withSystemDbAccessContext(() => db.transaction(tx =>
          withEpisodeLock(tx, candidate.id, async row => {
            // Discovery is only a hint: a report, release or extend may have won.
            if (isNotDelivered(row, now)) {
              const prev = toEpisodeSnapshot(row);
              const transition = applyEpisodeEvent(prev, { type: 'not_delivered', generation: row.generation, at: now });
              if (!('next' in transition) || !await writeEpisodeSnapshot(tx, row.id, prev, transition.next, now)) {
                throw new Error('Network isolation sweeper transition conflict');
              }
              await synchronizeEpisodeOutcome(tx, row, prev, transition.next, now);
              return 'notDelivered' as const;
            }
            if (!isExpiring(row, now)) return null;

            const [device] = await tx.select({ siteId: devices.siteId }).from(devices)
              .where(and(eq(devices.id, row.deviceId), eq(devices.orgId, row.orgId))).limit(1);
            const [incident] = row.incidentId
              ? await tx.select({ assignedTo: incidents.assignedTo }).from(incidents)
                .where(and(eq(incidents.id, row.incidentId), eq(incidents.orgId, row.orgId))).limit(1)
              : [];
            const payload = {
              isolationId: row.id, generation: row.generation, deviceId: row.deviceId,
              incidentId: row.incidentId, expiresAt: row.expiresAt.toISOString(),
              requestedByUserId: row.requestedByUserId, incidentOwnerUserId: incident?.assignedTo ?? null,
            };
            // Consume the warning under the episode lock, then commit before any
            // notification. Failure after commit is at-most-once for this window.
            await tx.update(deviceNetworkIsolations).set({ expiryWarnedAt: now })
              .where(eq(deviceNetworkIsolations.id, row.id));
            return { orgId: row.orgId, siteId: device?.siteId ?? null, payload };
          }),
        ));
        if (!result.found || !result.value) continue;
        if (result.value === 'notDelivered') {
          counts.notDelivered++;
          continue;
        }

        // The outer system context has committed too; alert publication can no
        // longer escape a rollback of expiryWarnedAt and repeat next sweep.
        const { orgId, siteId, payload } = result.value;
        const alertId = await withSystemDbAccessContext(() => createSourcedAlert({
          orgId, deviceId: payload.deviceId, siteId,
          severity: 'medium', title: 'Network isolation expiring',
          message: 'Network isolation expires within 12 hours. Review the incident and extend or release isolation.',
          context: { source: 'network_isolation', ...payload }, eventPayload: payload,
          publisher: PUBLISHER, triggeredAt: now,
        }));
        if (!alertId) throw new Error('Network isolation expiry alert was not published');
        const digest = createHash('sha256').update(`${payload.isolationId}:expiring:${payload.generation}`).digest('hex');
        const eventId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        await publishEvent('device.isolation_expiring', orgId, payload, PUBLISHER, { siteId, eventId });
        counts.warned++;
      } catch (error) {
        console.error('[NetworkIsolationSweeper] Candidate failed', { isolationId: candidate.id });
        captureException(error, undefined, { isolationId: candidate.id });
      }
    }
    return counts;
  });
}

let sweeperQueue: Queue<SweeperJobData> | null = null;
let sweeperWorker: Worker<SweeperJobData> | null = null;

function getQueue(): Queue<SweeperJobData> {
  if (!sweeperQueue) sweeperQueue = new Queue<SweeperJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  return sweeperQueue;
}

function createWorker(): Worker<SweeperJobData> {
  return new Worker<SweeperJobData>(QUEUE_NAME, async (_job: Job<SweeperJobData>) => {
    try {
      return await sweepNetworkIsolations(new Date());
    } catch (err) {
      console.error('[NetworkIsolationSweeper] Run failed:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }, { connection: getBullMQConnection(), concurrency: 1 });
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === 'sweep-network-isolations') await queue.removeRepeatableByKey(job.key);
  }
  await queue.add('sweep-network-isolations', { type: 'sweep-network-isolations', queuedAt: new Date().toISOString() }, {
    jobId: QUEUE_NAME, repeat: { every: SWEEP_INTERVAL_MS },
    removeOnComplete: { count: 20 }, removeOnFail: { count: 200 },
  });
}

export async function initializeNetworkIsolationSweeper(): Promise<void> {
  if (sweeperWorker) return;
  sweeperWorker = createWorker();
  attachWorkerObservability(sweeperWorker, 'networkIsolationSweeper');
  sweeperWorker.on('error', error => {
    console.error('[NetworkIsolationSweeper] Worker error:', error);
    captureException(error);
  });
  sweeperWorker.on('failed', (job, error) => {
    console.error(`[NetworkIsolationSweeper] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await sweeperWorker.close();
    sweeperWorker = null;
    throw err;
  }
}

export async function shutdownNetworkIsolationSweeper(): Promise<void> {
  const worker = sweeperWorker;
  const queue = sweeperQueue;
  sweeperWorker = null;
  sweeperQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[NetworkIsolationSweeper] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[NetworkIsolationSweeper] Error closing queue:', err); }
  }
}
