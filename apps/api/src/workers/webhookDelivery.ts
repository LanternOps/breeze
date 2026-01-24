import { createHmac, randomUUID } from 'crypto';
import { getRedisConnection } from '../services/redis';
import { getEventBus, type BreezeEvent } from '../services/eventBus';

// Webhook delivery configuration
const WEBHOOK_TIMEOUT_MS = 30000;
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 300000; // 5 minutes
const BACKOFF_MULTIPLIER = 2;

// Queue names
const WEBHOOK_QUEUE = 'breeze:webhooks:delivery';
const WEBHOOK_DLQ = 'breeze:webhooks:dlq';

export interface WebhookConfig {
  id: string;
  orgId: string;
  name: string;
  url: string;
  secret?: string;
  events: string[];
  headers?: Record<string, string>;
  retryPolicy?: {
    maxRetries: number;
    backoffMultiplier: number;
    initialDelayMs: number;
    maxDelayMs: number;
  };
}

export interface WebhookDeliveryJob {
  id: string;
  webhookId: string;
  webhook: WebhookConfig;
  event: BreezeEvent;
  attempts: number;
  nextRetryAt?: string;
  createdAt: string;
}

export interface WebhookDeliveryResult {
  deliveryId: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  success: boolean;
  attempts: number;
  responseStatus?: number;
  responseBody?: string;
  responseTimeMs?: number;
  errorMessage?: string;
  deliveredAt?: string;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload
 *
 * The signature is computed as: HMAC-SHA256(secret, timestamp + '.' + payload)
 * This prevents replay attacks by including the timestamp in the signature.
 */
function generateSignature(payload: string, secret: string, timestamp: number): string {
  const signaturePayload = `${timestamp}.${payload}`;
  return createHmac('sha256', secret).update(signaturePayload).digest('hex');
}

/**
 * Deliver a webhook with retry logic and HMAC signing
 */
async function deliverWebhook(job: WebhookDeliveryJob): Promise<WebhookDeliveryResult> {
  const { webhook, event } = job;
  const deliveryId = job.id;
  const timestamp = Date.now();

  // Prepare payload
  const payload = JSON.stringify({
    id: event.id,
    type: event.type,
    timestamp: event.metadata.timestamp,
    orgId: event.orgId,
    data: event.payload
  });

  // Prepare headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Breeze-Webhooks/1.0',
    'X-Breeze-Delivery-Id': deliveryId,
    'X-Breeze-Event-Id': event.id,
    'X-Breeze-Event-Type': event.type,
    'X-Breeze-Timestamp': timestamp.toString(),
    ...webhook.headers
  };

  // Add HMAC signature if secret is configured
  if (webhook.secret) {
    const signature = generateSignature(payload, webhook.secret, timestamp);
    headers['X-Breeze-Signature'] = `sha256=${signature}`;
    // Also include timestamp header for signature verification
    headers['X-Breeze-Signature-Timestamp'] = timestamp.toString();
  }

  const startTime = Date.now();
  let responseStatus: number | undefined;
  let responseBody: string | undefined;
  let errorMessage: string | undefined;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    responseStatus = response.status;
    responseBody = await response.text().catch(() => undefined);

    // Consider 2xx as success
    if (response.ok) {
      return {
        deliveryId,
        webhookId: webhook.id,
        eventId: event.id,
        eventType: event.type,
        success: true,
        attempts: job.attempts + 1,
        responseStatus,
        responseBody: responseBody?.slice(0, 1000), // Truncate large responses
        responseTimeMs: Date.now() - startTime,
        deliveredAt: new Date().toISOString()
      };
    }

    errorMessage = `HTTP ${responseStatus}: ${responseBody?.slice(0, 500)}`;
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        errorMessage = `Timeout after ${WEBHOOK_TIMEOUT_MS}ms`;
      } else {
        errorMessage = err.message;
      }
    } else {
      errorMessage = 'Unknown error';
    }
  }

  return {
    deliveryId,
    webhookId: webhook.id,
    eventId: event.id,
    eventType: event.type,
    success: false,
    attempts: job.attempts + 1,
    responseStatus,
    responseBody: responseBody?.slice(0, 1000),
    responseTimeMs: Date.now() - startTime,
    errorMessage
  };
}

/**
 * Calculate next retry delay using exponential backoff
 */
function calculateRetryDelay(
  attempt: number,
  policy: WebhookConfig['retryPolicy']
): number {
  const {
    initialDelayMs = INITIAL_DELAY_MS,
    backoffMultiplier = BACKOFF_MULTIPLIER,
    maxDelayMs = MAX_DELAY_MS
  } = policy || {};

  const delay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
  return Math.min(delay, maxDelayMs);
}

/**
 * WebhookDeliveryWorker - Processes webhook delivery jobs from Redis
 */
class WebhookDeliveryWorker {
  private isRunning = false;
  private onDeliveryComplete?: (result: WebhookDeliveryResult) => Promise<void>;

  /**
   * Set callback for delivery completion (for updating database)
   */
  setDeliveryCallback(callback: (result: WebhookDeliveryResult) => Promise<void>): void {
    this.onDeliveryComplete = callback;
  }

  /**
   * Queue a webhook for delivery
   */
  async queueDelivery(webhook: WebhookConfig, event: BreezeEvent): Promise<string> {
    const redis = getRedisConnection();
    const deliveryId = randomUUID();

    const job: WebhookDeliveryJob = {
      id: deliveryId,
      webhookId: webhook.id,
      webhook,
      event,
      attempts: 0,
      createdAt: new Date().toISOString()
    };

    // Add to Redis list queue
    await redis.lpush(WEBHOOK_QUEUE, JSON.stringify(job));

    console.log(`[WebhookWorker] Queued delivery ${deliveryId} for webhook ${webhook.id}`);

    return deliveryId;
  }

  /**
   * Start processing webhook deliveries
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('[WebhookWorker] Starting webhook delivery worker');

    while (this.isRunning) {
      await this.processNextJob();
    }
  }

  /**
   * Stop the worker
   */
  stop(): void {
    this.isRunning = false;
    console.log('[WebhookWorker] Stopping webhook delivery worker');
  }

  /**
   * Process the next job from the queue
   */
  private async processNextJob(): Promise<void> {
    const redis = getRedisConnection();

    try {
      // Blocking pop with 5 second timeout
      const result = await redis.brpop(WEBHOOK_QUEUE, 5);

      if (!result) return; // Timeout, no jobs

      const [, jobJson] = result;
      const job: WebhookDeliveryJob = JSON.parse(jobJson);

      // Check if scheduled for later
      if (job.nextRetryAt && new Date(job.nextRetryAt) > new Date()) {
        // Re-queue for later processing
        await redis.lpush(WEBHOOK_QUEUE, jobJson);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
      }

      console.log(`[WebhookWorker] Processing delivery ${job.id} (attempt ${job.attempts + 1})`);

      // Attempt delivery
      const result2 = await deliverWebhook(job);

      // Notify callback
      if (this.onDeliveryComplete) {
        await this.onDeliveryComplete(result2);
      }

      if (result2.success) {
        console.log(`[WebhookWorker] Delivered ${job.id} successfully`);
        return;
      }

      // Handle failure
      const maxRetries = job.webhook.retryPolicy?.maxRetries ?? MAX_RETRIES;

      if (job.attempts + 1 >= maxRetries) {
        // Move to dead letter queue
        console.log(`[WebhookWorker] Max retries reached for ${job.id}, moving to DLQ`);
        await redis.lpush(WEBHOOK_DLQ, JSON.stringify({
          job,
          lastResult: result2,
          movedAt: new Date().toISOString()
        }));
        return;
      }

      // Schedule retry
      const retryDelay = calculateRetryDelay(job.attempts, job.webhook.retryPolicy);
      const nextRetryAt = new Date(Date.now() + retryDelay).toISOString();

      const retryJob: WebhookDeliveryJob = {
        ...job,
        attempts: job.attempts + 1,
        nextRetryAt
      };

      console.log(`[WebhookWorker] Scheduling retry for ${job.id} at ${nextRetryAt}`);
      await redis.lpush(WEBHOOK_QUEUE, JSON.stringify(retryJob));

    } catch (err) {
      console.error('[WebhookWorker] Error processing job:', err);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Get dead letter queue entries
   */
  async getDeadLetterQueue(start = 0, count = 100): Promise<unknown[]> {
    const redis = getRedisConnection();
    const entries = await redis.lrange(WEBHOOK_DLQ, start, start + count - 1);
    return entries.map(e => JSON.parse(e));
  }

  /**
   * Retry a dead letter queue entry
   */
  async retryFromDLQ(index: number): Promise<void> {
    const redis = getRedisConnection();
    const entry = await redis.lindex(WEBHOOK_DLQ, index);
    if (!entry) return;

    const { job } = JSON.parse(entry) as { job: WebhookDeliveryJob };

    // Reset attempts and re-queue
    const retryJob: WebhookDeliveryJob = {
      ...job,
      id: randomUUID(), // New delivery ID
      attempts: 0,
      nextRetryAt: undefined,
      createdAt: new Date().toISOString()
    };

    await redis.lpush(WEBHOOK_QUEUE, JSON.stringify(retryJob));
    await redis.lrem(WEBHOOK_DLQ, 1, entry);

    console.log(`[WebhookWorker] Retried DLQ entry, new delivery: ${retryJob.id}`);
  }

  /**
   * Clear dead letter queue
   */
  async clearDLQ(): Promise<number> {
    const redis = getRedisConnection();
    const count = await redis.llen(WEBHOOK_DLQ);
    await redis.del(WEBHOOK_DLQ);
    return count;
  }
}

// Singleton instance
let workerInstance: WebhookDeliveryWorker | null = null;

export function getWebhookWorker(): WebhookDeliveryWorker {
  if (!workerInstance) {
    workerInstance = new WebhookDeliveryWorker();
  }
  return workerInstance;
}

/**
 * Initialize webhook delivery by subscribing to all events
 * and routing to appropriate webhooks
 */
export async function initializeWebhookDelivery(
  getWebhooksForEvent: (orgId: string, eventType: string) => Promise<WebhookConfig[]>
): Promise<void> {
  const eventBus = getEventBus();
  const worker = getWebhookWorker();

  // Subscribe to all events
  eventBus.subscribe('*', async (event) => {
    try {
      // Get webhooks configured for this event type in this org
      const webhooks = await getWebhooksForEvent(event.orgId, event.type);

      // Queue delivery for each webhook
      for (const webhook of webhooks) {
        await worker.queueDelivery(webhook, event);
      }
    } catch (err) {
      console.error('[WebhookDelivery] Error routing event to webhooks:', err);
    }
  });

  console.log('[WebhookDelivery] Initialized webhook event subscription');
}

// Export signature generation for webhook verification endpoint
export { generateSignature };
