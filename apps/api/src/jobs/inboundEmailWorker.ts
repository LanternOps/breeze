/**
 * Inbound Email Worker
 *
 * Consumes the `inbound-email` BullMQ queue and processes each normalized
 * inbound email through processInboundEmail, which:
 *   1. Resolves partner by recipient address
 *   2. Deduplicates by provider message id
 *   3. Finds or creates the ticket (with reopen logic)
 *   4. Appends the public comment
 *   5. Emits ticket.commented with inbound:true (suppresses echo in ticketNotifyWorker)
 *
 * DB work runs inside runOutsideDbContext → withSystemDbAccessContext to avoid
 * idle-in-transaction pool poison (#1105): the provider HTTP callback is not
 * active at this point, so withSystemDbAccessContext is safe to call directly,
 * but we wrap in runOutsideDbContext as belt-and-suspenders in case the worker
 * is started in a context that already holds a DB context open.
 */

import { Worker, type Job } from 'bullmq';
import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { INBOUND_EMAIL_QUEUE } from '../services/inboundEmailQueue';
import { processInboundEmail } from '../services/inboundEmail/inboundEmailService';
import type { NormalizedInboundEmail } from '../services/inboundEmail/types';

let worker: Worker<NormalizedInboundEmail> | null = null;

export async function handleInboundEmail(job: Job<NormalizedInboundEmail>): Promise<void> {
  // runOutsideDbContext is a synchronous wrapper that asserts no open DB context
  // exists on the current async-context stack and then runs fn() in a clean scope.
  // We need to bridge it to our async work by returning the Promise it produces.
  return dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(() => processInboundEmail(job.data))
  );
}

export function initializeInboundEmailWorker(): Promise<void> {
  if (worker) return Promise.resolve();

  worker = new Worker<NormalizedInboundEmail>(
    INBOUND_EMAIL_QUEUE,
    (job: Job<NormalizedInboundEmail>) => handleInboundEmail(job),
    { connection: getBullMQConnection(), concurrency: 5 }
  );

  worker.on('error', (error) => {
    console.error('[InboundEmail] Worker error:', error);
  });

  worker.on('failed', (job, error) => {
    const msgId = job?.data?.providerMessageId;
    const attempts = job?.attemptsMade;
    console.error(`[InboundEmail] Job ${job?.id} failed (providerMessageId=${msgId}, attempts=${attempts}):`, error);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  });

  console.log('[InboundEmail] Worker initialized');
  return Promise.resolve();
}

export async function shutdownInboundEmailWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
