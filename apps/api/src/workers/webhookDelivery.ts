import { createHmac } from 'crypto';
import { DelayedError, type Job, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { parseQueueJobData } from '../services/bullmqValidation';
import { webhookAttemptJobDataSchema, type WebhookAttemptJobData } from '../jobs/queueSchemas';
import { WEBHOOK_DELIVERY_QUEUE, enqueueWebhookAttempt, closeWebhookDeliveryQueue } from '../jobs/webhookDeliveryQueue';
import { attachWorkerObservability } from '../jobs/workerObservability';
import { nextWebhookRetryAt } from '../services/webhookRetrySchedule';
import type { BreezeEvent } from '../services/eventBus';
import { safeFetch, SsrfBlockedError } from '../services/urlSafety';
import { selfHostAllowsPrivateNetwork } from '../config/env';
import { sanitizeOutboundHeaders } from '../services/outboundHeaders';
import { formatHttpFailure } from '../services/httpFailureMessage';
import { collectChannelSecretStrings } from '../services/notificationChannelSecrets';
import { captureException } from '../services/sentry';
import * as dbModule from '../db';
import { organizations, webhooks as webhooksTable, webhookDeliveryStatusEnum } from '../db/schema';
import { partnerFanoutOrgCondition } from '../services/partnerFanoutOrgs';
import { toWebhookConfig } from '../services/webhookConfig';
import { scrubUrlsInText } from '../utils/endpointDisplay';
import { isSelfDeliveryOfHealthEvent } from '../services/connectionHealth/eventPayload';
import { buildWebhookEnvelope } from '../services/webhookPayload/envelope';
import { isAlertV2EventType } from '../services/webhookPayload/alertV2';
import { buildAlertWebhookProjections } from '../services/webhookPayload/alertEnrichment';

const { db } = dbModule;

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// Webhook delivery configuration
const WEBHOOK_TIMEOUT_MS = 30000;
export const WEBHOOK_DELIVERY_CONCURRENCY = 10;
const MIN_REDELAY_MS = 1000;

export interface WebhookConfig {
  id: string;
  orgId: string | null;
  partnerId: string | null;
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
  orgId: string | null;
  id: string;
  webhookId: string;
  generation: number;
  payloadVersion: 1 | 2;
  replayOf?: string | null;
  attempts: number;
  event: { id: string; type: string; timestamp: string; payload: unknown };
}

/**
 * Site-ceiling gate contract §7E. The fan-out lookup and delivery-record
 * dedupe never needed decrypted credentials — both only ever read `.id`
 * (and `.orgId`/`.approvalGeneration` for enqueueing, plus `.payloadVersion`
 * for the envelope and payload projection) — so this lean,
 * UNDECRYPTED shape replaces `WebhookConfig` on that path entirely.
 * Decryption now happens exactly once, inside `resolveDeliveryWebhookConfig`,
 * right before the actual HTTP POST.
 */
export interface WebhookFanoutTarget {
  payloadVersion: 1 | 2;
  id: string;
  orgId: string | null;
  partnerId: string | null;
  approvalGeneration: number;
}

export interface ClaimedWebhookDelivery {
  orgId: string | null;
  webhookGeneration: number | null;
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  payloadVersion: 1 | 2;
  eventTimestamp: Date | null;
  createdAt: Date;
  replayRootEventId: string | null;
  attempts: number;
}

export type DeliveryClaimOutcome =
  | { claimed: true; delivery: ClaimedWebhookDelivery }
  | { claimed: false; observedStatus: typeof webhookDeliveryStatusEnum.enumValues[number] | null; observedAttempts: number | null; dueInMs: number | null };

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
  /** Lifecycle changes invalidate the queued premise, so they never schedule a retry. */
  superseded?: boolean;
  nextAttemptAt?: Date | null;
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

export type ResolveDeliveryWebhookConfigOutcome =
  | { status: 'ok'; webhook: WebhookConfig }
  | { status: 'not_found' }
  | { status: 'superseded' }
  | { status: 'decrypt_failed' }
  | { status: 'org_departed' };

/** Reload and decrypt at send time so queued jobs never store credentials. */
async function resolveDeliveryWebhookConfig(job: WebhookDeliveryJob): Promise<ResolveDeliveryWebhookConfigOutcome> {
  const [row] = await runWithSystemDbAccess(() =>
    db.select().from(webhooksTable).where(eq(webhooksTable.id, job.webhookId)).limit(1)
  );

  if (!row) {
    return { status: 'not_found' };
  }
  if (row.status !== 'active') {
    return { status: 'superseded' };
  }
  if (row.approvalGeneration !== job.generation) {
    return { status: 'superseded' };
  }

  // A queued event remains tied to its original org, even after that org moves
  // or stops being eligible for partner-wide fan-out. Tests have no event org.
  if (row.partnerId && job.orgId != null) {
    const [org] = await runWithSystemDbAccess(() => db.select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, job.orgId!), eq(organizations.partnerId, row.partnerId!), partnerFanoutOrgCondition()))
      .limit(1));
    if (!org) return { status: 'org_departed' };
  }

  try {
    return { status: 'ok', webhook: toWebhookConfig(row) };
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[WebhookWorker] decrypt-failed ${JSON.stringify({
      errorId: 'WEBHOOK_DELIVERY_DECRYPT_FAILED',
      deliveryId: job.id,
      webhookId: job.webhookId
    })}`);
    return { status: 'decrypt_failed' };
  }
}

/**
 * Make ONE signed delivery attempt. Retry scheduling is the caller's job
 * (`processWebhookAttemptJob`), which persists it on the delivery row.
 */
async function deliverWebhook(job: WebhookDeliveryJob): Promise<WebhookDeliveryResult> {
  const { event } = job;
  const deliveryId = job.id;
  const timestamp = Date.now();

  const resolved = await resolveDeliveryWebhookConfig(job);
  if (resolved.status !== 'ok') {
    const errorMessage = resolved.status === 'not_found'
      ? 'Webhook not found (deleted after this delivery was queued)'
      : resolved.status === 'org_departed'
        ? "superseded_by_edit: organization no longer belongs to this webhook's partner"
        : resolved.status === 'decrypt_failed'
          ? 'superseded_by_edit: webhook credentials could not be decrypted'
          : 'superseded_by_edit: webhook was edited or disabled after this delivery was queued';
    return {
      deliveryId,
      webhookId: job.webhookId,
      eventId: event.id,
      eventType: event.type,
      success: false,
      superseded: true,
      attempts: job.attempts + 1,
      errorMessage
    };
  }
  const { webhook } = resolved;

  // No pre-flight DNS re-validation here. It used to call
  // `validateWebhookUrlSafetyWithDns`, which performs its OWN resolution
  // separate from the one `safeFetch` pins below — two lookups that can
  // disagree, which is precisely the TOCTOU window the pinning exists to
  // close. `safeFetch` enforces the same rules (scheme, blocked ranges, and
  // the cleartext-to-private rule) against the single record it then connects
  // to, and its `SsrfBlockedError` is already mapped to the same
  // "Unsafe webhook URL" message in the catch below.

  // Prepare payload
  const payload = buildWebhookEnvelope({
    version: job.payloadVersion,
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    orgId: job.orgId ?? webhook.orgId,
    data: event.payload,
    replayOf: job.replayOf ?? null
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

  if (job.replayOf) headers['X-Breeze-Replay-Of'] = job.replayOf;

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
    // Transport errors can quote the request URL, and a webhook URL can carry
    // credentials in its userinfo, query or path. Keep only scheme + host.
    errorMessage = scrubUrlsInText(errorMessage);
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

interface WebhookDeliveryExecution {
  claim: (input: { deliveryId: string; attemptsMade: number }) => Promise<DeliveryClaimOutcome>;
  recordOutcome: (result: WebhookDeliveryResult) => Promise<boolean>;
  releaseClaim: (input: { deliveryId: string; attemptsMade: number }) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}
let execution: WebhookDeliveryExecution | null = null;

export function configureWebhookDeliveryExecution(callbacks: WebhookDeliveryExecution): void {
  execution = callbacks;
}

export async function processWebhookAttemptJob(job: Job<WebhookAttemptJobData>, token?: string): Promise<void> {
  if (!execution) throw new Error('processWebhookAttemptJob invoked before configureWebhookDeliveryExecution()');
  const { deliveryId, webhookId, generation: jobGeneration, attemptsMade } = parseQueueJobData(
    WEBHOOK_DELIVERY_QUEUE, job, webhookAttemptJobDataSchema
  );
  const outcome = await execution.claim({ deliveryId, attemptsMade });
  if (!outcome.claimed) {
    const { observedStatus, observedAttempts, dueInMs } = outcome;
    if (observedStatus === null) {
      console.log(`[WebhookWorker] delivery-row-gone ${JSON.stringify({
        errorId: 'WEBHOOK_DELIVERY_ROW_GONE', deliveryId, webhookId, attemptsMade
      })}`);
      return;
    }
    if (observedStatus === 'scheduled' && observedAttempts === attemptsMade) {
      const delayMs = Math.max(dueInMs ?? 0, MIN_REDELAY_MS);
      console.warn(`[WebhookWorker] delivery-early-wake ${JSON.stringify({
        errorId: 'WEBHOOK_DELIVERY_EARLY_WAKE', deliveryId, attemptsMade, delayMs
      })}`);
      // Moving this same job preserves its identity and leaves no wake-up gap.
      if (!token) throw new Error('Webhook early wake requires a job lock token');
      await job.moveToDelayed(Date.now() + delayMs, token);
      throw new DelayedError();
    }
    console.warn(`[WebhookWorker] duplicate-job-skipped ${JSON.stringify({
      errorId: 'WEBHOOK_DELIVERY_DUPLICATE_JOB_SKIPPED', deliveryId, webhookId,
      observedStatus, observedAttempts, attemptsMade,
      cause: observedStatus === 'retrying' ? 'already-claimed'
        : observedStatus === 'pending' || observedStatus === 'scheduled' ? 'stale-attempt' : 'already-resolved'
    })}`);
    return;
  }

  const row = outcome.delivery;
  const generation = row.webhookGeneration ?? jobGeneration;
  let result: WebhookDeliveryResult;
  try {
    result = await deliverWebhook({
      id: row.id, webhookId: row.webhookId, orgId: row.orgId, generation,
      payloadVersion: row.payloadVersion, replayOf: row.replayRootEventId, attempts: row.attempts,
      event: { id: row.eventId, type: row.eventType, payload: row.payload,
        timestamp: (row.eventTimestamp ?? row.createdAt).toISOString() }
    });
  } catch (err) {
    // deliverWebhook catches transport errors; a throw here preceded any POST.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[WebhookWorker] pre-send-failed ${JSON.stringify({
      errorId: 'WEBHOOK_DELIVERY_PRE_SEND_FAILED', deliveryId, attemptsMade,
      error: err instanceof Error ? err.message : String(err)
    })}`);
    try {
      await execution.releaseClaim({ deliveryId, attemptsMade });
    } catch (releaseError) {
      captureException(releaseError instanceof Error ? releaseError : new Error(String(releaseError)));
      console.error(`[WebhookWorker] claim-release-failed ${JSON.stringify({
        errorId: 'WEBHOOK_DELIVERY_CLAIM_RELEASE_FAILED', deliveryId, attemptsMade,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError)
      })}`);
    }
    throw err;
  }
  const nextAttemptAt = result.success || result.superseded ? null : nextWebhookRetryAt(result.attempts, new Date());
  result.nextAttemptAt = nextAttemptAt;
  let recorded = false;
  try {
    const sleep = execution.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (let writeAttempt = 0; writeAttempt < 3; writeAttempt++) {
      try {
        recorded = await execution.recordOutcome(result);
        break;
      } catch (err) {
        if (writeAttempt === 2) throw err;
        await sleep(writeAttempt === 0 ? 250 : 1000);
      }
    }
  } catch (persistError) {
    // The POST may already have happened. Do not persist its result on the job:
    // after a DB outage longer than ~1.3s, recovery's documented "outcome unknown"
    // handling owns resolution, without trusting a separately persisted result.
    captureException(persistError instanceof Error ? persistError : new Error(String(persistError)));
    console.error(`[WebhookWorker] delivery-outcome-unrecorded ${JSON.stringify({
      errorId: 'WEBHOOK_DELIVERY_OUTCOME_UNRECORDED', deliveryId, webhookId,
      eventId: row.eventId, delivered: result.success, responseStatus: result.responseStatus ?? null,
      error: persistError instanceof Error ? persistError.message : String(persistError)
    })}`);
    throw persistError;
  }
  if (nextAttemptAt && recorded) {
    try {
      await enqueueWebhookAttempt({ deliveryId, webhookId, generation, attemptsMade: result.attempts }, nextAttemptAt);
    } catch (err) {
      // Postgres retains the schedule; recovery replaces a missing wake-up.
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error(`[WebhookWorker] retry-enqueue-failed ${JSON.stringify({
        errorId: 'WEBHOOK_DELIVERY_RETRY_ENQUEUE_FAILED', deliveryId, webhookId,
        error: err instanceof Error ? err.message : String(err)
      })}`);
    }
  }
  if (result.superseded) {
    console.warn(`[WebhookWorker] delivery-superseded ${JSON.stringify({
      errorId: 'WEBHOOK_DELIVERY_SUPERSEDED', deliveryId, webhookId, eventId: row.eventId
    })}`);
  } else if (!nextAttemptAt && !result.success) {
    console.warn(`[WebhookWorker] retries-exhausted ${JSON.stringify({
      errorId: 'WEBHOOK_DELIVERY_RETRIES_EXHAUSTED', deliveryId, webhookId, attempts: result.attempts
    })}`);
  }
}

let workerInstance: Worker<WebhookAttemptJobData> | null = null;

export function createWebhookDeliveryWorker(): Worker<WebhookAttemptJobData> {
  return new Worker<WebhookAttemptJobData>(WEBHOOK_DELIVERY_QUEUE,
    (job, token) => processWebhookAttemptJob(job, token),
    { connection: getBullMQConnection(), concurrency: WEBHOOK_DELIVERY_CONCURRENCY });
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
  webhook: WebhookFanoutTarget,
  event: BreezeEvent
) => Promise<WebhookDeliveryRecordOutcome>;

/**
 * Statuses whose skip is routine. Anything else is reported at warn.
 *
 * `retrying` is deliberately NOT here: it is one of the three statuses the
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
  webhook: WebhookFanoutTarget,
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
  // and legacy cut-over own re-queueing. Execution claims prevent duplicate
  // wake-ups from POSTing the same attempt twice.
  if (existing && BENIGN_DUPLICATE_STATUSES.has(existing.status)) {
    console.log(line);
  } else {
    console.warn(line);
  }
}

export interface WebhookFanoutDeps {
  getWebhooksForEvent: (orgId: string, eventType: string) => Promise<WebhookFanoutTarget[]>;
  createDeliveryRecord: CreateWebhookDeliveryRecord;
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

  let webhooks: WebhookFanoutTarget[];
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
  // before send"); `enqueueWebhookAttempt` itself runs
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
  let projections: ReturnType<typeof buildAlertWebhookProjections> | undefined;
  const failures: Array<{ webhookId: string; error: unknown }> = [];
  for (const webhook of webhooks) {
    // Spec 2026-10-15 §9 W5: a connection health event about this very webhook
    // is never delivered to it (a failing endpoint fed "you are failing"
    // deliveries is a feedback loop). Skipped before the delivery record, so
    // neither a retry nor the recovery sweep can revive it.
    if (isSelfDeliveryOfHealthEvent(event, webhook.id)) continue;
    try {
      const version = webhook.payloadVersion === 2 ? 2 : 1;
      let data = event.payload;
      if (version === 2 && isAlertV2EventType(event.type)) {
        projections ??= buildAlertWebhookProjections(event);
        data = webhook.partnerId != null ? (await projections).partner : (await projections).org;
      }
      const deliveryEvent = data === event.payload ? event : { ...event, payload: data };
      const outcome = await runWithSystemDbAccess(() => createDeliveryRecord({ ...webhook, payloadVersion: version }, deliveryEvent));
      // The original row owns this event. Recovery, not another fan-out,
      // rescues a recorded delivery whose wake-up was lost.
      if (!outcome.created) {
        reportDuplicateSkip(webhook, event, outcome.existing);
        continue;
      }
      await enqueueWebhookAttempt({ deliveryId: outcome.deliveryId, webhookId: webhook.id,
        generation: webhook.approvalGeneration, attemptsMade: 0 }, new Date());
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
  if (workerInstance) return;
  // API-role producers import this module too; only the registry's global
  // initialization path owns a worker and declares its readiness consumer.
  workerInstance = createWebhookDeliveryWorker();
  attachWorkerObservability(workerInstance, 'webhookDeliveryWorker');
  workerInstance.on('error', (err) => console.error('[WebhookDelivery] Worker failed:', err));
  console.log('[WebhookDelivery] Initialized webhook delivery worker');
}

export async function shutdownWebhookDelivery(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
  await closeWebhookDeliveryQueue();
}

// Export signature generation for webhook verification endpoint
export { deliverWebhook, generateSignature };
