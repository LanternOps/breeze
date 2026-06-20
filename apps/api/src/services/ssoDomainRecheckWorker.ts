import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { getBullMQConnection } from './redis';
import { recheckAllDomains } from './ssoDomainVerification';

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const SSO_DOMAIN_RECHECK_QUEUE = 'sso-domain-recheck';

let recheckQueue: Queue | null = null;
let recheckWorker: Worker | null = null;

interface RecheckAllJob { type: 'recheck-all'; }

export function getSsoDomainRecheckQueue(): Queue {
  if (!recheckQueue) {
    recheckQueue = new Queue(SSO_DOMAIN_RECHECK_QUEUE, { connection: getBullMQConnection() });
  }
  return recheckQueue;
}

function createSsoDomainRecheckWorker(): Worker<RecheckAllJob> {
  return new Worker<RecheckAllJob>(
    SSO_DOMAIN_RECHECK_QUEUE,
    async (job: Job<RecheckAllJob>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'recheck-all') {
          const result = await recheckAllDomains();
          console.log(`[SsoDomainRecheck] Rechecked ${result.checked} domains, ${result.verified} verified`);
          return result;
        }
        throw new Error(`Unknown sso-domain-recheck job type: ${(job.data as { type: string }).type}`);
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

async function scheduleSsoDomainRecheckJobs(): Promise<void> {
  const queue = getSsoDomainRecheckQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    'recheck-all',
    { type: 'recheck-all' },
    {
      repeat: { every: 24 * 60 * 60 * 1000 }, // daily
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    }
  );
  console.log('[SsoDomainRecheck] Scheduled daily SSO domain re-check job');
}

export async function initializeSsoDomainRecheckWorker(): Promise<void> {
  try {
    recheckWorker = createSsoDomainRecheckWorker();
    recheckWorker.on('error', (error) => console.error('[SsoDomainRecheck] Worker error:', error));
    recheckWorker.on('failed', (job, error) => console.error(`[SsoDomainRecheck] Job ${job?.id} failed:`, error));
    await scheduleSsoDomainRecheckJobs();
    console.log('[SsoDomainRecheck] Worker initialized');
  } catch (error) {
    console.error('[SsoDomainRecheck] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownSsoDomainRecheckWorker(): Promise<void> {
  if (recheckWorker) { await recheckWorker.close(); recheckWorker = null; }
  if (recheckQueue) { await recheckQueue.close(); recheckQueue = null; }
  console.log('[SsoDomainRecheck] Worker shut down');
}
