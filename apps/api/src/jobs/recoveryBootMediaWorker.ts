import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { buildRecoveryBootMediaArtifact } from '../services/recoveryBootMediaService';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import {
  recoveryBootMediaQueueJobDataSchema,
  type RecoveryBootMediaQueueJobData,
  withQueueMeta,
} from './queueSchemas';

const RECOVERY_BOOT_MEDIA_QUEUE = 'recovery-boot-media';
const PRIVILEGED_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1_000,
  },
};

let recoveryBootMediaQueue: Queue<RecoveryBootMediaQueueJobData> | null = null;
let recoveryBootMediaWorkerInstance: Worker<RecoveryBootMediaQueueJobData> | null = null;

function getRecoveryBootMediaQueue(): Queue<RecoveryBootMediaQueueJobData> {
  if (!recoveryBootMediaQueue) {
    recoveryBootMediaQueue = new Queue<RecoveryBootMediaQueueJobData>(RECOVERY_BOOT_MEDIA_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return recoveryBootMediaQueue;
}

function createRecoveryBootMediaWorker(): Worker<RecoveryBootMediaQueueJobData> {
  return new Worker<RecoveryBootMediaQueueJobData>(
    RECOVERY_BOOT_MEDIA_QUEUE,
    async (job: Job<RecoveryBootMediaQueueJobData>) => {
      const data = parseQueueJobData(RECOVERY_BOOT_MEDIA_QUEUE, job, recoveryBootMediaQueueJobDataSchema);
      if (data.type !== 'build-boot-media') {
        throw new Error(`Unknown recovery boot media job type: ${(data as { type: string }).type}`);
      }
      assertQueueJobName(RECOVERY_BOOT_MEDIA_QUEUE, job, 'build-boot-media');
      await buildRecoveryBootMediaArtifact(data.artifactId);
      return { artifactId: data.artifactId };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
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
    recoveryBootMediaQueueJobDataSchema.parse(withQueueMeta({
      type: 'build-boot-media',
      artifactId,
    }, {
      actorType: 'system',
      actorId: null,
      source: 'service:recovery-boot-media:build',
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
