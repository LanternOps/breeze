import { type JobsOptions, Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { tdSynnexSftpIntegrations } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { captureException } from '../services/sentry';
import { syncSftpPriceFile } from '../services/tdSynnexSftpSync';

const TDS_SFTP_QUEUE = 'td-synnex-sftp-sync';
/**
 * TD SYNNEX regenerates the P&A file nightly. Run at 05:40 UTC — after their
 * generation window and offset from the Pax8 sweep (04:15) so the two nightly
 * distributor syncs don't contend for the same pooled DB connections.
 */
const TDS_SFTP_SYNC_CRON = '40 5 * * *';

type TdSynnexSftpJobData =
  | { type: 'sync-integration'; integrationId: string }
  | { type: 'sync-all' };

let sftpQueue: Queue<TdSynnexSftpJobData> | null = null;
let sftpWorker: Worker<TdSynnexSftpJobData> | null = null;

export function getTdSynnexSftpQueue(): Queue<TdSynnexSftpJobData> {
  if (!sftpQueue) {
    sftpQueue = new Queue<TdSynnexSftpJobData>(TDS_SFTP_QUEUE, { connection: getBullMQConnection() });
  }
  return sftpQueue;
}

/**
 * BullMQ dedups on jobId and `removeOnComplete: { count }` retains completed
 * jobs, so a plain `queue.add` with a fixed jobId is a silent no-op after the
 * first run. Reuse a still-pending job; remove a settled one before re-adding.
 * (Same trap as the Pax8 and Huntress workers.)
 */
async function addUniqueSftpJob(
  jobId: string,
  data: TdSynnexSftpJobData,
  opts: Omit<JobsOptions, 'jobId'>,
): Promise<string> {
  const queue = getTdSynnexSftpQueue();
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((err) => {
      console.warn(`[TdSynnexSftpWorker] Failed to remove stale job ${jobId}, proceeding with re-add:`, err);
    });
  }
  const created = await queue.add('sync-integration', data, { jobId, ...opts });
  return String(created.id);
}

export async function enqueueTdSynnexSftpSync(integrationId: string): Promise<string> {
  // jobIds must not contain ':' (BullMQ key separator) — use '-'.
  return addUniqueSftpJob(
    `td-synnex-sftp-sync-${integrationId}`,
    { type: 'sync-integration', integrationId },
    {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}

export async function processTdSynnexSftpSyncIntegration(integrationId: string) {
  // syncSftpPriceFile self-manages its DB contexts so the multi-minute SFTP
  // download and parse run outside any held transaction (#1105 / #1697).
  return syncSftpPriceFile(integrationId);
}

export async function processTdSynnexSftpSyncAll(): Promise<{ queued: number; failed: number }> {
  const integrations = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select({ id: tdSynnexSftpIntegrations.id })
        .from(tdSynnexSftpIntegrations)
        .where(eq(tdSynnexSftpIntegrations.enabled, true))
    )
  );

  let queued = 0;
  let failed = 0;
  for (const integration of integrations) {
    try {
      await enqueueTdSynnexSftpSync(integration.id);
      queued++;
    } catch (err) {
      failed++;
      console.error('[TdSynnexSftpWorker] failed to queue sync', `integrationId=${integration.id}`, err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return { queued, failed };
}

export function createTdSynnexSftpWorker(): Worker<TdSynnexSftpJobData> {
  return new Worker<TdSynnexSftpJobData>(
    TDS_SFTP_QUEUE,
    async (job) => {
      switch (job.data.type) {
        case 'sync-integration':
          return processTdSynnexSftpSyncIntegration(job.data.integrationId);
        case 'sync-all':
          return processTdSynnexSftpSyncAll();
        default:
          throw new Error(`Unknown TD SYNNEX SFTP sync job: ${(job.data as { type: string }).type}`);
      }
    },
    // Concurrency 1: each job downloads and parses a large file, so the memory
    // cost of running several partners' catalogs at once is what bounds this.
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function scheduleTdSynnexSftpJobs(): Promise<void> {
  const queue = getTdSynnexSftpQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    'sync-all',
    { type: 'sync-all' },
    {
      repeat: { pattern: TDS_SFTP_SYNC_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
  console.log('[TdSynnexSftpWorker] Scheduled nightly TD SYNNEX P&A sync');
}

export async function initializeTdSynnexSftpWorkers(): Promise<void> {
  try {
    sftpWorker = createTdSynnexSftpWorker();
    sftpWorker.on('error', (error) => {
      console.error('[TdSynnexSftpWorker] Worker error:', error);
      captureException(error);
    });
    sftpWorker.on('failed', (job, error) => {
      console.error(`[TdSynnexSftpWorker] Job ${job?.id} failed:`, error);
      captureException(error);
    });
    await scheduleTdSynnexSftpJobs();
    console.log('[TdSynnexSftpWorker] TD SYNNEX SFTP sync workers initialized');
  } catch (error) {
    console.error('[TdSynnexSftpWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownTdSynnexSftpWorkers(): Promise<void> {
  if (sftpWorker) {
    await sftpWorker.close();
    sftpWorker = null;
  }
  if (sftpQueue) {
    await sftpQueue.close();
    sftpQueue = null;
  }
  console.log('[TdSynnexSftpWorker] TD SYNNEX SFTP sync workers shut down');
}
