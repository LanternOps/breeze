/**
 * Mount-order regression test for issue #2053.
 *
 * `webhookRoutes` (org webhook CRUD, session-auth) and `emailWebhookRoutes`
 * (public, HMAC-gated inbound email) both mount under the `/webhooks` prefix in
 * index.ts. Hono flattens `.route()` mounts, so a `/webhooks/*` wildcard auth
 * middleware on webhookRoutes would blanket the nested public `/webhooks/tickets`
 * routes and 401 them with "Missing or invalid authorization header" before the
 * HMAC handler ever runs.
 *
 * This test reproduces the real mount topology (webhookRoutes mounted BEFORE
 * emailWebhookRoutes, both under /webhooks) and asserts:
 *   1. an unauthenticated POST to /webhooks/tickets/email-inbound reaches the
 *      HMAC handler (NOT session auth), and
 *   2. webhookRoutes' own CRUD endpoints still require session auth.
 *
 * The Stripe Connect webhook (`/webhooks/stripe/connect`) and the QuickBooks
 * webhook (`/webhooks/quickbooks`, Phase D Task 5) are affected by the
 * identical mechanism and protected by the same per-route-auth fix — a
 * re-added `/webhooks/*` wildcard auth middleware would 401 Intuit's CDC
 * deliveries before the HMAC handler ever ran, and Intuit does not retry a
 * 401 (it reads as "permanently rejected"), so the regression would be
 * silent until CDC payments simply stopped flowing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { verifyMock, parseMock, enqueueMock, rateLimiterMock, qboVerifyWebhookMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  parseMock: vi.fn(),
  enqueueMock: vi.fn().mockResolvedValue(undefined),
  rateLimiterMock: vi.fn(),
  qboVerifyWebhookMock: vi.fn()
}));

// --- Inbound-email service deps (exercised by the email route) ---
vi.mock('../services/inboundEmail/mailgun', () => ({
  MailgunInboundProvider: class {
    name = 'mailgun';
    verify(...args: unknown[]) { return verifyMock(...args); }
    parse(...args: unknown[]) { return parseMock(...args); }
  }
}));
vi.mock('../services/inboundEmailQueue', () => ({
  enqueueInboundEmail: enqueueMock
}));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: rateLimiterMock
}));
vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({}))
}));
// Partial mock: only the IP SOURCE is stubbed. rateLimitIpKey (the IPv6 /64
// bucket folding used to build limiter keys) is kept REAL so the test exercises
// the same key the production path produces.
vi.mock('../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: vi.fn(() => '1.2.3.4')
}));

// --- webhookRoutes-only deps (never reached on the no-auth paths under test) ---
vi.mock('../workers/webhookDelivery', () => ({
  getWebhookWorker: vi.fn(() => ({}))
}));
vi.mock('../services/notificationSenders/webhookSender', () => ({
  redactUrlForLogs: vi.fn((u: string) => u),
  validateWebhookUrlSafetyWithDns: vi.fn(async () => [])
}));

// --- Stripe webhook deps (the signature handler is reached past auth) ---
vi.mock('../services/stripeWebhook', () => ({
  verifyStripeEvent: vi.fn(() => { throw new Error('should not be reached without a signature'); }),
  handleStripeEvent: vi.fn(async () => undefined)
}));
vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn()
}));

// --- QuickBooks webhook deps (the signature handler is reached past auth) ---
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/env')>()),
  QBO_WEBHOOK_VERIFIER_TOKEN: 'test-verifier-token'
}));
vi.mock('../services/accounting/providerRegistry', () => ({
  getAccountingProvider: () => ({ verifyWebhook: qboVerifyWebhookMock })
}));
vi.mock('../services/accounting/accountingConnectionService', () => ({
  findConnectionByRealmFingerprint: vi.fn().mockResolvedValue(null)
}));
vi.mock('../jobs/accountingReconcileWorker', () => ({
  enqueueAccountingReconcile: vi.fn().mockResolvedValue(true)
}));

// db is mocked to avoid a real connection at import; the paths under test
// (no Authorization header) short-circuit before any query runs.
vi.mock('../db', () => ({
  db: {},
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn())
}));

import { webhookRoutes } from './webhooks';
import { emailWebhookRoutes } from './tickets/emailWebhook';
import { stripeWebhookRoutes } from './webhooks/stripe';
import { quickbooksWebhookRoutes } from './webhooks/quickbooks';

// Reproduce the index.ts mount order: CRUD router first, then the public
// signature-gated siblings — emailWebhookRoutes at /webhooks/tickets,
// stripeWebhookRoutes back under /webhooks, and quickbooksWebhookRoutes last
// (index.ts:925,928,932,938).
function buildApp() {
  const app = new Hono();
  app.route('/webhooks', webhookRoutes);
  app.route('/webhooks/tickets', emailWebhookRoutes);
  app.route('/webhooks', stripeWebhookRoutes);
  app.route('/webhooks', quickbooksWebhookRoutes);
  return app;
}

async function postInbound(app: Hono) {
  const form = new FormData();
  form.append('timestamp', 't');
  form.append('token', 'k');
  form.append('signature', 'sig');
  return app.request('/webhooks/tickets/email-inbound', { method: 'POST', body: form });
}

describe('webhooks mount-order regression (#2053)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 59, resetAt: new Date() });
    verifyMock.mockResolvedValue(true);
    parseMock.mockResolvedValue({ provider: 'mailgun', to: 'x', from: 'y', attachments: [], raw: {} });
    qboVerifyWebhookMock.mockReturnValue(true);
  });

  it('inbound email reaches the HMAC handler, not session auth (bad sig → 401 "Unauthorized")', async () => {
    verifyMock.mockResolvedValue(false);
    const res = await postInbound(buildApp());
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    // The bug surfaced as the authMiddleware message; the HMAC handler returns "Unauthorized".
    expect(body.error).toBe('Unauthorized');
    expect(body.error).not.toBe('Missing or invalid authorization header');
    expect(verifyMock).toHaveBeenCalled();
  });

  it('inbound email with a valid signature is accepted (202)', async () => {
    const res = await postInbound(buildApp());
    expect(res.status).toBe(202);
    expect(enqueueMock).toHaveBeenCalled();
  });

  it('Stripe Connect webhook reaches the signature handler, not session auth (no sig → 400)', async () => {
    // The same `/webhooks/*` wildcard that broke inbound email also blanketed
    // /webhooks/stripe/connect. With no stripe-signature header the handler
    // returns 400 "Missing signature" — proof it ran past auth, not the
    // authMiddleware 401.
    const res = await buildApp().request('/webhooks/stripe/connect', {
      method: 'POST',
      body: '{}'
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Missing signature');
    expect(body.error).not.toBe('Missing or invalid authorization header');
  });

  it('QuickBooks webhook reaches the signature handler, not session auth (no sig → 401 "Unauthorized")', async () => {
    // Same wildcard-mount hazard as Stripe/email above, applied to Task 5's
    // Intuit CDC webhook. With no intuit-signature header the handler returns
    // 401 "Unauthorized" — proof it ran past auth, not the authMiddleware 401
    // ("Missing or invalid authorization header"). Getting this backwards
    // means Intuit's CDC deliveries get a PERMANENT 401 (no retry) instead of
    // ever reaching the HMAC check.
    const res = await buildApp().request('/webhooks/quickbooks', {
      method: 'POST',
      body: '{}'
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(body.error).not.toBe('Missing or invalid authorization header');
    expect(qboVerifyWebhookMock).not.toHaveBeenCalled();
  });

  it('webhookRoutes CRUD still requires session auth (no token → 401 auth header)', async () => {
    const res = await buildApp().request('/webhooks', { method: 'GET' });
    expect(res.status).toBe(401);
    // authMiddleware throws an HTTPException; a bare Hono app (no onError) returns
    // its message as the raw body. The real app.onError wraps this as JSON, but
    // here we just assert the auth gate fired.
    const body = await res.text();
    expect(body).toContain('Missing or invalid authorization header');
  });
});
