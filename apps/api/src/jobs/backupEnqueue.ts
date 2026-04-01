/**
 * Backup Queue — enqueue helpers for backup job dispatch/result processing
 *
 * Extracted from backupWorker.ts to keep files under the 500-line limit.
 * Re-exported from backupWorker.ts for backward compatibility.
 */

import { Queue } from 'bullmq';
import { getRedisConnection } from '../services/redis';
import {
  backupQueueJobDataSchema,
  type QueueActorMeta,
  withQueueMeta,
} from './queueSchemas';

const BACKUP_QUEUE = 'backup';
const PRIVILEGED_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1_000,
  },
};

let backupQueue: Queue | null = null;

export function getBackupQueue(): Queue {
  if (!backupQueue) {
    backupQueue = new Queue(BACKUP_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return backupQueue;
}

export async function closeBackupQueue(): Promise<void> {
  if (backupQueue) {
    await backupQueue.close();
    backupQueue = null;
  }
}

// ── Job data sub-types (needed by enqueue callers) ───────────────────────────

export interface ProcessResultsResult {
  status: string;
  jobId?: string;
  snapshotId?: string;
  filesBackedUp?: number;
  bytesBackedUp?: number;
  warning?: string;
  snapshot?: {
    id: string;
    timestamp?: string;
    size?: number;
    files?: Array<{
      sourcePath: string;
      backupPath: string;
      size?: number;
      modTime?: string;
    }>;
  };
  error?: string;
}

const SYSTEM_DISPATCH_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:backup:dispatch',
};

const AGENT_RESULT_META: QueueActorMeta = {
  actorType: 'agent',
  actorId: null,
  source: 'route:agentWs:backup-result',
};

// ── Public enqueue functions ─────────────────────────────────────────────────

export async function enqueueBackupDispatch(
  jobId: string,
  configId: string,
  orgId: string,
  deviceId: string,
  meta: QueueActorMeta = SYSTEM_DISPATCH_META,
): Promise<string> {
  const queue = getBackupQueue();
  const payload = backupQueueJobDataSchema.parse(withQueueMeta({
    type: 'dispatch-backup' as const,
    jobId,
    configId,
    orgId,
    deviceId,
  }, meta));
  const job = await queue.add(
    'dispatch-backup',
    payload,
    {
      jobId: `backup-dispatch-${jobId}`,
      ...PRIVILEGED_JOB_OPTIONS,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

export async function enqueueBackupResults(
  jobId: string,
  orgId: string,
  deviceId: string,
  result: ProcessResultsResult,
  meta: QueueActorMeta = AGENT_RESULT_META,
): Promise<string> {
  const queue = getBackupQueue();
  const payload = backupQueueJobDataSchema.parse(withQueueMeta({
    type: 'process-results' as const,
    jobId,
    orgId,
    deviceId,
    result,
  }, meta));
  const job = await queue.add(
    'process-results',
    payload,
    {
      jobId: `backup-result-${jobId}`,
      ...PRIVILEGED_JOB_OPTIONS,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

export async function removeQueuedBackupDispatch(jobId: string): Promise<boolean> {
  const queue = getBackupQueue();
  const queuedJob = await queue.getJob(`backup-dispatch-${jobId}`);
  if (!queuedJob) {
    return false;
  }

  const state = await queuedJob.getState();
  if (state !== 'waiting' && state !== 'delayed' && state !== 'paused') {
    return false;
  }

  await queuedJob.remove();
  return true;
}
