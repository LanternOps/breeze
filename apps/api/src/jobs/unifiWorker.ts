import { Worker, type Job, type Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { unifiIntegrations, unifiSiteMappings } from '../db/schema';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { createUnifiClient } from '../services/unifi/unifiClient';
import { markStatus, markSynced } from '../services/unifi/unifiConnectionService';
import { getSyncKeys, recordKeyResults, unifiKeyLast4 } from '../services/unifi/unifiKeyService';
import { collectSyncData, applySyncData, type CollectedSync } from '../services/unifi/unifiSyncService';
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

/**
 * A failed run's integration status (plan D6): `reauth_required` only when every
 * key failed with a 401 or 403 (typed, never matched on message text), or when
 * there is no enabled key at all; `error` otherwise.
 */
function failedStatus(collected: CollectedSync): 'reauth_required' | 'error' {
  if (!collected.fatalError) return 'error';
  return collected.keyResults.every((r) => r.status !== 'success' && r.authFailure) ? 'reauth_required' : 'error';
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
      // Only cloud connections are synced from Site Manager; self-hosted ones are
      // polled by their collectors (plan D6).
      .where(and(eq(unifiIntegrations.isActive, true), eq(unifiIntegrations.connectionType, 'cloud')))
  );

  const queue = getUnifiSyncQueue();
  let queued = 0;
  for (const integration of integrations) {
    try {
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
      queued += 1;
    } catch (error) {
      // One bad enqueue must not skip every later integration this tick.
      console.error(`[UnifiWorker] Failed to enqueue sync for integration ${integration.id}:`, error);
    }
  }

  return { queued };
}

async function processSyncIntegration(data: SyncIntegrationJobData): Promise<void> {
  // 1) Short DB context: read the keys + mappings. No network I/O here, so no
  //    pooled connection is held while UniFi is being called.
  const prep = await withSystemDbAccessContext(async () => {
    const creds = await getSyncKeys(db, data.integrationId, data.partnerId);
    if (!creds) return null;
    const mappings = await db
      .select()
      .from(unifiSiteMappings)
      .where(eq(unifiSiteMappings.integrationId, data.integrationId));
    return { creds, mappings };
  });

  // Gone, inactive or self-hosted: there is nothing to sync and nothing to mark.
  if (!prep) return;

  const integration = { id: data.integrationId, partnerId: data.partnerId };
  const { keys, baseUrl } = prep.creds;
  // Each key's status write is conditional on its last_sync_at being older than
  // this, so a run that finishes late never overwrites a newer run's result.
  const runStartedAt = new Date();

  // 2) NO DB context: every enabled key's UniFi HTTP (hosts, sites, devices and
  //    ISP metrics, 429 backoff sleeps) runs here without holding a connection
  //    idle-in-transaction. A key that does not decrypt gets no client: it is a
  //    failed key, never a silent skip. Zero keys is a failed run (D6).
  const collected = await collectSyncData(
    keys.map((key) => ({
      id: key.id,
      label: key.label,
      client: key.apiKey === null ? null : createUnifiClient({ baseUrl, apiKey: key.apiKey }),
      decryptError: key.apiKey === null ? key.decryptError : undefined,
      lastSeenHostIds: key.lastSeenHostIds,
    })),
    prep.mappings,
  );
  // A backfilled key has no key_last4 yet; it is filled from the key in memory.
  const keyLast4ById = new Map<string, string>();
  for (const key of keys) {
    if (key.apiKey !== null && key.keyLast4 === null) keyLast4ById.set(key.id, unifiKeyLast4(key.apiKey));
  }
  const recordKeys = () => recordKeyResults(db, {
    integrationId: data.integrationId,
    partnerId: data.partnerId,
    runStartedAt,
    results: collected.keyResults,
    keyLast4ById,
  });

  // 3) Short DB context(s): persist the run + device reconciliation, then the
  //    key rows, the run summary and the integration status.
  try {
    const result = await withSystemDbAccessContext(() =>
      applySyncData(db, integration, data.trigger, prep.mappings, collected),
    );
    await withSystemDbAccessContext(async () => {
      await recordKeys();
      await markSynced(db, data.integrationId, data.partnerId, result.status, result.error ?? null);
      if (result.status === 'failed') {
        await markStatus(db, data.integrationId, data.partnerId, failedStatus(collected), result.error ?? 'UniFi sync failed');
      } else {
        // Partial (some keys failed) stays connected; last_sync_error names them.
        await markStatus(db, data.integrationId, data.partnerId, 'connected', result.error ?? null);
      }
    });
  } catch (error) {
    const message = errorMessage(error);
    await withSystemDbAccessContext(async () => {
      // The keys' outcomes are real even when saving the run failed.
      await recordKeys();
      await markStatus(db, data.integrationId, data.partnerId, failedStatus(collected), message);
      await markSynced(db, data.integrationId, data.partnerId, 'failed', message);
    });
  }
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

export async function shutdownUnifiWorker(): Promise<void> {
  if (unifiWorker) {
    await unifiWorker.close();
    unifiWorker = null;
  }
  if (unifiSyncQueue) {
    await unifiSyncQueue.close();
    unifiSyncQueue = null;
  }
}
