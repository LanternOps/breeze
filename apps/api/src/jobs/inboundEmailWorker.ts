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
import {
  INBOUND_EMAIL_QUEUE,
  type InboundEmailJobData,
  type InboundEmailQueueJob,
} from '../services/inboundEmailQueue';
import { processInboundEmail, InboundEmailProcessingRecorded } from '../services/inboundEmail/inboundEmailService';
import {
  discardUnpersistedAttachments,
  prepareM365Attachments,
} from '../services/ticketMailbox/fetchInboundAttachments';
import { inboundQueueMaxPerSec } from '../config/env';
import { attachWorkerObservability } from './workerObservability';

let worker: Worker<InboundEmailQueueJob> | null = null;

function unwrapJob(data: InboundEmailQueueJob): InboundEmailJobData {
  return 'email' in data ? data : { email: data };
}

export async function handleInboundEmail(job: Job<InboundEmailQueueJob>): Promise<void> {
  const { email, mailboxGeneration } = unwrapJob(job.data);
  // DB work runs inside runOutsideDbContext → withSystemDbAccessContext to avoid
  // idle-in-transaction pool poison (#1105). Flood protection is the global
  // per-second queue limiter configured on the Worker below (INBOUND_QUEUE_MAX_PER_SEC);
  // there is no per-sender Redis cap in the pipeline.
  const run = async (): Promise<void> => {
    try {
      await dbModule.runOutsideDbContext(() =>
        dbModule.withSystemDbAccessContext(() => processInboundEmail(email, mailboxGeneration)),
      );
    } catch (err) {
      // processInboundEmail throws this sentinel AFTER durably recording a terminal
      // `failed` row, purely so the outer tx rolls back its partial writes. That row
      // is the terminal record (surfaced in the review queue), so swallow it — do NOT
      // let it reject the job, which would make BullMQ retry. Any OTHER error is a
      // genuine infra fault: rethrow so BullMQ retries.
      if (err instanceof InboundEmailProcessingRecorded) return;
      throw err;
    }
  };

  // M365 attachments (#6688): Graph download + blob put happen HERE, before the
  // transaction opens, never inside it (see fetchInboundAttachments.ts). Only a
  // generation-bound job can name the tenant to fetch from.
  if (email.provider !== 'm365' || !mailboxGeneration || !email.hasAttachments) return run();

  await prepareM365Attachments(email, {
    tenantId: mailboxGeneration.tenantId,
    finalAttempt: (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1),
  });
  try {
    return await run();
  } finally {
    await discardUnpersistedAttachments(email);
  }
}

export function initializeInboundEmailWorker(): Promise<void> {
  if (worker) return Promise.resolve();

  worker = new Worker<InboundEmailQueueJob>(
    INBOUND_EMAIL_QUEUE,
    (job: Job<InboundEmailQueueJob>) => handleInboundEmail(job),
    {
      connection: getBullMQConnection(),
      concurrency: 5,
      // Flood protection: cap how many inbound jobs PROCESS per second across ALL
      // senders (INBOUND_QUEUE_MAX_PER_SEC). This is backpressure — it bounds the
      // RATE of ticket creation, smoothing a burst or spam flood so the worker,
      // Postgres, and downstream notifications are not overwhelmed. BullMQ delays
      // over-rate jobs rather than dropping them (nothing is lost), so it does NOT
      // cap the TOTAL number of tickets a sustained flood eventually creates — it
      // only slows the rate. A per-sender/volume cap is deferred (see env.ts).
      limiter: { max: inboundQueueMaxPerSec(), duration: 1000 },
    }
  );
  attachWorkerObservability(worker, 'inboundEmailWorker');

  worker.on('error', (error) => {
    console.error('[InboundEmail] Worker error:', error);
  });

  worker.on('failed', (job, error) => {
    const msgId = job ? unwrapJob(job.data).email.providerMessageId : undefined;
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
