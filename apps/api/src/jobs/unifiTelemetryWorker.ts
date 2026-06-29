import { Worker, type Job, type Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { reconcileTelemetry, type TelemetryPayload } from '../services/unifi/unifiTelemetryService';
import { markCollectorPoll } from '../services/unifi/unifiCollectorService';

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

async function processIngest(payload: TelemetryPayload): Promise<void> {
  await withSystemDbAccessContext(async () => {
    if (!payload.firmwareOk) {
      await markCollectorPoll(db, payload.collectorId, 'firmware_too_old', false, payload.error ?? 'Controller firmware below 9.3 or integration disabled');
      return;
    }
    try {
      await reconcileTelemetry(db, payload);
      await markCollectorPoll(db, payload.collectorId, 'connected', true, payload.error ?? null);
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
