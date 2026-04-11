import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { withSystemDbAccessContext } from '../db';
import { reconcileDrExecution } from '../services/drExecutionService';
import { isReusableState } from '../services/bullmqUtils';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import {
  drExecutionQueueJobDataSchema,
  type DrExecutionQueueJobData,
  withQueueMeta,
} from './queueSchemas';

const DR_EXECUTION_QUEUE = 'dr-execution';
const PRIVILEGED_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1_000,
  },
};

let drExecutionQueue: Queue<DrExecutionQueueJobData> | null = null;
let drExecutionWorkerInstance: Worker<DrExecutionQueueJobData> | null = null;

function getDrExecutionReconcileJobId(executionId: string): string {
  return `dr-execution:${executionId}`;
}

function getDrExecutionQueue(): Queue<DrExecutionQueueJobData> {
  if (!drExecutionQueue) {
    drExecutionQueue = new Queue<DrExecutionQueueJobData>(DR_EXECUTION_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return drExecutionQueue;
}

function createDrExecutionWorker(): Worker<DrExecutionQueueJobData> {
  return new Worker<DrExecutionQueueJobData>(
    DR_EXECUTION_QUEUE,
    async (job: Job<DrExecutionQueueJobData>) => {
      return withSystemDbAccessContext(async () => {
        const data = parseQueueJobData(DR_EXECUTION_QUEUE, job, drExecutionQueueJobDataSchema);
        if (data.type !== 'reconcile-execution') {
          throw new Error(`Unknown DR execution job type: ${(data as { type: string }).type}`);
        }
        assertQueueJobName(DR_EXECUTION_QUEUE, job, 'reconcile-execution');
        const execution = await reconcileDrExecution(data.executionId);
        return {
          executionId: data.executionId,
          status: execution?.status ?? 'missing',
        };
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 4,
      lockDuration: 120_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

export async function enqueueDrExecutionReconcile(executionId: string, delayMs = 0): Promise<string> {
  const queue = getDrExecutionQueue();
  const stableJobId = getDrExecutionReconcileJobId(executionId);
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing.id!;
    }
    if (state === 'completed' || state === 'failed') {
      await existing.remove().catch((error) => {
        console.error(`[DrExecutionWorker] Failed to remove stale job:`, error);
      });
    }
  }
  const job = await queue.add(
    'reconcile-execution',
    drExecutionQueueJobDataSchema.parse(withQueueMeta({
      type: 'reconcile-execution',
      executionId,
    }, {
      actorType: 'system',
      actorId: null,
      source: 'service:dr:reconcile',
    })),
    {
      jobId: stableJobId,
      delay: Math.max(0, delayMs),
      ...PRIVILEGED_JOB_OPTIONS,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

export async function initializeDrExecutionWorker(): Promise<void> {
  drExecutionWorkerInstance = createDrExecutionWorker();

  drExecutionWorkerInstance.on('error', (error) => {
    console.error('[DrExecutionWorker] Worker error:', error);
  });

  drExecutionWorkerInstance.on('failed', (job, error) => {
    console.error(`[DrExecutionWorker] Job ${job?.id} failed:`, error);
  });

  console.log('[DrExecutionWorker] DR execution worker initialized');
}

export async function shutdownDrExecutionWorker(): Promise<void> {
  if (drExecutionWorkerInstance) {
    await drExecutionWorkerInstance.close();
    drExecutionWorkerInstance = null;
  }

  if (drExecutionQueue) {
    await drExecutionQueue.close();
    drExecutionQueue = null;
  }
}
