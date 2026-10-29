/**
 * Keep execution wiring outside the worker: the record service imports its
 * types, and importing that service back into the worker creates a cycle.
 */
import { configureWebhookDeliveryExecution, initializeWebhookDelivery, shutdownWebhookDelivery } from '../workers/webhookDelivery';
import { claimDeliveryForExecution, recordDeliveryOutcome } from './webhookDeliveryRecord';
import { drainLegacyWebhookQueues } from '../jobs/webhookLegacyQueueCutover';
import { captureException } from './sentry';

export async function initializeWebhookDeliveryWorker(): Promise<void> {
  configureWebhookDeliveryExecution({ claim: claimDeliveryForExecution, recordOutcome: recordDeliveryOutcome });
  await initializeWebhookDelivery();
  try {
    await drainLegacyWebhookQueues();
  } catch (err) {
    // A legacy backlog must not prevent the new durable consumer from starting.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[WebhookCutover] legacy-queue-cutover-failed ${JSON.stringify({
      errorId: 'WEBHOOK_LEGACY_QUEUE_CUTOVER_FAILED',
      error: err instanceof Error ? err.message : String(err)
    })}`);
  }
}

export async function shutdownWebhookDeliveryWorker(): Promise<void> {
  await shutdownWebhookDelivery();
}
