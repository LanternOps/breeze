import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EdrProviderRequestError, type GuardedFetch } from '../types';
import { EMSISOFT_HOST_ALLOWLIST, EMSI_MAX_PAGES, EMSI_PAGE_SIZE, EmsisoftClient } from './client';

const API_KEY = 'SECRETKEY0123456789abcdef';
const WS = '00000000-0000-4000-8000-0000000000b1';
const DV = '00000000-0000-4000-8000-0000000000d1';
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

interface Stub { status?: number; body: string; headers?: Record<string, string> }

function makeFetch(responses: Stub[] | ((n: number, url: string) => Stub)) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const impl: GuardedFetch = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const n = calls.length - 1;
    const r = typeof responses === 'function' ? responses(n, url) : responses[Math.min(n, responses.length - 1)]!;
    return { status: r.status ?? 200, headers: new Headers(r.headers ?? {}), text: async () => r.body };
  });
  return { impl, calls };
}

function makeClient(fetchImpl: GuardedFetch, extra: { onRateHeaders?: (h: Record<string, string>) => void } = {}) {
  const limiter = { acquire: vi.fn(async () => {}) };
  const sleep = vi.fn(async () => {});
  const client = new EmsisoftClient({ creds: { apiKey: API_KEY }, fetch: fetchImpl, limiter, sleep, ...extra });
  return { client, limiter, sleep };
}

async function rejection(p: Promise<unknown>): Promise<EdrProviderRequestError> {
  try { await p; } catch (e) { return e as EdrProviderRequestError; }
  throw new Error('expected rejection');
}

const page = (items: Array<{ guid: string }>, totalCount: number) => JSON.stringify({ data: items, totalCount });
const guid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

describe('EmsisoftClient transport', () => {
  it('exports the exact-host allowlist and the page size', () => {
    expect(EMSISOFT_HOST_ALLOWLIST).toEqual(['api.emsisoft.com']);
    expect(EMSI_PAGE_SIZE).toBe(100);
    expect(EMSI_MAX_PAGES).toEqual({ workspaces: 50, devices: 100, incidents: 20 });
  });

  it('sends the key ONLY in the Api-Key header, never in the URL, and acquires the limiter once per request', async () => {
    const { impl, calls } = makeFetch([{ body: fx('account-partner.json') }]);
    const { client, limiter } = makeClient(impl);
    await client.getAccount();
    expect(calls[0]!.url).toBe('https://api.emsisoft.com/v1/account');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['Api-Key']).toBe(API_KEY);
    expect(calls[0]!.headers.Accept).toBe('application/json');
    expect(calls[0]!.url).not.toContain(API_KEY);
    expect(limiter.acquire).toHaveBeenCalledTimes(1);
  });

  it('pages workspaces with Skip/Take=100, one acquire per page, deduped by guid', async () => {
    const { impl, calls } = makeFetch([{ body: fx('workspaces-page1.json') }, { body: fx('workspaces-page2.json') }]);
    const { client, limiter } = makeClient(impl);
    const all = await client.listWorkspacesAll();
    expect(all.map((w) => w.guid)).toEqual([guid(0xb1), guid(0xb2), guid(0xb3)]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://api.emsisoft.com/v1/workspaces?Skip=0&Take=100');
    expect(calls[1]!.url).toBe('https://api.emsisoft.com/v1/workspaces?Skip=2&Take=100');
    expect(limiter.acquire).toHaveBeenCalledTimes(2);
  });

  it('stops on an empty page even when totalCount overstates', async () => {
    const { impl, calls } = makeFetch([{ body: page([{ guid: DV }], 5) }, { body: page([], 5) }]);
    const { client } = makeClient(impl);
    expect(await client.listDevicesAll(WS)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('devices over the page cap -> too_many_devices (tenant scope) and no partial list', async () => {
    // Every page returns 100 fresh guids and claims more: the cap (100 pages) must stop it.
    const { impl, calls } = makeFetch((n) => ({
      body: page(Array.from({ length: 100 }, (_, i) => ({ guid: guid(n * 100 + i + 1) })), 1_000_000),
    }));
    const { client } = makeClient(impl);
    const err = await rejection(client.listDevicesAll(WS));
    expect(err).toMatchObject({ code: 'too_many_devices', scope: 'tenant', reauth: false });
    expect(calls).toHaveLength(EMSI_MAX_PAGES.devices);
  });

  it('workspaces over the cap -> too_many_workspaces (connection scope); incidents over the cap -> tenant scope', async () => {
    const big = (n: number) => ({ body: page(Array.from({ length: 100 }, (_, i) => ({ guid: guid(n * 100 + i + 1) })), 1_000_000) });
    const ws = await rejection(makeClient(makeFetch(big).impl).client.listWorkspacesAll());
    expect(ws).toMatchObject({ code: 'too_many_workspaces', scope: 'connection' });
    const inc = await rejection(makeClient(makeFetch(big).impl).client.listIncidentsAll(WS, new Date('2026-09-20T00:00:00Z'), new Date('2026-10-20T00:00:00Z')));
    expect(inc).toMatchObject({ code: 'too_many_incidents', scope: 'tenant' });
  });

  it('exactly the cap worth of pages is fine', async () => {
    const { impl } = makeFetch((n) => ({
      body: page(Array.from({ length: 100 }, (_, i) => ({ guid: guid(n * 100 + i + 1) })), EMSI_MAX_PAGES.workspaces * 100),
    }));
    const all = await makeClient(impl).client.listWorkspacesAll();
    expect(all).toHaveLength(EMSI_MAX_PAGES.workspaces * 100);
  });

  it('a page that is not { data: [], totalCount } -> malformed_response; an item without a guid too', async () => {
    for (const body of ['{"data":"x","totalCount":1}', '{"data":[]}', '[]', '{"data":[{"name":"no guid"}],"totalCount":1}']) {
      const err = await rejection(makeClient(makeFetch([{ body }]).impl).client.listDevicesAll(WS));
      expect(err).toMatchObject({ code: 'malformed_response', scope: 'tenant' });
    }
  });

  it('incidents: sends DateFrom/DateTo and parses items', async () => {
    const { impl, calls } = makeFetch([{ body: fx('incidents-page.json') }]);
    const out = await makeClient(impl).client.listIncidentsAll(WS, new Date('2026-09-20T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
    expect(out).toHaveLength(1);
    expect(out[0]!.involvedDevices).toEqual(['PC01', 'srv01.corp.example.test']);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v1/workspaces/${WS}/incidents`);
    expect(url.searchParams.get('DateFrom')).toBe('2026-09-20T00:00:00.000Z');
    expect(url.searchParams.get('DateTo')).toBe('2026-10-20T00:00:00.000Z');
    expect(url.searchParams.get('Take')).toBe('100');
  });

  it('probeWorkspaceDevices asks for exactly one device', async () => {
    const { impl, calls } = makeFetch([{ body: fx('devices-page1.json') }]);
    await makeClient(impl).client.probeWorkspaceDevices(WS);
    expect(new URL(calls[0]!.url).searchParams.get('Take')).toBe('1');
    expect(calls).toHaveLength(1);
  });

  it('device details parse (nullable and unknown fields tolerated)', async () => {
    const { impl, calls } = makeFetch([{ body: fx('device-details.json') }]);
    const d = await makeClient(impl).client.getDeviceDetails(DV);
    expect(calls[0]!.url).toBe(`https://api.emsisoft.com/v1/devices/${DV}/details`);
    expect(d.protectionStatus).toBe('Protected');
    expect(d.networkAdapters?.[0]?.iPv4Addresses).toContain('192.0.2.10');
  });

  it('a bad guid / bad incidentRef -> invalid_vendor_id with ZERO fetches', async () => {
    const { impl } = makeFetch([{ body: '{}' }]);
    const { client } = makeClient(impl);
    for (const run of [
      () => client.listDevicesAll('not-a-guid'),
      () => client.listDevicesAll(`${WS}/../x`),
      () => client.getDeviceDetails('../../etc'),
      () => client.listIncidentsAll('x y', new Date(), new Date()),
      () => client.getIncident(WS, 'a/b'),
      () => client.getIncident(WS, 'bad ref?x=1'),
      () => client.getIncident(WS, ''),
    ]) {
      expect(await rejection(run())).toMatchObject({ code: 'invalid_vendor_id', scope: 'operation' });
    }
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('EmsisoftClient error classification (path kind decides the scope)', () => {
  const run = (kind: 'account' | 'workspaces' | 'workspace' | 'device', status: number, opts: { accountOk?: boolean } = {}) => {
    const stubs: Stub[] = kind === 'workspaces' && opts.accountOk !== false
      ? [{ body: fx('account-partner.json') }, { status, body: '{}' }]
      : [{ status, body: '{}' }];
    const { impl } = makeFetch(stubs);
    const { client } = makeClient(impl);
    const call = async () => {
      if (kind === 'account') return client.getAccount();
      if (kind === 'workspaces') { if (opts.accountOk !== false) await client.getAccount(); return client.listWorkspacesAll(); }
      if (kind === 'workspace') return client.listDevicesAll(WS);
      return client.getDeviceDetails(DV);
    };
    return { err: rejection(call()), impl };
  };

  it.each([401, 403])('HTTP %s on /account -> auth, REAUTH, connection (the only proof of a dead key)', async (status) => {
    expect(await run('account', status).err).toMatchObject({ code: 'auth', reauth: true, scope: 'connection' });
  });

  it.each([401, 403])('HTTP %s on /workspaces after /account succeeded -> forbidden, NOT reauth, connection', async (status) => {
    expect(await run('workspaces', status).err).toMatchObject({ code: 'forbidden', reauth: false, scope: 'connection' });
  });

  it('a /workspaces 401 with no prior /account success probes /account once to tell a dead key from a missing permission', async () => {
    const { impl, calls } = makeFetch((n) => (n === 0 ? { status: 401, body: '{}' } : { body: fx('account-partner.json') }));
    const err = await rejection(makeClient(impl).client.listWorkspacesAll());
    expect(err).toMatchObject({ code: 'forbidden', reauth: false, scope: 'connection' });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/workspaces', '/v1/account']);
    // ...and a dead key is still reauth
    const dead = makeFetch([{ status: 401, body: '{}' }]);
    expect(await rejection(makeClient(dead.impl).client.listWorkspacesAll())).toMatchObject({ code: 'auth', reauth: true, scope: 'connection' });
  });

  it.each([401, 403])('HTTP %s on a workspace path -> forbidden, tenant, NOT reauth', async (status) => {
    expect(await run('workspace', status).err).toMatchObject({ code: 'forbidden', reauth: false, scope: 'tenant' });
  });

  it.each([401, 403])('HTTP %s on a device path -> forbidden, operation, NOT reauth', async (status) => {
    expect(await run('device', status).err).toMatchObject({ code: 'forbidden', reauth: false, scope: 'operation' });
  });

  it('404 per path kind', async () => {
    expect(await run('account', 404).err).toMatchObject({ code: 'not_found', scope: 'connection' });
    expect(await run('workspaces', 404).err).toMatchObject({ code: 'not_found', scope: 'connection' });
    expect(await run('workspace', 404).err).toMatchObject({ code: 'not_found', scope: 'tenant' });
    expect(await run('device', 404).err).toMatchObject({ code: 'not_found', scope: 'operation' });
  });

  it('400 -> invalid_params, operation, for every kind', async () => {
    for (const kind of ['account', 'workspaces', 'workspace', 'device'] as const) {
      expect(await run(kind, 400).err).toMatchObject({ code: 'invalid_params', scope: 'operation', reauth: false });
    }
  });

  it('5xx is retried x3 with backoff, then vendor_error scoped by kind', async () => {
    for (const [kind, scope] of [['account', 'connection'], ['workspaces', 'connection'], ['workspace', 'tenant'], ['device', 'operation']] as const) {
      const r = run(kind, 503);
      expect(await r.err).toMatchObject({ code: 'vendor_error', scope, reauth: false });
    }
    const { impl } = makeFetch([{ status: 503, body: '' }]);
    const { client, sleep } = makeClient(impl);
    await rejection(client.getAccount());
    expect(impl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('a transient 502 then success returns the data', async () => {
    const { impl } = makeFetch([{ status: 502, body: '' }, { body: fx('account-partner.json') }]);
    expect((await makeClient(impl).client.getAccount()).partners).toHaveLength(1);
  });

  it('a non-JSON 200 is retried, then vendor_error', async () => {
    const { impl } = makeFetch([{ body: '<html>maintenance</html>' }]);
    const err = await rejection(makeClient(impl).client.getAccount());
    expect(err).toMatchObject({ code: 'vendor_error', scope: 'connection' });
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('a network error is retried x3, then vendor_error (cause dropped)', async () => {
    const impl: GuardedFetch = vi.fn(async () => { throw new Error(`socket hang up ${API_KEY}`); });
    const err = await rejection(makeClient(impl).client.getAccount());
    expect(err).toMatchObject({ code: 'vendor_error', scope: 'connection' });
    expect(err.message).not.toContain(API_KEY);
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('a guardedFetch refusal (typed error) is rethrown untouched, not retried', async () => {
    const refusal = new EdrProviderRequestError('host_not_allowed', { code: 'host_not_allowed', reauth: false, scope: 'connection' });
    const impl: GuardedFetch = vi.fn(async () => { throw refusal; });
    expect(await rejection(makeClient(impl).client.getAccount())).toBe(refusal);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('429 with Retry-After: 2 sleeps ~2 s and retries; after x3 it throws rate_limited (connection) carrying retryAfterMs', async () => {
    const ok = makeFetch([{ status: 429, body: '', headers: { 'Retry-After': '2' } }, { body: fx('account-partner.json') }]);
    const a = makeClient(ok.impl);
    await a.client.getAccount();
    expect(a.sleep).toHaveBeenCalledWith(2000);

    const never = makeFetch([{ status: 429, body: '', headers: { 'Retry-After': '2' } }]);
    const b = makeClient(never.impl);
    const err = await rejection(b.client.getAccount());
    expect(err).toMatchObject({ code: 'rate_limited', scope: 'connection', retryAfterMs: 2000, reauth: false });
    expect(never.impl).toHaveBeenCalledTimes(3);
  });

  it('Retry-After as an HTTP date is honoured and capped at 120 s; a missing header falls back to a small default', async () => {
    const future = new Date(Date.now() + 3_600_000).toUTCString();
    const capped = makeFetch([{ status: 429, body: '', headers: { 'Retry-After': future } }]);
    const err = await rejection(makeClient(capped.impl).client.getAccount());
    expect(err.retryAfterMs).toBe(120_000);
    const none = makeFetch([{ status: 429, body: '' }]);
    const e2 = await rejection(makeClient(none.impl).client.getAccount());
    expect(e2.retryAfterMs).toBeGreaterThan(0);
    expect(e2.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  it('error messages carry method, status and the path TEMPLATE only: no key, guid, query or body', async () => {
    const { impl } = makeFetch([{ status: 500, body: `{"detail":"SECRET-SENTINEL ${API_KEY}"}` }]);
    const err = await rejection(makeClient(impl).client.listIncidentsAll(WS, new Date('2026-09-20T00:00:00Z'), new Date('2026-10-20T00:00:00Z')));
    expect(err.message).toBe('Emsisoft GET /v1/workspaces/{ws}/incidents: HTTP 500');
    for (const leak of [API_KEY, WS, 'SECRET-SENTINEL', 'DateFrom', 'Skip']) expect(err.message).not.toContain(leak);
    const dev = await rejection(makeClient(makeFetch([{ status: 401, body: '' }]).impl).client.getDeviceDetails(DV));
    expect(dev.message).toBe('Emsisoft GET /v1/devices/{dv}/details: HTTP 401');
  });
});

describe('EmsisoftClient.getIncident (the OpenAPI documents no 404 for incidents)', () => {
  it('200 -> detail, requested by the URL-encoded locator', async () => {
    const { impl, calls } = makeFetch([{ body: fx('incident-detail.json') }]);
    const d = await makeClient(impl).client.getIncident(WS, SHA1);
    expect(d?.verdict).toBe('ConfirmedBenign');
    expect(calls[0]!.url).toBe(`https://api.emsisoft.com/v1/workspaces/${WS}/incidents/${SHA1}`);
  });

  it('404 -> null', async () => {
    expect(await makeClient(makeFetch([{ status: 404, body: '' }]).impl).client.getIncident(WS, SHA1)).toBeNull();
  });

  it('400 IncidentNotFound / WorkspaceThreatIncorrectTarget -> null', async () => {
    for (const f of ['error-400-incident-not-found.json', 'error-400-incorrect-target.json']) {
      expect(await makeClient(makeFetch([{ status: 400, body: fx(f) }]).impl).client.getIncident(WS, SHA1)).toBeNull();
    }
  });

  it('any other 400 -> invalid_params (operation)', async () => {
    const err = await rejection(makeClient(makeFetch([{ status: 400, body: '{"code":"SomethingElse"}' }]).impl).client.getIncident(WS, SHA1));
    expect(err).toMatchObject({ code: 'invalid_params', scope: 'operation' });
  });

  it('401/403 on the workspace path -> forbidden, tenant', async () => {
    const err = await rejection(makeClient(makeFetch([{ status: 403, body: '' }]).impl).client.getIncident(WS, SHA1));
    expect(err).toMatchObject({ code: 'forbidden', scope: 'tenant', reauth: false });
  });
});

describe('EmsisoftClient observed rate-limit headers', () => {
  it('hands over only changed sets, and drops values that are not plain tokens', async () => {
    const seen: Array<Record<string, string>> = [];
    const { impl } = makeFetch([
      { body: fx('account-partner.json'), headers: { 'X-RateLimit-Remaining': '59', 'Content-Type': 'application/json' } },
      { body: fx('account-partner.json'), headers: { 'X-RateLimit-Remaining': '59' } },
      { body: fx('account-partner.json'), headers: { 'X-RateLimit-Remaining': '58' } },
      { body: fx('account-partner.json'), headers: { 'X-RateLimit-Limit': '<script>alert(1)</script>' } },
    ]);
    const { client } = makeClient(impl, { onRateHeaders: (h) => seen.push(h) });
    for (let i = 0; i < 4; i += 1) await client.getAccount();
    expect(seen).toEqual([{ 'x-ratelimit-remaining': '59' }, { 'x-ratelimit-remaining': '58' }, {}]);
  });

  it('a response with none hands over an empty set once (so the adapter can log "none")', async () => {
    const seen: Array<Record<string, string>> = [];
    const { impl } = makeFetch([{ body: fx('account-partner.json') }]);
    const { client } = makeClient(impl, { onRateHeaders: (h) => seen.push(h) });
    await client.getAccount();
    await client.getAccount();
    expect(seen).toEqual([{}]);
  });
});
