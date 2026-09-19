// apps/api/src/routes/webhooks/quickbooks.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route is UNAUTHENTICATED (Intuit-signed). We mock the rate limiter, the
// client-ip helper, the provider's HMAC verifier, the realm->connection
// lookup, and the reconcile enqueue so the test exercises the route's
// contract (status codes, dedup, capping/chunking, and that the RAW body
// string is what reaches verifyWebhook) without real Redis/Postgres/QuickBooks.
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

// Finds the ('[quickbooksWebhook] processed webhook delivery', {...}) info-log
// call and returns its structured payload, so tests can assert positively on
// the logged counts instead of only on absence of a substring.
function findProcessedLogPayload(infoSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> | undefined {
  const call = (infoSpy.mock.calls as unknown[][]).find(
    (args) => typeof args[0] === 'string' && args[0].includes('processed webhook delivery'),
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

describe('POST /quickbooks (Intuit CDC webhook)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter.mockResolvedValue({ allowed: true });
    verifyWebhook.mockReturnValue(true);
    findConnectionByRealmFingerprint.mockResolvedValue({ id: 'c1', partnerId: 'p1' });
    enqueueAccountingReconcile.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('throttles the missing-token Sentry capture to once per 10 minutes', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock('../../config/env', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../config/env')>()),
      QBO_WEBHOOK_VERIFIER_TOKEN: '',
    }));
    const { quickbooksWebhookRoutes: fresh } = await import('./quickbooks');

    // Two consecutive requests -> ONE captureMessage call (the second is throttled).
    const res1 = await post(fresh, { sig: SIG });
    const res2 = await post(fresh, { sig: SIG });
    expect(res1.status).toBe(503);
    expect(res2.status).toBe(503);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(verifyWebhook).not.toHaveBeenCalled();

    // A request after the 10-minute throttle window elapses -> a SECOND call.
    vi.advanceTimersByTime(10 * 60 * 1000);
    const res3 = await post(fresh, { sig: SIG });
    expect(res3.status).toBe(503);
    expect(captureMessage).toHaveBeenCalledTimes(2);
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

  it('202s on the happy path, enqueues once, and logs a positive Payment count', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const res = await post(quickbooksWebhookRoutes, { sig: SIG });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(enqueueAccountingReconcile).toHaveBeenCalledTimes(1);
    expect(enqueueAccountingReconcile).toHaveBeenCalledWith('c1', 'p1', 'webhook');
    // Positive assertion on the log payload — this fails if the log line is
    // ever deleted, unlike a pure absence check.
    expect(findProcessedLogPayload(infoSpy)).toMatchObject({
      matched: 1,
      enqueued: 1,
      entityCounts: { Payment: 1, Invoice: 0, other: 0 },
    });
    infoSpy.mockRestore();
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

  it('503s (never 500) when the realm lookup rejects', async () => {
    findConnectionByRealmFingerprint.mockRejectedValue(new Error('pg connection lost'));
    const res = await post(quickbooksWebhookRoutes, { sig: SIG });
    expect(res.status).toBe(503);
    expect(enqueueAccountingReconcile).not.toHaveBeenCalled();
  });

  it('caps unique realms per payload at 50 and drops the rest (still 202)', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const realmIds = Array.from({ length: 51 }, (_, i) => `realm-${i}`);
    const body = JSON.stringify({
      eventNotifications: realmIds.map((realmId) => ({
        realmId,
        dataChangeEvent: { entities: [{ name: 'Payment', id: `p-${realmId}`, operation: 'Update', lastUpdated: '2026-09-02T20:04:34.000Z' }] },
      })),
    });
    const res = await post(quickbooksWebhookRoutes, { sig: SIG, body });
    expect(res.status).toBe(202);
    expect(findConnectionByRealmFingerprint).toHaveBeenCalledTimes(50);
    expect(enqueueAccountingReconcile).toHaveBeenCalledTimes(50);
    expect(findProcessedLogPayload(infoSpy)).toMatchObject({ realmsCapped: 1, dropped: 1, matched: 50 });
    infoSpy.mockRestore();
  });

  it('issues the realm lookups ONE AT A TIME on the shared transaction handle', async () => {
    // Finding F (Opus #6). The lookups share ONE system DB context, i.e. ONE
    // Postgres transaction. Firing them concurrently means a single rejected
    // lookup aborts that transaction and 25P02s every other lookup riding on
    // it, turning one transient error into a whole delivery lost.
    let inFlight = 0;
    let maxInFlight = 0;
    findConnectionByRealmFingerprint.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { id: 'c1', partnerId: 'p1' };
    });
    const realmIds = Array.from({ length: 25 }, (_, i) => `realm-${i}`);
    const body = JSON.stringify({
      eventNotifications: realmIds.map((realmId) => ({ realmId, dataChangeEvent: { entities: [] } })),
    });
    const res = await post(quickbooksWebhookRoutes, { sig: SIG, body });
    expect(res.status).toBe(202);
    expect(findConnectionByRealmFingerprint).toHaveBeenCalledTimes(25);
    expect(maxInFlight).toBe(1);
  });

  it('503s when only SOME enqueues failed — Intuit must retry the realm we dropped (finding F)', async () => {
    findConnectionByRealmFingerprint.mockImplementation(async (_db: unknown, _p: unknown, fp: string) => ({
      id: `c-${fp.slice(-4)}`, partnerId: 'p1',
    }));
    let call = 0;
    enqueueAccountingReconcile.mockImplementation(async () => (call++ === 0));

    const body = JSON.stringify({
      eventNotifications: [
        { realmId: 'realm-ok', dataChangeEvent: { entities: [] } },
        { realmId: 'realm-refused', dataChangeEvent: { entities: [] } },
      ],
    });
    const res = await post(quickbooksWebhookRoutes, { sig: SIG, body });

    // The jobId is deterministic per connection, so re-delivering the whole
    // batch is a no-op for the realm that DID enqueue.
    expect(res.status).toBe(503);
    expect(enqueueAccountingReconcile).toHaveBeenCalledTimes(2);
  });

  it('still 202s when every enqueue succeeded and only unknown realms were dropped', async () => {
    findConnectionByRealmFingerprint
      .mockResolvedValueOnce({ id: 'c1', partnerId: 'p1' })
      .mockResolvedValueOnce(null);
    const body = JSON.stringify({
      eventNotifications: [
        { realmId: 'realm-known', dataChangeEvent: { entities: [] } },
        { realmId: 'realm-other-region', dataChangeEvent: { entities: [] } },
      ],
    });
    const res = await post(quickbooksWebhookRoutes, { sig: SIG, body });
    expect(res.status).toBe(202);
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

  it('clamps an unrecognized entity name to "other" in the info log', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const body = JSON.stringify({ eventNotifications: [{ realmId: '1185883561', dataChangeEvent: { entities: [
      { name: 'not-a-real-qbo-entity<script>', id: '999', operation: 'Update', lastUpdated: '2026-09-02T20:04:34.000Z' },
    ] } }] });
    const res = await post(quickbooksWebhookRoutes, { sig: SIG, body });
    expect(res.status).toBe(202);
    expect(findProcessedLogPayload(infoSpy)).toMatchObject({ entityCounts: { Payment: 0, Invoice: 0, other: 1 } });
    const allArgs = infoSpy.mock.calls.flat().map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' | ');
    expect(allArgs).not.toContain('script');
    infoSpy.mockRestore();
  });
});
