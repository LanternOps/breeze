import type { JobsOptions, Queue } from 'bullmq';
import { createInstrumentedQueue } from '../bullmqQueue';
import { bullmqJobId, enqueueOrReplaceStale } from '../bullmqUtils';

/**
 * The `portal-directory-deprovision` queue (portal registration W8 #11385,
 * plan D10), in its own leaf module: the run store enqueues `apply-run` after
 * commit, and the worker (jobs) consumes it, so neither imports the other.
 *
 * Job names: `apply-run` (here), `google-sweep`, `google-org` and `recover`
 * (the worker's). Job ids carry no colons. The run row is the outbox: an
 * `applying` run whose enqueue failed is re-enqueued by `recover`.
 */
export const PORTAL_DIRECTORY_QUEUE = 'portal-directory-deprovision';
export const PORTAL_DIRECTORY_APPLY_JOB = 'apply-run';

export interface PortalDirectoryApplyJobData {
  runId: string;
  orgId: string;
}

/**
 * `removeOnComplete: true` — a finished run is fully described by its row.
 * Failures are kept 7 days for an operator. Backoff 1 / 5 / 15 min through the
 * worker's `backoffStrategy` ({@link portalDirectoryBackoff}).
 */
export const PORTAL_DIRECTORY_JOB_OPTS: Omit<JobsOptions, 'jobId'> = {
  attempts: 3,
  backoff: { type: 'custom' },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 86400 },
};

const BACKOFF_LADDER_MS = [60_000, 300_000, 900_000] as const;

/** BullMQ passes the 1-based attempt number. Never -1 (see jobs/m365SyncQueue.ts). */
export function portalDirectoryBackoff(attemptsMade: number): number {
  const index = Math.min(Math.max(Math.trunc(attemptsMade), 1), BACKOFF_LADDER_MS.length) - 1;
  return BACKOFF_LADDER_MS[index]!;
}

export function applyRunJobId(runId: string): string {
  return bullmqJobId('portal-dir-apply', runId);
}

let queue: Queue | null = null;

export function getPortalDirectoryQueue(): Queue {
  if (!queue) queue = createInstrumentedQueue(PORTAL_DIRECTORY_QUEUE);
  return queue;
}

export async function closePortalDirectoryQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

/**
 * Enqueue the apply of one `applying` run, after its transaction committed.
 * `enqueueOrReplaceStale`: a retained failed record under the same id would
 * otherwise swallow the re-enqueue forever. Never throws — `false` leaves the
 * run to the recovery sweep.
 */
export async function enqueueApplyRun(runId: string, orgId: string): Promise<boolean> {
  try {
    const data: PortalDirectoryApplyJobData = { runId, orgId };
    await enqueueOrReplaceStale(
      getPortalDirectoryQueue(),
      PORTAL_DIRECTORY_APPLY_JOB,
      applyRunJobId(runId),
      data,
      PORTAL_DIRECTORY_JOB_OPTS,
      '[portal-directory]',
    );
    return true;
  } catch (err) {
    console.error('[portal-directory] apply-run enqueue failed; the recovery sweep re-enqueues it', {
      runId,
      orgId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return false;
  }
}
