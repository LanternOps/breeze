/**
 * Backup Queue — enqueue helpers for backup job dispatch/result processing
 *
 * Extracted from backupWorker.ts to keep files under the 500-line limit.
 * Re-exported from backupWorker.ts for backward compatibility.
 */

import { Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import {
  backupQueueJobDataSchema,
  type QueueActorMeta,
  withQueueMeta,
} from './queueSchemas';

const BACKUP_QUEUE = 'backup';

/**
 * Retrying options for the queue's IDEMPOTENT work.
 *
 * `process-results` re-applies the same agent payload to the same job row, so
 * replaying it after a transient DB/Redis blip converges on the same state —
 * retrying is a straight win there.
 *
 * NOT for `dispatch-backup`: see {@link DISPATCH_JOB_OPTIONS}.
 */
const PRIVILEGED_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1_000,
  },
};

/**
 * One-shot options for `dispatch-backup` (#4137).
 *
 * `processDispatchBackup` is NOT idempotent: its Phase 3
 * (`prepareBackupDispatchTargets`) INSERTs a brand-new `backup_jobs` child row
 * for every target after the first, and commits them before the Phase-4 sends.
 * A retry therefore re-runs Phase 3 and creates a SECOND set of children while
 * the first set is stranded at status='running' forever — nothing sweeps
 * children by parent id, because no parent linkage column exists. It would
 * also re-send commands the agent may already be running.
 *
 * So the dispatch gives up retries entirely: a failed dispatch leaves the job
 * row as the retry surface (the scheduler creates a fresh job on the next
 * tick, and an operator can re-run it manually), exactly the trade the other
 * non-idempotent one-shots in this repo make — `jobs/aiAgentEnqueuer.ts`,
 * `jobs/orgMerge.ts`, `jobs/tenantErasure.ts`.
 *
 * `attempts: 1` alone does not close the whole hole: BullMQ re-delivers a
 * STALLED job (worker process killed mid-run) independently of `attempts`,
 * up to the worker's `maxStalledCount`. `processDispatchBackup` therefore also
 * refuses to run a re-delivery — see the `redelivered` guard in backupWorker.ts.
 */
const DISPATCH_JOB_OPTIONS = {
  attempts: 1,
};

let backupQueue: Queue | null = null;

export function getBackupQueue(): Queue {
  if (!backupQueue) {
    backupQueue = createInstrumentedQueue(BACKUP_QUEUE);
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
  // The agent's own terminal status (`completed` | `partial` | …), distinct
  // from `status` above which is the outer completed/failed command status.
  // See backupProcessResultSchema — a `partial` run rides only this key.
  agentStatus?: string;
  jobId?: string;
  snapshotId?: string;
  filesBackedUp?: number;
  bytesBackedUp?: number;
  warning?: string;
  // Partial-success count and incremental dedup accounting. Must ride the
  // queue payload: the persistence layer only writes what arrives here, and
  // dropping them silently zeroes the job's error count and upload savings.
  errorCount?: number;
  referencedFiles?: number;
  referencedBytes?: number;
  // system_image (system-state) backups carry these; the WS handler must
  // forward them or the snapshot loses its type label + BMR restore manifest.
  backupType?: 'file' | 'system_image' | 'database' | 'application';
  systemStateManifest?: Record<string, unknown> | null;
  // Windows VSS diagnostics (#3027). Must ride the queue payload for the same
  // reason the manifest does: the persistence layer only writes what arrives
  // here, and dropping it leaves backup_jobs.vss_metadata permanently NULL.
  // Typed `unknown` on purpose — see backupProcessResultSchema.
  vssMetadata?: unknown;
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
      ...DISPATCH_JOB_OPTIONS,
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
  if (state !== 'waiting' && state !== 'delayed' && state !== ('paused' as string)) {
    return false;
  }

  await queuedJob.remove();
  return true;
}
