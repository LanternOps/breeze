import { Worker, type Job, type Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { unifiIntegrations } from '../db/schema';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { createUnifiClient } from '../services/unifi/unifiClient';
import { getDecryptedApiKey, markStatus, markSynced } from '../services/unifi/unifiConnectionService';
import { syncIntegration } from '../services/unifi/unifiSyncService';
import { attachWorkerObservability } from './workerObservability';

export const UNIFI_SYNC_QUEUE = 'unifi-sync';
const SYNC_SCHEDULER_JOB = 'sync-scheduler';
const SYNC_INTEGRATION_JOB = 'sync-integration';
const SYNC_INTERVAL_MS = 30 * 60 * 1000;

const jobSchema = z.union([
  z.object({ type: z.literal(SYNC_SCHEDULER_JOB) }),
  z.object({
    type: z.literal(SYNC_INTEGRATION_JOB),
    integrationId: z.string().uuid(),
    partnerId: z.string().uuid(),
    trigger: z.enum(['scheduled', 'manual']),
  }),
]);

type UnifiJobData = z.infer<typeof jobSchema>;
type SyncIntegrationJobData = Extract<UnifiJobData, { type: typeof SYNC_INTEGRATION_JOB }>;

let unifiSyncQueue: Queue<UnifiJobData> | null = null;
let unifiWorker: Worker<UnifiJobData> | null = null;

export function getUnifiSyncQueue(): Queue<UnifiJobData> {
  if (!unifiSyncQueue) {
    unifiSyncQueue = createInstrumentedQueue<UnifiJobData>(UNIFI_SYNC_QUEUE);
  }
  return unifiSyncQueue;
}

export async function enqueueUnifiSync(
  integrationId: string,
  partnerId: string,
  trigger: 'manual',
): Promise<void> {
  await runOutsideDbContext(() =>
    getUnifiSyncQueue().add(
      SYNC_INTEGRATION_JOB,
      { type: SYNC_INTEGRATION_JOB, integrationId, partnerId, trigger },
      {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    )
  );
}

function isAuthFailure(message: string): boolean {
  return /\b401\b|unauthorized/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function processScheduler(): Promise<{ queued: number }> {
  const integrations = await withSystemDbAccessContext(() =>
    db
      .select({
        id: unifiIntegrations.id,
        partnerId: unifiIntegrations.partnerId,
      })
      .from(unifiIntegrations)
      .where(eq(unifiIntegrations.isActive, true))
  );

  const queue = getUnifiSyncQueue();
  for (const integration of integrations) {
    await queue.add(
      SYNC_INTEGRATION_JOB,
      {
        type: SYNC_INTEGRATION_JOB,
        integrationId: integration.id,
        partnerId: integration.partnerId,
        trigger: 'scheduled',
      },
      {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    );
  }

  return { queued: integrations.length };
}

async function processSyncIntegration(data: SyncIntegrationJobData): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const apiKey = await getDecryptedApiKey(db, data.partnerId);
    if (!apiKey) {
      await markStatus(db, data.integrationId, data.partnerId, 'reauth_required', 'No API key on connection');
      return;
    }

    const [integration] = await db
      .select({ baseUrl: unifiIntegrations.baseUrl })
      .from(unifiIntegrations)
      .where(
        and(
          eq(unifiIntegrations.id, data.integrationId),
          eq(unifiIntegrations.partnerId, data.partnerId),
        ),
      )
      .limit(1);

    const client = createUnifiClient({
      baseUrl: integration?.baseUrl ?? 'https://api.ui.com',
      apiKey,
    });

    try {
      const result = await syncIntegration(
        { db, client },
        { id: data.integrationId, partnerId: data.partnerId },
        data.trigger,
      );
      await markSynced(db, data.integrationId, data.partnerId, result.status, result.error ?? null);
      if (result.status === 'failed') {
        const message = result.error ?? 'UniFi sync failed';
        await markStatus(
          db,
          data.integrationId,
          data.partnerId,
          isAuthFailure(message) ? 'reauth_required' : 'error',
          message,
        );
        return;
      }

      await markStatus(db, data.integrationId, data.partnerId, 'connected', result.error ?? null);
    } catch (error) {
      const message = errorMessage(error);
      await markStatus(
        db,
        data.integrationId,
        data.partnerId,
        isAuthFailure(message) ? 'reauth_required' : 'error',
        message,
      );
      await markSynced(db, data.integrationId, data.partnerId, 'failed', message);
    }
  });
}

function createWorker(): Worker<UnifiJobData> {
  return new Worker<UnifiJobData>(
    UNIFI_SYNC_QUEUE,
    async (job: Job<UnifiJobData>) => {
      const data = jobSchema.parse(job.data);
      if (data.type === SYNC_SCHEDULER_JOB) {
        return processScheduler();
      }
      return processSyncIntegration(data);
    },
    {
      connection: getBullMQConnection(),
      concurrency: 3,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
}

async function scheduleUnifiSync(): Promise<void> {
  const queue = getUnifiSyncQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === SYNC_SCHEDULER_JOB) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    SYNC_SCHEDULER_JOB,
    { type: SYNC_SCHEDULER_JOB },
    {
      jobId: 'unifi-sync-scheduler',
      repeat: { every: SYNC_INTERVAL_MS },
      attempts: 1,
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 },
    },
  );
}

export async function initializeUnifiWorker(): Promise<void> {
  unifiWorker = createWorker();
  attachWorkerObservability(unifiWorker, 'unifiWorker');
  unifiWorker.on('error', (error) => {
    console.error('[UnifiWorker] Worker error:', error);
  });
  unifiWorker.on('failed', (job, error) => {
    console.error(`[UnifiWorker] Job ${job?.id} (${job?.data?.type}) failed:`, error);
  });

  await scheduleUnifiSync();
  console.log('[UnifiWorker] UniFi sync worker initialized');
}
