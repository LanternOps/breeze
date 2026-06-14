import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import type { NormalizedInboundEmail } from './inboundEmail/types';

export const INBOUND_EMAIL_QUEUE = 'inbound-email';

let queue: Queue<NormalizedInboundEmail> | null = null;

export function getInboundEmailQueue(): Queue<NormalizedInboundEmail> {
  if (!queue) {
    queue = new Queue<NormalizedInboundEmail>(INBOUND_EMAIL_QUEUE, {
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
export async function enqueueInboundEmail(email: NormalizedInboundEmail): Promise<void> {
  await getInboundEmailQueue().add('process', email, {
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
    // Provider will retry the webhook on 5xx, so worker retries are conservative —
    // keep idempotency cheap; processInboundEmail has its own dedup guard.
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 }
  });
}
