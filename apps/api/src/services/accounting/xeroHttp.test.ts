import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { slotMock, noteMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
  noteMock: vi.fn(async () => {}),
}));
// xeroHttp imports exactly these two from the limiter; the real module (Redis)
// is not needed to prove the slot boundary.
vi.mock('./accountingRateLimit', () => ({
  withProviderCallSlot: slotMock,
  noteDailyRemaining: noteMock,
}));

import {
  classifyXeroInvoiceKind, classifyXeroValidation, decodeXeroAuthEventId, deleteXeroConnection, formatXeroIfModifiedSince,
  listXeroConnections, parseXeroDate, requestXeroTokens, requireXeroBody, xeroApiError, xeroApiGet, xeroApiWrite, xeroArray,
  xeroIdempotencyKey, xeroQuery, xeroTokenError, XERO_CONNECTIONS_URL, XERO_REFRESH_TOKEN_LIFETIME_MS, XERO_SCOPES,
  XERO_TOKEN_URL,
} from './xeroHttp';
import { AccountingProviderError, DEFAULT_RATE_LIMIT_DELAY_MS } from './accountingProviderError';

const SPEC = {
  perConnection: { limit: 60, windowSeconds: 60 }, maxConcurrentPerConnection: 5,
  appWide: { limit: 10_000, windowSeconds: 60 }, dailyPerConnection: { limit: () => 1000 },
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const jwt = (claims: Record<string, unknown>) => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.signature`;
};

beforeEach(() => {
  process.env.XERO_CLIENT_ID = 'client-abc';
  process.env.XERO_CLIENT_SECRET = 'secret-xyz';
  process.env.XERO_REDIRECT_URI = 'https://breeze.example.com/api/v1/accounting/xero/callback';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  slotMock.mockClear();
  noteMock.mockClear();
  delete process.env.XERO_CLIENT_ID;
  delete process.env.XERO_CLIENT_SECRET;
  delete process.env.XERO_REDIRECT_URI;
});

describe('XERO_SCOPES (open verification item 3)', () => {
  it('is exactly the granular set, never the deprecated broad transactions scope', () => {
    expect(XERO_SCOPES.join(' ')).toBe('offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings');
    expect(XERO_SCOPES).not.toContain('accounting.transactions');
    // Lab X16 (2026-09-28): Xero refuses an Item create with 401
    // insufficient_scope under accounting.settings.read; Items are written
    // under accounting.settings, which also covers the settings reads.
    expect(XERO_SCOPES).not.toContain('accounting.settings.read');
  });
});

describe('requestXeroTokens', () => {
  it('exchanges a code with HTTP Basic client auth and stamps a sliding 60-day refresh expiry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 1800, token_type: 'Bearer' }));
    const tokens = await requestXeroTokens({ grantType: 'authorization_code', code: 'the-code' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(XERO_TOKEN_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('client-abc:secret-xyz').toString('base64')}`);
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code', code: 'the-code',
      redirect_uri: 'https://breeze.example.com/api/v1/accounting/xero/callback',
    });
    expect(tokens).toEqual({
      realmId: '', accessToken: 'at1', refreshToken: 'rt1',
      accessTokenExpiresAt: new Date('2026-10-01T00:30:00Z'),
      refreshTokenExpiresAt: new Date(Date.parse('2026-10-01T00:00:00Z') + XERO_REFRESH_TOKEN_LIFETIME_MS),
    });
    expect(XERO_REFRESH_TOKEN_LIFETIME_MS).toBe(60 * 24 * 60 * 60 * 1000);
    expect(slotMock).not.toHaveBeenCalled(); // token endpoint is outside the call slot (C4)
  });

  it('refresh sends the refresh grant (no redirect_uri) and re-stamps the sliding expiry from NOW', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 1800 }));
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
    const tokens = await requestXeroTokens({ grantType: 'refresh_token', refreshToken: 'rt1' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt1' });
    expect(tokens.refreshTokenExpiresAt.getTime()).toBe(Date.parse('2026-11-15T12:00:00Z') + XERO_REFRESH_TOKEN_LIFETIME_MS);
    expect(slotMock).not.toHaveBeenCalled();
  });

  it('invalid_grant is kind reauth and never echoes the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    const err = await requestXeroTokens({ grantType: 'refresh_token', refreshToken: 'rt-secret' }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err).toMatchObject({ kind: 'reauth', provider: 'xero', providerCode: 'invalid_grant', httpStatus: 400 });
    expect(String(err.message)).not.toContain('rt-secret');
  });

  it.each([
    [500, {}, 'transient'],
    [429, { 'retry-after': '30' }, 'rate_limited'],
    [400, {}, 'validation'],
  ])('HTTP %d → %s', async (status, headers, kind) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: status === 400 ? 'invalid_client' : 'x' }, status, headers as Record<string, string>));
    await expect(requestXeroTokens({ grantType: 'authorization_code', code: 'c' })).rejects.toMatchObject({ kind, provider: 'xero' });
  });

  it('a 429 carries Retry-After, defaulting to the shared 60 s when absent', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '30' }))
      .mockResolvedValueOnce(json({}, 429));
    await expect(requestXeroTokens({ grantType: 'refresh_token', refreshToken: 'r' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(requestXeroTokens({ grantType: 'refresh_token', refreshToken: 'r' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: DEFAULT_RATE_LIMIT_DELAY_MS });
  });

  it('a 200 missing refresh_token is a transient failure, not a half-stored grant', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ access_token: 'at', expires_in: 1800 }));
    await expect(requestXeroTokens({ grantType: 'authorization_code', code: 'c' })).rejects.toMatchObject({ kind: 'transient' });
  });

  it('a 200 that is not JSON is transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>oops</html>', { status: 200 }));
    await expect(requestXeroTokens({ grantType: 'authorization_code', code: 'c' })).rejects.toMatchObject({ kind: 'transient' });
  });

  it.each([
    ['XERO_CLIENT_ID', 'client id'],
    ['XERO_CLIENT_SECRET', 'client secret'],
  ])('an instance with %s unset refuses BEFORE any fetch — transient (misconfigured instance), never reauth', async (envVar) => {
    process.env[envVar] = '  ';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not reach the network'));
    const err = await requestXeroTokens({ grantType: 'refresh_token', refreshToken: 'rt' }).then(
      () => { throw new Error('expected a rejection'); },
      (e: AccountingProviderError) => e,
    );
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err).toMatchObject({ kind: 'transient', provider: 'xero', message: 'Xero OAuth is not configured on this instance' });
    expect(err.kind).not.toBe('reauth');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a fetch timeout is a Xero-attributed transient error with no URL or token in its message', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(timeout);
    const err = await requestXeroTokens({ grantType: 'refresh_token', refreshToken: 'rt-secret' }).then(
      () => { throw new Error('expected a rejection'); },
      (e: AccountingProviderError) => e,
    );
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err).toMatchObject({ kind: 'transient', provider: 'xero', operation: 'Xero token refresh' });
    expect(err.cause).toBe(timeout);
    expect(err.message).not.toMatch(/https?:|identity\.xero|rt-secret|Basic|client-abc|secret-xyz/);
  });
});

describe('xeroTokenError', () => {
  it('a 429 is rate_limited WHATEVER its body — even one naming invalid_grant (never reauth; W01c P5)', () => {
    const err = xeroTokenError('Xero token refresh', 429, new Headers({ 'retry-after': '12' }), JSON.stringify({ error: 'invalid_grant' }));
    expect(err).toMatchObject({ kind: 'rate_limited', provider: 'xero', httpStatus: 429, retryAfterMs: 12_000 });
    expect(err.kind).not.toBe('reauth');
  });

  it('only an explicit invalid_grant on a 4xx is reauth; a 5xx is transient even if its body says invalid_grant', () => {
    expect(xeroTokenError('op', 400, new Headers(), JSON.stringify({ error: 'invalid_grant' })).kind).toBe('reauth');
    expect(xeroTokenError('op', 503, new Headers(), '<html>upstream mentions invalid_grant</html>').kind).toBe('transient');
    expect(xeroTokenError('op', 502, new Headers(), JSON.stringify({ error: 'invalid_grant' })).kind).toBe('transient');
    expect(xeroTokenError('op', 400, new Headers(), 'invalid_grant').kind).toBe('validation'); // text mention, not the field
  });

  it('a 401 invalid_client (bad app credentials) is transient, not reauth', () => {
    expect(xeroTokenError('op', 401, new Headers(), JSON.stringify({ error: 'invalid_client' })).kind).toBe('transient');
  });
});

describe('xeroApiError', () => {
  it('a 429 is rate_limited with the X-Rate-Limit-Problem as providerCode', () => {
    const err = xeroApiError('op', 429, new Headers({ 'x-rate-limit-problem': 'day' }), '{}');
    expect(err).toMatchObject({ kind: 'rate_limited', providerCode: 'day', retryAfterMs: DEFAULT_RATE_LIMIT_DELAY_MS });
  });

  it.each([[401, 'transient'], [403, 'transient'], [500, 'transient']])('HTTP %d → %s', (status, kind) => {
    expect(xeroApiError('op', status, new Headers(), '{}').kind).toBe(kind);
  });
});

describe('decodeXeroAuthEventId (Review Focus 4)', () => {
  it('reads authentication_event_id from the access token', () => {
    expect(decodeXeroAuthEventId(jwt({ authentication_event_id: 'd0ddcf81-f942-4f4d-b3c7-f98045204db4' })))
      .toBe('d0ddcf81-f942-4f4d-b3c7-f98045204db4');
  });
  it.each([
    ['claim missing', jwt({ sub: 'x' })],
    ['claim empty', jwt({ authentication_event_id: '' })],
    ['claim not a string', jwt({ authentication_event_id: 42 })],
    ['claim with odd characters', jwt({ authentication_event_id: 'a b;c' })],
    ['not a JWT', 'opaque-token'],
    ['garbage payload', 'a.!!!.c'],
  ])('%s → null (fail closed)', (_label, token) => {
    expect(decodeXeroAuthEventId(token)).toBeNull();
  });
});

describe('listXeroConnections', () => {
  const EVT = 'evt-00000001';
  const rows = [
    { id: 'conn-A', authEventId: EVT, tenantId: 'ten-A', tenantType: 'ORGANISATION', tenantName: 'Alpha Ltd' },
    { id: 'conn-B', authEventId: 'evt-OTHER-01', tenantId: 'ten-B', tenantType: 'ORGANISATION', tenantName: 'Other partner Ltd' },
    { id: 'conn-C', authEventId: EVT, tenantId: 'ten-C', tenantType: 'PRACTICEMANAGER', tenantName: 'Practice' },
    { id: 'conn-D', authEventId: null, tenantId: 'ten-D', tenantType: 'ORGANISATION', tenantName: 'No event' },
  ];

  it('filters by authEventId in the query AND client-side (never returns another auth event\'s links)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(rows));
    const out = await listXeroConnections('at', { authEventId: EVT });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${XERO_CONNECTIONS_URL}?authEventId=${EVT}`);
    expect(out).toEqual([
      { tenantId: 'ten-A', connectionRef: 'conn-A', name: 'Alpha Ltd', tenantType: 'ORGANISATION', authEventId: EVT },
      { tenantId: 'ten-C', connectionRef: 'conn-C', name: 'Practice', tenantType: 'PRACTICEMANAGER', authEventId: EVT },
    ]);
    expect(slotMock).not.toHaveBeenCalled(); // identity API is outside the call slot
  });

  it.each([
    ['empty string', ''],
    ['too short', 'evt-1'],
    ['odd characters', 'a b;c&all=1'],
    ['not a string', 42],
    ['null (a missing claim must never mean "unfiltered")', null],
  ])('an invalid authEventId (%s) fails closed as validation BEFORE any fetch', async (_label, bad) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not reach the network'));
    const err = await listXeroConnections('at', { authEventId: bad as string }).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err).toMatchObject({ kind: 'validation', provider: 'xero' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a filter naming neither mode fails closed before any fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not reach the network'));
    await expect(listXeroConnections('at', {} as never)).rejects.toMatchObject({ kind: 'validation', provider: 'xero' });
    await expect(listXeroConnections('at', { all: false } as never)).rejects.toMatchObject({ kind: 'validation', provider: 'xero' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('{ all: true } (reconnect lookup ONLY) sends no filter and returns every link', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(rows));
    expect(await listXeroConnections('at', { all: true })).toHaveLength(4);
    expect(fetchMock.mock.calls[0]![0]).toBe(XERO_CONNECTIONS_URL);
  });

  it('a non-2xx is a provider error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Title: 'Unauthorized' }, 401));
    await expect(listXeroConnections('at', { authEventId: EVT })).rejects.toMatchObject({ provider: 'xero', httpStatus: 401 });
  });

  it('a 429 is rate_limited', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 429, { 'retry-after': '5' }));
    await expect(listXeroConnections('at', { authEventId: EVT })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 5_000 });
  });

  it('a non-array body is transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ not: 'an array' }));
    await expect(listXeroConnections('at', { authEventId: EVT })).rejects.toMatchObject({ kind: 'transient' });
  });

  it('a network failure is a Xero-attributed transient error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(listXeroConnections('at', { authEventId: EVT }))
      .rejects.toMatchObject({ kind: 'transient', provider: 'xero', operation: 'Xero connections list' });
  });
});

describe('deleteXeroConnection', () => {
  it('DELETEs /connections/{id}; 204 and 404 both resolve', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await deleteXeroConnection('at', 'conn-A');
    await deleteXeroConnection('at', 'conn-gone');
    expect(fetchMock.mock.calls[0]![0]).toBe(`${XERO_CONNECTIONS_URL}/conn-A`);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
    expect(slotMock).not.toHaveBeenCalled();
  });
  it('a 500 throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(deleteXeroConnection('at', 'conn-A')).rejects.toMatchObject({ kind: 'transient' });
  });
  it('a network failure is a Xero-attributed transient error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(deleteXeroConnection('at', 'conn-A'))
      .rejects.toMatchObject({ kind: 'transient', provider: 'xero', operation: 'Xero connection delete' });
  });
});

describe('xeroApiGet', () => {
  const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };

  it('sends the tenant header, takes a call slot, and records X-DayLimit-Remaining', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Organisations: [] }, 200, { 'x-daylimit-remaining': '412' }));
    await expect(xeroApiGet(ctx, 'Organisation', 'Xero organisation read')).resolves.toEqual({ Organisations: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.xero.com/api.xro/2.0/Organisation');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer at', 'xero-tenant-id': 'ten-A', Accept: 'application/json' });
    expect(slotMock).toHaveBeenCalledWith('xero', SPEC, 'c1', expect.any(Function));
    expect(noteMock).toHaveBeenCalledWith('xero', 'c1', 412);
  });

  it('no X-DayLimit-Remaining header records nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}));
    await xeroApiGet(ctx, 'Organisation', 'op');
    expect(noteMock).not.toHaveBeenCalled();
  });

  it('a limiter refusal propagates UNCHANGED as rate_limited, and nothing is sent (W01c P5)', async () => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1234, throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not reach the network'));
    await expect(xeroApiGet(ctx, 'Accounts', 'Xero account list')).rejects.toBe(refusal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a fetch TimeoutError inside the slot is a Xero-attributed transient error (no URL, header or token in the message)', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(timeout);
    const err = await xeroApiGet(ctx, 'Organisation', 'Xero organisation read').then(
      () => { throw new Error('expected a rejection'); },
      (e: AccountingProviderError) => e,
    );
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err).toMatchObject({ kind: 'transient', provider: 'xero', operation: 'Xero organisation read' });
    expect(err.cause).toBe(timeout);
    expect(err.message).not.toMatch(/https?:|api\.xero|Bearer|ten-A|\bat\b/);
  });

  it('an AccountingProviderError raised inside the leaf is never re-wrapped', async () => {
    const inner = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'inner', retryAfterMs: 7 });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(inner);
    await expect(xeroApiGet(ctx, 'Organisation', 'op')).rejects.toBe(inner);
  });

  it('429 is rate_limited with Retry-After', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 429, { 'retry-after': '30', 'x-rate-limit-problem': 'minute' }));
    await expect(xeroApiGet(ctx, 'Accounts', 'Xero account list')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000, providerCode: 'minute' });
  });

  it('400 is validation with the first ValidationErrors message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ ValidationErrors: [{ Message: 'Account code is invalid' }] }] }, 400));
    await expect(xeroApiGet(ctx, 'Accounts', 'Xero account list')).rejects.toMatchObject({ kind: 'validation', providerMessage: 'Account code is invalid' });
  });

  it('404 is not_found; 503 is transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({}, 503));
    await expect(xeroApiGet(ctx, 'X', 'op')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(xeroApiGet(ctx, 'X', 'op')).rejects.toMatchObject({ kind: 'transient' });
  });

  it('a 200 that is not JSON is transient and does not leak the body into the message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>proxy error</html>', { status: 200 }));
    const err = await xeroApiGet(ctx, 'X', 'Xero organisation read').then(
      () => { throw new Error('expected a rejection'); },
      (e: AccountingProviderError) => e,
    );
    expect(err).toMatchObject({ kind: 'transient' });
    expect(err.message).not.toContain('proxy');
  });
});

describe('xeroQuery (Xero W03)', () => {
  it('encodes values and drops undefined', () => {
    expect(xeroQuery({ page: 2, pageSize: 1000, includeArchived: true, searchTerm: 'a b&c', skip: undefined }))
      .toBe('?page=2&pageSize=1000&includeArchived=true&searchTerm=a%20b%26c');
  });
  it('encodes a where clause with quotes and a colon', () => {
    expect(xeroQuery({ where: 'ContactNumber=="breeze:0f0e"' })).toBe('?where=ContactNumber%3D%3D%22breeze%3A0f0e%22');
  });
  it('returns an empty string for no params', () => {
    expect(xeroQuery({})).toBe('');
  });
});

describe('xeroIdempotencyKey (Xero W03)', () => {
  it('is deterministic and within Xero\'s 128-char limit', () => {
    const a = xeroIdempotencyKey('ten-A', 'PUT', 'Contacts', '{"Contacts":[{"Name":"Acme"}]}');
    expect(a).toBe(xeroIdempotencyKey('ten-A', 'PUT', 'Contacts', '{"Contacts":[{"Name":"Acme"}]}'));
    expect(a).toMatch(/^breeze-[0-9a-f]{64}$/);
  });
  it.each<[string, string, string, string, string]>([
    ['tenant', 'ten-B', 'PUT', 'Contacts', '{}'],
    ['method', 'ten-A', 'POST', 'Contacts', '{}'],
    ['path', 'ten-A', 'PUT', 'Items', '{}'],
    ['body', 'ten-A', 'PUT', 'Contacts', '{"x":1}'],
  ])('changes when the %s changes', (_label, tenant, method, path, body) => {
    expect(xeroIdempotencyKey(tenant, method, path, body)).not.toBe(xeroIdempotencyKey('ten-A', 'PUT', 'Contacts', '{}'));
  });
});

describe('xeroApiWrite (Xero W03)', () => {
  const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };

  it('sends JSON through the slot with tenant, auth and a request-derived Idempotency-Key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [{ ContactID: 'x' }] }, 200, { 'x-daylimit-remaining': '900' }));
    const body = { Contacts: [{ Name: 'Acme' }] };
    await expect(xeroApiWrite(ctx, 'PUT', 'Contacts', body, 'Xero contact create')).resolves.toEqual({ Contacts: [{ ContactID: 'x' }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.xero.com/api.xro/2.0/Contacts');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify(body));
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer at', 'xero-tenant-id': 'ten-A', Accept: 'application/json', 'Content-Type': 'application/json',
      'Idempotency-Key': xeroIdempotencyKey('ten-A', 'PUT', 'Contacts', JSON.stringify(body)),
    });
    expect(slotMock).toHaveBeenCalledWith('xero', SPEC, 'c1', expect.any(Function));
    expect(noteMock).toHaveBeenCalledWith('xero', 'c1', 900);
  });

  it('identical requests carry identical keys (a replay inside 6 minutes is deduplicated by Xero)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Contacts: [] }));
    const body = { Contacts: [{ Name: 'Acme', ContactNumber: 'breeze:o1' }] };
    await xeroApiWrite(ctx, 'PUT', 'Contacts', body, 'op');
    await xeroApiWrite(ctx, 'PUT', 'Contacts', body, 'op');
    const keyOf = (i: number) => ((fetchMock.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>)['Idempotency-Key'];
    expect(keyOf(0)).toBe(keyOf(1));
  });

  it('a POST update carries no key, so an A → B → A edit inside 6 minutes is never replayed (quorum 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Contacts: [] }));
    await xeroApiWrite(ctx, 'POST', 'Contacts/xc-1', { Contacts: [{ ContactID: 'xc-1', Name: 'A' }] }, 'op');
    await xeroApiWrite(ctx, 'POST', 'Contacts/xc-1', { Contacts: [{ ContactID: 'xc-1', Name: 'A' }] }, 'op');
    for (const i of [0, 1]) {
      const headers = (fetchMock.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>;
      expect(headers).not.toHaveProperty('Idempotency-Key');
      expect(headers['Content-Type']).toBe('application/json');
    }
  });

  it('uses an explicit key when one is given', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}));
    await xeroApiWrite(ctx, 'POST', 'Items', {}, 'op', { idempotencyKey: 'breeze-explicit' });
    expect(((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>)['Idempotency-Key']).toBe('breeze-explicit');
  });

  it('translates a duplicate-name 400 to validation + duplicate_name, with the full message kept out of the thrown message', async () => {
    const longName = 'A'.repeat(240);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({
      ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred',
      Elements: [{ ValidationErrors: [{ Message: `The contact name ${longName} is already assigned to another contact. The contact name must be unique across all active contacts.` }] }],
    }, 400));
    const err = await xeroApiWrite(ctx, 'PUT', 'Contacts', {}, 'Xero contact create').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'validation', provider: 'xero', providerCode: 'duplicate_name', httpStatus: 400 });
    expect((err as Error).message).toBe('Xero contact create failed with 400');
  });

  it.each(['insufficent_scope', 'insufficient_scope'])('classifies a 401/403 whose WWW-Authenticate names %s as validation + insufficient_scope', async (spelling) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 401, headers: { 'www-authenticate': `Bearer error="${spelling}"` } }))
      .mockResolvedValueOnce(new Response('', { status: 403, headers: { 'www-authenticate': `Bearer error="${spelling}"` } }));
    await expect(xeroApiWrite(ctx, 'PUT', 'Items', {}, 'Xero item create')).rejects.toMatchObject({ kind: 'validation', providerCode: 'insufficient_scope', httpStatus: 401 });
    await expect(xeroApiWrite(ctx, 'PUT', 'Items', {}, 'Xero item create')).rejects.toMatchObject({ kind: 'validation', providerCode: 'insufficient_scope', httpStatus: 403 });
  });

  it('keeps a bare 401 transient (link removed) — unchanged W02 behaviour', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(xeroApiWrite(ctx, 'PUT', 'Items', {}, 'op')).rejects.toMatchObject({ kind: 'transient', providerCode: undefined });
  });

  it('propagates a limiter refusal untouched', async () => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    await expect(xeroApiWrite(ctx, 'PUT', 'Contacts', {}, 'op')).rejects.toBe(refusal);
  });

  it('a timeout is a Xero-attributed transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('t', 'TimeoutError'));
    await expect(xeroApiWrite(ctx, 'PUT', 'Contacts', {}, 'Xero contact create')).rejects.toMatchObject({ kind: 'transient', message: 'Xero contact create timed out' });
  });

  it('xeroApiGet still sends no body, no Content-Type and no Idempotency-Key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Items: [] }));
    await xeroApiGet(ctx, 'Items?unitdp=4', 'op');
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('Idempotency-Key');
    expect(init.headers).not.toHaveProperty('Content-Type');
  });
});

describe('classifyXeroValidation (Xero W03)', () => {
  const body = (...messages: string[]) => JSON.stringify({ Elements: [{ ValidationErrors: messages.map((Message) => ({ Message })) }] });
  it.each([
    ['The contact name Acme is already assigned to another contact. The contact name must be unique across all active contacts.', 'duplicate_name'],
    ['The contact number breeze:o1 is already assigned to another contact. The contact number must be unique across all contacts.', 'duplicate_key'],
    ["Price List Item with Code 'abc' already exists", 'duplicate_key'],
    ["Item code 'abc' already exists", 'duplicate_key'],
    ['Account code is invalid', undefined],
  ] as const)('%s → %s', (message, expected) => {
    expect(classifyXeroValidation(body(message))).toBe(expected);
  });
  it('finds the verdict in any element, not only the first message', () => {
    expect(classifyXeroValidation(body('Email address must be valid.', 'The contact name Acme is already assigned to another contact.'))).toBe('duplicate_name');
  });
  it('returns undefined for a non-JSON or empty body', () => {
    expect(classifyXeroValidation('<html>')).toBeUndefined();
    expect(classifyXeroValidation('')).toBeUndefined();
  });
});

describe('parseXeroDate (Xero W03)', () => {
  it.each([
    ['/Date(1503348544227+0000)/', '2017-08-21T20:49:04.227Z'],
    ['/Date(1573755038314)/', '2019-11-14T18:10:38.314Z'],
    ['/Date(1503348544227-0800)/', '2017-08-21T20:49:04.227Z'],
    ['2026-09-27T10:00:00', '2026-09-27T10:00:00.000Z'],
  ])('%s → %s', (input, expected) => {
    expect(parseXeroDate(input)).toBe(expected);
  });
  it.each([[undefined], [null], [''], ['/Date(abc)/'], [42]])('returns null for %s', (input) => {
    expect(parseXeroDate(input)).toBeNull();
  });
});

describe('requireXeroBody / xeroArray (moved from xeroProvider, Xero W03)', () => {
  it('requireXeroBody passes an object through and refuses null as a Xero-attributed transient', () => {
    const body = { Items: [] };
    expect(requireXeroBody(body, 'op')).toBe(body);
    expect(() => requireXeroBody(null, 'Xero item list')).toThrow(expect.objectContaining({
      kind: 'transient', provider: 'xero', message: 'Xero item list returned an unexpected response',
    }));
  });
  it('xeroArray returns a real array as-is and anything else as empty', () => {
    const rows = [{ a: 1 }];
    expect(xeroArray(rows)).toBe(rows);
    expect(xeroArray(undefined)).toEqual([]);
    expect(xeroArray({ 0: 'x' })).toEqual([]);
  });
});

describe('classifyXeroInvoiceKind (Xero W04)', () => {
  const body = (...messages: string[]) => JSON.stringify({
    ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred',
    Elements: [{ ValidationErrors: messages.map((Message) => ({ Message })) }],
  });
  it.each([
    ['Invoice # must be unique.', 'duplicate_doc_number'],
    ['The status VOIDED cannot be applied to the invoice because it has payments or credit notes allocated to it.', 'payment_linked'],
    ['This document cannot be edited as it has a payment or credit note allocated to it.', 'payment_linked'],
    ['Idempotency Key: breeze-inv-abc is used with a different request.', 'transient'],
    ["Account code '999' is not a valid code for this document.", undefined],
  ] as const)('%s → %s', (message, expected) => {
    expect(classifyXeroInvoiceKind(body(message))).toBe(expected);
  });
  it('also reads a top-level Message (Xero may report key reuse outside Elements)', () => {
    expect(classifyXeroInvoiceKind(JSON.stringify({ Message: 'Idempotency Key: k is used with a different request.' }))).toBe('transient');
  });
  it('finds the verdict in any message', () => {
    expect(classifyXeroInvoiceKind(body('Email address must be valid.', 'Invoice # must be unique.'))).toBe('duplicate_doc_number');
  });
  it('is undefined for a non-JSON body', () => {
    expect(classifyXeroInvoiceKind('<html>')).toBeUndefined();
  });
});

describe('invoice refusals through the write helper (Xero W04)', () => {
  const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };
  const failing = (message: string) => json({ Elements: [{ ValidationErrors: [{ Message: message }] }] }, 400);

  it('a duplicate invoice number is kind duplicate_doc_number', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failing('Invoice # must be unique.'));
    await expect(xeroApiWrite(ctx, 'PUT', 'Invoices', {}, 'Xero invoice create'))
      .rejects.toMatchObject({ kind: 'duplicate_doc_number', httpStatus: 400, providerCode: undefined });
  });
  it('a void refused for an allocated payment is kind payment_linked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failing('The status VOIDED cannot be applied to the invoice because it has payments or credit notes allocated to it.'));
    await expect(xeroApiWrite(ctx, 'POST', 'Invoices/x', {}, 'Xero invoice void')).rejects.toMatchObject({ kind: 'payment_linked', httpStatus: 400 });
  });
  it('a reused key with a different body is an uncertain (transient) outcome, never a validation refusal (refinement 2)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failing('Idempotency Key: breeze-inv-abc is used with a different request.'));
    await expect(xeroApiWrite(ctx, 'PUT', 'Invoices', {}, 'Xero invoice create', { idempotencyKey: 'breeze-inv-abc' }))
      .rejects.toMatchObject({ kind: 'transient', httpStatus: 400 });
  });
  it('W03 classifications are unchanged (a duplicate contact name stays validation + duplicate_name)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failing('The contact name Acme is already assigned to another contact.'));
    await expect(xeroApiWrite(ctx, 'PUT', 'Contacts', {}, 'op')).rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_name' });
  });
});

describe('If-Modified-Since reads (Xero W05)', () => {
  const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };

  it('formats UTC to the second, no zone suffix (Xero: "yyyy-mm-ddThh:mm:ss")', () => {
    expect(formatXeroIfModifiedSince(new Date('2026-09-27T08:05:09.987Z'))).toBe('2026-09-27T08:05:09');
  });

  it('sends the header only when asked', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Payments: [] }));
    await xeroApiGet(ctx, 'Payments', 'op', { ifModifiedSince: new Date('2026-09-27T08:05:09Z') });
    await xeroApiGet(ctx, 'Payments', 'op');
    const headersOf = (i: number) => new Headers((fetchMock.mock.calls[i]![1] as RequestInit).headers);
    expect(headersOf(0).get('if-modified-since')).toBe('2026-09-27T08:05:09');
    expect(headersOf(1).get('if-modified-since')).toBeNull();
  });

  it('a 304 to a conditional read is "nothing changed" (null), never an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(xeroApiGet(ctx, 'Payments', 'op', { ifModifiedSince: new Date() })).resolves.toBeNull();
  });

  it('a 304 to an UNconditional read is still an error (transient)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(xeroApiGet(ctx, 'Payments', 'op')).rejects.toMatchObject({ kind: 'transient', httpStatus: 304 });
  });
});

describe('payment refusals (Xero W05 refinement 16)', () => {
  const body = (...messages: string[]) => JSON.stringify({
    ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred',
    Elements: [{ ValidationErrors: messages.map((Message) => ({ Message })) }],
  });
  it.each([
    ['Payment amount exceeds the amount outstanding on this document', 'amount_exceeds_due'],
    ['Payments can only be made against Authorised documents', 'remote_missing'],
    ['Payments can only be made against Authorized documents', 'remote_missing'],
    ['This payment has been reconciled and cannot be deleted', 'remote_locked'],
    // #7300: a payment inside a Xero batch payment. The first text is the one
    // integrators report (Bookeo's Xero-sync help); the rest are defensive
    // variants until lab X55/X56 records Xero's real words.
    ['Payments within a batch cannot be deleted.', 'remote_batched'],
    ['This payment is part of a batch payment and cannot be deleted', 'remote_batched'],
    ['Payment cannot be deleted because it belongs to a batch payment', 'remote_batched'],
    ['A batch payment cannot be removed from here', 'remote_batched'],
    ['Batched payments cannot be deleted individually', 'remote_batched'],
    // Batch AND reconciled: the batch is the more specific instruction.
    ['This payment is part of a batch payment that has been reconciled', 'remote_batched'],
    ['Batch payment reference is required', undefined], // mentions a batch, refuses nothing
    ['The contact name Acme is already assigned to another contact.', 'duplicate_name'], // W03 unchanged
    ['Account code 999 is not a valid code for this document.', undefined],
  ] as const)('%s → %s', (message, expected) => {
    expect(classifyXeroValidation(body(message))).toBe(expected);
  });

  it('a create refused for exceeding the amount due reaches the core as validation + amount_exceeds_due', async () => {
    const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(
      { Elements: [{ ValidationErrors: [{ Message: 'Payment amount exceeds the amount outstanding on this document' }] }] }, 400));
    await expect(xeroApiWrite(ctx, 'PUT', 'Payments', {}, 'Xero payment create', { idempotencyKey: 'k' }))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'amount_exceeds_due' });
  });
});

it('stamps a fee create only inside the acquired slot immediately before fetch',async()=>{
  const order:string[]=[];
  const stamp=vi.fn(async()=>{order.push('stamp');});
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{order.push('fetch');return json({});});
  const ctx={accessToken:'test',tenantId:'tenant',connectionId:'connection',rate:SPEC};
  slotMock.mockImplementationOnce(()=>{throw new AccountingProviderError({provider:'xero',kind:'rate_limited',operation:'slot'});});
  await expect(xeroApiWrite(ctx,'PUT','BankTransactions',{},'Xero fee create',{beforeCreate:stamp})).rejects.toMatchObject({kind:'rate_limited'});
  expect(stamp).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
  await xeroApiWrite(ctx,'PUT','BankTransactions',{},'Xero fee create',{beforeCreate:stamp});
  expect(order).toEqual(['stamp','fetch']);
});
