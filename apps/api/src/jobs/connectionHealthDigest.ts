/**
 * Connection health daily digest worker (spec 2026-10-15 §4, W3 #8847). Hourly
 * on the registry slot; each run digests the partners whose local hour is
 * 08–11 and skips users already in the delivery ledger for that local date, so
 * an overlapping or repeated run sends nothing twice. The work lives in
 * services/connectionHealth/digest.ts.
 */
import { Queue, Worker } from 'bullmq';
import { getBullMQConnection, getRedis } from '../services/redis';
import { runDigest } from '../services/connectionHealth/digest';
import { writeDigestHeartbeat } from '../services/connectionHealth/heartbeat';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

export const CONNECTION_HEALTH_DIGEST_QUEUE = 'connection-health-digest';
const REPEAT_JOB_ID = 'connection-health-digest';

let queue: Queue | null = null;
let worker: Worker | null = null;

export function getConnectionHealthDigestQueue(): Queue {
  if (!queue) queue = new Queue(CONNECTION_HEALTH_DIGEST_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeConnectionHealthDigestWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(CONNECTION_HEALTH_DIGEST_QUEUE, async () => {
    const result = await runDigest();
    // Dead-man for /admin/system (W4): written only after a completed run;
    // never fails the job.
    await writeDigestHeartbeat(getRedis(), new Date());
    return result;
  }, {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, CONNECTION_HEALTH_DIGEST_QUEUE);

  const pattern = jobSchedule('connection-health-digest');
  const q = getConnectionHealthDigestQueue();
  // Only stale entries go, so the live schedule is never absent while several
  // processes start at once (same rule as the reconciler).
  for (const r of await q.getRepeatableJobs()) {
    if (r.id !== REPEAT_JOB_ID || r.pattern !== pattern) await q.removeRepeatableByKey(r.key);
  }
  await q.add('digest', {}, {
    jobId: REPEAT_JOB_ID,
    repeat: { pattern: jobSchedule('connection-health-digest') },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
}

export async function shutdownConnectionHealthDigestWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
