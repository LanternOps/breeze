import { Job, Queue, Worker } from 'bullmq';
import { getRedisConnection } from '../services/redis';
import { reconcileDrExecution } from '../services/drExecutionService';
import { isReusableState } from '../services/bullmqUtils';

const DR_EXECUTION_QUEUE = 'dr-execution';

type DrExecutionJobData = {
  type: 'reconcile-execution';
  executionId: string;
};

let drExecutionQueue: Queue<DrExecutionJobData> | null = null;
let drExecutionWorkerInstance: Worker<DrExecutionJobData> | null = null;

function getDrExecutionReconcileJobId(executionId: string): string {
  return `dr-execution:${executionId}`;
}

function getDrExecutionQueue(): Queue<DrExecutionJobData> {
  if (!drExecutionQueue) {
    drExecutionQueue = new Queue<DrExecutionJobData>(DR_EXECUTION_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return drExecutionQueue;
}

function createDrExecutionWorker(): Worker<DrExecutionJobData> {
  return new Worker<DrExecutionJobData>(
    DR_EXECUTION_QUEUE,
    async (job: Job<DrExecutionJobData>) => {
      if (job.data.type !== 'reconcile-execution') {
        throw new Error(`Unknown DR execution job type: ${(job.data as { type: string }).type}`);
      }
      const execution = await reconcileDrExecution(job.data.executionId);
      return {
        executionId: job.data.executionId,
        status: execution?.status ?? 'missing',
      };
    },
    {
      connection: getRedisConnection(),
      concurrency: 4,
      lockDuration: 120_000,
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
    {
      type: 'reconcile-execution',
      executionId,
    },
    {
      jobId: stableJobId,
      delay: Math.max(0, delayMs),
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
