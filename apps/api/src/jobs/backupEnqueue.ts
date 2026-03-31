/**
 * Backup Queue — enqueue helpers for backup/restore job dispatch
 *
 * Extracted from backupWorker.ts to keep files under the 500-line limit.
 * Re-exported from backupWorker.ts for backward compatibility.
 */

import { Queue } from 'bullmq';
import { getRedisConnection } from '../services/redis';

const BACKUP_QUEUE = 'backup';

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

// ── Public enqueue functions ─────────────────────────────────────────────────

export async function enqueueBackupDispatch(
  jobId: string,
  configId: string,
  orgId: string,
  deviceId: string
): Promise<string> {
  const queue = getBackupQueue();
  const job = await queue.add(
    'dispatch-backup',
    {
      type: 'dispatch-backup' as const,
      jobId,
      configId,
      orgId,
      deviceId,
    },
    {
      jobId: `backup-dispatch-${jobId}`,
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
  result: ProcessResultsResult
): Promise<string> {
  const queue = getBackupQueue();
  const job = await queue.add(
    'process-results',
    {
      type: 'process-results' as const,
      jobId,
      orgId,
      deviceId,
      result,
    },
    {
      jobId: `backup-result-${jobId}`,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

export async function enqueueRestoreDispatch(
  restoreJobId: string,
  snapshotId: string,
  deviceId: string,
  orgId: string,
  targetPath?: string,
  selectedPaths?: string[]
): Promise<string> {
  const queue = getBackupQueue();
  const job = await queue.add(
    'dispatch-restore',
    {
      type: 'dispatch-restore' as const,
      restoreJobId,
      snapshotId,
      deviceId,
      orgId,
      targetPath,
      selectedPaths,
    },
    {
      jobId: `backup-restore-${restoreJobId}`,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}
