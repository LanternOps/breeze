/**
 * Wisp W06a Task 5 — the 15-minute nudge digest + morning-brief sweep
 * (w00 A28: both ride one lane). Each half runs in its own try/catch so one
 * failing never starves the other.
 *
 * The Worker is constructed UNCONDITIONALLY (same as wispConcernRetention and
 * the other Wisp workers): the worker readiness manifest expects it attached,
 * so the Wisp flag is checked inside each sweep (`wispEnabled()` -> zeros),
 * on every run, rather than returning before construction.
 */
import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { runMorningBriefs } from '../services/wisp/brief';
import { runNudgeDigest } from '../services/wisp/nudgeDigest';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[WispNudgeDigest]';
export const WISP_NUDGE_DIGEST_QUEUE = 'wisp-nudge-digest';
const JOB_NAME = 'sweep';
const JOB_ID = 'wisp-nudge-digest';

type JobData = Record<string, never>;
type DigestResult = Awaited<ReturnType<typeof runNudgeDigest>>;
type BriefResult = Awaited<ReturnType<typeof runMorningBriefs>>;

let digestQueue: Queue<JobData> | null = null;
let digestWorker: Worker<JobData> | null = null;

function reportFailure(op: string, err: unknown): void {
  console.error(`${LOG_PREFIX} ${op} failed:`, err);
  captureException(err, undefined, { op: `wisp.nudgeDigestJob.${op}` });
}

async function processSweep(): Promise<{ digest: DigestResult | null; briefs: BriefResult | null }> {
  const now = new Date();
  let digest: DigestResult | null = null;
  let briefs: BriefResult | null = null;
  try {
    digest = await runNudgeDigest(now);
  } catch (err) {
    reportFailure('digest', err);
  }
  try {
    briefs = await runMorningBriefs(now);
  } catch (err) {
    reportFailure('briefs', err);
  }
  return { digest, briefs };
}

export async function initializeWispNudgeDigestWorker(): Promise<void> {
  try {
    digestWorker = new Worker<JobData>(
      WISP_NUDGE_DIGEST_QUEUE,
      async (_job: Job<JobData>) => processSweep(),
      { connection: getBullMQConnection(), concurrency: 1 },
    );
    attachWorkerObservability(digestWorker, 'wispNudgeDigest');
    digestWorker.on('error', (error) => console.error(`${LOG_PREFIX} Worker error:`, error));

    digestQueue = new Queue<JobData>(WISP_NUDGE_DIGEST_QUEUE, { connection: getBullMQConnection() });
    const existing = await digestQueue.getRepeatableJobs();
    for (const job of existing) {
      await digestQueue.removeRepeatableByKey(job.key);
    }
    await digestQueue.add(JOB_NAME, {}, {
      jobId: JOB_ID,
      repeat: { pattern: jobSchedule('wisp-nudge-digest') },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    });
    console.log(`${LOG_PREFIX} Digest worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownWispNudgeDigestWorker(): Promise<void> {
  if (digestWorker) { await digestWorker.close(); digestWorker = null; }
  if (digestQueue) { await digestQueue.close(); digestQueue = null; }
}
