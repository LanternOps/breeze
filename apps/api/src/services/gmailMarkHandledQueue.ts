import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import type { MailboxGenerationContext } from './inboundEmailQueue';

/**
 * Gmail "mark handled" (#7949) runs on its own queue, off the inbound-email
 * worker: the inbound job enqueues one small job per ingested Gmail message and
 * returns, so ticket intake never waits on Gmail. The consumer
 * (jobs/gmailMarkHandledWorker) re-reads the mailbox setting and the message's
 * ticket status itself, so a message that did not become a ticket, or a mailbox
 * with no handled label, is a cheap no-op there.
 */
export const GMAIL_MARK_HANDLED_QUEUE = 'gmail-mark-handled';

/** Only what marking needs: no message body or headers are copied into Redis. */
export interface GmailMarkHandledJobData {
  email: { provider: 'gmail'; providerMessageId: string };
  generation: MailboxGenerationContext;
}

let queue: Queue<GmailMarkHandledJobData> | null = null;

export function getGmailMarkHandledQueue(): Queue<GmailMarkHandledJobData> {
  if (!queue) {
    queue = new Queue<GmailMarkHandledJobData>(GMAIL_MARK_HANDLED_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return queue;
}

/** One job per message and connection generation. BullMQ ignores an add whose
 *  job id already exists, so a retried inbound job does not queue a second mark.
 *  Custom job ids may not contain ':', so the provider message id is hashed. */
export function gmailMarkHandledJobId(providerMessageId: string, generation: MailboxGenerationContext): string {
  const digest = createHash('sha256')
    .update(`${generation.connectionId}\u0000${generation.consentAttemptId}\u0000${providerMessageId}`)
    .digest('hex');
  return `gmail-mark-${digest}`;
}

/** Most jobs waiting (or delayed for a retry) before new marks are skipped.
 *  At about a second per mark that is over an hour of backlog; past it, a Gmail
 *  outage stops growing Redis and the skip is recorded on the mailbox card. */
export const GMAIL_MARK_HANDLED_QUEUE_CAP = 5_000;

/** Queue-level retries for a transient Gmail failure (rate limit, unavailable,
 *  too slow) that outlasts the in-call retries: 30 s, 1, 2 and 4 minutes. */
export const GMAIL_MARK_HANDLED_ATTEMPTS = 5;
const GMAIL_MARK_HANDLED_BACKOFF_MS = 30_000;

export type EnqueueGmailMarkResult = 'queued' | 'full';

/**
 * Must be called outside any DB context: it only talks to Redis. Returns
 * 'full' without queueing when the backlog is at the cap. The cap is checked
 * before the add, so concurrent producers can overshoot it slightly.
 */
export async function enqueueGmailMarkHandled(
  providerMessageId: string,
  generation: MailboxGenerationContext,
  /** `cap` and `backoffMs` are test hooks; production uses the defaults. */
  opts: { cap?: number; backoffMs?: number } = {},
): Promise<EnqueueGmailMarkResult> {
  const q = getGmailMarkHandledQueue();
  // waiting + paused + delayed (retry backoff) + prioritized
  if (await q.count() >= (opts.cap ?? GMAIL_MARK_HANDLED_QUEUE_CAP)) return 'full';
  const data: GmailMarkHandledJobData = { email: { provider: 'gmail', providerMessageId }, generation };
  await q.add('mark', data, {
    jobId: gmailMarkHandledJobId(providerMessageId, generation),
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
    attempts: GMAIL_MARK_HANDLED_ATTEMPTS,
    backoff: { type: 'exponential', delay: opts.backoffMs ?? GMAIL_MARK_HANDLED_BACKOFF_MS },
  });
  return 'queued';
}
