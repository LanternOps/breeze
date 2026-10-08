import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EdrProviderRequestError, type EdrAdapterContext, type GuardedFetch } from '../types';
import { bitdefenderAdapter as adapter } from './adapter';

const fx = (n: string) => readFileSync(join(__dirname, '__fixtures__', n), 'utf8');
const C1 = '5f0a1b2c3d4e5f60718293a1';
const C2 = '5f0a1b2c3d4e5f60718293a2';
const SP = '5f0a1b2c3d4e5f60718293a9';
const P0 = '5f0a1b2c3d4e5f60718293a0';
const NOW = new Date('2026-10-08T12:00:00.000Z');

type Reply = { status?: number; body: string; headers?: Record<string, string> };
type Route = Reply | Reply[] | ((params: any) => Reply);

/** Routes by `service.method`; arrays are consumed in order (last one repeats). */
function makeCtx(routes: Record<string, Route>, over: Partial<EdrAdapterContext> = {}) {
  const calls: Array<{ key: string; params: any }> = [];
  const counters: Record<string, number> = {};
  const fetch: GuardedFetch = vi.fn(async (url, init) => {
    const service = url.split('/jsonrpc/')[1];
    const body = JSON.parse(init.body!);
    const key = `${service}.${body.method}`;
    calls.push({ key, params: body.params });
    const route = routes[key];
    if (!route) throw new Error(`unrouted ${key}`);
    const i = (counters[key] = (counters[key] ?? -1) + 1);
    const r = typeof route === 'function' ? route(body.params) : Array.isArray(route) ? route[Math.min(i, route.length - 1)]! : route;
    return { status: r.status ?? 200, headers: new Headers(r.headers ?? {}), text: async () => r.body };
  });
  const ctx: EdrAdapterContext = {
    creds: { apiKey: 'SECRETKEY0123456789abcdef' },
    baseUrl: 'https://cloud.gravityzone.bitdefender.com/api',
    region: null,
    fetch,
    limiter: { acquire: async () => {} },
    runCache: new Map(),
    ...over,
  };
  const count = (key: string) => calls.filter((c) => c.key === key).length;
  return { ctx, calls, count };
}

const ok = (name: string): Reply => ({ body: fx(name) });
const rpc = (result: unknown): Reply => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });

describe('bitdefender adapter metadata', () => {
  it('pins budgets and capabilities', () => {
    expect(adapter.capabilities.operationBudgets?.incidents).toEqual({ perMinute: 2 });
    expect(adapter.capabilities.detectionStatusModel).toBe('delta_with_updates');
    expect(adapter.hostAllowlist).toEqual(['.gravityzone.bitdefender.com']);
    expect(adapter.credentialsSchema.safeParse({ apiKey: 'short' }).success).toBe(false);
  });
});

describe('testConnection', () => {
  it('uses getApiKeyDetails: notes quarantine as not enabled, counts tenants for a partner, no incident/quarantine probes', async () => {
    const { ctx, count } = makeCtx({
      'general.getApiKeyDetails': ok('api-key-details.json'),
      'companies.getCompanyDetails': ok('company-details-partner.json'),
      'network.getCompaniesList': (p) => (p.filters.companyType === 1 && p.parentId === P0 ? ok('companies-list-root.json') : rpc([])),
    });
    const r = await adapter.testConnection(ctx);
    expect(r).toEqual({
      ok: true, rootId: P0, rootName: 'Example Partner', rootType: 'partner', tenantCount: 2,
      capabilityNotes: ['quarantine: API not enabled on key'],
    });
    expect(count('incidents.getIncidentsList')).toBe(0);
    expect(count('quarantine/computers.getQuarantineItemsList')).toBe(0);
  });

  it('customer key -> rootType company, tenantCount 1', async () => {
    const { ctx } = makeCtx({
      'general.getApiKeyDetails': ok('api-key-details.json'),
      'companies.getCompanyDetails': ok('company-details-customer.json'),
    });
    expect(await adapter.testConnection(ctx)).toMatchObject({ ok: true, rootType: 'company', tenantCount: 1 });
  });

  it('missing network or companies in enabledApis -> ok:false reauth:true with the exact message', async () => {
    const { ctx } = makeCtx({
      'general.getApiKeyDetails': rpc({ enabledApis: ['companies', 'incidents'] }),
    });
    expect(await adapter.testConnection(ctx)).toEqual({
      ok: false, reauth: true, error: 'The API key must have the Network and Companies APIs enabled',
    });
  });

  it('HTTP 401 -> ok:false reauth:true', async () => {
    const { ctx } = makeCtx({ 'general.getApiKeyDetails': { status: 401, body: '{}' } });
    expect(await adapter.testConnection(ctx)).toMatchObject({ ok: false, reauth: true });
  });

  it('general API denied -> falls back to probing incidents and quarantine, turning api_not_enabled into notes', async () => {
    const { ctx, count } = makeCtx({
      'general.getApiKeyDetails': { status: 403, body: fx('error-api-not-enabled-quarantine-403.json') },
      'companies.getCompanyDetails': ok('company-details-customer.json'),
      'incidents.getIncidentsList': ok('error-api-not-enabled-incidents.json'),
      'quarantine/computers.getQuarantineItemsList': { status: 403, body: fx('error-api-not-enabled-quarantine-403.json') },
    });
    const r = await adapter.testConnection(ctx);
    expect(r).toMatchObject({ ok: true, rootType: 'company' });
    expect((r as any).capabilityNotes).toEqual(['incidents: API not enabled on key', 'quarantine: API not enabled on key']);
    expect(count('incidents.getIncidentsList')).toBe(1);
  });
});

describe('listTenants', () => {
  it('partner key: walks sub-partners and returns only customer companies as tenants', async () => {
    const { ctx } = makeCtx({
      'network.getCompaniesList': (p) => {
        if (p.parentId === P0) return p.filters.companyType === 1 ? ok('companies-list-root.json') : ok('companies-list-subpartner.json');
        if (p.parentId === SP) return p.filters.companyType === 1 ? rpc([{ id: '5f0a1b2c3d4e5f60718293b1', name: 'Nested Customer' }]) : rpc([]);
        throw new Error('unexpected parent');
      },
    });
    const t = await adapter.listTenants(ctx, { id: P0, type: 'partner' });
    expect(t.map((x) => x.vendorTenantId)).toEqual([C1, C2, '5f0a1b2c3d4e5f60718293b1']);
    expect(t.every((x) => x.tenantType === 'company' && x.apiHost === null && x.externalCode === null)).toBe(true);
    expect(t[2]!.parentId).toBe(SP);
    expect(t.map((x) => x.vendorTenantId)).not.toContain(SP);
  });

  it('customer key: returns exactly one tenant, the root company', async () => {
    const { ctx, count } = makeCtx({ 'companies.getCompanyDetails': ok('company-details-customer.json') });
    const t = await adapter.listTenants(ctx, { id: C1, type: 'company' });
    expect(t).toEqual([{ vendorTenantId: C1, name: 'Example Customer One', parentId: null, tenantType: 'company', externalCode: null, apiHost: null }]);
    expect(count('network.getCompaniesList')).toBe(0);
  });

  it('refuses to truncate a sub-partner chain deeper than 5 levels', async () => {
    const { ctx } = makeCtx({
      'network.getCompaniesList': (p) => (p.filters.companyType === 1 ? rpc([]) : rpc([{ id: `${p.parentId}x`, name: 'deeper' }])),
    });
    await expect(adapter.listTenants(ctx, { id: P0, type: 'partner' })).rejects.toMatchObject({ code: 'too_deep' });
  });

  it('a failing company list call throws rather than returning a partial tree', async () => {
    const { ctx } = makeCtx({ 'network.getCompaniesList': { status: 500, body: 'x' } });
    await expect(adapter.listTenants(ctx, { id: P0, type: 'partner' })).rejects.toBeInstanceOf(EdrProviderRequestError);
  });
});

describe('listEndpoints / countEndpoints / enrichEndpoints', () => {
  it('drops unmanaged inventory items and maps the rest', async () => {
    const { ctx } = makeCtx({ 'network.getNetworkInventoryItems': [ok('inventory-page1.json'), ok('inventory-page2.json')] });
    const eps = await adapter.listEndpoints(ctx, { vendorTenantId: C1, apiHost: null });
    expect(eps.map((e) => e.vendorEndpointId)).toEqual(['6a0000000000000000000a01', '6a0000000000000000000a02']);
    expect(eps[0]).toMatchObject({ hostname: 'WS-ALPHA', macAddresses: ['aa:bb:cc:00:11:22'], isolationState: 'isolated', health: 'degraded' });
  });

  it('countEndpoints returns the inventory total from a perPage:1 call', async () => {
    const { ctx, calls } = makeCtx({ 'network.getNetworkInventoryItems': ok('inventory-page1.json') });
    expect(await adapter.countEndpoints!(ctx, { vendorTenantId: C1, apiHost: null })).toBe(3);
    expect(calls[0]!.params.perPage).toBe(1);
  });

  it('enrichment: infected -> unhealthy; a per-id invalid_params/not_found skips that id without throwing', async () => {
    const infected = JSON.parse(fx('endpoint-details.json'));
    infected.result.malwareStatus.infected = true;
    const { ctx } = makeCtx({
      'network.getManagedEndpointDetails': (p) =>
        p.endpointId === 'bad' ? ok('error-invalid-params-32602.json') : { body: JSON.stringify(infected) },
    });
    const out = await adapter.enrichEndpoints!(ctx, { vendorTenantId: C1, apiHost: null }, ['a', 'bad', 'c']);
    expect(out.map((d) => [d.vendorEndpointId, d.health])).toEqual([['a', 'unhealthy'], ['c', 'unhealthy']]);
  });

  it('enrichment: a connection-scope failure (401) throws', async () => {
    const { ctx } = makeCtx({ 'network.getManagedEndpointDetails': { status: 401, body: '{}' } });
    await expect(adapter.enrichEndpoints!(ctx, { vendorTenantId: C1, apiHost: null }, ['a'])).rejects.toMatchObject({ reauth: true });
  });
});

describe('listDetections', () => {
  const tenant = (id: string) => ({ vendorTenantId: id, apiHost: null });
  const routes = (): Record<string, Route> => ({
    'incidents.getIncidentsList': ok('incidents-page.json'),
    'quarantine/computers.getQuarantineItemsList': ok('quarantine-page.json'),
  });

  it('returns this tenant\'s incidents + quarantine only; cursor holds the run window END for both sources', async () => {
    const { ctx } = makeCtx(routes());
    const page = await adapter.listDetections(ctx, tenant(C1), null, NOW);
    expect(page.detections.map((d) => d.vendorDetectionId).sort()).toEqual([
      '6b0000000000000000000001', '6b0000000000000000000003', '6c0000000000000000000001',
    ]);
    expect(page.warnings).toEqual([]);
    expect(JSON.parse(page.cursor!)).toEqual({ v: 1, incidentsChangedAfter: NOW.toISOString(), quarantineAfter: NOW.toISOString() });
  });

  it('incidents fetched ONCE per run across tenants (runCache), quarantine too, no companyId filter', async () => {
    const { ctx, count, calls } = makeCtx(routes());
    const a = await adapter.listDetections(ctx, tenant(C1), null, NOW);
    const b = await adapter.listDetections(ctx, tenant(C2), null, NOW);
    expect(count('incidents.getIncidentsList')).toBe(1);
    expect(count('quarantine/computers.getQuarantineItemsList')).toBe(1);
    expect(calls.find((c) => c.key === 'incidents.getIncidentsList')!.params.filters).not.toHaveProperty('companyId');
    expect(a.detections.length).toBe(3);
    expect(b.detections.map((d) => d.vendorDetectionId).sort()).toEqual(['6b0000000000000000000002', '6c0000000000000000000002']);
  });

  it('concurrent tenants share the same in-flight fetch', async () => {
    const { ctx, count } = makeCtx(routes());
    await Promise.all([adapter.listDetections(ctx, tenant(C1), null, NOW), adapter.listDetections(ctx, tenant(C2), null, NOW)]);
    expect(count('incidents.getIncidentsList')).toBe(1);
  });

  it('first sync without cursor uses the 30-day lookback; a garbage cursor is treated as first sync', async () => {
    for (const cursor of [null, 'not json', '{"v":2}', '{"v":1,"incidentsChangedAfter":"nope"}']) {
      const { ctx, calls } = makeCtx(routes());
      await adapter.listDetections(ctx, tenant(C1), cursor, NOW);
      const f = calls.find((c) => c.key === 'incidents.getIncidentsList')!.params.filters;
      expect(f.changeStartDate).toBe(new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
      expect(f.changeEndDate).toBe(NOW.toISOString());
    }
  });

  it('cursor overlap: window starts 5 minutes before the cursor; boundary incident keeps the same vendorDetectionId', async () => {
    const cursor = JSON.stringify({ v: 1, incidentsChangedAfter: '2026-10-08T11:00:00.000Z', quarantineAfter: '2026-10-08T11:00:00.000Z' });
    const { ctx, calls } = makeCtx(routes());
    const p1 = await adapter.listDetections(ctx, tenant(C1), cursor, NOW);
    expect(calls.find((c) => c.key === 'incidents.getIncidentsList')!.params.filters.changeStartDate).toBe('2026-10-08T10:55:00.000Z');
    const { ctx: ctx2 } = makeCtx(routes());
    const p2 = await adapter.listDetections(ctx2, tenant(C1), p1.cursor, new Date(NOW.getTime() + 600_000));
    const ids = (p: typeof p1) => p.detections.map((d) => d.vendorDetectionId).sort();
    expect(ids(p2)).toEqual(ids(p1));
  });

  it('a cursor older than the lookback is clamped to the lookback', async () => {
    const cursor = JSON.stringify({ v: 1, incidentsChangedAfter: '2020-01-01T00:00:00.000Z' });
    const { ctx, calls } = makeCtx(routes());
    await adapter.listDetections(ctx, tenant(C1), cursor, NOW);
    expect(calls.find((c) => c.key === 'incidents.getIncidentsList')!.params.filters.changeStartDate)
      .toBe(new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
  });

  it('incidents API not enabled -> quarantine only + one warning, incidents cursor NOT advanced', async () => {
    const old = '2026-10-08T10:00:00.000Z';
    const { ctx } = makeCtx({ ...routes(), 'incidents.getIncidentsList': ok('error-api-not-enabled-incidents.json') });
    const page = await adapter.listDetections(ctx, tenant(C1), JSON.stringify({ v: 1, incidentsChangedAfter: old }), NOW);
    expect(page.detections.map((d) => d.vendorKind)).toEqual(['quarantine_item']);
    expect(page.warnings).toEqual(['incidents: API not enabled on key']);
    expect(JSON.parse(page.cursor!)).toEqual({ v: 1, incidentsChangedAfter: old, quarantineAfter: NOW.toISOString() });
  });

  it('licence error on incidents -> licence warning, cursor not advanced (absent stays absent)', async () => {
    const { ctx } = makeCtx({ ...routes(), 'incidents.getIncidentsList': ok('error-licence-32001.json') });
    const page = await adapter.listDetections(ctx, tenant(C1), null, NOW);
    expect(page.warnings).toEqual(['incidents: licence not available']);
    expect(JSON.parse(page.cursor!)).toEqual({ v: 1, quarantineAfter: NOW.toISOString() });
  });

  it('quarantine API not enabled (HTTP 403) -> warning, quarantine cursor not advanced, incidents still delivered', async () => {
    const { ctx } = makeCtx({
      ...routes(),
      'quarantine/computers.getQuarantineItemsList': { status: 403, body: fx('error-api-not-enabled-quarantine-403.json') },
    });
    const page = await adapter.listDetections(ctx, tenant(C1), null, NOW);
    expect(page.warnings).toEqual(['quarantine: API not enabled on key']);
    expect(page.detections.some((d) => d.vendorKind === 'incident')).toBe(true);
    expect(JSON.parse(page.cursor!)).toEqual({ v: 1, incidentsChangedAfter: NOW.toISOString() });
  });

  it('unknown incident status / severityScore -> unknown bucket, never throws', async () => {
    const { ctx } = makeCtx(routes());
    const page = await adapter.listDetections(ctx, tenant(C1), null, NOW);
    const weird = page.detections.find((d) => d.vendorDetectionId === '6b0000000000000000000003')!;
    expect(weird).toMatchObject({ status: 'unknown', severity: 'unknown' });
  });

  it('incident page 2 failure throws and returns no cursor', async () => {
    const withItem = rpc({ total: 2, page: 1, perPage: 1000, pagesCount: 2, items: [{ incidentId: 'z', company: { id: C1 } }] });
    const { ctx } = makeCtx({ ...routes(), 'incidents.getIncidentsList': [withItem, { status: 500, body: 'boom' }] });
    await expect(adapter.listDetections(ctx, tenant(C1), null, NOW)).rejects.toBeInstanceOf(EdrProviderRequestError);
  });

  it('two 429s -> rate_limited (connection scope) propagates; nothing advances', async () => {
    const { ctx } = makeCtx({
      ...routes(),
      'incidents.getIncidentsList': { status: 429, body: fx('error-429-nginx.html'), headers: { 'Retry-After': '60' } },
    });
    // The client's default sleep is a real timer; stub it out by racing with fake timers.
    vi.useFakeTimers();
    try {
      const p = adapter.listDetections(ctx, tenant(C1), null, NOW);
      const assertion = expect(p).rejects.toMatchObject({ code: 'rate_limited', scope: 'connection', reauth: false });
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
