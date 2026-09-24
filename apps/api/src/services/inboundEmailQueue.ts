import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import type { NormalizedInboundEmail } from './inboundEmail/types';

export const INBOUND_EMAIL_QUEUE = 'inbound-email';

/** Providers whose mail is PULLED from a connected mailbox (vs pushed by a
 * signed webhook). These jobs MUST carry a generation context and acquire the
 * mailbox-lifecycle lock before writing; webhook providers (mailgun/resend) do
 * not. Kept here so the producer and the consumer agree on the exact set. */
export const POLLED_MAILBOX_PROVIDERS = ['m365', 'gmail'] as const;
export type PolledMailboxProvider = (typeof POLLED_MAILBOX_PROVIDERS)[number];

/** Lifecycle-generation context for a polled mailbox job. `tenantId` is
 * Microsoft-only (null for Gmail); the durable generation key is
 * (connectionId, partnerId, consentAttemptId), which both providers carry and
 * which rotates on re-consent. `provider` binds the job to the connection's
 * provider so a job cannot be locked against a connection of another provider. */
export interface MailboxGenerationContext {
  provider: PolledMailboxProvider;
  connectionId: string;
  partnerId: string;
  tenantId: string | null;
  consentAttemptId: string;
}

export interface InboundEmailJobData {
  email: NormalizedInboundEmail;
  mailboxGeneration?: MailboxGenerationContext;
}

/** Generic providers retain the raw-email shape for rolling compatibility.
 * Generation-bound polled-mailbox jobs use the wrapped contract; old consumers
 * fail closed on that unfamiliar shape instead of ingesting it without a lock. */
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
  mailboxGeneration?: MailboxGenerationContext,
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
