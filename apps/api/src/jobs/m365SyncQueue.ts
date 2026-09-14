import { Queue, type JobsOptions } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { syncJobId } from '../services/m365Sync/claim';
import type { M365SyncJobData } from '../services/m365Sync/types';

/**
 * Queue handle + enqueue policy for the m365 tenant sync, in its own leaf
 * module. `services/m365Sync/claim.ts` must enqueue (the priority-1 lane) and
 * `jobs/m365SyncWorker.ts` must claim; putting the Queue in the worker file
 * would make those two import each other.
 */
export const M365_SYNC_QUEUE = 'm365-sync';
export const M365_SYNC_TICK_JOB_ID = 'm365-sync-tick';
export const M365_SYNC_TICK_INTERVAL_MS = 60_000;

export type M365SyncQueueJobData = M365SyncJobData | Record<string, never>;

/**
 * Spec §5.2 step 4. `removeOnComplete: true` keeps Redis flat — a completed
 * run is fully described by m365_sync_state. Failures are retained (100) so an
 * operator can see why a domain stopped.
 */
export const SYNC_DOMAIN_JOB_OPTS: Omit<JobsOptions, 'jobId' | 'priority'> = {
  removeOnComplete: true,
  removeOnFail: { count: 100 },
  attempts: 3,
  backoff: { type: 'custom' },
};

/**
 * 30 s / 2 min / 8 min (spec §5.7). BullMQ passes the 1-based attempt number.
 * Never returns -1: a -1 tells BullMQ to stop retrying WITHOUT advancing
 * attemptsMade, which would strand `reportOnlyWhenExhausted` reports forever
 * (see the hazard note in jobs/workerObservability.ts).
 */
const BACKOFF_LADDER_MS = [30_000, 120_000, 480_000] as const;
export function m365SyncBackoff(attemptsMade: number): number {
  const index = Math.min(Math.max(Math.trunc(attemptsMade), 1), BACKOFF_LADDER_MS.length) - 1;
  return BACKOFF_LADDER_MS[index]!;
}

let queue: Queue<M365SyncQueueJobData> | null = null;

export function getM365SyncQueue(): Queue<M365SyncQueueJobData> {
  if (!queue) {
    queue = new Queue<M365SyncQueueJobData>(M365_SYNC_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

export async function closeM365SyncQueue(): Promise<void> {
  if (queue) { await queue.close(); queue = null; }
}

/**
 * A bare `queue.add({ jobId })` would be silently DISCARDED when a retained
 * FAILED job already holds the id — a permanent wedge with no error anywhere.
 * `enqueueOrReplaceStale` reuses a genuinely in-flight job and replaces a spent
 * record. The generation in the id means a fresh claim never collides with an
 * old one anyway; this is the belt to that braces.
 */
export async function enqueueSyncDomain(data: M365SyncJobData): Promise<string> {
  const { id } = await enqueueOrReplaceStale(
    getM365SyncQueue(),
    'sync-domain',
    syncJobId(data),
    data,
    { ...SYNC_DOMAIN_JOB_OPTS, priority: data.priority },
    '[M365Sync]',
  );
  return id;
}
