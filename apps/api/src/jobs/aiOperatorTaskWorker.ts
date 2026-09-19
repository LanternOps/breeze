/**
 * The AI Operator task coordinator's worker (#5205 W06), spec §6.3, §11.2.
 *
 * TWO WORKERS, ONE QUEUE, TWO JOB NAMES:
 *
 *  - `task-wake` — the EVENT path. `aiOperatorTaskOutboxPublisher` (W05)
 *    drains `ai_operator_task_outbox` into this queue, one job per
 *    authoritative transition. The job data is a typed REFERENCE only, so the
 *    handler re-reads every source row it reasons about (spec §6.3).
 *  - `coordinator-tick` — the POLL path. A 15 s repeatable that runs the
 *    reconciler's four recovery scans. Sub-hourly, so it is deliberately NOT
 *    in `jobs/scheduleRegistry.ts` (below `COARSE_REPEAT_INTERVAL_MS`, exactly
 *    like `intentOutboxPublisher` and the W05 publisher).
 *
 * WHY THE TICK IS NOT OPTIONAL. The event path can lose a wake — Redis
 * unavailable during publish, a consumer that dies after acknowledging, a
 * BullMQ job that exhausts its retries. Acceptance scenario 4 requires the
 * system to converge anyway, and the tick is the only thing that makes that
 * true. It is also the only thing that ever notices a task whose coordinator
 * died mid-step.
 *
 * WAKE ACKNOWLEDGEMENT (spec §6.3): a wake is acknowledged only after the
 * transition it caused has committed. `handleTaskWake` returns normally only
 * once its `advanceTask` write has committed, and any throw propagates — so
 * BullMQ retries the job AND the outbox row stays eligible for the reconciler.
 * There is deliberately no try/catch that swallows a failure into a completed
 * job: a silently-completed wake is a stranded task.
 */

import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { handleTaskWake } from '../services/aiOperator/taskCoordinator';
import { runReconcilerPass } from '../services/aiOperator/taskReconciler';
import {
  AI_OPERATOR_COORDINATOR_QUEUE_NAME,
  AI_OPERATOR_COORDINATOR_WAKE_JOB_NAME,
  aiOperatorTaskWakeJobDataSchema,
  type AiOperatorTaskWakeJobData,
} from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';

/** Job name for the poll-driven reconciler tick. */
export const AI_OPERATOR_COORDINATOR_TICK_JOB_NAME = 'coordinator-tick';

/** Spec §11.2's proposed 15 s coordinator tick. */
export const COORDINATOR_TICK_INTERVAL_MS = 15 * 1000;

type CoordinatorJobData = AiOperatorTaskWakeJobData | { type: 'coordinator-tick'; queuedAt: string };

let coordinatorQueue: Queue<CoordinatorJobData> | null = null;
let coordinatorWorker: Worker<CoordinatorJobData> | null = null;

function getQueue(): Queue<CoordinatorJobData> {
  if (!coordinatorQueue) {
    coordinatorQueue = new Queue<CoordinatorJobData>(AI_OPERATOR_COORDINATOR_QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return coordinatorQueue;
}

/**
 * Process one job. Exported for the unit suite, which drives it directly
 * rather than standing up a real Worker.
 */
export async function processAiOperatorCoordinatorJob(
  job: Job<CoordinatorJobData>,
): Promise<{ handled: string }> {
  if (job.name === AI_OPERATOR_COORDINATOR_TICK_JOB_NAME) {
    const pass = await runReconcilerPass();
    return {
      handled: `tick: queued=${pass.queuedPastWake} waiting=${pass.waitingPastWake} `
        + `lease=${pass.runningPastLease} unsettled=${pass.terminalUnsettled}`,
    };
  }

  // DEFENSIVE PARSE at the dequeue boundary, matching every other consumer in
  // `jobs/`. A job that has been sitting in Redis across a deploy may predate
  // the current schema, and a malformed one must fail loudly here rather than
  // reach `handleTaskWake` and be interpreted as some other task's wake.
  const parsed = aiOperatorTaskWakeJobDataSchema.safeParse(job.data);
  if (!parsed.success) {
    throw new Error(
      `[AiOperatorTaskWorker] malformed wake job ${job.id}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const handled = await handleTaskWake({
    orgId: parsed.data.orgId,
    taskId: parsed.data.taskId,
    sourceKind: parsed.data.sourceKind,
    sourceId: parsed.data.sourceId,
  });
  return { handled };
}

function createWorker(): Worker<CoordinatorJobData> {
  return new Worker<CoordinatorJobData>(
    AI_OPERATOR_COORDINATOR_QUEUE_NAME,
    async (job: Job<CoordinatorJobData>) => processAiOperatorCoordinatorJob(job),
    {
      connection: getBullMQConnection(),
      // ONE. Two concurrent handlers on one pod would contend on the same
      // `FOR UPDATE SKIP LOCKED` rows for no throughput gain, and the whole
      // design is that a step is short and a wait holds nothing — the work per
      // job is a handful of indexed reads and one CAS.
      concurrency: 1,
    },
  );
}

async function scheduleTick(): Promise<void> {
  const queue = getQueue();

  // Replace any prior repeatable with a different interval, same pattern as
  // the W05 publisher: an interval change in code must not leave the old
  // cadence running alongside the new one.
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === AI_OPERATOR_COORDINATOR_TICK_JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    AI_OPERATOR_COORDINATOR_TICK_JOB_NAME,
    { type: 'coordinator-tick', queuedAt: new Date().toISOString() },
    {
      jobId: 'ai-operator-coordinator-tick',
      repeat: { every: COORDINATOR_TICK_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeAiOperatorTaskWorker(): Promise<void> {
  if (coordinatorWorker) return;

  coordinatorWorker = createWorker();
  attachWorkerObservability(coordinatorWorker, 'aiOperatorTaskWorker');
  coordinatorWorker.on('error', (error) => {
    console.error('[AiOperatorTaskWorker] Worker error:', error);
    captureException(error);
  });
  coordinatorWorker.on('failed', (job, error) => {
    console.error(`[AiOperatorTaskWorker] Job ${job?.id} (${job?.name}) failed:`, error);
    captureException(error);
  });

  try {
    await scheduleTick();
  } catch (err) {
    await coordinatorWorker.close();
    coordinatorWorker = null;
    throw err;
  }

  console.log('[AiOperatorTaskWorker] Initialized');
}

export async function shutdownAiOperatorTaskWorker(): Promise<void> {
  const worker = coordinatorWorker;
  const queue = coordinatorQueue;
  coordinatorWorker = null;
  coordinatorQueue = null;

  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[AiOperatorTaskWorker] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[AiOperatorTaskWorker] Error closing queue:', err);
    }
  }
}

/** Re-exported so callers do not need two imports to enqueue a wake in tests. */
export { AI_OPERATOR_COORDINATOR_QUEUE_NAME, AI_OPERATOR_COORDINATOR_WAKE_JOB_NAME };
