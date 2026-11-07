import { Queue } from 'bullmq';
import { bullmqJobId } from '../bullmqUtils';
import { getBullMQConnection } from '../redis';
import type { TicketImportSliceJobData } from '../../jobs/queueSchemas';

/**
 * The `ticket-import` queue (#8313 W4; spec 2026-10-19 §5.8). One job per
 * slice, `{ runId, partnerId, seq }`, id `ticket-import-<runId>-<seq>`.
 * Producers: the run-start route (slice 0) and the worker itself (slice
 * seq + 1, the first job in the repo that continues itself). The consumer is
 * jobs/ticketImportWorker.ts.
 */

export const TICKET_IMPORT_QUEUE = 'ticket-import';
export const TICKET_IMPORT_SLICE_JOB = 'slice';
/** The stalled-run sweep, a repeatable job on the same queue (review #9). */
export const TICKET_IMPORT_SWEEP_JOB = 'stalled-run-sweep';
export const TICKET_IMPORT_SLICE_ATTEMPTS = 3;

let queue: Queue | null = null;

export function getTicketImportQueue(): Queue {
  if (!queue) queue = new Queue(TICKET_IMPORT_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export function ticketImportSliceJobId(runId: string, seq: number): string {
  return bullmqJobId('ticket-import', runId, seq);
}

/**
 * Enqueues one slice. A plain `add` under the slice's id on purpose: BullMQ
 * keeps a job id that exists in any state, so a retried slice that re-enqueues
 * a successor already queued, delayed, running or done adds nothing, and a
 * slice never runs twice from two enqueues.
 */
export async function enqueueTicketImportSlice(data: TicketImportSliceJobData, delayMs = 0): Promise<void> {
  await getTicketImportQueue().add(TICKET_IMPORT_SLICE_JOB, data, {
    jobId: ticketImportSliceJobId(data.runId, data.seq),
    attempts: TICKET_IMPORT_SLICE_ATTEMPTS,
    backoff: { type: 'exponential', delay: 10_000 },
    ...(delayMs > 0 ? { delay: Math.ceil(delayMs) } : {}),
    removeOnComplete: { age: 7 * 24 * 3600, count: 2000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 2000 },
  });
}

export async function closeTicketImportQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
