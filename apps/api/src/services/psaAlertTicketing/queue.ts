import type { Queue } from 'bullmq';
import type { z } from 'zod';
import { hasDbAccessContext, runAfterDbContextExit } from '../../db';
import { psaTicketingJobDataSchema } from '../../jobs/queueSchemas';
import { createInstrumentedQueue } from '../bullmqQueue';
export const PSA_TICKETING_QUEUE = 'psa-ticketing';
export type PsaTicketingJob = z.infer<typeof psaTicketingJobDataSchema>;
const DEFERRED_WAKE_TIMEOUT_MS = 2_000;
let queue: Queue<PsaTicketingJob> | null = null;
export function ticketingQueue() {
  return (queue ??= createInstrumentedQueue<PsaTicketingJob>(PSA_TICKETING_QUEUE));
}
function enqueueWake(mappingId: string, op: PsaTicketingJob['op'], at: Date) {
  return ticketingQueue().add(
    'reconcile',
    { mappingId, op },
    {
      // Include the due second so an active job can enqueue its successor.
      // Simultaneous wakes for the same mapping and due second collapse.
      jobId: `${mappingId}-${Math.ceil(at.getTime() / 1000)}`,
      priority: op === 'create' ? 10 : 1,
      delay: Math.max(0, at.getTime() - Date.now()),
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );
}
/**
 * Nobody awaits a deferred wake, and the BullMQ connection's offline queue makes
 * add() hang rather than reject while Redis is down. Time-box it so that outage
 * still leaves a log line. The reconciler repairs the lost wake.
 */
async function deferredWake(mappingId: string, op: PsaTicketingJob['op'], at: Date) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      enqueueWake(mappingId, op, at),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`wake timed out after ${DEFERRED_WAKE_TIMEOUT_MS} ms`)),
          DEFERRED_WAKE_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    console.warn('[psa-ticketing] deferred wake failed; the reconciler will pick it up', {
      mappingId, op, message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}
/**
 * The single enqueue path. Inside a held DB context the enqueue is deferred
 * until that context's transaction settles, so a Redis round trip never pins
 * its pooled connection (#1105, #10933) and a worker never reads the row before
 * the commit that made it due (#10926). A deferred failure is logged, not thrown.
 * Deferred on exit, not commit: admission and connection resume commit on their
 * own connection and wake from inside a request context, so a request rollback
 * must not lose their wake. The worker derives its operation from committed
 * state, which makes a wake after a rollback a no-op.
 *
 * With no context held (the worker), a failed enqueue rejects to the caller.
 */
export async function wakeMapping(
  mappingId: string,
  // Priority hint only: the worker derives the actual operation from committed state.
  op: PsaTicketingJob['op'] = 'create',
  at = new Date()
) {
  if (hasDbAccessContext()) {
    runAfterDbContextExit(`psa-ticketing.wake:${mappingId}`, () => deferredWake(mappingId, op, at));
    return;
  }
  await enqueueWake(mappingId, op, at);
}
export async function closeTicketingQueue() {
  await queue?.close();
  queue = null;
}
