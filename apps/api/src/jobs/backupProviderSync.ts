import type { JobsOptions, Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';

/**
 * External backup provider sync (#6008).
 *
 * W01 ships ONLY the queue handle and the enqueue helper — the connection
 * create route and "Sync now" both call `enqueueBackupProviderSync`, and the
 * job waits in Redis until W02 adds the worker, the repeatable `sync-all`
 * ticker and `syncConnectionById` to this same file. Shipping a route that
 * claims to sync with nothing behind it would be worse than a visibly queued
 * job.
 */
export const BACKUP_PROVIDER_SYNC_QUEUE = 'backup-provider-sync';

export interface SyncAllJobData { type: 'sync-all' }
export interface SyncConnectionJobData { type: 'sync-connection'; connectionId: string }
export type BackupProviderSyncJobData = SyncAllJobData | SyncConnectionJobData;

/**
 * Three attempts with exponential backoff, matching huntressSync: a
 * per-connection sync is one enumeration plus one idempotent upsert
 * transaction, so a transient managed-Postgres connection drop or a vendor 503
 * is worth retrying. W02's `reauth` failures throw `UnrecoverableError`, which
 * BullMQ does not retry regardless of this setting.
 */
export const BACKUP_PROVIDER_SYNC_JOB_OPTS: Omit<JobsOptions, 'jobId'> = {
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 200 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

let queue: Queue<BackupProviderSyncJobData> | null = null;

/**
 * `createInstrumentedQueue`, not a bare `new Queue`: it wraps `add`/`addBulk`
 * in `assertOutsideHeldDbContext`, which throws in CI when an enqueue happens
 * inside a held request transaction (#1105). Every call site of
 * `enqueueBackupProviderSync` therefore runs it under `runOutsideDbContext`.
 */
export function getBackupProviderSyncQueue(): Queue<BackupProviderSyncJobData> {
  if (!queue) {
    queue = createInstrumentedQueue<BackupProviderSyncJobData>(BACKUP_PROVIDER_SYNC_QUEUE);
  }
  return queue;
}

/** The ONE job id for a connection, so a scheduled sync and "Sync now" coalesce. */
export function backupProviderSyncJobId(connectionId: string): string {
  return `backup-provider-sync-${connectionId}`;
}

/**
 * Queue a sync for one connection, returning the job id.
 *
 * Goes through `enqueueOrReplaceStale` rather than a bare `queue.add`: BullMQ's
 * jobId dedup keys on "a record with this id EXISTS", and `removeOnFail`
 * deliberately keeps recent failures around — so after a failed sync every
 * later `add` under the same id is silently discarded and the operator's "Sync
 * now" does nothing, forever. The helper reuses a genuinely in-flight job
 * (active/waiting/delayed/prioritized) and replaces a spent record.
 */
export async function enqueueBackupProviderSync(connectionId: string): Promise<string> {
  if (!connectionId) {
    throw new Error('enqueueBackupProviderSync requires a connection id');
  }
  const { id } = await enqueueOrReplaceStale(
    getBackupProviderSyncQueue(),
    'sync-connection',
    backupProviderSyncJobId(connectionId),
    { type: 'sync-connection', connectionId } satisfies SyncConnectionJobData,
    BACKUP_PROVIDER_SYNC_JOB_OPTS,
    '[BackupProviderSync]',
  );
  return id;
}

/** Close the queue connection (tests, and W02's `shutdownBackupProviderSyncJob`). */
export async function shutdownBackupProviderSyncQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = null;
}
