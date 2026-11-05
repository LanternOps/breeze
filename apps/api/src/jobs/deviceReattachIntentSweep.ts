/**
 * Every minute: expire reattach intents past their deadline and prune old
 * terminal ones (#8318 spec §4.3, §6.5). The work is
 * services/deviceReattach/expirySweep.ts.
 *
 * Sub-hourly, so `repeat.every` (not a scheduleRegistry slot): a `requested`
 * intent lives 60 minutes and a `staged` one 15, and an expired intent must
 * stop receiving directives and lose its staged set promptly. Confirm and
 * phase 1 also refuse an intent past `expires_at` on their own, so a late
 * sweep never lets a staged set be activated after expiry.
 *
 * `global` placement: the closure reaches the database, the certificate
 * lifecycle and the audit service, never routes/agentWs.ts.
 */
import { Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { runReattachIntentSweepOnce } from '../services/deviceReattach/expirySweep';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[DeviceReattachIntentSweep]';
const QUEUE_NAME = 'device-reattach-intent-sweep';
const JOB_NAME = 'sweep';
export const DEVICE_REATTACH_INTENT_SWEEP_INTERVAL_MS = 60_000;

let sweepQueue: Queue | null = null;
let sweepWorker: Worker | null = null;

export function getDeviceReattachIntentSweepQueue(): Queue {
  if (!sweepQueue) sweepQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return sweepQueue;
}

export async function initializeDeviceReattachIntentSweep(): Promise<void> {
  if (sweepWorker) return;
  try {
    sweepWorker = new Worker(QUEUE_NAME, () => runReattachIntentSweepOnce(), {
      connection: getBullMQConnection(),
      concurrency: 1,
    });
    attachWorkerObservability(sweepWorker, 'deviceReattachIntentSweep');
    sweepWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });

    const queue = getDeviceReattachIntentSweepQueue();
    for (const job of await queue.getRepeatableJobs()) {
      if (job.name === JOB_NAME) await queue.removeRepeatableByKey(job.key);
    }
    await queue.add(JOB_NAME, {}, {
      jobId: QUEUE_NAME,
      repeat: { every: DEVICE_REATTACH_INTENT_SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 20 },
    });
    console.log(`${LOG_PREFIX} worker initialized (every ${DEVICE_REATTACH_INTENT_SWEEP_INTERVAL_MS / 1000}s)`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownDeviceReattachIntentSweep(): Promise<void> {
  if (sweepWorker) {
    await sweepWorker.close();
    sweepWorker = null;
  }
  if (sweepQueue) {
    await sweepQueue.close();
    sweepQueue = null;
  }
}
