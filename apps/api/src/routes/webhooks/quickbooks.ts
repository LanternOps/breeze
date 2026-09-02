// apps/api/src/routes/webhooks/quickbooks.ts
//
// Intuit QuickBooks CDC webhook route.
//
// POST /api/v1/webhooks/quickbooks
//
// This endpoint is intentionally unauthenticated (no session auth / no JWT) —
// security is provided exclusively by HMAC verification of the raw request
// body against QBO_WEBHOOK_VERIFIER_TOKEN. It is mounted OUTSIDE the auth
// middleware chain (see index.ts mount point), modeled on
// routes/tickets/emailWebhook.ts: verify -> enqueue -> 202. The Stripe
// webhook route reconciles inline and is deliberately NOT the model here —
// this route only ROUTES a change-data-capture ping to the reconcile worker;
// it never reads or acts on payload entity ids itself. The reconcile job
// (Task 4) re-reads QuickBooks via `reconcileChanges`, which is the only
// thing that decides what actually changed — the webhook is a doorbell, not
// a data source.
//
// Flow:
//   rate-limit (per source IP) -> raw body read -> verifier-token presence
//   check -> provider.verifyWebhook (HMAC) -> JSON.parse -> shape check ->
//   dedup realmIds -> look up each connection by realm fingerprint (ONE short
//   system DB context) -> enqueue a reconcile per matched connection (no DB
//   context held around the Redis call) -> 202.
//
// Status matrix (Intuit retry behaviour in comments):
//   429 — rate limiter denies (fails CLOSED: a Redis outage lands here too) -> retries
//   503 — QBO_WEBHOOK_VERIFIER_TOKEN unset -- NEVER 200, so Intuit keeps retrying
//         (24h backoff) instead of believing an unconfigured region processed the event
//   401 — missing or bad intuit-signature -> does NOT retry (permanent)
//   400 — body is not JSON, or has no eventNotifications array -> does NOT retry
//   503 — every queue add for the request failed -> retries
//   202 — accepted, including "all realms unknown" (nothing more we can do with it) -> done
import { Hono } from 'hono';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import { findConnectionByRealmFingerprint } from '../../services/accounting/accountingConnectionService';
import { enqueueAccountingReconcile } from '../../jobs/accountingReconcileWorker';
import { hmacFingerprint } from '../../services/secretCrypto';
import { db, withSystemDbAccessContext } from '../../db';
import { QBO_WEBHOOK_VERIFIER_TOKEN } from '../../config/env';
import { captureMessage } from '../../services/sentry';

export const quickbooksWebhookRoutes = new Hono();

const RATE_LIMIT = 240;
const RATE_WINDOW_SECONDS = 60;

interface QboEventEntity {
  name?: string;
  id?: string;
  operation?: string;
  lastUpdated?: string;
}

interface QboEventNotification {
  realmId?: string;
  dataChangeEvent?: { entities?: QboEventEntity[] };
}

quickbooksWebhookRoutes.post('/quickbooks', async (c) => {
  // 1. Rate limit (keyed by source IP; fails CLOSED so a Redis outage -> 429)
  const ip = getTrustedClientIp(c, 'unknown');
  const rate = await rateLimiter(getRedis(), `qbo-webhook:${rateLimitIpKey(ip)}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!rate.allowed) {
    return c.json({ error: 'Too Many Requests' }, 429);
  }

  // 2. Read the raw body FIRST, before anything else can consume it — the
  //    HMAC is computed over the exact bytes Intuit sent.
  const raw = await c.req.text();

  // 3. A region without QBO_WEBHOOK_VERIFIER_TOKEN configured must never
  //    return 200/202 here — that would tell Intuit the event was handled
  //    when nothing was verified or processed. Returning 503 keeps Intuit
  //    retrying (24h backoff) until the token is configured; the 15-minute
  //    reconcile sweep is the fallback in the meantime.
  if (!QBO_WEBHOOK_VERIFIER_TOKEN) {
    captureMessage('QuickBooks webhook received but QBO_WEBHOOK_VERIFIER_TOKEN is unset', {
      eventCode: 'accounting_webhook_verifier_token_missing',
    });
    return c.json({ error: 'Service Unavailable' }, 503);
  }

  // 4. Signature check.
  const sig = c.req.header('intuit-signature');
  if (!sig) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const valid = getAccountingProvider('quickbooks').verifyWebhook(sig, raw, QBO_WEBHOOK_VERIFIER_TOKEN);
  if (!valid) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // 5. Parse + shape check.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: 'Bad Request' }, 400);
  }
  const notifications = (parsed as { eventNotifications?: unknown })?.eventNotifications;
  if (!Array.isArray(notifications)) {
    return c.json({ error: 'Bad Request' }, 400);
  }
  const typedNotifications = notifications as QboEventNotification[];

  // 6. Dedup realmIds within this payload — Intuit can (and does) batch
  //    multiple notifications for the same realm in one delivery, and we
  //    only ever want ONE reconcile enqueue per connection per delivery
  //    (the reconcile job itself re-reads everything that changed via CDC).
  const realmIds = new Set<string>();
  const entityNames = new Set<string>();
  for (const notification of typedNotifications) {
    if (notification?.realmId) {
      realmIds.add(notification.realmId);
    }
    for (const entity of notification?.dataChangeEvent?.entities ?? []) {
      if (entity?.name) {
        entityNames.add(entity.name);
      }
    }
  }

  // 7. Resolve realm -> connection in ONE short system context; the enqueue
  //    below runs OUTSIDE any DB context (Redis call, not DB work).
  const connections = await withSystemDbAccessContext(() =>
    Promise.all(
      [...realmIds].map((realmId) =>
        findConnectionByRealmFingerprint(db, 'quickbooks', hmacFingerprint(realmId)),
      ),
    ),
  );

  let matched = 0;
  let dropped = 0;
  let enqueued = 0;
  let failed = 0;
  for (const conn of connections) {
    if (!conn) {
      dropped += 1;
      continue;
    }
    matched += 1;
    const ok = await enqueueAccountingReconcile(conn.id, conn.partnerId, 'webhook');
    if (ok) {
      enqueued += 1;
    } else {
      failed += 1;
    }
  }

  // Log entity NAMES only (e.g. "Payment", "Invoice") — never ids. The
  // handler never acts on payload entity ids; CDC (Task 2) is the only thing
  // that decides what changed.
  console.info('[quickbooksWebhook] processed webhook delivery', {
    notifications: typedNotifications.length,
    matched,
    dropped,
    enqueued,
    failed,
    entities: [...entityNames],
  });

  if (enqueued === 0 && failed > 0) {
    return c.json({ error: 'Service Unavailable' }, 503);
  }
  return c.json({ accepted: true }, 202);
});
