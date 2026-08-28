/**
 * Wave 6.2a (#3828) — the repeatable that drives the fix-held watch sweep and
 * its retention pass.
 *
 * A thin BullMQ shell only. All the lifecycle logic (lease-claim, check
 * outside the transaction, epoch-guarded finalize) lives in
 * `services/aiAgents/fixWatchSweeper.ts`, where it is unit-testable without a
 * queue.
 *
 * Placement is `socket-owner`: `fixWatchCheck` reaches `commandQueue` through
 * `actVerify`'s shared service read. `workerEntrypointClosure.contract.test.ts`
 * is the authority on that value — do not re-reason it by hand.
 */
import { Queue, Worker, Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { jobSchedule } from './scheduleRegistry';
import { sweepDueFixWatches } from '../services/aiAgents/fixWatchSweeper';
import { purgeExpiredFixWatchState } from '../services/aiAgents/fixWatchRetention';

const FIX_WATCH_QUEUE = 'ai-fix-watch';

let queue: Queue | null = null;
let worker: Worker | null = null;

type FixWatchJob = { type: 'sweep' } | { type: 'retention' };

export function getAiAgentFixWatchQueue(): Queue {
  if (!queue) {
    queue = new Queue(FIX_WATCH_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

function createFixWatchWorker(): Worker<FixWatchJob> {
  return new Worker<FixWatchJob>(
    FIX_WATCH_QUEUE,
    async (job: Job<FixWatchJob>) => {
      if (job.data.type === 'sweep') {
        const result = await sweepDueFixWatches();
        if (result.claimed > 0) {
          console.log('[AiFixWatch] swept due watches', result);
        }
        return result;
      }
      if (job.data.type === 'retention') {
        const purged = await purgeExpiredFixWatchState();
        console.log('[AiFixWatch] retention pass', purged);
        return purged;
      }
      throw new Error(`Unknown ai-fix-watch job type: ${(job.data as { type: string }).type}`);
    },
    {
      connection: getBullMQConnection(),
      // One sweep at a time per process. The sweep is already internally
      // bounded (FIX_WATCH_SWEEP_BATCH) and every row is claimed exclusively,
      // so extra concurrency would only contend for the command queue.
      concurrency: 1,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
}

async function scheduleFixWatchJobs(): Promise<void> {
  const q = getAiAgentFixWatchQueue();
  const existing = await q.getRepeatableJobs();
  for (const job of existing) {
    await q.removeRepeatableByKey(job.key);
  }
  await q.add('sweep', { type: 'sweep' }, {
    repeat: { pattern: jobSchedule('ai-fix-watch-sweep') },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 50 },
  });
  await q.add('retention', { type: 'retention' }, {
    repeat: { pattern: jobSchedule('ai-fix-watch-retention') },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  });
  console.log('[AiFixWatch] Scheduled fix-held watch sweep + retention jobs');
}

export async function initializeAiAgentFixWatchWorker(): Promise<void> {
  try {
    worker = createFixWatchWorker();
    worker.on('error', (error) => console.error('[AiFixWatch] Worker error:', error));
    worker.on('failed', (job, error) => console.error(`[AiFixWatch] Job ${job?.id} failed:`, error));
    await scheduleFixWatchJobs();
    console.log('[AiFixWatch] Worker initialized');
  } catch (error) {
    console.error('[AiFixWatch] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAiAgentFixWatchWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
  console.log('[AiFixWatch] Worker shut down');
}
