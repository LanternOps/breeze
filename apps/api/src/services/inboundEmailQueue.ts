import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import type { NormalizedInboundEmail } from './inboundEmail/types';

export const INBOUND_EMAIL_QUEUE = 'inbound-email';

export interface M365MailboxGenerationContext {
  connectionId: string;
  partnerId: string;
  tenantId: string;
  consentAttemptId: string;
}

export interface InboundEmailJobData {
  email: NormalizedInboundEmail;
  mailboxGeneration?: M365MailboxGenerationContext;
}

/** Generic providers retain the raw-email shape for rolling compatibility.
 * Generation-bound M365 jobs use the wrapped contract; old consumers fail
 * closed on that unfamiliar shape instead of ingesting it without a lock. */
export type InboundEmailQueueJob = InboundEmailJobData | NormalizedInboundEmail;

let queue: Queue<InboundEmailQueueJob> | null = null;

export function getInboundEmailQueue(): Queue<InboundEmailQueueJob> {
  if (!queue) {
    queue = new Queue<InboundEmailQueueJob>(INBOUND_EMAIL_QUEUE, {
      connection: getBullMQConnection()
    });
  }
  return queue;
}

/**
 * Fire-and-forget: Redis outage must never fail the provider's webhook request
 * (returning non-2xx causes the provider to retry). The caller is responsible
 * for returning 503 if this throws so the provider can retry.
 */
export async function enqueueInboundEmail(
  email: NormalizedInboundEmail,
  mailboxGeneration?: M365MailboxGenerationContext,
): Promise<void> {
  const data: InboundEmailQueueJob = mailboxGeneration
    ? { email, mailboxGeneration }
    : email;
  await getInboundEmailQueue().add('process', data, {
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
    // Provider will retry the webhook on 5xx, so worker retries are conservative —
    // keep idempotency cheap; processInboundEmail has its own dedup guard.
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 }
  });
}
