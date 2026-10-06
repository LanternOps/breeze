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

export async function handleGmailMarkHandled(job: Job<GmailMarkHandledJobData>): Promise<MarkIngestedResult> {
  const { email, generation } = job.data;
  return markIngestedGmailHandled(email, generation);
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
  attachWorkerObservability(worker, 'gmailMarkHandledWorker');

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
