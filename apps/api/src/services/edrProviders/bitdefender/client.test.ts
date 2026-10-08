import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EdrProviderRequestError, type GuardedFetch } from '../types';
import { GravityZoneClient, GZ_HOST_ALLOWLIST, GZ_MAX_PAGES } from './client';

const API_KEY = 'SECRETKEY0123456789abcdef';
const ACCESS_URL = 'https://cloud.gravityzone.bitdefender.com/api';

const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

interface Stub { status?: number; body: string; headers?: Record<string, string> }

function makeFetch(responses: Stub[] | ((n: number, url: string, body: any) => Stub)) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const impl: GuardedFetch = vi.fn(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers, body });
    const n = calls.length - 1;
    const r = typeof responses === 'function' ? responses(n, url, body) : responses[Math.min(n, responses.length - 1)];
    return {
      status: r.status ?? 200,
      headers: new Headers(r.headers ?? {}),
      text: async () => r.body,
    };
  });
  return { impl, calls };
}

function makeClient(fetchImpl: GuardedFetch, extra: Partial<{ sleep: (ms: number) => Promise<void> }> = {}) {
  const limiter = { acquire: vi.fn(async () => {}) };
  const sleep = extra.sleep ?? vi.fn(async () => {});
  const client = new GravityZoneClient({
    accessUrl: ACCESS_URL, creds: { apiKey: API_KEY }, fetch: fetchImpl, limiter, sleep,
  });
  return { client, limiter, sleep: sleep as ReturnType<typeof vi.fn> };
}

async function rejection(p: Promise<unknown>): Promise<EdrProviderRequestError> {
  try { await p; } catch (e) { return e as EdrProviderRequestError; }
  throw new Error('expected rejection');
}

describe('GravityZoneClient transport', () => {
  it('exports the host allowlist and page cap', () => {
    expect(GZ_HOST_ALLOWLIST).toEqual(['.gravityzone.bitdefender.com']);
    expect(GZ_MAX_PAGES).toBe(200);
  });

  it('sends Basic base64("KEY:") and a JSON-RPC 2.0 envelope to {accessUrl}/v1.1/jsonrpc/network', async () => {
    const { impl, calls } = makeFetch([{ body: fx('inventory-page2.json') }]);
    const { client } = makeClient(impl);
    await client.call('network', '1.1', 'getNetworkInventoryItems', { page: 1 });
    expect(calls[0].url).toBe(`${ACCESS_URL}/v1.1/jsonrpc/network`);
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`);
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toMatchObject({ jsonrpc: '2.0', method: 'getNetworkInventoryItems', params: { page: 1 } });
    expect(typeof calls[0].body.id).toBe('string');
  });

  it('routes quarantine/computers on its nested service path', async () => {
    const { impl, calls } = makeFetch([{ body: fx('quarantine-page.json') }]);
    const { client } = makeClient(impl);
    await client.getQuarantineBetween(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
    expect(calls[0].url).toBe(`${ACCESS_URL}/v1.1/jsonrpc/quarantine/computers`);
    expect(calls[0].body.params.filters).toEqual({
      startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-08T00:00:00.000Z',
    });
  });
});

describe('GravityZoneClient pagination', () => {
  it('paginates inventory until hasMoreRecords is false and returns every item', async () => {
    const { impl, calls } = makeFetch([{ body: fx('inventory-page1.json') }, { body: fx('inventory-page2.json') }]);
    const { client, limiter } = makeClient(impl);
    const items = await client.getInventoryAll('5f0a1b2c3d4e5f60718293a1');
    expect(items.map((i) => i.id)).toEqual([
      '6a0000000000000000000a01', '6a0000000000000000000a02', '6a0000000000000000000a03',
    ]);
    expect(calls.map((c) => c.body.params.page)).toEqual([1, 2]);
    expect(calls[0].body.params).toMatchObject({
      parentId: '5f0a1b2c3d4e5f60718293a1', perPage: 1000,
      filters: { type: { computers: true, virtualMachines: true }, depth: { allItemsRecursively: true } },
    });
    expect(limiter.acquire).toHaveBeenCalledWith('inventory');
  });

  it('THROWS when page 2 of the inventory fails — never returns page 1 alone (Review Focus 1)', async () => {
    const { impl } = makeFetch([{ body: fx('inventory-page1.json') }, { status: 500, body: 'boom' }]);
    const { client } = makeClient(impl);
    const err = await rejection(client.getInventoryAll('c1'));
    expect(err).toBeInstanceOf(EdrProviderRequestError);
    expect(err.reauth).toBe(false);
  });

  it('stops at GZ_MAX_PAGES and throws instead of looping forever', async () => {
    const { impl, calls } = makeFetch(() => ({
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { page: 1, hasMoreRecords: true, pagesCount: 9999, total: 9, items: [{ id: 'x' }] } }),
    }));
    const { client } = makeClient(impl);
    const err = await rejection(client.getInventoryAll('c1'));
    expect(err.code).toBe('too_many_pages');
    expect(calls.length).toBe(GZ_MAX_PAGES);
  });

  it('paginates incidents by pagesCount (no hasMoreRecords), connection-wide, perPage 1000, class incidents', async () => {
    const page = (p: number) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { total: 2, page: p, perPage: 1000, pagesCount: 2, items: [{ incidentId: `i${p}` }] } });
    const { impl, calls } = makeFetch([{ body: page(1) }, { body: page(2) }]);
    const { client, limiter } = makeClient(impl);
    const from = new Date('2026-09-08T00:00:00Z');
    const to = new Date('2026-10-08T00:00:00Z');
    const items = await client.getIncidentsChangedBetween(from, to);
    expect(items.map((i) => i.incidentId)).toEqual(['i1', 'i2']);
    expect(calls[0].url).toBe(`${ACCESS_URL}/v1.2/jsonrpc/incidents`);
    expect(calls[0].body.params.filters).toEqual({
      changeStartDate: from.toISOString(), changeEndDate: to.toISOString(),
    });
    expect(calls[0].body.params.filters).not.toHaveProperty('companyId');
    expect(calls[0].body.params).toMatchObject({ perPage: 1000, options: { sortBy: 'lastIncidentChange' } });
    expect(limiter.acquire).toHaveBeenCalledWith('incidents');
  });

  it('stops incidents on an empty page even if pagesCount claims more', async () => {
    const empty = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { total: 0, page: 1, perPage: 1000, pagesCount: 5, items: [] } });
    const { impl, calls } = makeFetch([{ body: empty }]);
    const { client } = makeClient(impl);
    expect(await client.getIncidentsChangedBetween(new Date(0), new Date(1))).toEqual([]);
    expect(calls.length).toBe(1);
  });
});

describe('GravityZoneClient classification', () => {
  it('HTTP 401 -> reauth=true, scope=connection', async () => {
    const { impl } = makeFetch([{ status: 401, body: '{"error":"Unauthorized"}' }]);
    const err = await rejection(makeClient(impl).client.getEndpointDetails('e1'));
    expect(err).toMatchObject({ reauth: true, scope: 'connection', code: 'auth' });
  });

  it('JSON-RPC -32001 on the key itself (getOwnCompany) -> reauth=true, scope=connection', async () => {
    const { impl } = makeFetch([{ body: fx('error-auth-32001.json') }]);
    const err = await rejection(makeClient(impl).client.getOwnCompany());
    expect(err).toMatchObject({ reauth: true, scope: 'connection', code: 'auth' });
  });

  it('JSON-RPC -32001 on getApiKeyDetails -> reauth connection', async () => {
    const { impl } = makeFetch([{ body: fx('error-auth-32001.json') }]);
    const err = await rejection(makeClient(impl).client.getApiKeyDetails());
    expect(err).toMatchObject({ reauth: true, scope: 'connection' });
  });

  it('-32001 on a non-key call -> forbidden, scope=tenant, reauth=false', async () => {
    const { impl } = makeFetch([{ body: fx('error-auth-32001.json') }]);
    const err = await rejection(makeClient(impl).client.getEndpointDetails('e1'));
    expect(err).toMatchObject({ reauth: false, scope: 'tenant', code: 'forbidden' });
  });

  it('-32001 "not allowed to access the selected API: Incidents" -> api_not_enabled, operation, reauth=false', async () => {
    const { impl } = makeFetch([{ body: fx('error-api-not-enabled-incidents.json') }]);
    const err = await rejection(makeClient(impl).client.getIncidentsChangedBetween(new Date(0), new Date(1)));
    expect(err).toMatchObject({ reauth: false, scope: 'operation', code: 'api_not_enabled' });
  });

  it('HTTP 403 with -32000 "not allowed to access the selected API: Quarantine" -> api_not_enabled, operation', async () => {
    const { impl } = makeFetch([{ status: 403, body: fx('error-api-not-enabled-quarantine-403.json') }]);
    const err = await rejection(makeClient(impl).client.getQuarantineBetween(new Date(0), new Date(1)));
    expect(err).toMatchObject({ reauth: false, scope: 'operation', code: 'api_not_enabled' });
  });

  it('api-not-enabled text wins even on a getOwnCompany (key-identity) call', async () => {
    const { impl } = makeFetch([{ body: fx('error-api-not-enabled-incidents.json') }]);
    const err = await rejection(makeClient(impl).client.getOwnCompany());
    expect(err).toMatchObject({ code: 'api_not_enabled', reauth: false, scope: 'operation' });
  });

  it('-32001 licence restriction -> licence, operation, reauth=false', async () => {
    const { impl } = makeFetch([{ body: fx('error-licence-32001.json') }]);
    const err = await rejection(makeClient(impl).client.getIncidentsChangedBetween(new Date(0), new Date(1)));
    expect(err).toMatchObject({ reauth: false, scope: 'operation', code: 'licence' });
  });

  it('-32002 -> not_found, scope=tenant, reauth=false', async () => {
    const { impl } = makeFetch([{ body: fx('error-not-found-32002.json') }]);
    const err = await rejection(makeClient(impl).client.getInventoryAll('c1'));
    expect(err).toMatchObject({ reauth: false, scope: 'tenant', code: 'not_found' });
  });

  it('-32602 -> invalid_params, scope=tenant', async () => {
    const { impl } = makeFetch([{ body: fx('error-invalid-params-32602.json') }]);
    const err = await rejection(makeClient(impl).client.getEndpointDetails('nope'));
    expect(err).toMatchObject({ reauth: false, scope: 'tenant', code: 'invalid_params' });
  });

  it('non-JSON body on a 200 does not crash: retried, then malformed_response', async () => {
    const { impl, calls } = makeFetch([{ body: '<html>oops</html>' }]);
    const err = await rejection(makeClient(impl).client.getEndpointDetails('e1'));
    expect(err).toBeInstanceOf(EdrProviderRequestError);
    expect(err.reauth).toBe(false);
    expect(calls.length).toBe(3);
  });

  it('HTTP 5xx is retried up to 3 times with backoff, then throws reauth=false', async () => {
    const { impl, calls } = makeFetch([{ status: 503, body: 'down' }]);
    const { client, sleep } = makeClient(impl);
    const err = await rejection(client.getEndpointDetails('e1'));
    expect(calls.length).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({ reauth: false, code: 'upstream_error' });
  });

  it('a network error is retried then succeeds', async () => {
    let n = 0;
    const impl: GuardedFetch = vi.fn(async () => {
      if (n++ === 0) throw new Error('ECONNRESET');
      return { status: 200, headers: new Headers(), text: async () => fx('endpoint-details.json') };
    });
    const { client } = makeClient(impl);
    const d = await client.getEndpointDetails('e1');
    expect(d.agent?.productVersion).toBe('7.9.12.345');
    expect(n).toBe(2);
  });
});

describe('GravityZoneClient rate limiting (DESIGN: honour 429 once)', () => {
  it('HTTP 429 (nginx HTML) then success retries once after Retry-After', async () => {
    const { impl, calls } = makeFetch([
      { status: 429, body: fx('error-429-nginx.html'), headers: { 'Retry-After': '60' } },
      { body: fx('incidents-page.json') },
    ]);
    const { client, sleep } = makeClient(impl);
    const items = await client.getIncidentsChangedBetween(new Date(0), new Date(1));
    expect(items.length).toBe(3);
    expect(calls.length).toBe(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('JSON-RPC -32003 (HTTP 429, "60, 60" header) then success retries once', async () => {
    const { impl, calls } = makeFetch([
      { status: 429, body: fx('error-too-many-32003.json'), headers: { 'Retry-After': '60, 60' } },
      { body: fx('incidents-page.json') },
    ]);
    const { client, sleep } = makeClient(impl);
    await client.getIncidentsChangedBetween(new Date(0), new Date(1));
    expect(calls.length).toBe(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('two 429s -> rate_limited, scope connection, retryAfterMs, reauth=false', async () => {
    const { impl, calls } = makeFetch([
      { status: 429, body: fx('error-429-nginx.html'), headers: { 'Retry-After': '60' } },
    ]);
    const err = await rejection(makeClient(impl).client.getIncidentsChangedBetween(new Date(0), new Date(1)));
    expect(calls.length).toBe(2);
    expect(err).toMatchObject({ code: 'rate_limited', scope: 'connection', reauth: false, retryAfterMs: 60_000 });
  });

  it('a 200 -32003 body twice is also rate_limited', async () => {
    const { impl } = makeFetch([{ body: fx('error-too-many-32003.json') }]);
    const err = await rejection(makeClient(impl).client.getIncidentsChangedBetween(new Date(0), new Date(1)));
    expect(err).toMatchObject({ code: 'rate_limited', scope: 'connection', reauth: false });
  });

  it('Retry-After beyond 65 s is not slept on: fails immediately with retryAfterMs', async () => {
    const { impl, calls } = makeFetch([{ status: 429, body: '', headers: { 'Retry-After': '300' } }]);
    const { client, sleep } = makeClient(impl);
    const err = await rejection(client.getIncidentsChangedBetween(new Date(0), new Date(1)));
    expect(calls.length).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterMs: 300_000 });
  });
});

describe('GravityZoneClient operation classes and typed helpers', () => {
  it('acquires inventory for getNetworkInventoryItems, companies for getCompaniesList/getOwnCompany, default for details', async () => {
    const { impl } = makeFetch([
      { body: fx('inventory-page2.json') },
      { body: fx('companies-list-root.json') },
      { body: fx('company-details-partner.json') },
      { body: fx('endpoint-details.json') },
    ]);
    const { client, limiter } = makeClient(impl);
    await client.getInventoryAll('c1');
    await client.getCompaniesList('p1', 1);
    await client.getOwnCompany();
    await client.getEndpointDetails('e1');
    expect(limiter.acquire.mock.calls.map((c: unknown[]) => c[0])).toEqual(['inventory', 'companies', 'companies', 'default']);
  });

  it('getCompaniesList uses the network service with parentId + companyType filter', async () => {
    const { impl, calls } = makeFetch([{ body: fx('companies-list-root.json') }]);
    const list = await makeClient(impl).client.getCompaniesList('p1', 1);
    expect(calls[0].url).toBe(`${ACCESS_URL}/v1.0/jsonrpc/network`);
    expect(calls[0].body.method).toBe('getCompaniesList');
    expect(calls[0].body.params).toEqual({ parentId: 'p1', filters: { companyType: 1 } });
    expect(list.length).toBe(2);
  });

  it('getOwnCompany posts companies.getCompanyDetails with empty params', async () => {
    const { impl, calls } = makeFetch([{ body: fx('company-details-partner.json') }]);
    const c = await makeClient(impl).client.getOwnCompany();
    expect(calls[0].url).toBe(`${ACCESS_URL}/v1.0/jsonrpc/companies`);
    expect(calls[0].body).toMatchObject({ method: 'getCompanyDetails', params: {} });
    expect(c).toMatchObject({ name: 'Example Partner', type: 0 });
  });

  it('getApiKeyDetails posts general.getApiKeyDetails', async () => {
    const { impl, calls } = makeFetch([{ body: fx('api-key-details.json') }]);
    const d = await makeClient(impl).client.getApiKeyDetails();
    expect(calls[0].url).toBe(`${ACCESS_URL}/v1.0/jsonrpc/general`);
    expect(d.enabledApis).toContain('network');
  });

  it('getInventoryTotal asks for one item and returns total', async () => {
    const { impl, calls } = makeFetch([{ body: fx('inventory-page1.json') }]);
    expect(await makeClient(impl).client.getInventoryTotal('c1')).toBe(3);
    expect(calls[0].body.params.perPage).toBe(1);
  });
});

describe('GravityZoneClient secret hygiene', () => {
  it('never puts the API key into an error message, even if the vendor echoes it', async () => {
    const echo = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: `bad key ${API_KEY}`, data: { details: `key ${API_KEY} rejected` } } });
    for (const stub of [
      { status: 401, body: echo }, { body: echo }, { status: 500, body: echo },
    ]) {
      const { impl } = makeFetch([stub]);
      const err = await rejection(makeClient(impl).client.getOwnCompany());
      expect(err.message).not.toContain(API_KEY);
      expect(JSON.stringify(err)).not.toContain(API_KEY);
      expect(String(err.stack)).not.toContain(API_KEY);
    }
  });
});
