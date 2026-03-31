import { Job, Queue, Worker } from 'bullmq';
import { getRedisConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { buildRecoveryMediaArtifact } from '../services/recoveryMediaService';

const RECOVERY_MEDIA_QUEUE = 'recovery-media';

type RecoveryMediaJobData = {
  type: 'build-media';
  artifactId: string;
};

let recoveryMediaQueue: Queue<RecoveryMediaJobData> | null = null;
let recoveryMediaWorkerInstance: Worker<RecoveryMediaJobData> | null = null;

function getRecoveryMediaQueue(): Queue<RecoveryMediaJobData> {
  if (!recoveryMediaQueue) {
    recoveryMediaQueue = new Queue<RecoveryMediaJobData>(RECOVERY_MEDIA_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return recoveryMediaQueue;
}

function createRecoveryMediaWorker(): Worker<RecoveryMediaJobData> {
  return new Worker<RecoveryMediaJobData>(
    RECOVERY_MEDIA_QUEUE,
    async (job: Job<RecoveryMediaJobData>) => {
      if (job.data.type !== 'build-media') {
        throw new Error(`Unknown recovery media job type: ${(job.data as { type: string }).type}`);
      }
      await buildRecoveryMediaArtifact(job.data.artifactId);
      return { artifactId: job.data.artifactId };
    },
    {
      connection: getRedisConnection(),
      concurrency: 2,
      lockDuration: 300_000,
    }
  );
}

export async function enqueueRecoveryMediaBuild(artifactId: string): Promise<string> {
  const queue = getRecoveryMediaQueue();
  const stableJobId = `recovery-media:${artifactId}`;
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing.id!;
    }
    if (state === 'completed' || state === 'failed') {
      await existing.remove().catch((error) => {
        console.error(`[RecoveryMediaWorker] Failed to remove stale job ${stableJobId}:`, error);
      });
    }
  }

  const job = await queue.add(
    'build-media',
    { type: 'build-media', artifactId },
    {
      jobId: stableJobId,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

export async function initializeRecoveryMediaWorker(): Promise<void> {
  recoveryMediaWorkerInstance = createRecoveryMediaWorker();

  recoveryMediaWorkerInstance.on('error', (error) => {
    console.error('[RecoveryMediaWorker] Worker error:', error);
  });

  recoveryMediaWorkerInstance.on('failed', (job, error) => {
    console.error(`[RecoveryMediaWorker] Job ${job?.id} failed:`, error);
  });

  console.log('[RecoveryMediaWorker] Recovery media worker initialized');
}

export async function shutdownRecoveryMediaWorker(): Promise<void> {
  if (recoveryMediaWorkerInstance) {
    await recoveryMediaWorkerInstance.close();
    recoveryMediaWorkerInstance = null;
  }
  if (recoveryMediaQueue) {
    await recoveryMediaQueue.close();
    recoveryMediaQueue = null;
  }
}
