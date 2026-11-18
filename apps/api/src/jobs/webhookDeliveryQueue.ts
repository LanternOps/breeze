import type { Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { bullmqJobId, enqueueOrReplaceStale } from '../services/bullmqUtils';
import type { WebhookAttemptJobData } from './queueSchemas';

export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';
export const WEBHOOK_ATTEMPT_JOB_NAME = 'webhook-attempt';
let queue: Queue<WebhookAttemptJobData> | null = null;

// Producers import this leaf so API processes never construct a delivery worker.
export function getWebhookDeliveryQueue(): Queue<WebhookAttemptJobData> {
  if (!queue) queue = createInstrumentedQueue<WebhookAttemptJobData>(WEBHOOK_DELIVERY_QUEUE);
  return queue;
}

export async function closeWebhookDeliveryQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

export function webhookAttemptJobId(deliveryId: string, attemptsMade: number): string {
  return bullmqJobId('webhook-attempt', deliveryId, attemptsMade);
}

export async function enqueueWebhookAttempt(job: WebhookAttemptJobData, runAt: Date): Promise<string> {
  const { deliveryId, webhookId, generation, attemptsMade } = job;
  const { id } = await enqueueOrReplaceStale(
    getWebhookDeliveryQueue() as unknown as Queue,
    WEBHOOK_ATTEMPT_JOB_NAME,
    webhookAttemptJobId(deliveryId, attemptsMade),
    { deliveryId, webhookId, generation, attemptsMade },
    {
      delay: Math.max(0, runAt.getTime() - Date.now()),
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
    '[WebhookDeliveryQueue]',
  );
  return id;
}
