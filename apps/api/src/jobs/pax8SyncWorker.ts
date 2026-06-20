import { type JobsOptions, Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { pax8Integrations } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { captureException } from '../services/sentry';
import { syncPax8Integration } from '../services/pax8SyncService';

const PAX8_QUEUE = 'pax8-sync';
const PAX8_SYNC_CRON = '15 4 * * *';

type Pax8SyncJobData =
  | { type: 'sync-integration'; integrationId: string }
  | { type: 'sync-all' };

let pax8Queue: Queue<Pax8SyncJobData> | null = null;
let pax8Worker: Worker<Pax8SyncJobData> | null = null;

export function getPax8SyncQueue(): Queue<Pax8SyncJobData> {
  if (!pax8Queue) {
    pax8Queue = new Queue<Pax8SyncJobData>(PAX8_QUEUE, { connection: getBullMQConnection() });
  }
  return pax8Queue;
}

/**
 * Add a job with a fixed jobId, re-adding it if a prior job with that id has
 * already settled. BullMQ dedups on jobId and `removeOnComplete: { count }`
 * retains completed jobs, so a plain `queue.add` with this jobId would be a
 * silent no-op on every call after the first — the nightly fan-out and manual
 * `POST /sync` would run once and then never again. We reuse a job that is
 * still pending and remove a settled one before re-adding. Mirrors the
 * Huntress sync worker's `addUniqueJob`.
 */
async function addUniquePax8Job(
  jobId: string,
  data: Pax8SyncJobData,
  opts: Omit<JobsOptions, 'jobId'>,
): Promise<string> {
  const queue = getPax8SyncQueue();
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((err) => {
      console.warn(`[Pax8SyncWorker] Failed to remove stale job ${jobId}, proceeding with re-add:`, err);
    });
  }
  const created = await queue.add('sync-integration', data, { jobId, ...opts });
  return String(created.id);
}

export async function enqueuePax8Sync(integrationId: string): Promise<string> {
  return addUniquePax8Job(
    `pax8-sync-${integrationId}`,
    { type: 'sync-integration', integrationId },
    {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
}

export async function processPax8SyncIntegration(integrationId: string) {
  // syncPax8Integration self-manages its DB contexts so its Pax8 API fetch runs
  // outside any held transaction (#1697); no blanket wrap here.
  return syncPax8Integration(integrationId);
}

export async function processPax8SyncAll(): Promise<{ queued: number; failed: number }> {
  const integrations = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select({ id: pax8Integrations.id })
        .from(pax8Integrations)
        .where(eq(pax8Integrations.isActive, true))
    )
  );

  let queued = 0;
  let failed = 0;
  for (const integration of integrations) {
    try {
      await enqueuePax8Sync(integration.id);
      queued++;
    } catch (err) {
      failed++;
      console.error('[Pax8SyncWorker] failed to queue sync', `integrationId=${integration.id}`, err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return { queued, failed };
}

export function createPax8SyncWorker(): Worker<Pax8SyncJobData> {
  return new Worker<Pax8SyncJobData>(
    PAX8_QUEUE,
    async (job) => {
      switch (job.data.type) {
        case 'sync-integration':
          return processPax8SyncIntegration(job.data.integrationId);
        case 'sync-all':
          return processPax8SyncAll();
        default:
          throw new Error(`Unknown Pax8 sync job: ${(job.data as { type: string }).type}`);
      }
    },
    { connection: getBullMQConnection(), concurrency: 2 },
  );
}

export async function schedulePax8SyncJobs(): Promise<void> {
  const queue = getPax8SyncQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    'sync-all',
    { type: 'sync-all' },
    {
      repeat: { pattern: PAX8_SYNC_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
  console.log('[Pax8SyncWorker] Scheduled nightly Pax8 sync');
}

export async function initializePax8SyncWorkers(): Promise<void> {
  try {
    pax8Worker = createPax8SyncWorker();
    pax8Worker.on('error', (error) => {
      console.error('[Pax8SyncWorker] Worker error:', error);
      captureException(error);
    });
    pax8Worker.on('failed', (job, error) => {
      console.error(`[Pax8SyncWorker] Job ${job?.id} failed:`, error);
      captureException(error);
    });
    await schedulePax8SyncJobs();
    console.log('[Pax8SyncWorker] Pax8 sync workers initialized');
  } catch (error) {
    console.error('[Pax8SyncWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownPax8SyncWorkers(): Promise<void> {
  if (pax8Worker) {
    await pax8Worker.close();
    pax8Worker = null;
  }
  if (pax8Queue) {
    await pax8Queue.close();
    pax8Queue = null;
  }
  console.log('[Pax8SyncWorker] Pax8 sync workers shut down');
}
