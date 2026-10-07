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
  type MailboxGenerationContext,
} from '../services/inboundEmailQueue';
import { processInboundEmail, InboundEmailProcessingRecorded } from '../services/inboundEmail/inboundEmailService';
import {
  discardUnpersistedAttachments,
  prepareM365Attachments,
} from '../services/ticketMailbox/fetchInboundAttachments';
import { inboundQueueMaxPerSec } from '../config/env';
import { enqueueGmailMarkHandled } from '../services/gmailMarkHandledQueue';
import { isGmailMarkWanted, recordGmailHandledFailure } from '../services/ticketMailbox/markIngestedGmailHandled';
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

  if (email.provider === 'gmail') {
    await run();
    // Opt-in per mailbox (ticket_mailbox_connections.gmail_handled_label):
    // label/archive mail that became a ticket. Best effort, on its own queue and
    // worker (jobs/gmailMarkHandledWorker), so intake never waits on Gmail.
    // Everything here runs after the pipeline's transaction has closed and
    // outside any DB context, and nothing here may fail the job: the ticket
    // already exists, and a rejected job would be retried and re-run the
    // pipeline. Only a generation-bound Gmail job can be marked.
    if (mailboxGeneration?.provider !== 'gmail') return;
    await queueGmailMark(email.providerMessageId, mailboxGeneration);
    return;
  }
  // M365 attachments (#6688): Graph download + blob put happen HERE, before the
  // transaction opens, never inside it (see fetchInboundAttachments.ts). Only a
  // generation-bound job can name the tenant to fetch from.
  if (email.provider !== 'm365' || !mailboxGeneration?.tenantId || !email.hasAttachments) return run();

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

/** Longest the intake job waits on Redis to queue a mark before recording
 *  not_queued and moving on. */
export const GMAIL_MARK_ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * Queue the mark for a message only when it can matter (the mailbox has a
 * handled label and the message became a ticket). A full queue, a Redis
 * failure or an enqueue that does not finish within
 * GMAIL_MARK_ENQUEUE_TIMEOUT_MS leaves the message unlabelled in the inbox and
 * is recorded on the mailbox as `not_queued`, so the card shows it. If that
 * database write also fails, it is only logged. Never throws.
 */
async function queueGmailMark(providerMessageId: string, generation: MailboxGenerationContext): Promise<void> {
  try {
    if (!(await isGmailMarkWanted(providerMessageId, generation))) return;
  } catch (err) {
    // The mark job re-checks everything itself, so queue it anyway.
    console.warn('[gmailHandled] mark pre-check failed; queueing anyway', {
      connectionId: generation.connectionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  let failure: unknown = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bounded: the shared Redis client retries a lost connection indefinitely,
    // so an outage must not hold this intake job. A late add may still land
    // after the timeout; its job id keeps it to one mark.
    const queued = await Promise.race([
      dbModule.runOutsideDbContext(() => enqueueGmailMarkHandled(providerMessageId, generation)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('mark-handled enqueue timed out')), GMAIL_MARK_ENQUEUE_TIMEOUT_MS);
      }),
    ]);
    if (queued === 'full') failure = new Error('mark-handled queue is at its cap');
  } catch (err) {
    failure = err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (failure === null) return;
  console.warn('[gmailHandled] mark not queued; message stays in the inbox', {
    connectionId: generation.connectionId,
    err: failure instanceof Error ? failure.message : String(failure),
  });
  await recordGmailHandledFailure(generation, 'not_queued', failure).catch(() => {});
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
