// apps/api/src/jobs/aiModelDiscoveryWorker.ts
/**
 * AI model registry (#7598) discovery queue. W01: `sync-platform` (daily,
 * manual "Refresh", and once shortly after boot). W03 (#7601) adds
 * `sync-connection` (one BYOK/catalog connection; on connect, on key or
 * endpoint rotation, and on demand) and the daily `sync-all-connections`
 * fan-out. W06 (#7604) adds gateway kinds (openai_compatible) to the fan-out;
 * a job payload carries only the connection id, never key material.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { GATEWAY_CONNECTION_KINDS } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../db';
import { partnerAiConnections } from '../db/schema';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  syncConnectionModels,
  syncPlatformModels,
  type ConnectionSyncReport,
  type SyncReport,
} from '../services/aiModels/discovery';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

export const AI_MODEL_DISCOVERY_QUEUE = 'ai-model-discovery';
export const SYNC_PLATFORM_JOB = 'sync-platform';
export const SYNC_CONNECTION_JOB = 'sync-connection';
export const SYNC_ALL_CONNECTIONS_JOB = 'sync-all-connections';

// BullMQ 5 rejects ':' in a custom jobId.
const DAILY_REPEAT_JOB_ID = 'ai-model-discovery-sync-platform-daily';
const DAILY_CONNECTIONS_REPEAT_JOB_ID = 'ai-model-discovery-sync-all-connections-daily';
const MANUAL_JOB_ID = 'ai-model-discovery-sync-platform-manual';
const BOOT_JOB_ID = 'ai-model-discovery-sync-platform-boot';
const DAILY_CRON = jobSchedule('ai-model-discovery-sync');
const DAILY_CONNECTIONS_CRON = jobSchedule('ai-model-discovery-connections');
const BOOT_DELAY_MS = 60_000;

export type AiModelDiscoveryJobData =
  | { type: 'sync-platform'; trigger: 'schedule' | 'manual' | 'boot' }
  | { type: 'sync-connection'; connectionId: string }
  | { type: 'sync-all-connections' };

let queue: Queue<AiModelDiscoveryJobData> | null = null;
let worker: Worker<AiModelDiscoveryJobData> | null = null;

export function getAiModelDiscoveryQueue(): Queue<AiModelDiscoveryJobData> {
  if (!queue) queue = new Queue<AiModelDiscoveryJobData>(AI_MODEL_DISCOVERY_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/** The index's `sync-connection:{id}`, colon-free: BullMQ rejects a custom id with ':' unless it splits into exactly 3 parts. */
export function aiModelConnectionSyncJobId(connectionId: string): string {
  return `sync-connection-${connectionId}`;
}

/**
 * Queue one connection's discovery. Collapses onto a waiting/active job for the
 * same connection; a spent (completed/failed) record is replaced. Call it
 * OUTSIDE any held DB context, after the write that motivates it committed.
 */
export async function enqueueConnectionSync(connectionId: string): Promise<void> {
  await enqueueOrReplaceStale(
    getAiModelDiscoveryQueue() as unknown as Queue,
    SYNC_CONNECTION_JOB,
    aiModelConnectionSyncJobId(connectionId),
    { type: 'sync-connection', connectionId } satisfies AiModelDiscoveryJobData,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
    '[aiModelDiscovery]',
  );
}

async function enqueueAllConnectionSyncs(): Promise<{ enqueued: number }> {
  const ids = await withSystemDbAccessContext(async () => (await db
    .select({ id: partnerAiConnections.id })
    .from(partnerAiConnections)
    .where(and(
      // W06: gateway kinds too; a kind without a discoverer is skipped by the sync itself.
      inArray(partnerAiConnections.kind, ['anthropic_byok', 'catalog', ...GATEWAY_CONNECTION_KINDS]),
      eq(partnerAiConnections.status, 'active'),
    ))).map((row) => row.id), 'aiModelDiscovery.listConnections');
  for (const id of ids) await enqueueConnectionSync(id);
  return { enqueued: ids.length };
}

export async function processAiModelDiscoveryJob(
  job: Pick<Job<AiModelDiscoveryJobData>, 'data'>,
): Promise<SyncReport | ConnectionSyncReport | { enqueued: number }> {
  switch (job.data.type) {
    case 'sync-platform': {
      const report = await syncPlatformModels();
      // A failed listing changed nothing (spec §6). Throwing lets BullMQ retry with backoff.
      if (report.status === 'failed') throw new Error(`Platform model sync failed: ${report.error}`);
      if (report.status === 'skipped') console.info(`[aiModelDiscovery] platform sync skipped: ${report.reason}`);
      return report;
    }
    case 'sync-connection': {
      const report = await syncConnectionModels(job.data.connectionId);
      // A failed listing is recorded on the connection (discovery_error) and
      // retried by the daily fan-out; a rejected partner key is not transient.
      // A listing superseded by a concurrent rotation re-runs with the new key.
      if (report.status === 'skipped' && report.retry) {
        throw new Error(`Connection model sync must re-run: ${report.error ?? 'superseded'}`);
      }
      return report;
    }
    case 'sync-all-connections':
      return enqueueAllConnectionSyncs();
    default:
      throw new Error(`Unknown ai-model-discovery job type: ${String((job.data as { type?: unknown }).type)}`);
  }
}

export async function enqueuePlatformModelSync(trigger: 'manual' | 'boot' = 'manual'): Promise<{ id: string }> {
  return enqueueOrReplaceStale(
    getAiModelDiscoveryQueue() as unknown as Queue,
    SYNC_PLATFORM_JOB,
    trigger === 'manual' ? MANUAL_JOB_ID : BOOT_JOB_ID,
    { type: 'sync-platform', trigger } satisfies AiModelDiscoveryJobData,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
      ...(trigger === 'boot' ? { delay: BOOT_DELAY_MS } : {}),
    },
    '[aiModelDiscovery]',
  );
}

export async function scheduleAiModelDiscoveryJobs(): Promise<void> {
  const q = getAiModelDiscoveryQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(SYNC_PLATFORM_JOB, { type: 'sync-platform', trigger: 'schedule' }, {
    jobId: DAILY_REPEAT_JOB_ID,
    repeat: { pattern: DAILY_CRON },
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
  await q.add(SYNC_ALL_CONNECTIONS_JOB, { type: 'sync-all-connections' }, {
    jobId: DAILY_CONNECTIONS_REPEAT_JOB_ID,
    repeat: { pattern: DAILY_CONNECTIONS_CRON },
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
}

export async function initializeAiModelDiscoveryWorker(): Promise<void> {
  worker = new Worker<AiModelDiscoveryJobData>(AI_MODEL_DISCOVERY_QUEUE, processAiModelDiscoveryJob, {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'aiModelDiscoveryWorker');
  worker.on('error', (error) => {
    console.error('[aiModelDiscovery] worker error:', error);
    captureException(error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[aiModelDiscovery] job ${job?.id ?? '?'} failed:`, error);
    captureException(error);
  });
  await scheduleAiModelDiscoveryJobs();
  await enqueuePlatformModelSync('boot');
}

export async function shutdownAiModelDiscoveryWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}

export const __testOnly = { DAILY_REPEAT_JOB_ID, DAILY_CONNECTIONS_REPEAT_JOB_ID, MANUAL_JOB_ID, BOOT_JOB_ID, DAILY_CRON, DAILY_CONNECTIONS_CRON };
