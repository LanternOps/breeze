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

/** Must be called outside any DB context: it only talks to Redis. */
export async function enqueueGmailMarkHandled(
  providerMessageId: string,
  generation: MailboxGenerationContext,
): Promise<void> {
  const data: GmailMarkHandledJobData = { email: { provider: 'gmail', providerMessageId }, generation };
  await getGmailMarkHandledQueue().add('mark', data, {
    jobId: gmailMarkHandledJobId(providerMessageId, generation),
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
    // markIngestedGmailHandled retries rate-limited/transient Gmail errors itself
    // within its time budget and never throws; these attempts only cover a job
    // that dies before it can run (e.g. the worker process stops mid-job).
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
  });
}
