import { Job, Queue, Worker } from 'bullmq';
import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { sweepOffboardingTenants } from '../services/tenantOffboarding';
import { attachWorkerObservability } from './workerObservability';

/**
 * Offboarding drain reaper (#2774): finalizes tenants in the `offboarding`
 * drain state. A tenant finalizes when its queued self_uninstall commands are
 * all terminal, or when its drain window (offboarding_started_at +
 * OFFBOARDING_DRAIN_WINDOW_HOURS) closes. Finalization cancels leftovers with
 * an explicit never-drained audit report, severs agent credentials, and flips
 * the tenant to `churned` — see services/tenantOffboarding.ts.
 *
 * Runs every 5 minutes; drain windows are hours-to-days long, so cadence is
 * not latency-critical.
 */

const QUEUE_NAME = 'offboarding-drain-reaper';
const JOB_NAME = 'sweep-offboarding-tenants';
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

type ReaperJobData = { type: typeof JOB_NAME; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[OffboardingDrainReaper] withSystemDbAccessContext not available — reaper cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return reaperQueue;
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const result = await runWithSystemDbAccess(() => sweepOffboardingTenants());
        if (result.orgsFinalized > 0 || result.partnersFinalized > 0) {
          console.log(
            `[OffboardingDrainReaper] Finalized ${result.orgsFinalized} org(s), ${result.partnersFinalized} partner(s)`,
          );
        }
        return result;
      } catch (err) {
        console.error('[OffboardingDrainReaper] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();

  // Remove any existing repeatable jobs (in case the interval changed).
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      // Fixed jobId dedupes the repeatable across API replicas while every
      // replica's worker still processes (oauthCleanup singleton idiom).
      jobId: 'offboarding-drain-reaper',
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeOffboardingDrainReaper(): Promise<void> {
  if (reaperWorker) return;

  reaperWorker = createWorker();
  attachWorkerObservability(reaperWorker, 'offboardingDrainReaper');
  reaperWorker.on('error', (error) => {
    console.error('[OffboardingDrainReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[OffboardingDrainReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }

  console.log('[OffboardingDrainReaper] Initialized');
}

export async function shutdownOffboardingDrainReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;

  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[OffboardingDrainReaper] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[OffboardingDrainReaper] Error closing queue:', err);
    }
  }
}
