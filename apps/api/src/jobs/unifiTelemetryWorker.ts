import { Worker, type Job, type Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { reconcileTelemetry, type TelemetryPayload } from '../services/unifi/unifiTelemetryService';
import { markCollectorPoll, getCollectorOwnerDeviceId } from '../services/unifi/unifiCollectorService';

export const UNIFI_TELEMETRY_QUEUE = 'unifi-telemetry';

let queue: Queue<TelemetryPayload> | null = null;
export function getUnifiTelemetryQueue(): Queue<TelemetryPayload> {
  if (!queue) queue = createInstrumentedQueue<TelemetryPayload>(UNIFI_TELEMETRY_QUEUE);
  return queue;
}

// Route handlers hold a DB context; the instrumented queue forbids enqueue there.
export async function enqueueUnifiTelemetry(payload: TelemetryPayload): Promise<void> {
  await runOutsideDbContext(() => getUnifiTelemetryQueue().add('ingest', payload, {
    attempts: 2, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 },
  }));
}

export async function processIngest(payload: TelemetryPayload): Promise<void> {
  await withSystemDbAccessContext(async () => {
    // Ownership gate (system context bypasses RLS): the posting agent's
    // token-resolved deviceId, stamped by the route, must own this collector.
    // Reject — without ANY write — a payload for a collector on another device.
    const ownerDeviceId = await getCollectorOwnerDeviceId(db, payload.collectorId);
    if (!ownerDeviceId || ownerDeviceId !== payload.deviceId) {
      console.warn(
        `[UnifiTelemetryWorker] rejected telemetry for collector ${payload.collectorId}: ` +
        `device mismatch (owner=${ownerDeviceId ?? 'none'}, claimed=${payload.deviceId ?? 'none'})`,
      );
      return;
    }

    if (!payload.firmwareOk) {
      await markCollectorPoll(db, payload.collectorId, 'firmware_too_old', false, payload.error ?? 'Controller firmware below 9.3 or integration disabled');
      return;
    }

    // A poll-level error means the controller was reachable but the poll was
    // partial (or fully failed). Don't stale on partial data; report the right
    // status: 'unreachable' when nothing came back, 'error' when some did.
    const partial = !!payload.error;
    try {
      await reconcileTelemetry(db, payload, { markStale: !partial });
      if (partial) {
        const empty = payload.devices.length === 0 && payload.clients.length === 0;
        await markCollectorPoll(db, payload.collectorId, empty ? 'unreachable' : 'error', true, payload.error ?? null);
      } else {
        await markCollectorPoll(db, payload.collectorId, 'connected', true, null);
      }
    } catch (err) {
      await markCollectorPoll(db, payload.collectorId, 'error', true, (err as Error).message);
      throw err; // surface to BullMQ for retry/visibility
    }
  });
}

let workerInstance: Worker<TelemetryPayload> | null = null;
export async function initializeUnifiTelemetryWorker(): Promise<void> {
  workerInstance = new Worker<TelemetryPayload>(
    UNIFI_TELEMETRY_QUEUE,
    async (job: Job<TelemetryPayload>) => processIngest(job.data),
    { connection: getBullMQConnection(), concurrency: 4 },
  );
  workerInstance.on('error', (e) => console.error('[UnifiTelemetryWorker] error:', e));
  workerInstance.on('failed', (job, e) => console.error(`[UnifiTelemetryWorker] job ${job?.id} failed:`, e));
  console.log('[UnifiTelemetryWorker] initialized');
}
