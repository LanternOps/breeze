import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { buildRecoveryMediaArtifact } from '../services/recoveryMediaService';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import {
  recoveryMediaQueueJobDataSchema,
  type RecoveryMediaQueueJobData,
  withQueueMeta,
} from './queueSchemas';

const RECOVERY_MEDIA_QUEUE = 'recovery-media';
const PRIVILEGED_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1_000,
  },
};

let recoveryMediaQueue: Queue<RecoveryMediaQueueJobData> | null = null;
let recoveryMediaWorkerInstance: Worker<RecoveryMediaQueueJobData> | null = null;

function getRecoveryMediaQueue(): Queue<RecoveryMediaQueueJobData> {
  if (!recoveryMediaQueue) {
    recoveryMediaQueue = new Queue<RecoveryMediaQueueJobData>(RECOVERY_MEDIA_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return recoveryMediaQueue;
}

function createRecoveryMediaWorker(): Worker<RecoveryMediaQueueJobData> {
  return new Worker<RecoveryMediaQueueJobData>(
    RECOVERY_MEDIA_QUEUE,
    async (job: Job<RecoveryMediaQueueJobData>) => {
      const data = parseQueueJobData(RECOVERY_MEDIA_QUEUE, job, recoveryMediaQueueJobDataSchema);
      if (data.type !== 'build-media') {
        throw new Error(`Unknown recovery media job type: ${(data as { type: string }).type}`);
      }
      assertQueueJobName(RECOVERY_MEDIA_QUEUE, job, 'build-media');
      await buildRecoveryMediaArtifact(data.artifactId);
      return { artifactId: data.artifactId };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
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
    recoveryMediaQueueJobDataSchema.parse(withQueueMeta({
      type: 'build-media',
      artifactId,
    }, {
      actorType: 'system',
      actorId: null,
      source: 'service:recovery-media:build',
    })),
    {
      jobId: stableJobId,
      ...PRIVILEGED_JOB_OPTIONS,
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
