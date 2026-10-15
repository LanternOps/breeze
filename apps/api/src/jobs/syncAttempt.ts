import type { Job } from 'bullmq';

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
