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
//   dedup + cap realmIds -> look up each connection by realm fingerprint, in
//   chunks, inside ONE short system DB context -> enqueue a reconcile per
//   matched connection (no DB context held around the Redis call) -> 202.
//
// Status matrix (Intuit retry behaviour in comments):
//   429 — rate limiter denies (fails CLOSED: a Redis outage lands here too) -> retries
//   503 — QBO_WEBHOOK_VERIFIER_TOKEN unset -- NEVER 200, so Intuit keeps retrying
//         (24h backoff) instead of believing an unconfigured region processed the event
//   401 — missing or bad intuit-signature -> does NOT retry (permanent)
//   400 — body is not JSON, or has no eventNotifications array -> does NOT retry
//   503 — ANY queue add for the request failed, OR the realm lookup itself
//         threw (never surface a bare 500 to an external caller) -> retries.
//         Deliberately ANY, not "every" (final-review finding F): a partial
//         failure used to answer 202, and Intuit never retried — so the realm
//         whose enqueue was refused waited up to 15 minutes for the sweep. The
//         jobId is deterministic per connection, so re-delivering the whole
//         batch is a no-op for the realms that DID enqueue.
//   202 — accepted, including "all realms unknown" or "some realms dropped
//         past the cap" (nothing more we can do with those) -> done
import { Hono } from 'hono';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import {
  findConnectionByRealmFingerprint,
  type AccountingConnection,
} from '../../services/accounting/accountingConnectionService';
import { enqueueAccountingReconcile } from '../../jobs/accountingReconcileWorker';
import { hmacFingerprint } from '../../services/secretCrypto';
import { db, withSystemDbAccessContext } from '../../db';
import { QBO_WEBHOOK_VERIFIER_TOKEN } from '../../config/env';
import { captureMessage } from '../../services/sentry';

export const quickbooksWebhookRoutes = new Hono();

const RATE_LIMIT = 240;
const RATE_WINDOW_SECONDS = 60;

// Intuit can (and does) batch an unbounded number of distinct realms into one
// delivery. Without a cap, an unusually large or malicious payload would open
// one system DB context and issue one HMAC + one Postgres lookup per realm —
// the context stays held for the whole fan-out, which is exactly the "long
// held context" shape the repo's DB-context guard exists to catch. Beyond the
// cap, excess realms are simply dropped (counted, logged, still 202) — the
// 15-minute reconcile sweep is the backstop for anything a capped delivery
// can't route this time.
const MAX_REALMS_PER_PAYLOAD = 50;
// Within the cap, look up connections CHUNK_SIZE at a time rather than in one
// unbounded pass — bounds how much work one delivery can queue up while the
// system context is held. Lookups WITHIN a chunk run sequentially: they all
// ride the SAME system DB context, i.e. the same Postgres transaction, and a
// single rejected lookup aborts it — every sibling issued concurrently on that
// handle would then fail with 25P02 and the whole delivery would 503 over one
// transient error (final-review finding F / Opus #6).
const REALM_LOOKUP_CHUNK_SIZE = 10;

// Sentry throttle for the missing-verifier-token capture below. The route is
// unauthenticated: ANY anonymous POST (not just genuine Intuit deliveries)
// reaches this check before any signature is verified, so without a throttle
// a trivial anonymous flood (up to the rate limiter's 240/min ceiling) mints
// one Sentry event per request. One capture per throttle window is enough to
// alert an operator that the token needs configuring; console.warn stays
// unthrottled locally but carries no request content.
const VERIFIER_TOKEN_MISSING_CAPTURE_THROTTLE_MS = 10 * 60 * 1000;
let lastVerifierTokenMissingCaptureAtMs: number | null = null;

function reportMissingVerifierToken(): void {
  const now = Date.now();
  if (
    lastVerifierTokenMissingCaptureAtMs !== null &&
    now - lastVerifierTokenMissingCaptureAtMs < VERIFIER_TOKEN_MISSING_CAPTURE_THROTTLE_MS
  ) {
    console.warn('[quickbooksWebhook] QBO_WEBHOOK_VERIFIER_TOKEN unset (Sentry capture throttled)');
    return;
  }
  lastVerifierTokenMissingCaptureAtMs = now;
  captureMessage('QuickBooks webhook received but QBO_WEBHOOK_VERIFIER_TOKEN is unset', {
    eventCode: 'accounting_webhook_verifier_token_missing',
  });
}

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

// The info log below reports entity NAMES, never ids — but the payload is
// only signature-verified, not schema-validated, so an entity `name` is still
// attacker-shaped input. Clamp to the two names Phase D actually cares about
// and bucket everything else as 'other' so a signed-but-crafted payload can't
// inject arbitrary strings into structured logs.
type LoggedEntityKind = 'Payment' | 'Invoice' | 'other';

function classifyEntityName(name: string | undefined): LoggedEntityKind {
  if (name === 'Payment' || name === 'Invoice') return name;
  return 'other';
}

async function lookupConnectionsChunked(realmIds: readonly string[]): Promise<Array<AccountingConnection | null>> {
  const results: Array<AccountingConnection | null> = [];
  for (let i = 0; i < realmIds.length; i += REALM_LOOKUP_CHUNK_SIZE) {
    const chunk = realmIds.slice(i, i + REALM_LOOKUP_CHUNK_SIZE);
    for (const realmId of chunk) {
      results.push(await findConnectionByRealmFingerprint(db, 'quickbooks', hmacFingerprint(realmId)));
    }
  }
  return results;
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
    reportMissingVerifierToken();
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
  const entityCounts: Record<LoggedEntityKind, number> = { Payment: 0, Invoice: 0, other: 0 };
  for (const notification of typedNotifications) {
    if (notification?.realmId) {
      realmIds.add(notification.realmId);
    }
    for (const entity of notification?.dataChangeEvent?.entities ?? []) {
      entityCounts[classifyEntityName(entity?.name)] += 1;
    }
  }

  // Cap the unique-realm fan-out; anything past the cap is dropped (counted
  // below) rather than looked up.
  const allRealmIds = [...realmIds];
  const cappedRealmIds = allRealmIds.slice(0, MAX_REALMS_PER_PAYLOAD);
  const realmsCapped = allRealmIds.length - cappedRealmIds.length;

  // 7. Resolve realm -> connection in ONE short system context, chunked; the
  //    enqueue below runs OUTSIDE any DB context (Redis call, not DB work).
  //    A rejected lookup must never surface as a bare 500 to an external,
  //    unauthenticated caller — Intuit gets a 503 (retry) instead.
  let connections: Array<AccountingConnection | null>;
  try {
    connections = await withSystemDbAccessContext(() => lookupConnectionsChunked(cappedRealmIds));
  } catch (err) {
    console.error('[quickbooksWebhook] realm lookup failed', err instanceof Error ? err.message : err);
    return c.json({ error: 'Service Unavailable' }, 503);
  }

  let matched = 0;
  let dropped = realmsCapped;
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

  // Log entity NAMES (clamped to a known set above) and COUNTS only — never
  // ids. The handler never acts on payload entity ids; CDC (Task 2) is the
  // only thing that decides what changed.
  console.info('[quickbooksWebhook] processed webhook delivery', {
    notifications: typedNotifications.length,
    realmsCapped,
    matched,
    dropped,
    enqueued,
    failed,
    entityCounts,
  });

  // ANY failed enqueue -> 503 (finding F). A 202 here would tell Intuit the
  // whole delivery was handled and it would never retry, leaving the refused
  // realm to wait for the next 15-minute sweep.
  if (failed > 0) {
    return c.json({ error: 'Service Unavailable' }, 503);
  }
  return c.json({ accepted: true }, 202);
});
