import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// UNAUTHENTICATED route, Xero-signed. The REAL provider verifier runs (so the
// test proves HMAC-before-parse with real signatures); the limiter, client IP,
// router and fingerprint are mocked.
const m = vi.hoisted(() => ({
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  route: vi.fn(async () => 'enqueued' as string),
  fingerprint: vi.fn((t: string) => `fp:${t}`),
  captureMessage: vi.fn(),
  // DB-context spies (refinement 2: a bad signature never opens a DB context).
  // The route must not import ../../db at all; these catch it (or anything it
  // pulls in) opening a context on a request that failed the HMAC.
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: m.rateLimiter }));
vi.mock('../../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/clientIp', async (orig) => ({
  rateLimitIpKey: (await orig<typeof import('../../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: () => '1.2.3.4',
}));
vi.mock('../../services/accounting/providerRegistry', async () => {
  const { xeroProvider } = await vi.importActual<typeof import('../../services/accounting/xeroProvider')>('../../services/accounting/xeroProvider');
  return { getAccountingProvider: () => xeroProvider };
});
vi.mock('../../services/accounting/accountingWebhookRouting', () => ({ routeWebhookToConnection: m.route }));
vi.mock('../../services/secretCrypto', () => ({ hmacFingerprint: m.fingerprint }));
vi.mock('../../services/sentry', () => ({ captureMessage: m.captureMessage }));
vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: m.withSystemDbAccessContext,
  withDbAccessContext: m.withDbAccessContext,
  runOutsideDbContext: m.runOutsideDbContext,
}));

import { MAX_EVENTS_SCANNED, MAX_TENANTS_PER_PAYLOAD, XERO_WEBHOOK_RECONCILE_DELAY_MS, xeroWebhookRoutes } from './xero';

const KEY = 'test-signing-key';
const T1 = '11111111-2222-3333-4444-555555555555';
const T2 = '66666666-7777-8888-9999-000000000000';
const sign = (raw: string) => createHmac('sha256', KEY).update(raw, 'utf8').digest('base64');
const event = (over: Record<string, unknown> = {}) => ({
  resourceUrl: 'https://api.xero.com/api.xro/2.0/Invoices/abc', resourceId: 'abc', eventDateUtc: '2026-09-27T08:00:00.000',
  eventType: 'UPDATE', eventCategory: 'INVOICE', tenantId: T1, tenantType: 'ORGANISATION', ...over,
});
const payload = (events: unknown[]) => JSON.stringify({ events, firstEventSequence: 1, lastEventSequence: events.length, entropy: 'XYZ' });
function post(body: string, sig: string | null = sign(body)) {
  return xeroWebhookRoutes.request('/xero', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'x-xero-signature': sig }) },
    body,
  });
}
function expectNoDbContextOpened() {
  expect(m.withSystemDbAccessContext).not.toHaveBeenCalled();
  expect(m.withDbAccessContext).not.toHaveBeenCalled();
  expect(m.runOutsideDbContext).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.XERO_WEBHOOK_KEY = KEY;
  m.route.mockResolvedValue('enqueued');
  m.rateLimiter.mockResolvedValue({ allowed: true });
});
afterEach(() => {
  delete process.env.XERO_WEBHOOK_KEY;
  vi.restoreAllMocks();
});

describe('POST /webhooks/xero', () => {
  it('intent to receive: a signed empty batch → exactly 200, empty body, no cookie, no lookup', async () => {
    const res = await post(payload([]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(m.route).not.toHaveBeenCalled();
  });

  it('intent to receive: a badly signed batch → 401, empty body, no cookie, no DB context', async () => {
    const res = await post(payload([]), 'bm90LXRoZS1zaWduYXR1cmU=');
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(res.headers.get('set-cookie')).toBeNull();
    expectNoDbContextOpened();
  });

  it('checks the signature BEFORE parsing or looking anything up (malformed body + bad sig → 401, not 400)', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const res = await post('{not json', 'AAAA');
    expect(res.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
    expect(m.fingerprint).not.toHaveBeenCalled();
    expect(m.route).not.toHaveBeenCalled();
    expectNoDbContextOpened();
  });

  it('a well-formed, correctly-shaped payload with a WRONG signature never parses, fingerprints, routes or opens a DB context', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const body = payload([event(), event({ tenantId: T2 })]);
    const res = await post(body, sign(`${body} `));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(parse).not.toHaveBeenCalled();
    expect(m.fingerprint).not.toHaveBeenCalled();
    expect(m.route).not.toHaveBeenCalled();
    expectNoDbContextOpened();
  });

  it('a missing signature header is 401, empty body, no cookie, no parse, no DB context', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const res = await post(payload([event()]), null);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(parse).not.toHaveBeenCalled();
    expect(m.fingerprint).not.toHaveBeenCalled();
    expect(m.route).not.toHaveBeenCalled();
    expectNoDbContextOpened();
  });

  it('a signed but unparseable body is 400; a signed body without events[] is 400', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post('{"foo":1}')).status).toBe(400);
  });

  it('without XERO_WEBHOOK_KEY: 503 (never 200), one throttled Sentry message, no lookup', async () => {
    delete process.env.XERO_WEBHOOK_KEY;
    const body = payload([event()]);
    expect((await post(body)).status).toBe(503);
    expect((await post(body)).status).toBe(503);
    expect(m.captureMessage).toHaveBeenCalledTimes(1);
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), { eventCode: 'accounting_webhook_signing_key_missing' });
    expect(m.route).not.toHaveBeenCalled();
    expectNoDbContextOpened();
  });

  it('the IP limiter refusing (incl. a Redis outage) is 429 before any verification', async () => {
    m.rateLimiter.mockResolvedValueOnce({ allowed: false });
    expect((await post(payload([event()]))).status).toBe(429);
    expect(m.route).not.toHaveBeenCalled();
  });

  it('routes each distinct ORGANISATION tenant with an INVOICE event once, delayed', async () => {
    const res = await post(payload([event(), event({ eventType: 'CREATE' }), event({ tenantId: T2 })]));
    expect(res.status).toBe(200);
    expect(m.route.mock.calls).toEqual([
      ['xero', `fp:${T1}`, { delayMs: XERO_WEBHOOK_RECONCILE_DELAY_MS }],
      ['xero', `fp:${T2}`, { delayMs: XERO_WEBHOOK_RECONCILE_DELAY_MS }],
    ]);
  });

  it.each([
    ['a CONTACT event', { eventCategory: 'CONTACT' }],
    ['a CREDITNOTE event', { eventCategory: 'CREDITNOTE' }],
    ['a SUBSCRIPTION (APPLICATION) event', { eventCategory: 'SUBSCRIPTION', tenantType: 'APPLICATION' }],
    ['a non-GUID tenant id', { tenantId: "x' OR 1=1" }],
    ['a missing tenant id', { tenantId: undefined }],
  ])('ignores %s (200, no lookup)', async (_l, over) => {
    const res = await post(payload([event(over)]));
    expect(res.status).toBe(200);
    expect(m.route).not.toHaveBeenCalled();
  });

  it('caps distinct tenants per delivery', async () => {
    const tenants = Array.from({ length: MAX_TENANTS_PER_PAYLOAD + 5 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    await post(payload(tenants.map((tenantId) => event({ tenantId }))));
    expect(m.route).toHaveBeenCalledTimes(MAX_TENANTS_PER_PAYLOAD);
  });

  it.each(['no_connection', 'capability_unavailable'])('a %s tenant is dropped and still answers 200', async (outcome) => {
    m.route.mockResolvedValueOnce(outcome);
    expect((await post(payload([event()]))).status).toBe(200);
  });

  it('ANY failed enqueue answers 503 so Xero retries (jobId dedupe makes the retry free)', async () => {
    m.route.mockResolvedValueOnce('enqueued').mockResolvedValueOnce('enqueue_failed');
    expect((await post(payload([event(), event({ tenantId: T2 })]))).status).toBe(503);
  });

  it('a thrown lookup answers 503, never a bare 500', async () => {
    m.route.mockRejectedValueOnce(new Error('db down'));
    expect((await post(payload([event()]))).status).toBe(503);
  });

  it('scans only the first MAX_EVENTS_SCANNED events — a valid event past the cap is invisible, and the summary reports scanned vs events', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const ignoredEvents = Array.from({ length: MAX_EVENTS_SCANNED }, () => event({ eventCategory: 'CONTACT' }));
    const beyondCap = event({ eventCategory: 'INVOICE', tenantType: 'ORGANISATION', tenantId: T1 });
    const res = await post(payload([...ignoredEvents, beyondCap]));

    expect(res.status).toBe(200);
    expect(m.route).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      '[xeroWebhook] processed webhook delivery',
      expect.objectContaining({ scanned: MAX_EVENTS_SCANNED, events: MAX_EVENTS_SCANNED + 1 }),
    );
  });

  it('re-arms the Sentry throttle after the window elapses, and stays silent inside it', async () => {
    vi.useFakeTimers();
    try {
      delete process.env.XERO_WEBHOOK_KEY;
      const body = payload([event()]);

      // Clear the throttle state left by the earlier missing-key test by letting
      // a full window elapse before this test's first capture.
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      expect((await post(body)).status).toBe(503);
      expect(m.captureMessage).toHaveBeenCalledTimes(1);

      // Within the window: throttled, no second capture.
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect((await post(body)).status).toBe(503);
      expect(m.captureMessage).toHaveBeenCalledTimes(1);

      // Past the window: re-armed, captures again.
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect((await post(body)).status).toBe(503);
      expect(m.captureMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never logs tenant or resource ids', async () => {
    const info = vi.spyOn(console, 'info');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    await post(payload([event()]));
    m.route.mockRejectedValueOnce(new Error('db down'));
    await post(payload([event()]));
    const logged = JSON.stringify([info.mock.calls, warn.mock.calls, error.mock.calls]);
    expect(info).toHaveBeenCalled(); // the summary line ran, so the negative checks below are not vacuous
    expect(logged).not.toContain(T1);
    expect(logged).not.toContain('"abc"');
  });
});
