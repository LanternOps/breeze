import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerSendingDomains } from '../../db/schema';
import { enqueueAutoSuspendEvaluation, enqueueSyncDomain } from '../../jobs/sendingDomainsWorker';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { getEmailDomainsConfig } from '../../services/emailDomains/config';
import { incrementPartnerSendingStat, type DeliveryStatColumn } from '../../services/emailDomains/deliveryStats';
import { verifySvixSignature } from '../../services/emailDomains/webhookSignature';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { captureException } from '../../services/sentry';

/**
 * Resend delivery webhook (spec §9.3). PUBLIC and unauthenticated: the Svix
 * signature is the credential.
 *
 * Order of operations, and why each step is where it is:
 *
 *  1. Per-IP limiter. Fails CLOSED (Redis down -> 429), which makes the
 *     provider retry rather than letting an outage open the endpoint up.
 *  2. Secret check -> 404 when unset. NOT 401 and NOT 503: on an instance that
 *     never configured the feature this endpoint does not exist, and a 5xx
 *     would make a misdirected caller retry forever. This is spec §9.3's
 *     "inert unless EMAIL_DOMAINS_WEBHOOK_SECRET is set".
 *  3. Raw body via `await c.req.text()` — the signature covers the exact bytes,
 *     so nothing may consume the body first. This is why no body-consuming
 *     middleware may be mounted in front of this route (see index.ts).
 *  4. Signature. An unauthenticated caller must never get past here, in
 *     particular never far enough to reserve a dedupe key.
 *  5. Replay reservation on `svix-id`. Svix delivers AT LEAST once, so a
 *     redelivery of an already-counted event would inflate every counter the
 *     auto-suspension thresholds read. Redis unavailable -> 503, so the
 *     provider retries: silently processing without the guard trades a retry
 *     for permanently wrong numbers.
 *  6. Handle, then 202. The handler never calls the provider — `domain.updated`
 *     only enqueues `sync-domain`, and a bounce/complaint only enqueues
 *     `evaluate-auto-suspend`. All provider calls live in the worker (spec §2).
 *
 * ATTRIBUTION. Events are attributed by the `partner_id` provider tag W04 sets
 * on every partner-lane message. The tag is never trusted beyond an existence
 * check: it must parse as a UUID, and the increment statement's row source is a
 * SELECT over `partners`, so an id that matches no partner counts nowhere. A
 * fallback message (platform lane) carries no tags at all, so it produces no
 * attributable event by construction.
 *
 * DB CONTEXT. There is no ambient auth transaction on a public route, so every
 * read and write opens its own `withSystemDbAccessContext`. `runOutsideDbContext`
 * is deliberately NOT used: it does not close an outer transaction, and there is
 * no outer transaction here to close.
 */

export const resendWebhookRoutes = new Hono();

const RATE_LIMIT = 600;
const RATE_WINDOW_SECONDS = 60;
/** Comfortably past Svix's retry schedule, so a late redelivery is still caught. */
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/**
 * The events this endpoint counts. `email.sent` is the ONLY source of the
 * `sent` column: the send path is forbidden from writing a partner-axis table,
 * so subscribing this event on the provider webhook is what populates the rate
 * denominator (spec §9.3 + W04's Global Constraints).
 */
const EVENT_COLUMN: Readonly<Record<string, DeliveryStatColumn>> = Object.freeze({
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
});

/** Events that can move a partner across the spec §9.3 thresholds. */
const EVALUATES_AUTO_SUSPENSION: ReadonlySet<string> = new Set(['email.bounced', 'email.complained']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WebhookEnvelope {
  type: string;
  data?: {
    tags?: Record<string, unknown> | null;
    id?: unknown;
    name?: unknown;
  } | null;
}

/** One log line per unknown tag value per process, so a misconfiguration is visible but not a flood. */
const loggedUnknownTags = new Set<string>();
function logUnknownTagOnce(reason: string, value: string): void {
  const key = `${reason}:${value}`;
  if (loggedUnknownTags.has(key)) return;
  if (loggedUnknownTags.size > 500) loggedUnknownTags.clear();
  loggedUnknownTags.add(key);
  console.warn('[emailProviderWebhook] event not attributable to a partner', { reason, value });
}

resendWebhookRoutes.post('/email-provider/resend', async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const rate = await rateLimiter(
    getRedis(),
    `email-domains-webhook:${rateLimitIpKey(ip)}`,
    RATE_LIMIT,
    RATE_WINDOW_SECONDS,
  );
  if (!rate.allowed) return c.json({ error: 'Too Many Requests' }, 429);

  const secret = getEmailDomainsConfig().webhookSecret;
  if (!secret) {
    // Inert. No body read, no Redis, no database.
    return c.json({ error: 'Not Found' }, 404);
  }

  // The signature covers these exact bytes — read them before anything else.
  const raw = await c.req.text();

  const verified = verifySvixSignature(
    {
      id: c.req.header('svix-id') ?? null,
      timestamp: c.req.header('svix-timestamp') ?? null,
      signature: c.req.header('svix-signature') ?? null,
    },
    raw,
    secret,
  );
  if (!verified.ok) {
    console.warn('[emailProviderWebhook] rejected delivery', { reason: verified.reason });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Svix is at-least-once. Reserve the message id BEFORE doing any counting.
  const svixId = (c.req.header('svix-id') ?? '').trim();
  const redis = getRedis();
  if (!redis) {
    console.error('[emailProviderWebhook] Redis unavailable; asking the provider to retry');
    return c.json({ error: 'Service Unavailable' }, 503);
  }
  let reserved: string | null;
  try {
    reserved = await redis.set(`emaildomains:webhook:${svixId}`, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
  } catch (err) {
    console.error('[emailProviderWebhook] replay reservation failed:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Service Unavailable' }, 503);
  }
  if (reserved !== 'OK') {
    // Already processed. 202 so the provider stops retrying.
    return c.json({ received: true, duplicate: true }, 202);
  }

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(raw) as WebhookEnvelope;
  } catch {
    return c.json({ error: 'Bad Request' }, 400);
  }
  if (typeof envelope?.type !== 'string' || envelope.type.length === 0) {
    return c.json({ error: 'Bad Request' }, 400);
  }

  try {
    if (envelope.type === 'domain.updated') {
      await handleDomainUpdated(envelope);
    } else {
      await handleEmailEvent(envelope);
    }
  } catch (err) {
    console.error('[emailProviderWebhook] handler error', envelope.type, err instanceof Error ? err.message : err);
    captureException(
      err instanceof Error ? err : new Error(`[emailProviderWebhook] handler error for ${envelope.type}: ${String(err)}`),
      c,
    );
    // 500 so the provider retries. The svix-id reservation is already held, so
    // a retry would be deduped — which is the correct trade: delivery stats are
    // advisory, and double-counting them would move a kill switch.
    return c.json({ error: 'Handler error' }, 500);
  }

  return c.json({ received: true }, 202);
});

async function handleEmailEvent(envelope: WebhookEnvelope): Promise<void> {
  const column = EVENT_COLUMN[envelope.type];
  // email.opened / email.clicked / email.scheduled / email.delivery_delayed and
  // the contact.* and domain.created/deleted families are simply not counted.
  if (!column) return;

  const rawTag = envelope.data?.tags?.partner_id;
  if (typeof rawTag !== 'string' || rawTag.length === 0) {
    logUnknownTagOnce('missing_partner_tag', envelope.type);
    return;
  }
  if (!UUID_RE.test(rawTag)) {
    logUnknownTagOnce('malformed_partner_tag', rawTag.slice(0, 64));
    return;
  }

  const counted = await incrementPartnerSendingStat(rawTag, column, new Date());
  if (!counted) {
    logUnknownTagOnce('unknown_partner', rawTag);
    return;
  }

  if (EVALUATES_AUTO_SUSPENSION.has(envelope.type)) {
    // jobId = autosuspend:<partnerId>, so a bounce storm collapses into one
    // evaluation instead of one per message.
    await enqueueAutoSuspendEvaluation(rawTag);
  }
}

async function handleDomainUpdated(envelope: WebhookEnvelope): Promise<void> {
  const providerDomainId = envelope.data?.id;
  if (typeof providerDomainId !== 'string' || providerDomainId.length === 0) return;

  const rows = await withSystemDbAccessContext(() => db
    .select({ id: partnerSendingDomains.id })
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.providerDomainId, providerDomainId))
    .limit(1), 'emailProviderWebhookDomainLookup') as Array<{ id: string }>;

  const row = rows[0];
  if (!row) {
    // A provider domain Breeze does not know about. The daily drift report
    // (W03) owns that case; the webhook says nothing.
    return;
  }
  // The worker re-reads the domain from the provider and maps the status. The
  // event's own `status` field is deliberately ignored: one mapper, one place.
  await enqueueSyncDomain(row.id);
}
