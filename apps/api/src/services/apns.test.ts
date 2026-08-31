import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, decodeProtectedHeader } from 'jose';

// The real implementation reads config lazily via getConfig() from
// '../config/validate' (the config dir has no index barrel), so the mock
// targets that exact path — same pattern as stripeClient.test.ts.

// A fresh EC P-256 private key in PKCS#8 PEM, generated once at load time so
// the ES256 provider-JWT signing actually runs (no network, no real .p8).
const TEST_P8_PEM = crypto
  .generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const CONFIGURED = {
  APNS_AUTH_KEY: TEST_P8_PEM,
  APNS_KEY_ID: 'ABC123KEYID',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_BUNDLE_ID: 'app.breeze.mobile',
  APNS_ENVIRONMENT: 'production' as const,
};

function mockConfig(cfg: Record<string, unknown>) {
  vi.doMock('../config/validate', () => ({ getConfig: () => cfg }));
}

describe('apns — isApnsConfigured', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../config/validate');
  });

  it('is true when all four required credentials are present', async () => {
    mockConfig(CONFIGURED);
    const { isApnsConfigured } = await import('./apns');
    expect(isApnsConfigured()).toBe(true);
  });

  it('is false when unset entirely', async () => {
    mockConfig({});
    const { isApnsConfigured } = await import('./apns');
    expect(isApnsConfigured()).toBe(false);
  });

  it('is false when a required field is missing (partial config)', async () => {
    mockConfig({ ...CONFIGURED, APNS_AUTH_KEY: undefined });
    const { isApnsConfigured } = await import('./apns');
    expect(isApnsConfigured()).toBe(false);
  });
});

describe('apns — provider JWT', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../config/validate');
    vi.useRealTimers();
  });

  it('signs a token with the correct alg, kid and iss', async () => {
    mockConfig(CONFIGURED);
    const { getApnsProviderToken, __resetApnsProviderTokenCacheForTests } = await import('./apns');
    __resetApnsProviderTokenCacheForTests();

    const jwt = await getApnsProviderToken();

    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe(CONFIGURED.APNS_KEY_ID);

    const payload = decodeJwt(jwt);
    expect(payload.iss).toBe(CONFIGURED.APNS_TEAM_ID);
    expect(typeof payload.iat).toBe('number');
  });

  it('normalizes literal \\n escapes in the PEM before importing', async () => {
    // Simulate an env-file value where real newlines are stored as "\n".
    const escapedPem = TEST_P8_PEM.replace(/\n/g, '\\n');
    mockConfig({ ...CONFIGURED, APNS_AUTH_KEY: escapedPem });
    const { getApnsProviderToken, __resetApnsProviderTokenCacheForTests } = await import('./apns');
    __resetApnsProviderTokenCacheForTests();

    // If normalization were missing, importPKCS8 would throw here.
    const jwt = await getApnsProviderToken();
    expect(decodeProtectedHeader(jwt).alg).toBe('ES256');
  });

  it('reuses the cached token within the refresh window, then refreshes after ~40m', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));

    mockConfig(CONFIGURED);
    const { getApnsProviderToken, __resetApnsProviderTokenCacheForTests } = await import('./apns');
    __resetApnsProviderTokenCacheForTests();

    const first = await getApnsProviderToken();
    const iat1 = decodeJwt(first).iat;

    // Still inside the window (39 minutes later): same cached token instance.
    vi.setSystemTime(new Date('2026-07-10T00:39:00Z'));
    const reused = await getApnsProviderToken();
    expect(reused).toBe(first);

    // Past the ~40m refresh threshold (41 minutes): a fresh token is minted.
    vi.setSystemTime(new Date('2026-07-10T00:41:00Z'));
    const refreshed = await getApnsProviderToken();
    expect(refreshed).not.toBe(first);
    expect(decodeJwt(refreshed).iat).toBeGreaterThan(iat1 as number);
  });
});

describe('apns — buildApnsRequest', () => {
  it('emits aps.thread-id and aps.category only when set', async () => {
    mockConfig(CONFIGURED);
    const { buildApnsRequest } = await import('./apns');
    const req = buildApnsRequest('tok', { title: 'T', body: 'B', threadId: 'ticket:t-1', category: 'BREEZE_TICKET' }, 'jwt');
    const body = JSON.parse(req.body);
    expect(body.aps['thread-id']).toBe('ticket:t-1');
    expect(body.aps.category).toBe('BREEZE_TICKET');
  });

  it('keeps the approval request byte-identical when threadId/category are absent', async () => {
    mockConfig(CONFIGURED);
    const { buildApnsRequest } = await import('./apns');
    const before = JSON.parse(buildApnsRequest('tok', { title: 'T', body: 'B', data: { type: 'approval' } }, 'jwt').body);
    expect(Object.keys(before.aps).sort()).toEqual(['alert', 'sound']);
  });

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../config/validate');
    vi.useRealTimers();
  });

  it('produces the correct path, pseudo-headers and aps payload shape', async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse('2026-07-10T12:00:00Z');
    vi.setSystemTime(new Date(nowMs));

    mockConfig(CONFIGURED);
    const { buildApnsRequest } = await import('./apns');

    const req = buildApnsRequest('devicetoken123', { title: 'Hello', body: 'World' }, 'JWT.SIG');

    expect(req.path).toBe('/3/device/devicetoken123');
    expect(req.headers[':method']).toBe('POST');
    expect(req.headers[':path']).toBe('/3/device/devicetoken123');
    expect(req.headers.authorization).toBe('bearer JWT.SIG');
    expect(req.headers['apns-topic']).toBe(CONFIGURED.APNS_BUNDLE_ID);
    expect(req.headers['apns-push-type']).toBe('alert');
    expect(req.headers['apns-priority']).toBe('10');
    // default ttl = 3600s
    expect(req.headers['apns-expiration']).toBe(String(Math.floor(nowMs / 1000) + 3600));
    // no collapse id by default
    expect(req.headers['apns-collapse-id']).toBeUndefined();

    expect(JSON.parse(req.body)).toEqual({
      aps: { alert: { title: 'Hello', body: 'World' }, sound: 'default' },
    });
  });

  it('honors collapseId, custom ttl and merges data at the top level', async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse('2026-07-10T12:00:00Z');
    vi.setSystemTime(new Date(nowMs));

    mockConfig(CONFIGURED);
    const { buildApnsRequest } = await import('./apns');

    const req = buildApnsRequest(
      'tok',
      { title: 'T', body: 'B', data: { type: 'approval', approvalId: 'a1' }, collapseId: 'grp-1', ttl: 60 },
      'JWT',
    );

    expect(req.headers['apns-collapse-id']).toBe('grp-1');
    expect(req.headers['apns-expiration']).toBe(String(Math.floor(nowMs / 1000) + 60));
    expect(JSON.parse(req.body)).toEqual({
      aps: { alert: { title: 'T', body: 'B' }, sound: 'default' },
      type: 'approval',
      approvalId: 'a1',
    });
  });

  /**
   * REGRESSION (#4281 review, critical): APNs rejects an `apns-collapse-id`
   * longer than 64 BYTES with 400 `BadCollapseId`, and nothing on the path
   * bounded it. The wire layer is the last place that can guarantee the
   * contract regardless of what a caller builds.
   */
  it('clamps an over-long collapse id to 64 bytes, deterministically and injectively', async () => {
    mockConfig(CONFIGURED);
    const { buildApnsRequest } = await import('./apns');

    const long = `ticket:${'a'.repeat(80)}:sla_breached:resolution`;
    const got = buildApnsRequest('tok', { title: 'T', body: 'B', collapseId: long }, 'JWT')
      .headers['apns-collapse-id']!;

    expect(Buffer.byteLength(got, 'utf8')).toBeLessThanOrEqual(64);
    // Same input -> same header (coalescing still works across sends).
    expect(buildApnsRequest('tok', { title: 'T', body: 'B', collapseId: long }, 'JWT')
      .headers['apns-collapse-id']).toBe(got);
    // Different input -> different header (distinct notifications never merge).
    expect(buildApnsRequest('tok', { title: 'T', body: 'B', collapseId: `${long}x` }, 'JWT')
      .headers['apns-collapse-id']).not.toBe(got);
    // A value already inside the limit is passed through untouched.
    expect(buildApnsRequest('tok', { title: 'T', body: 'B', collapseId: 'grp-1' }, 'JWT')
      .headers['apns-collapse-id']).toBe('grp-1');
  });

  it('never lets a caller-supplied aps key in data clobber the notification payload', async () => {
    mockConfig(CONFIGURED);
    const { buildApnsRequest } = await import('./apns');

    const req = buildApnsRequest(
      'tok',
      { title: 'T', body: 'B', data: { aps: { alert: 'spoofed' }, type: 'approval' } },
      'JWT',
    );

    expect(JSON.parse(req.body)).toEqual({
      aps: { alert: { title: 'T', body: 'B' }, sound: 'default' },
      type: 'approval',
    });
  });

  it('emits apns-expiration 0 when ttl is 0 (deliver-now-or-discard)', async () => {
    mockConfig(CONFIGURED);
    const { buildApnsRequest } = await import('./apns');
    const req = buildApnsRequest('tok', { title: 'T', body: 'B', ttl: 0 }, 'JWT');
    expect(req.headers['apns-expiration']).toBe('0');
  });
});

describe('apns — sendApnsNotification (no network)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../config/validate');
  });

  it('returns not_configured without touching the network when unset', async () => {
    mockConfig({});
    const { sendApnsNotification } = await import('./apns');
    const result = await sendApnsNotification('tok', { title: 'T', body: 'B' });
    expect(result).toEqual({ ok: false, status: 0, reason: 'not_configured' });
  });
});
