/**
 * Gmail Mark-Handled Worker (#7949)
 *
 * Consumes the `gmail-mark-handled` queue: for each Gmail message the inbound
 * worker ingested, applies the mailbox's handled label (and optional archive)
 * when the message became a ticket. All the rules live in
 * markIngestedGmailHandled (per-mailbox setting, generation binding, time
 * budget, no Gmail call inside a DB transaction, failures recorded on the
 * connection and reported once per change).
 *
 * Concurrency 1: marking is cosmetic, so a Gmail slowdown or outage may delay
 * labels but must never hold more than one slot of anything. Ticket intake runs
 * on the separate inbound-email worker and never waits on this one.
 */

import { Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { GMAIL_MARK_HANDLED_QUEUE, type GmailMarkHandledJobData } from '../services/gmailMarkHandledQueue';
import { markIngestedGmailHandled, type MarkIngestedResult } from '../services/ticketMailbox/markIngestedGmailHandled';
import { attachWorkerObservability } from './workerObservability';

export const GMAIL_MARK_HANDLED_CONCURRENCY = 1;

let worker: Worker<GmailMarkHandledJobData> | null = null;

/** Thrown only to make BullMQ retry a transient failure with backoff. The
 *  failure itself is already recorded on the connection (and reported to Sentry
 *  once, when its code changed), so these attempts are not reported again. */
export class GmailMarkRetryLater extends Error {
  constructor() {
    super('transient Gmail mark-handled failure; retrying with backoff');
    this.name = 'GmailMarkRetryLater';
  }
}

export async function handleGmailMarkHandled(job: Job<GmailMarkHandledJobData>): Promise<MarkIngestedResult> {
  const { email, generation } = job.data;
  const result = await markIngestedGmailHandled(email, generation);
  if (result !== 'retry') return result;
  // The last attempt completes instead of failing, so the BullMQ failure path
  // never reaches Sentry for it: the recorded code already said what happened.
  const attemptsLeft = (job.opts?.attempts ?? 1) - ((job.attemptsMade ?? 0) + 1);
  if (attemptsLeft > 0) throw new GmailMarkRetryLater();
  return 'failed';
}

export function initializeGmailMarkHandledWorker(): Promise<void> {
  if (worker) return Promise.resolve();

  worker = new Worker<GmailMarkHandledJobData>(
    GMAIL_MARK_HANDLED_QUEUE,
    (job: Job<GmailMarkHandledJobData>) => handleGmailMarkHandled(job),
    {
      connection: getBullMQConnection(),
      concurrency: GMAIL_MARK_HANDLED_CONCURRENCY,
    },
  );
  attachWorkerObservability(worker, 'gmailMarkHandledWorker', {
    // A retry-later attempt is expected and already recorded on the connection;
    // anything else a job throws is reported as usual.
    classifyFailure: (_job, err) => (err instanceof GmailMarkRetryLater
      ? { level: 'warning', reason: 'gmail_mark_retry', reportOnlyWhenExhausted: true }
      : null),
  });

  worker.on('error', (error) => {
    console.error('[GmailMarkHandled] Worker error:', error);
  });

  console.log('[GmailMarkHandled] Worker initialized');
  return Promise.resolve();
}

export async function shutdownGmailMarkHandledWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
