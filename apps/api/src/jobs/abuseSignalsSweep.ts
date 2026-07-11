import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { runAbuseSweep, runAbuseDigest } from '../services/abuseSignals';
import { recordAbuseSweepRun } from '../services/abuseMetrics';

const ABUSE_QUEUE = 'abuse-signals';
const SWEEP_JOB = 'abuse-sweep';
const DIGEST_JOB = 'abuse-digest';
// jobIds use hyphens, never colons (BullMQ jobId rule).
const SWEEP_REPEAT_ID = 'abuse-sweep-repeat';
const DIGEST_REPEAT_ID = 'abuse-digest-repeat';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DIGEST_CRON = '0 9 * * 1'; // Monday 09:00

type AbuseJobData = Record<string, never>;

let abuseQueue: Queue<AbuseJobData> | null = null;
let abuseWorker: Worker<AbuseJobData> | null = null;

export function getAbuseSignalsQueue(): Queue<AbuseJobData> {
  if (!abuseQueue) {
    abuseQueue = new Queue<AbuseJobData>(ABUSE_QUEUE, { connection: getBullMQConnection() });
  }
  return abuseQueue;
}

export async function scheduleAbuseSignalsJobs(): Promise<void> {
  const queue = getAbuseSignalsQueue();
  // Clear prior repeatables so interval/cron changes take effect on redeploy.
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === SWEEP_JOB || job.name === DIGEST_JOB) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(SWEEP_JOB, {}, {
    jobId: SWEEP_REPEAT_ID,
    repeat: { every: SWEEP_INTERVAL_MS },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
  await queue.add(DIGEST_JOB, {}, {
    jobId: DIGEST_REPEAT_ID,
    repeat: { pattern: DIGEST_CRON },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
}

export function createAbuseSignalsWorker(): Worker<AbuseJobData> {
  return new Worker<AbuseJobData>(
    ABUSE_QUEUE,
    async (job: Job<AbuseJobData>) => {
      try {
        if (job.name === SWEEP_JOB) {
          const result = await runAbuseSweep();
          recordAbuseSweepRun('success');
          return result;
        }
        if (job.name === DIGEST_JOB) {
          await runAbuseDigest();
          return {};
        }
        return {};
      } catch (error) {
        recordAbuseSweepRun('error');
        throw error;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeAbuseSignalsWorker(): Promise<void> {
  abuseWorker = createAbuseSignalsWorker();
  attachWorkerObservability(abuseWorker, 'abuseSignalsWorker');
  await scheduleAbuseSignalsJobs();
  console.log('[AbuseSignals] Sweep worker initialized');
}

export async function shutdownAbuseSignalsWorker(): Promise<void> {
  if (abuseWorker) {
    await abuseWorker.close();
    abuseWorker = null;
  }
  if (abuseQueue) {
    await abuseQueue.close();
    abuseQueue = null;
  }
}
