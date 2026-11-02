import type { Queue } from 'bullmq';
import type { z } from 'zod';
import { psaTicketingJobDataSchema } from '../../jobs/queueSchemas';
import { createInstrumentedQueue } from '../bullmqQueue';
export const PSA_TICKETING_QUEUE = 'psa-ticketing';
export type PsaTicketingJob = z.infer<typeof psaTicketingJobDataSchema>;
let queue: Queue<PsaTicketingJob> | null = null;
export function ticketingQueue() {
  return (queue ??= createInstrumentedQueue<PsaTicketingJob>(PSA_TICKETING_QUEUE));
}
export async function wakeMapping(
  mappingId: string,
  // Priority hint only: the worker derives the actual operation from committed state.
  op: PsaTicketingJob['op'] = 'create',
  at = new Date()
) {
  await ticketingQueue().add(
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
export async function closeTicketingQueue() {
  await queue?.close();
  queue = null;
}
