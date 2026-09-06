/**
 * Dynamic device-group membership re-evaluation queue (#4630).
 *
 * WHY A QUEUE. The request handlers that observe a device attribute change
 * (agent heartbeat, agent enrollment, device provisioning) all run inside
 * `withDbAccessContext`, which is a real `baseDb.transaction(...)` holding a
 * pooled Postgres connection. Re-evaluating group membership inline there is
 * unbounded work — one SELECT + filter evaluation per dynamic group in the
 * org, plus an INSERT/DELETE, a membership-log write and a peripheral-policy
 * enqueue (2-3 Redis round trips) per membership flip — all while the
 * heartbeat's `UPDATE devices` row lock is still held. That is exactly the
 * pool-starvation shape of the 09-03 US incident, on the highest-volume
 * endpoint in the product.
 *
 * So the request side does nothing but hand the device id to this queue, and
 * a worker does the evaluation afterwards, off the request's connection:
 *
 *   - Coalesced per device under a fixed `jobId` (`group-reeval-<deviceId>`),
 *     the same shape `jobs/peripheralJobs.ts` uses for
 *     `policy-reconciliation-<deviceId>`. A device that flaps hostname three
 *     times in one second re-evaluates once, with the union of the changed
 *     fields — a burst can never fan out into a burst of evaluations.
 *   - `requestDeviceGroupReevaluation` is FIRE-AND-FORGET on purpose: it
 *     returns a promise the caller must not await, so not even the enqueue's
 *     own Redis round trips happen while the request transaction is open, and
 *     a Redis outage can never turn into a failed heartbeat. It touches no
 *     Postgres connection, so unlike a detached DB call it cannot be stranded
 *     on a committed transaction (the #3182 materialization bug).
 *   - The worker wraps the evaluation in `withSystemDbAccessContext` and
 *     re-reads the device's OWN org id from the database rather than trusting
 *     the job payload, so a stale or forged payload can never steer an
 *     evaluation at another tenant's groups. Without a DB access context the
 *     forced-RLS `breeze_app` role returns zero rows from every SELECT, which
 *     would make the whole evaluation a silent no-op.
 */
import { randomUUID } from 'node:crypto';
import { Job, Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';

import * as dbModule from '../db';
import { devices } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { attachWorkerObservability } from './workerObservability';
import {
  createDeviceChangeEvent,
  emitDeviceChange,
  initializeDeviceEventHandlers,
} from '../events/deviceEvents';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

export const DEVICE_GROUP_REEVALUATION_QUEUE = 'device-group-reevaluation';
const JOB_NAME = 'group-reevaluation';

/**
 * Only the two event types a request path can produce. `device.deleted` is
 * handled synchronously by the cascade, and the hardware/network/software
 * variants have no wired producer yet (see the PR body's unwired list).
 */
export type DeviceGroupReevaluationEventType = 'device.created' | 'device.updated';

export interface DeviceGroupReevaluationJobData {
  type: 'group-reevaluation';
  deviceId: string;
  orgId: string;
  eventType: DeviceGroupReevaluationEventType;
  changedFields: string[];
  reason: string;
  queuedAt: string;
}

let queue: Queue<DeviceGroupReevaluationJobData> | null = null;
let worker: Worker<DeviceGroupReevaluationJobData> | null = null;

export function getDeviceGroupReevaluationQueue(): Queue<DeviceGroupReevaluationJobData> {
  if (!queue) {
    queue = new Queue<DeviceGroupReevaluationJobData>(DEVICE_GROUP_REEVALUATION_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return queue;
}

export function deviceGroupReevaluationJobId(deviceId: string): string {
  return `group-reeval-${deviceId}`;
}

/**
 * Merge a newly requested re-evaluation into one that is already queued.
 *
 * `device.created` subsumes `device.updated`: the created handler evaluates
 * EVERY dynamic group in the org rather than only the ones whose filter keys
 * on a changed field, so collapsing the pair down to `device.updated` would
 * drop groups. Changed fields are unioned for the same reason — the coalesced
 * job has to cover everything each of its inputs would have covered.
 */
export function mergeReevaluationRequests(
  existing: Pick<DeviceGroupReevaluationJobData, 'eventType' | 'changedFields'>,
  incoming: Pick<DeviceGroupReevaluationJobData, 'eventType' | 'changedFields'>,
): { eventType: DeviceGroupReevaluationEventType; changedFields: string[] } {
  const eventType: DeviceGroupReevaluationEventType =
    existing.eventType === 'device.created' || incoming.eventType === 'device.created'
      ? 'device.created'
      : 'device.updated';
  const changedFields = [...new Set([...(existing.changedFields ?? []), ...(incoming.changedFields ?? [])])];
  return { eventType, changedFields };
}

export interface DeviceGroupReevaluationRequest {
  deviceId: string;
  orgId: string;
  eventType: DeviceGroupReevaluationEventType;
  changedFields?: string[];
  reason: string;
}

/**
 * Enqueue (or coalesce into) the re-evaluation job for one device.
 *
 * Throws on Redis failure — callers on a request path must use
 * `requestDeviceGroupReevaluation` instead, which swallows and logs.
 */
export async function scheduleDeviceGroupReevaluation(
  request: DeviceGroupReevaluationRequest,
): Promise<string> {
  const targetQueue = getDeviceGroupReevaluationQueue();
  const jobId = deviceGroupReevaluationJobId(request.deviceId);
  const changedFields = [...new Set(request.changedFields ?? [])];
  const payload: DeviceGroupReevaluationJobData = {
    type: 'group-reevaluation',
    deviceId: request.deviceId,
    orgId: request.orgId,
    eventType: request.eventType,
    changedFields,
    reason: request.reason,
    queuedAt: new Date().toISOString(),
  };

  const existing = await targetQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      if (state === 'active') {
        // Already running: its snapshot of the device predates this change, so
        // coalescing into it would drop the change entirely. Queue a distinct
        // follow-up instead (same shape as schedulePeripheralPolicyDevice).
        const followUp = await targetQueue.add(JOB_NAME, payload, {
          ...jobOptions(),
          jobId: `${jobId}-follow-up-${randomUUID()}`,
        });
        return String(followUp.id);
      }
      const merged = mergeReevaluationRequests(existing.data, payload);
      await (existing as Job<DeviceGroupReevaluationJobData>).updateData({
        ...existing.data,
        ...merged,
        reason: request.reason,
        queuedAt: payload.queuedAt,
      });
      return String(existing.id);
    }
    // A `failed`/`completed` record under this jobId would silently swallow
    // every future add (see services/bullmqUtils.ts) — drop it and re-add.
    await existing.remove().catch((error) => {
      console.error(`[DeviceGroupJobs] Failed to remove stale re-evaluation job ${jobId}:`, error);
    });
  }

  const job = await targetQueue.add(JOB_NAME, payload, { ...jobOptions(), jobId });
  return String(job.id);
}

function jobOptions() {
  return {
    attempts: 5,
    backoff: { type: 'exponential' as const, delay: 500 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  };
}

/**
 * Request-path entry point. Deliberately NOT awaited by its callers: the whole
 * point of the queue is that no Redis I/O happens while the request's Postgres
 * transaction is open. Returns the in-flight promise so tests can settle it.
 */
export function requestDeviceGroupReevaluation(
  request: DeviceGroupReevaluationRequest,
): Promise<string | null> {
  return scheduleDeviceGroupReevaluation(request).catch((error) => {
    console.error(
      `[DeviceGroupJobs] Failed to enqueue group re-evaluation for device ${request.deviceId}:`,
      error,
    );
    return null;
  });
}

/**
 * Run one re-evaluation. Assumes it is already inside a system DB access
 * context (the worker wraps it; the integration test wraps it explicitly).
 */
export async function processDeviceGroupReevaluation(
  data: DeviceGroupReevaluationJobData,
): Promise<{ evaluated: boolean; orgId: string | null }> {
  // Re-read the device's own org rather than trusting the payload: the job
  // outlives the request that produced it, and a membership write stamped from
  // a stale org id is a cross-tenant row.
  const [device] = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, data.deviceId))
    .limit(1);

  if (!device) {
    // Device deleted (or org erased) between enqueue and run — the deletion
    // cascade already removed its memberships. Nothing to do.
    return { evaluated: false, orgId: null };
  }

  // The queue can be drained by a `worker`-role process, which never runs
  // index.ts's bootstrap — without this the handler registry would be empty and
  // every job would be a silent no-op. Idempotent.
  initializeDeviceEventHandlers();

  await emitDeviceChange(
    createDeviceChangeEvent(data.eventType, data.deviceId, device.orgId, data.changedFields ?? []),
  );

  return { evaluated: true, orgId: device.orgId };
}

function createDeviceGroupReevaluationWorker(): Worker<DeviceGroupReevaluationJobData> {
  return new Worker<DeviceGroupReevaluationJobData>(
    DEVICE_GROUP_REEVALUATION_QUEUE,
    async (job: Job<DeviceGroupReevaluationJobData>) =>
      runWithSystemDbAccess(() => processDeviceGroupReevaluation(job.data)),
    {
      connection: getBullMQConnection(),
      concurrency: 4,
    },
  );
}

export async function initializeDeviceGroupJobs(): Promise<void> {
  worker = createDeviceGroupReevaluationWorker();
  attachWorkerObservability(worker, 'deviceGroupReevaluationWorker');

  worker.on('error', (error) => {
    console.error('[DeviceGroupJobs] Re-evaluation worker error:', error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[DeviceGroupJobs] Re-evaluation job ${job?.id} failed:`, error);
  });

  console.log('[DeviceGroupJobs] Dynamic device group re-evaluation worker initialized');
}

export async function shutdownDeviceGroupJobs(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
