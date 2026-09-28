// apps/api/src/routes/webhooks/xero.ts
//
// Xero webhook route (spec W05).
//
// POST /api/v1/webhooks/xero
//
// Intentionally unauthenticated: security is ONLY the HMAC of the raw body
// against XERO_WEBHOOK_KEY. Mounted outside the auth chain (index.ts), like
// the QuickBooks route, and exempt from partnerGuard by exact path. A doorbell,
// not a data source: it never reads event resource ids; the reconcile job
// re-reads Xero with the connection's own token and stored tenant id.
//
// Order (the security contract, refinement 2): IP limiter -> raw body -> key
// present -> signature (constant time) -> JSON.parse -> shape -> per-tenant
// routing through the shared system-scoped router (refinement 7).
//
// Status matrix (Xero retries a non-2xx immediately, then every 15 min, and
// disables the subscription after 24 h of failures):
//   429 — IP limiter denies (fails closed on a Redis outage)              -> retried
//   503 — XERO_WEBHOOK_KEY unset (never 200: nothing was verified)        -> retried
//   401 — missing or bad x-xero-signature, EMPTY body (the answer Xero's
//         intent-to-receive probe expects for a bad signature)
//   400 — signed body is not JSON / has no events[]                       -> retried
//   503 — ANY enqueue failed, or a lookup threw                           -> retried (jobId dedupe)
//   200 — handled, EMPTY body, incl. intent-to-receive (events: []) and
//         tenants with no connection / no payment pull yet
//
// NOT in SELF_MANAGED_DB_CONTEXT_ROUTES: there is no ambient auth transaction
// on an unauthenticated route. The route itself opens no DB context.
import { Hono } from 'hono';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import { routeWebhookToConnection } from '../../services/accounting/accountingWebhookRouting';
import { hmacFingerprint } from '../../services/secretCrypto';
import { xeroWebhookKey } from '../../config/env';
import { captureMessage } from '../../services/sentry';

export const xeroWebhookRoutes = new Hono();

const RATE_LIMIT = 240;
const RATE_WINDOW_SECONDS = 60;
/** Distinct tenants routed per delivery; the rest wait for the 15-minute sweep. */
export const MAX_TENANTS_PER_PAYLOAD = 50;
/** Events inspected per delivery (the tenant set is capped anyway). */
export const MAX_EVENTS_SCANNED = 1000;
/** A burst of events for one tenant coalesces into one reconcile (refinement 5). */
export const XERO_WEBHOOK_RECONCILE_DELAY_MS = 30_000;
const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEY_MISSING_CAPTURE_THROTTLE_MS = 10 * 60 * 1000;
let lastKeyMissingCaptureAtMs: number | null = null;

// Any anonymous POST reaches this before a signature is checked, so the Sentry
// capture is throttled (same rationale as the QuickBooks route).
function reportMissingKey(): void {
  const now = Date.now();
  if (lastKeyMissingCaptureAtMs !== null && now - lastKeyMissingCaptureAtMs < KEY_MISSING_CAPTURE_THROTTLE_MS) {
    console.warn('[xeroWebhook] XERO_WEBHOOK_KEY unset (Sentry capture throttled)');
    return;
  }
  lastKeyMissingCaptureAtMs = now;
  captureMessage('Xero webhook received but XERO_WEBHOOK_KEY is unset', {
    eventCode: 'accounting_webhook_signing_key_missing',
  });
}

/** The same bytes W02b fingerprinted when it stored the tenant (assumption B2). */
export function tenantFingerprint(tenantId: string): string {
  return hmacFingerprint(tenantId);
}

interface XeroWebhookEvent {
  eventCategory?: unknown;
  tenantId?: unknown;
  tenantType?: unknown;
}

// Signed, but not schema-validated: clamp categories to a known set so a
// crafted payload cannot inject strings into structured logs.
type LoggedCategory = 'INVOICE' | 'CONTACT' | 'other';

function loggedCategory(value: unknown): LoggedCategory {
  return value === 'INVOICE' || value === 'CONTACT' ? value : 'other';
}

xeroWebhookRoutes.post('/xero', async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const rate = await rateLimiter(getRedis(), `xero-webhook:${rateLimitIpKey(ip)}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!rate.allowed) return c.body(null, 429);

  // The HMAC is over the exact bytes Xero sent: read them before anything else.
  const raw = await c.req.text();

  const key = xeroWebhookKey();
  if (!key) {
    reportMissingKey();
    return c.body(null, 503);
  }

  const signature = c.req.header('x-xero-signature');
  if (!signature || !getAccountingProvider('xero').verifyWebhook(signature, raw, key)) {
    return c.body(null, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.body(null, 400);
  }
  const events = (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return c.body(null, 400);

  const tenants = new Set<string>();
  const categories: Record<LoggedCategory, number> = { INVOICE: 0, CONTACT: 0, other: 0 };
  let ignored = 0;
  const scanned = events.slice(0, MAX_EVENTS_SCANNED) as Array<XeroWebhookEvent | null | undefined>;
  for (const event of scanned) {
    const category = loggedCategory(event?.eventCategory);
    categories[category] += 1;
    // Xero has no PAYMENT category; an invoice change is the only payment signal (refinement 3).
    if (
      category !== 'INVOICE'
      || event?.tenantType !== 'ORGANISATION'
      || typeof event.tenantId !== 'string'
      || !TENANT_ID_RE.test(event.tenantId)
    ) {
      ignored += 1;
      continue;
    }
    tenants.add(event.tenantId);
  }

  const allTenants = [...tenants];
  const routed = allTenants.slice(0, MAX_TENANTS_PER_PAYLOAD);
  const tenantsCapped = allTenants.length - routed.length;

  let matched = 0;
  let dropped = tenantsCapped;
  let enqueued = 0;
  let failed = 0;
  try {
    for (const tenantId of routed) {
      const outcome = await routeWebhookToConnection('xero', tenantFingerprint(tenantId), {
        delayMs: XERO_WEBHOOK_RECONCILE_DELAY_MS,
      });
      if (outcome === 'no_connection' || outcome === 'capability_unavailable') { dropped += 1; continue; }
      matched += 1;
      if (outcome === 'enqueued') enqueued += 1; else failed += 1;
    }
  } catch (err) {
    console.error('[xeroWebhook] tenant lookup failed', err instanceof Error ? err.message : err);
    return c.body(null, 503);
  }

  // Counts and clamped categories only — never tenant or resource ids.
  console.info('[xeroWebhook] processed webhook delivery', {
    events: events.length, scanned: scanned.length, ignored, categories, tenantsCapped, matched, dropped, enqueued, failed,
  });

  if (failed > 0) return c.body(null, 503);
  return c.body(null, 200);
});
