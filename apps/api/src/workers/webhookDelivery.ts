import { createHmac, randomUUID } from 'crypto';
import { createBlockingRedisConnection, getRedisConnection } from '../services/redis';
import type Redis from 'ioredis';
import type { BreezeEvent } from '../services/eventBus';
import { safeFetch, SsrfBlockedError } from '../services/urlSafety';
import { selfHostAllowsPrivateNetwork } from '../config/env';
import { sanitizeOutboundHeaders } from '../services/outboundHeaders';
import { formatHttpFailure } from '../services/httpFailureMessage';
import { collectChannelSecretStrings } from '../services/notificationChannelSecrets';
import { captureException } from '../services/sentry';
import * as dbModule from '../db';

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

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
  /**
   * Skip the execution claim for this job.
   *
   * Set ONLY by `retryFromDLQ`, which mints a fresh delivery id with no
   * `webhook_deliveries` row behind it. The claim CAS matches on
   * `id = ? AND status = 'pending'`, so without this an operator-triggered DLQ
   * replay would match zero rows, be dropped, and be reported as a "duplicate"
   * — eating the retry and naming the wrong cause.
   */
  skipExecutionClaim?: boolean;
}

/**
 * Why a popped job did NOT win its execution claim. The three cases are
 * operationally different and the log has to name the right one — see
 * `claimDeliveryForExecution`.
 */
export type DeliveryClaimOutcome =
  | { claimed: true }
  | { claimed: false; observedStatus: string | null };

export interface WebhookDeliveryResult {
  deliveryId: string;
  /**
   * `false` when no `webhook_deliveries` row exists under `deliveryId` — only
   * ever a DLQ replay, which mints a fresh id (`retryFromDLQ`). The outcome
   * writer skips the row UPDATE in that case; without this it would match zero
   * rows and fire the zero-row warning on every routine replay, voiding that
   * warning for the real race it exists to catch.
   */
  hasDeliveryRow?: boolean;
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

  // No pre-flight DNS re-validation here. It used to call
  // `validateWebhookUrlSafetyWithDns`, which performs its OWN resolution
  // separate from the one `safeFetch` pins below — two lookups that can
  // disagree, which is precisely the TOCTOU window the pinning exists to
  // close. `safeFetch` enforces the same rules (scheme, blocked ranges, and
  // the cleartext-to-private rule) against the single record it then connects
  // to, and its `SsrfBlockedError` is already mapped to the same
  // "Unsafe webhook URL" message in the catch below.

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
    ...sanitizeOutboundHeaders(webhook.headers),
    'Content-Type': 'application/json',
    'User-Agent': 'Breeze-Webhooks/1.0',
    'X-Breeze-Delivery-Id': deliveryId,
    'X-Breeze-Event-Id': event.id,
    'X-Breeze-Event-Type': event.type,
    'X-Breeze-Timestamp': timestamp.toString()
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

    const response = await safeFetch(webhook.url, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
      redirect: 'error',
      // Same pair the notification-channel sender uses. Without
      // `allowPrivateNetwork` a self-hosted install could SAVE an on-LAN
      // webhook and then fail every delivery with "URL points to blocked
      // address"; `requirePrivateForCleartext` keeps that allowance confined
      // to the operator's own LAN hop rather than the open internet.
      allowPrivateNetwork: selfHostAllowsPrivateNetwork(),
      requirePrivateForCleartext: true
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

    // Operator-facing and therefore short + markup-free (#3992). The raw
    // body is not lost: the delivery record below keeps 1000 characters of it
    // in its own `responseBody` field.
    //
    // Redacted against the webhook's own credentials BEFORE the body is
    // transformed — nothing scrubs this string downstream, unlike the channel
    // test path. `secret` is routed through the `authToken` key so it picks up
    // the collector's own trim and minimum-length rules rather than being
    // pushed in raw; it is the HMAC signing key and is every bit as sensitive
    // as the URL.
    errorMessage = formatHttpFailure(responseStatus, responseBody, {
      secrets: collectChannelSecretStrings('webhook', {
        url: webhook.url,
        headers: webhook.headers,
        authToken: webhook.secret
      })
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      errorMessage = `Unsafe webhook URL: ${err.message}`;
    } else if (err instanceof Error) {
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
  private onClaimDelivery?: (job: WebhookDeliveryJob) => Promise<DeliveryClaimOutcome>;
  /**
   * Dedicated connection for the `BRPOP` in `processNextJob` — see
   * `createBlockingRedisConnection`. Lazily created (never at import time) and
   * cached for the worker's lifetime; a new connection per loop iteration
   * would churn a TCP connect + AUTH every 5 seconds forever.
   */
  private blockingRedis: Redis | null = null;

  private getBlockingRedis(): Redis {
    if (!this.blockingRedis || this.blockingRedis.status === 'end') {
      this.blockingRedis = createBlockingRedisConnection('breeze:webhook-delivery:brpop');
    }
    return this.blockingRedis;
  }

  /**
   * Set callback for delivery completion (for updating database)
   */
  setDeliveryCallback(callback: (result: WebhookDeliveryResult) => Promise<void>): void {
    this.onDeliveryComplete = callback;
  }

  /**
   * Set the EXECUTION CLAIM: the gate a popped job must win before its POST.
   *
   * The queue is a plain Redis list with no job identity, so nothing stops the
   * same delivery being enqueued twice — the recovery sweep (#4095) does
   * exactly that whenever a job turns out to have been merely backlogged
   * rather than lost. The claim is a CAS on the delivery row, so of N copies of
   * one job exactly one ever reaches the customer's endpoint and the rest are
   * dropped here.
   *
   * Return `{ claimed: false, observedStatus }` to mean "someone else owns this
   * delivery"; the status is what lets the drop name its real cause. With no
   * claim callback configured the worker delivers unguarded, which is the
   * pre-existing behaviour.
   */
  setDeliveryClaimCallback(
    callback: (job: WebhookDeliveryJob) => Promise<DeliveryClaimOutcome>
  ): void {
    this.onClaimDelivery = callback;
  }

  /**
   * Queue a webhook for delivery
   */
  async queueDelivery(webhook: WebhookConfig, event: BreezeEvent, deliveryId?: string): Promise<string> {
    const redis = getRedisConnection();
    const nextDeliveryId = deliveryId ?? randomUUID();

    const job: WebhookDeliveryJob = {
      id: nextDeliveryId,
      webhookId: webhook.id,
      webhook,
      event,
      attempts: 0,
      createdAt: new Date().toISOString()
    };

    // Add to Redis list queue
    await redis.lpush(WEBHOOK_QUEUE, JSON.stringify(job));

    console.log(`[WebhookWorker] Queued delivery ${nextDeliveryId} for webhook ${webhook.id}`);

    return nextDeliveryId;
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
      // Blocking pop with 5 second timeout. This MUST run on its own
      // connection: Redis serves one command at a time per connection, so a
      // BRPOP here on the shared connection stalls every other command on it
      // — including the BullMQ `Queue` writes that HTTP handlers await — by
      // up to the full 5s block. Non-blocking commands below stay on the
      // shared connection.
      const result = await this.getBlockingRedis().brpop(WEBHOOK_QUEUE, 5);

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

      // Win the row before POSTing. Only the FIRST attempt claims: a retry job
      // carries attempts > 0 and its row has already been moved out of
      // `pending` by the previous attempt's callback, so re-claiming it would
      // reject every legitimate retry.
      if (this.onClaimDelivery && job.attempts === 0 && !job.skipExecutionClaim) {
        const outcome = await this.onClaimDelivery(job);
        if (!outcome.claimed) {
          // Another copy of this job is already delivering it, or it has
          // already resolved, or there is no row at all. Dropping the duplicate
          // here is the whole point; it is logged because a silent drop is what
          // #4095 is about — and `observedStatus` is what stops the log from
          // calling all three "duplicate".
          console.warn(`[WebhookWorker] duplicate-job-skipped ${JSON.stringify({
            errorId: 'WEBHOOK_DELIVERY_DUPLICATE_JOB_SKIPPED',
            deliveryId: job.id,
            webhookId: job.webhookId,
            orgId: job.event.orgId,
            eventId: job.event.id,
            observedStatus: outcome.observedStatus,
            cause: outcome.observedStatus === null
              ? 'no-delivery-row'
              : outcome.observedStatus === 'retrying'
                ? 'already-claimed'
                : 'already-resolved'
          })}`);
          return;
        }
      }

      // Attempt delivery
      const result2 = await deliverWebhook(job);
      // A DLQ replay has no backing row; the outcome writer needs to know.
      result2.hasDeliveryRow = !job.skipExecutionClaim;

      // Persist the outcome. This is split out of the outer catch because the
      // two sides of the POST are NOT equally recoverable: anything that throws
      // BEFORE `deliverWebhook` leaves the row untouched for the recovery sweep
      // to reclaim, whereas a throw HERE means the customer's endpoint was
      // already called and that fact is now unrecorded. The sweep cannot repair
      // that — it will later see an abandoned `retrying` row and resolve it as
      // "outcome unknown" — so it has to page rather than scroll past.
      if (this.onDeliveryComplete) {
        try {
          await this.onDeliveryComplete(result2);
        } catch (persistError) {
          captureException(
            persistError instanceof Error ? persistError : new Error(String(persistError))
          );
          console.error(`[WebhookWorker] delivery-outcome-unrecorded ${JSON.stringify({
            errorId: 'WEBHOOK_DELIVERY_OUTCOME_UNRECORDED',
            deliveryId: job.id,
            webhookId: job.webhookId,
            orgId: job.event.orgId,
            eventId: job.event.id,
            delivered: result2.success,
            responseStatus: result2.responseStatus ?? null,
            error: persistError instanceof Error ? persistError.message : String(persistError)
          })}`);
          // Deliberately rethrown into the outer catch: continuing would run the
          // retry/DLQ ladder below against an outcome we failed to record.
          throw persistError;
        }
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
      // The job was already popped by BRPOP and is gone from Redis. When the
      // failure happened before the POST the delivery row is untouched and the
      // recovery sweep reclaims it; that is the designed path, but it is still
      // worth a Sentry event, because a claim or parse that fails on EVERY job
      // silently converts the whole worker into a 15-minute-latency system.
      captureException(err instanceof Error ? err : new Error(String(err)));
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
      createdAt: new Date().toISOString(),
      // No delivery row exists under the new id, so there is nothing to claim.
      skipExecutionClaim: true
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
 * The row that already owned a `(webhook, event)` pair when an insert was
 * deduped by `webhook_deliveries_webhook_event_uq`.
 */
export interface ExistingWebhookDelivery {
  id: string;
  status: string;
  attempts: number;
  createdAt: Date;
}

/**
 * Outcome of recording a delivery, as a discriminated union rather than the
 * old `string | null`.
 *
 * `null` alone could not say WHY there was no id, so the skip below had nothing
 * to report and emitted nothing at all (#4095). `existing` carries the row that
 * won, which is what separates a benign dedupe (`delivered`) from a delivery
 * the dedupe is eating (`pending`).
 */
export type WebhookDeliveryRecordOutcome =
  | { created: true; deliveryId: string }
  /** `existing` is null when the conflicting row could not be read back. */
  | { created: false; existing: ExistingWebhookDelivery | null };

export type CreateWebhookDeliveryRecord = (
  webhook: WebhookConfig,
  event: BreezeEvent
) => Promise<WebhookDeliveryRecordOutcome>;

/**
 * Statuses whose skip is routine. Anything else is reported at warn.
 *
 * `retrying` is deliberately NOT here: it is one of the two statuses the
 * recovery sweep treats as UNRESOLVED (`jobs/webhookDeliveryRecovery.ts`), so a
 * duplicate deferring to a `retrying` row is deferring to a delivery that may
 * itself be stuck — exactly the case #4095 exists to surface, and logging it at
 * info would bury it next to genuinely delivered rows.
 */
const BENIGN_DUPLICATE_STATUSES = new Set(['delivered', 'failed']);

/**
 * Report a skipped duplicate. This exists because the skip used to be a bare
 * `continue`: in production you could not tell "dedupe working as designed"
 * from "dedupe eating deliveries", and once #4085 makes delivery at-least-once
 * that same skip is what suppresses a (webhook, event) pair forever.
 */
function reportDuplicateSkip(
  webhook: WebhookConfig,
  event: BreezeEvent,
  existing: ExistingWebhookDelivery | null
): void {
  const line = `[WebhookDelivery] duplicate-delivery-skipped ${JSON.stringify({
    errorId: 'WEBHOOK_DELIVERY_DUPLICATE_SKIPPED',
    webhookId: webhook.id,
    orgId: event.orgId,
    eventId: event.id,
    eventType: event.type,
    existingDeliveryId: existing?.id ?? null,
    existingStatus: existing?.status ?? null,
    existingAttempts: existing?.attempts ?? null,
    existingCreatedAt: existing?.createdAt?.toISOString?.() ?? null
  })}`;

  // A still-`pending` original may never have been enqueued at all, and a row
  // we cannot read back tells us nothing — both deserve more than an info line.
  // Neither is re-queued here: the recovery sweep (jobs/webhookDeliveryRecovery)
  // is the single owner of re-queueing, so that a redelivered event and the
  // sweep cannot both drive the same row and POST twice.
  if (existing && BENIGN_DUPLICATE_STATUSES.has(existing.status)) {
    console.log(line);
  } else {
    console.warn(line);
  }
}

export interface WebhookFanoutDeps {
  getWebhooksForEvent: (orgId: string, eventType: string) => Promise<WebhookConfig[]>;
  createDeliveryRecord?: CreateWebhookDeliveryRecord;
}

let webhookFanoutDeps: WebhookFanoutDeps | null = null;

/**
 * Wires the org->webhooks lookup and delivery-record creator that
 * `handleWebhookFanoutEvent` needs. Called once from `registerAllEventSubscribers`
 * (services/eventSubscribers.ts) synchronously at boot, before the event bus
 * or the queue-mode dispatch worker can ever hand this handler an event.
 */
export function configureWebhookFanout(deps: WebhookFanoutDeps): void {
  webhookFanoutDeps = deps;
}

/**
 * Fan an event out to every webhook subscribed to it in the event's org.
 *
 * Registered under subscriber id `webhook-delivery` (services/eventSubscribers.ts).
 * MUST throw on failure — queue-mode dispatch (#4085) retries on a thrown
 * rejection, and local delivery's wrapper (eventBus.ts's invokeLocalHandlers)
 * provides the swallow-and-log semantics this function used to provide itself.
 */
export async function handleWebhookFanoutEvent(event: BreezeEvent): Promise<void> {
  if (!webhookFanoutDeps) {
    throw new Error('handleWebhookFanoutEvent invoked before configureWebhookFanout()');
  }
  const { getWebhooksForEvent, createDeliveryRecord } = webhookFanoutDeps;

  let webhooks: WebhookConfig[];
  try {
    // Get webhooks configured for this event type in this org — short DB context.
    webhooks = await runWithSystemDbAccess(() => getWebhooksForEvent(event.orgId, event.type));
  } catch (err) {
    // This used to be the ONE drop in this file with no recovery path anywhere
    // (#4095): the webhook lookup failed, so NO delivery rows were created for
    // this event — which means the recovery sweep cannot see it either, since
    // the sweep reclaims recorded-but-unenqueued rows and here nothing was
    // recorded. Rethrowing (rather than swallowing) lets queue-mode dispatch
    // retry this exact event; local delivery still logs+swallows one layer up.
    const msg = err instanceof Error ? err.message : String(err);
    const transient = msg.includes('CONNECTION_DESTROYED') || msg.includes('CONNECTION_ENDED');
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[WebhookDelivery] event-routing-failed ${JSON.stringify({
      errorId: 'WEBHOOK_EVENT_ROUTING_FAILED',
      eventId: event.id,
      orgId: event.orgId,
      eventType: event.type,
      transient,
      error: msg,
      impact: 'no delivery rows were created; this event\'s fan-out is lost for every subscribed webhook unless retried'
    })}`);
    throw err;
  }

  // Queue delivery for each webhook. The delivery record is created in
  // its own short DB context right before its enqueue ("mark-attempted
  // before send"); `queueDelivery` itself is a Redis LPUSH and runs
  // OUTSIDE any DB context (#1105) — looping Redis calls while a pooled
  // Postgres connection sits idle-in-transaction is exactly the hold
  // pattern that exhausts the pool under load, and this handler fires
  // on every event fleet-wide.
  //
  // The try/catch is INSIDE the loop (#4095): one webhook's failure must not
  // abort delivery for webhooks N+1… of the same event — combined with the
  // dedupe below, wrapping the whole loop would make a retry skip the
  // webhooks that already had a row while the rest proceeded, permanently
  // dropping the FAILING webhook. Failures are collected and raised together
  // AFTER the loop (#4085) so a retry re-attempts only the failed ones — the
  // (webhook_id, event_id) unique insert makes that safe.
  const failures: Array<{ webhookId: string; error: unknown }> = [];
  for (const webhook of webhooks) {
    try {
      let deliveryId: string | undefined;

      if (createDeliveryRecord) {
        const outcome = await runWithSystemDbAccess(() => createDeliveryRecord(webhook, event));
        // `created: false` means the (webhook, event) pair is already
        // recorded, so the ORIGINAL delivery owns this event's outcome.
        // Queueing again would POST to the customer's endpoint twice for one
        // event. A recorded-but-never-enqueued original is NOT rescued here —
        // see reportDuplicateSkip.
        if (!outcome.created) {
          reportDuplicateSkip(webhook, event, outcome.existing);
          continue;
        }
        deliveryId = outcome.deliveryId;
      }
      // With no creator there is no dedupe surface at all, so this queues
      // blind rather than skipping — a skip there would drop the delivery
      // outright rather than de-duplicate it.

      await getWebhookWorker().queueDelivery(webhook, event, deliveryId);
    } catch (err) {
      // Recorded-but-not-enqueued is exactly the orphan the recovery sweep
      // reclaims, so this is loud but not fatal to the rest of the fan-out.
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error(`[WebhookDelivery] webhook-routing-failed ${JSON.stringify({
        errorId: 'WEBHOOK_DELIVERY_ROUTING_FAILED',
        webhookId: webhook.id,
        orgId: event.orgId,
        eventId: event.id,
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err)
      })}`);
      failures.push({ webhookId: webhook.id, error: err });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `webhook fan-out failed for ${failures.length}/${webhooks.length} webhooks: ${failures.map((f) => f.webhookId).join(',')}`
    );
  }
}

/**
 * Initialize the webhook delivery BullMQ worker loop that drains the delivery
 * queue. Event routing itself no longer subscribes here — it runs through the
 * durable subscriber registry (`handleWebhookFanoutEvent` above, registered by
 * services/eventSubscribers.ts) so a webhook fan-out failure can be retried by
 * queue-mode dispatch (#4085).
 */
export async function initializeWebhookDelivery(): Promise<void> {
  const worker = getWebhookWorker();

  void worker.start().catch((err) => {
    console.error('[WebhookDelivery] Worker failed:', err);
  });

  console.log('[WebhookDelivery] Initialized webhook delivery worker');
}

// Export signature generation for webhook verification endpoint
export { deliverWebhook, generateSignature };
