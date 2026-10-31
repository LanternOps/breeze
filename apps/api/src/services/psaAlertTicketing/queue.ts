import type { Queue } from 'bullmq';
import { createInstrumentedQueue } from '../bullmqQueue';
export const PSA_TICKETING_QUEUE = 'psa-ticketing';
export type PsaTicketingJob = { mappingId: string; op: 'create' | 'close' | 'note' };
let queue: Queue<PsaTicketingJob> | null = null;
export function ticketingQueue() {
  return queue ??= createInstrumentedQueue<PsaTicketingJob>(PSA_TICKETING_QUEUE);
}
export async function wakeMapping(mappingId: string, op: PsaTicketingJob['op'] = 'create', at = new Date()) {
  await ticketingQueue().add('reconcile', { mappingId, op }, {
    priority: op === 'create' ? 10 : 1, delay: Math.max(0, at.getTime() - Date.now()),
    removeOnComplete: true, removeOnFail: 100,
  });
}
export async function closeTicketingQueue() { await queue?.close(); queue = null; }
