/**
 * Hourly re-check of verified customer domains (portal registration W5,
 * #11382, plan Task 6 / D10-D11). Each tick re-checks verified rows last
 * checked more than 23 h ago, oldest first, at most 100, one at a time.
 *
 * `recheckCustomerDomain` manages its own system-scope transactions and
 * refuses to run with a DB context held (the network check must not sit in a
 * transaction), so neither the processor nor the batch is wrapped in a context.
 */
import { Queue, Worker, Job } from 'bullmq';
import { runOutsideDbContext } from '../db';
import { getBullMQConnection } from './redis';
import { createInstrumentedQueue } from './bullmqQueue';
import { captureException } from './sentry';
import {
  PORTAL_DOMAIN_STALE_DAYS,
  listCustomerDomainsDueForRecheck,
  recheckCustomerDomain,
  type DomainVerificationCheckers,
} from './portalDomainVerification';
import { jobSchedule } from '../jobs/scheduleRegistry';
import { attachWorkerObservability } from '../jobs/workerObservability';

export const PORTAL_DOMAIN_RECHECK_QUEUE = 'portal-domain-recheck';
export const PORTAL_DOMAIN_RECHECK_BATCH = 100;
export const PORTAL_DOMAIN_RECHECK_MIN_AGE_HOURS = 23;

const HOUR_MS = 3_600_000;

let recheckQueue: Queue | null = null;
let recheckWorker: Worker | null = null;

interface RecheckJob { type: 'recheck'; }

export function getPortalDomainRecheckQueue(): Queue {
  if (!recheckQueue) {
    recheckQueue = createInstrumentedQueue(PORTAL_DOMAIN_RECHECK_QUEUE);
  }
  return recheckQueue;
}

export async function runPortalDomainRecheck(
  deps: { now?: Date; checkers?: DomainVerificationCheckers } = {},
): Promise<{ checked: number; cleared: number }> {
  const now = deps.now ?? new Date();
  const olderThan = new Date(now.getTime() - PORTAL_DOMAIN_RECHECK_MIN_AGE_HOURS * HOUR_MS);

  return runOutsideDbContext(async () => {
    const staleBefore = new Date(now.getTime() - PORTAL_DOMAIN_STALE_DAYS * 24 * HOUR_MS);
    const ids = await listCustomerDomainsDueForRecheck(olderThan, PORTAL_DOMAIN_RECHECK_BATCH, staleBefore);
    let checked = 0;
    let cleared = 0;
    for (const id of ids) {
      try {
        const outcome = await recheckCustomerDomain(id, { now, checkers: deps.checkers });
        if (outcome.status === 'skipped') continue;
        checked += 1;
        if (outcome.cleared) cleared += 1;
      } catch (error) {
        console.error(
          `[PortalDomainRecheck] Re-check failed for customer domain ${id}:`,
          error instanceof Error ? error.message : String(error),
        );
        captureException(error);
      }
    }
    return { checked, cleared };
  });
}

function createPortalDomainRecheckWorker(): Worker<RecheckJob> {
  return new Worker<RecheckJob>(
    PORTAL_DOMAIN_RECHECK_QUEUE,
    async (job: Job<RecheckJob>) => {
      if (job.data.type === 'recheck') {
        const result = await runPortalDomainRecheck();
        if (result.checked > 0) {
          console.log(`[PortalDomainRecheck] Re-checked ${result.checked} domains, ${result.cleared} cleared`);
        }
        return result;
      }
      throw new Error(`Unknown portal-domain-recheck job type: ${(job.data as { type: string }).type}`);
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
}

async function schedulePortalDomainRecheckJobs(): Promise<void> {
  const queue = getPortalDomainRecheckQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    'recheck',
    { type: 'recheck' },
    {
      // Hourly at a registry-allocated slot (jobs/scheduleRegistry.ts).
      repeat: { pattern: jobSchedule('portal-domain-recheck') },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
  console.log('[PortalDomainRecheck] Scheduled hourly portal domain re-check job');
}

export async function initializePortalDomainRecheckWorker(): Promise<void> {
  try {
    recheckWorker = createPortalDomainRecheckWorker();
    attachWorkerObservability(recheckWorker, 'portalDomainRecheckWorker');
    recheckWorker.on('error', (error) => console.error('[PortalDomainRecheck] Worker error:', error));
    recheckWorker.on('failed', (job, error) => console.error(`[PortalDomainRecheck] Job ${job?.id} failed:`, error));
    await schedulePortalDomainRecheckJobs();
    console.log('[PortalDomainRecheck] Worker initialized');
  } catch (error) {
    console.error('[PortalDomainRecheck] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownPortalDomainRecheckWorker(): Promise<void> {
  if (recheckWorker) { await recheckWorker.close(); recheckWorker = null; }
  if (recheckQueue) { await recheckQueue.close(); recheckQueue = null; }
  console.log('[PortalDomainRecheck] Worker shut down');
}
