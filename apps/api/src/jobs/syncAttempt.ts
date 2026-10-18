import type { Job } from 'bullmq';
import { nudgeConnectionHealth } from '../services/connectionHealth/nudge';
import type { ConnectionSourceKind } from '../services/connectionHealth/types';

/**
 * True on the job's last configured attempt. BullMQ 5 increments `attemptsMade` only when an
 * attempt finishes or is retried (move-to-active bumps `attemptsStarted`), so inside the
 * processor it is 0-based: the 3rd of 3 attempts runs with attemptsMade === 2.
 *
 * Shared by the EDR, backup-provider, M365 and Huntress sync workers (#8351). Lives in its own
 * module so a worker does not have to import another worker's queue/db graph to use it;
 * `edrProviderSync` re-exports it for its existing callers.
 */
export function isFinalSyncAttempt(job: Pick<Job, 'attemptsMade'> & { opts: { attempts?: number } }): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/**
 * The worker just recorded a terminal sync failure (the final attempt, or a
 * rejected credential): ask connection health to observe that kind in about a
 * minute instead of at its next poll (spec §1.3, W4). Fire-and-forget; never
 * throws into the worker, whose own error handling must stay unchanged.
 */
export function reportTerminalSyncFailure(kind: ConnectionSourceKind): void {
  try {
    nudgeConnectionHealth(kind);
  } catch {
    // nudgeConnectionHealth never throws; this guards the sync path anyway.
  }
}
