/**
 * Connection health reconciler worker (spec 2026-10-15 §1.2). The stable jobId
 * dedupes the repeatable schedule; it does not stop two runs overlapping. What
 * keeps runs apart is one job per tick, a global consumer at concurrency 1, the
 * run's 60s budget, and, as the hard guarantee, a per-kind advisory lock taken
 * in each kind's transaction (a run that cannot get it skips that kind). The
 * work itself lives in services/connectionHealth/reconcile.ts.
 */
import { Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { runReconcile } from '../services/connectionHealth/reconcile';
import { attachWorkerObservability } from './workerObservability';

export const CONNECTION_HEALTH_QUEUE = 'connection-health-reconcile';
const REPEAT_JOB_ID = 'connection-health-reconcile';
const REPEAT_PATTERN = '2,17,32,47 * * * *';

let queue: Queue | null = null;
let worker: Worker | null = null;

export function getConnectionHealthQueue(): Queue {
  if (!queue) queue = new Queue(CONNECTION_HEALTH_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeConnectionHealthReconcileWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(CONNECTION_HEALTH_QUEUE, async () => {
    const { kinds, notices, retained } = await runReconcile();
    return { kinds: kinds.map((k) => [k.kind, k.status]), notices, retained };
  }, { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, CONNECTION_HEALTH_QUEUE);
  // Sub-hourly (every 15 minutes), so it is exempt from scheduleRegistry.ts
  // (which only allocates coarse, >= hourly schedules). The offset minutes keep
  // it off the :00/:15/:30/:45 pile-up and away from ai-budget-alert's 7/22/37/52.
  const q = getConnectionHealthQueue();
  // A repeatable left from an earlier pattern would keep firing alongside the
  // new one. Only stale entries go, so the live schedule is never absent while
  // several processes start at once.
  for (const r of await q.getRepeatableJobs()) {
    if (r.id !== REPEAT_JOB_ID || r.pattern !== REPEAT_PATTERN) await q.removeRepeatableByKey(r.key);
  }
  await q.add('reconcile', {}, {
    jobId: REPEAT_JOB_ID,
    repeat: { pattern: REPEAT_PATTERN },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
}

export async function shutdownConnectionHealthReconcileWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
