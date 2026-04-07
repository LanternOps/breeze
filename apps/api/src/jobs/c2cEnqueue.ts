import { Queue, type JobsOptions } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';

const C2C_QUEUE = 'c2c-backup';

let c2cQueue: Queue | null = null;

export interface RunSyncData {
  type: 'run-sync';
  jobId: string;
  configId: string;
  orgId: string;
}

export interface ProcessRestoreData {
  type: 'process-restore';
  restoreJobId: string;
  orgId: string;
  itemIds: string[];
  targetConnectionId: string | null;
}

export function getC2cQueue(): Queue {
  if (!c2cQueue) {
    c2cQueue = new Queue(C2C_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return c2cQueue;
}

export async function closeC2cQueue(): Promise<void> {
  if (c2cQueue) {
    await c2cQueue.close();
    c2cQueue = null;
  }
}

async function addUniqueC2cJob(
  queue: Queue,
  name: 'run-sync' | 'process-restore',
  data: RunSyncData | ProcessRestoreData,
  stableJobId: string,
  opts: Omit<JobsOptions, 'jobId'> = {},
) {
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing;
    }
    await existing.remove().catch((error) => {
      console.error(`[C2CEnqueue] Failed to remove stale job:`, error);
    });
  }

  return queue.add(name, data, {
    jobId: stableJobId,
    ...opts,
  });
}

export async function enqueueC2cSync(
  jobId: string,
  configId: string,
  orgId: string,
): Promise<string> {
  const queue = getC2cQueue();
  const job = await addUniqueC2cJob(
    queue,
    'run-sync',
    {
      type: 'run-sync',
      jobId,
      configId,
      orgId,
    },
    `c2c-sync:${jobId}`,
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  );
  return job.id!;
}

export async function enqueueC2cRestore(
  restoreJobId: string,
  orgId: string,
  itemIds: string[],
  targetConnectionId: string | null,
): Promise<string> {
  const queue = getC2cQueue();
  const job = await addUniqueC2cJob(
    queue,
    'process-restore',
    {
      type: 'process-restore',
      restoreJobId,
      orgId,
      itemIds,
      targetConnectionId,
    },
    `c2c-restore:${restoreJobId}`,
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  );
  return job.id!;
}
