// apps/api/src/routes/webhooks/quickbooks.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route is UNAUTHENTICATED (Intuit-signed). We mock the rate limiter, the
// client-ip helper, the provider's HMAC verifier, the realm->connection
// lookup, and the reconcile enqueue so the test exercises the route's
// contract (status codes, dedup, and that the RAW body string is what reaches
// verifyWebhook) without real Redis/Postgres/QuickBooks.
const { rateLimiter, verifyWebhook, findConnectionByRealmFingerprint, enqueueAccountingReconcile, captureMessage } =
  vi.hoisted(() => ({
    rateLimiter: vi.fn().mockResolvedValue({ allowed: true }),
    verifyWebhook: vi.fn().mockReturnValue(true),
    findConnectionByRealmFingerprint: vi.fn().mockResolvedValue({ id: 'c1', partnerId: 'p1' }),
    enqueueAccountingReconcile: vi.fn().mockResolvedValue(true),
    captureMessage: vi.fn(),
  }));

// The route imports QBO_WEBHOOK_VERIFIER_TOKEN as a module-level const, so the
// token is per-module-instance: mock it once for the happy cases, and use
// vi.resetModules() + vi.doMock('') + a dynamic re-import for the single
// missing-token (503) case. Do NOT try to mutate the const between tests.
const envState = vi.hoisted(() => ({ verifierToken: 'test-verifier-token' }));
const TOKEN = 'test-verifier-token';
const SIG = 'ZmFrZS1zaWduYXR1cmU=';   // any base64 string; verifyWebhook is mocked
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  QBO_WEBHOOK_VERIFIER_TOKEN: envState.verifierToken,
}));
vi.mock('../../services/rate-limit', () => ({ rateLimiter }));
vi.mock('../../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: () => '1.2.3.4',
}));
vi.mock('../../services/accounting/providerRegistry', () => ({ getAccountingProvider: () => ({ verifyWebhook }) }));
vi.mock('../../services/accounting/accountingConnectionService', () => ({ findConnectionByRealmFingerprint }));
vi.mock('../../jobs/accountingReconcileWorker', () => ({ enqueueAccountingReconcile }));
vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../../services/sentry', () => ({ captureMessage }));

import { quickbooksWebhookRoutes } from './quickbooks';

const BODY = JSON.stringify({ eventNotifications: [{ realmId: '1185883561', dataChangeEvent: { entities: [
  { name: 'Payment', id: '180', operation: 'Update', lastUpdated: '2026-09-02T20:04:34.000Z' },
] } }] });

function post(routes: typeof quickbooksWebhookRoutes, opts: { sig?: string; body?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.sig !== undefined) headers['intuit-signature'] = opts.sig;
  return routes.request('/quickbooks', {
    method: 'POST',
    headers,
    body: opts.body ?? BODY,
  });
}

describe('POST /quickbooks (Intuit CDC webhook)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter.mockResolvedValue({ allowed: true });
    verifyWebhook.mockReturnValue(true);
    findConnectionByRealmFingerprint.mockResolvedValue({ id: 'c1', partnerId: 'p1' });
    enqueueAccountingReconcile.mockResolvedValue(true);
  });

  it('429s when rate-limited (before signature work)', async () => {
    rateLimiter.mockResolvedValue({ allowed: false });
    const res = await post(quickbooksWebhookRoutes, { sig: SIG });
    expect(res.status).toBe(429);
    expect(verifyWebhook).not.toHaveBeenCalled();
  });

  it('503s and captures to Sentry when QBO_WEBHOOK_VERIFIER_TOKEN is unset (never 200)', async () => {
    vi.resetModules();
    vi.doMock('../../config/env', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../config/env')>()),
      QBO_WEBHOOK_VERIFIER_TOKEN: '',
    }));
    const { quickbooksWebhookRoutes: fresh } = await import('./quickbooks');
    const res = await post(fresh, { sig: SIG });
    expect(res.status).toBe(503);
    expect(verifyWebhook).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalled();
  });

  it('401s when the intuit-signature header is missing', async () => {
    const res = await post(quickbooksWebhookRoutes, {});
    expect(res.status).toBe(401);
  });

  it('401s when verifyWebhook returns false (bad signature)', async () => {
    verifyWebhook.mockReturnValue(false);
    const res = await post(quickbooksWebhookRoutes, { sig: SIG });
    expect(res.status).toBe(401);
  });

  it('400s when the body is not JSON', async () => {
    const res = await post(quickbooksWebhookRoutes, { sig: SIG, body: 'not json' });
    expect(res.status).toBe(400);
    expect(enqueueAccountingReconcile).not.toHaveBeenCalled();
  });

  it('400s when the body has no eventNotifications array', async () => {
    const res = await post(quickbooksWebhookRoutes, { sig: SIG, body: '{}' });
    expect(res.status).toBe(400);
    expect(enqueueAccountingReconcile).not.toHaveBeenCalled();
  });

  it('202s on the happy path and enqueues once for the matched realm', async () => {
    const res = await post(quickbooksWebhookRoutes, { sig: SIG });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(enqueueAccountingReconcile).toHaveBeenCalledTimes(1);
    expect(enqueueAccountingReconcile).toHaveBeenCalledWith('c1', 'p1', 'webhook');
  });

  it('passes the RAW body string verbatim to verifyWebhook', async () => {
    await post(quickbooksWebhookRoutes, { sig: SIG, body: BODY });
    expect(verifyWebhook).toHaveBeenCalledWith(SIG, BODY, TOKEN);
  });

  it('202s with zero enqueues when the realm is unknown', async () => {
    findConnectionByRealmFingerprint.mockResolvedValue(null);
    const res = await post(quickbooksWebhookRoutes, { sig: SIG });
    expect(res.status).toBe(202);
    expect(enqueueAccountingReconcile).not.toHaveBeenCalled();
  });

  it('dedups two notifications for the same realm into exactly ONE enqueue', async () => {
    const dupeBody = JSON.stringify({ eventNotifications: [
      { realmId: '1185883561', dataChangeEvent: { entities: [{ name: 'Payment', id: '180', operation: 'Update', lastUpdated: '2026-09-02T20:04:34.000Z' }] } },
      { realmId: '1185883561', dataChangeEvent: { entities: [{ name: 'Payment', id: '181', operation: 'Create', lastUpdated: '2026-09-02T20:05:00.000Z' }] } },
    ] });
    const res = await post(quickbooksWebhookRoutes, { sig: SIG, body: dupeBody });
    expect(res.status).toBe(202);
    expect(enqueueAccountingReconcile).toHaveBeenCalledTimes(1);
  });

  it('503s when the only enqueue fails', async () => {
    enqueueAccountingReconcile.mockResolvedValue(false);
    const res = await post(quickbooksWebhookRoutes, { sig: SIG });
    expect(res.status).toBe(503);
  });

  it('never logs an entity id via console.log or console.info', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await post(quickbooksWebhookRoutes, { sig: SIG });
    const allArgs = [...infoSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' | ');
    expect(allArgs).not.toMatch(/180/);
    infoSpy.mockRestore();
    logSpy.mockRestore();
  });
});
