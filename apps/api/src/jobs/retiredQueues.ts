import { Queue } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { safeErrorMessage } from '../services/aiModels/safeDbError';

/**
 * BullMQ queues whose job code was deleted. Deleting a repeatable job's module
 * leaves its repeat key and its next delayed occurrence in Redis, where no
 * worker will ever consume them. `cleanupRetiredQueues` removes both at boot.
 * It is idempotent and never throws, so a Redis hiccup cannot fail boot.
 *
 * An entry stays for at least one release after the queue's last producer
 * shipped. Keep it longer when an upgrade may skip that release: a
 * deployment can jump from the last producing release straight to a later one.
 */
export const RETIRED_QUEUES: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: 'portal-identity-reconcile',
    reason: 'portal registration W10 (#11387, plan D4): the daily drift report read portal_users.entra_*, which release C drops',
  },
];

export type RetiredQueueCleanup = { queue: string; repeatablesRemoved: number; error?: string };

/** Remove every repeatable of each retired queue and drain its waiting + delayed jobs. */
export async function cleanupRetiredQueues(): Promise<RetiredQueueCleanup[]> {
  const results: RetiredQueueCleanup[] = [];
  for (const { name } of RETIRED_QUEUES) {
    const queue = new Queue(name, { connection: getBullMQConnection() });
    let removed = 0;
    try {
      for (const job of await queue.getRepeatableJobs()) {
        if (await queue.removeRepeatableByKey(job.key)) removed++;
      }
      await queue.drain(true);
      results.push({ queue: name, repeatablesRemoved: removed });
    } catch (err) {
      results.push({ queue: name, repeatablesRemoved: removed, error: safeErrorMessage(err) });
    } finally {
      try { await queue.close(); } catch { /* closing a broken connection is best-effort */ }
    }
  }
  return results;
}

export async function initializeRetiredQueueCleanup(): Promise<void> {
  for (const r of await cleanupRetiredQueues()) {
    if (r.error) console.warn(`[RetiredQueues] ${r.queue}: cleanup failed (${r.error}); retried at next boot`);
    else if (r.repeatablesRemoved > 0) console.log(`[RetiredQueues] ${r.queue}: removed ${r.repeatablesRemoved} repeatable(s)`);
  }
}
