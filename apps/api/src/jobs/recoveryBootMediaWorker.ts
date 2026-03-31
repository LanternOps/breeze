import { Job, Queue, Worker } from 'bullmq';
import { getRedisConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { buildRecoveryBootMediaArtifact } from '../services/recoveryBootMediaService';

const RECOVERY_BOOT_MEDIA_QUEUE = 'recovery-boot-media';

type RecoveryBootMediaJobData = {
  type: 'build-boot-media';
  artifactId: string;
};

let recoveryBootMediaQueue: Queue<RecoveryBootMediaJobData> | null = null;
let recoveryBootMediaWorkerInstance: Worker<RecoveryBootMediaJobData> | null = null;

function getRecoveryBootMediaQueue(): Queue<RecoveryBootMediaJobData> {
  if (!recoveryBootMediaQueue) {
    recoveryBootMediaQueue = new Queue<RecoveryBootMediaJobData>(RECOVERY_BOOT_MEDIA_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return recoveryBootMediaQueue;
}

function createRecoveryBootMediaWorker(): Worker<RecoveryBootMediaJobData> {
  return new Worker<RecoveryBootMediaJobData>(
    RECOVERY_BOOT_MEDIA_QUEUE,
    async (job: Job<RecoveryBootMediaJobData>) => {
      if (job.data.type !== 'build-boot-media') {
        throw new Error(`Unknown recovery boot media job type: ${(job.data as { type: string }).type}`);
      }
      await buildRecoveryBootMediaArtifact(job.data.artifactId);
      return { artifactId: job.data.artifactId };
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
      lockDuration: 300_000,
    }
  );
}

export async function enqueueRecoveryBootMediaBuild(artifactId: string): Promise<string> {
  const queue = getRecoveryBootMediaQueue();
  const stableJobId = `recovery-boot-media:${artifactId}`;
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing.id!;
    }
    if (state === 'completed' || state === 'failed') {
      await existing.remove().catch((error) => {
        console.error(`[RecoveryBootMediaWorker] Failed to remove stale job ${stableJobId}:`, error);
      });
    }
  }

  const job = await queue.add(
    'build-boot-media',
    { type: 'build-boot-media', artifactId },
    {
      jobId: stableJobId,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

export async function initializeRecoveryBootMediaWorker(): Promise<void> {
  recoveryBootMediaWorkerInstance = createRecoveryBootMediaWorker();

  recoveryBootMediaWorkerInstance.on('error', (error) => {
    console.error('[RecoveryBootMediaWorker] Worker error:', error);
  });

  recoveryBootMediaWorkerInstance.on('failed', (job, error) => {
    console.error(`[RecoveryBootMediaWorker] Job ${job?.id} failed:`, error);
  });

  console.log('[RecoveryBootMediaWorker] Recovery boot media worker initialized');
}

export async function shutdownRecoveryBootMediaWorker(): Promise<void> {
  if (recoveryBootMediaWorkerInstance) {
    await recoveryBootMediaWorkerInstance.close();
    recoveryBootMediaWorkerInstance = null;
  }
  if (recoveryBootMediaQueue) {
    await recoveryBootMediaQueue.close();
    recoveryBootMediaQueue = null;
  }
}
