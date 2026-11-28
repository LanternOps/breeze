import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdrActionKey } from '@breeze/shared';
import {
  EdrProviderRequestError, type EdrActionRequest, type EdrActionSupport, type EdrActionTargetFacts,
  type EdrAdapterContext, type GuardedFetch,
} from '../types';
import { __testOnly, bitdefenderAdapter as adapter } from './adapter';

const fx = (n: string) => readFileSync(join(__dirname, '__fixtures__', n), 'utf8');
const C1 = '5f0a1b2c3d4e5f60718293a1';
const C2 = '5f0a1b2c3d4e5f60718293a2';
const SP = '5f0a1b2c3d4e5f60718293a9';
const P0 = '5f0a1b2c3d4e5f60718293a0';
const NOW = new Date('2026-10-08T12:00:00.000Z');

type Reply = { status?: number; body: string; headers?: Record<string, string> };
type Route = Reply | Reply[] | ((params: any) => Reply);

/**
 * Routes by `service.method`; arrays are consumed in order (last one repeats). The key owner's
 * account (timezone America/New_York, #12821) answers unless a test routes it otherwise.
 */
function makeCtx(ownRoutes: Record<string, Route>, over: Partial<EdrAdapterContext> = {}) {
  const routes: Record<string, Route> = { 'accounts.getAccountDetails': { body: fx('account-details.json') }, ...ownRoutes };
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

describe('push (W03 PR-B)', () => {
  it('declares poll_and_push and a 5/min push budget', () => {
    expect(adapter.capabilities.detectionDelivery).toBe('poll_and_push');
    expect(adapter.capabilities.operationBudgets?.push).toEqual({ perMinute: 5 });
    expect(typeof adapter.verifyWebhook).toBe('function');
  });

  const OURS = 'https://breeze.example.test/api/v1/webhooks/edr/x';
  const settings = (status: number, url: string | null) => rpc({ status, serviceType: 'jsonRPC', serviceSettings: url ? { url } : {} });

  it('registerPush enables vendor push with the url, secret and mapped companies (console had no push)', async () => {
    const { ctx, calls } = makeCtx({ 'push.getPushEventSettings': settings(0, null), 'push.setPushEventSettings': rpc(true) });
    await adapter.registerPush!(ctx, { url: OURS, secret: 'sek', vendorTenantIds: [C1, C2] });
    expect(calls.map((c) => c.key)).toEqual(['push.getPushEventSettings', 'push.setPushEventSettings']);
    expect(calls[1]!.params).toMatchObject({
      status: 1, serviceSettings: { url: OURS, authorization: 'sek' },
      subscribeToCompanies: [C1, C2],
    });
  });

  it('review: registerPush refuses to overwrite push that already goes elsewhere (e.g. a SIEM) unless told to replace it', async () => {
    const { ctx, count } = makeCtx({ 'push.getPushEventSettings': settings(1, 'https://siem.example.test/ingest'), 'push.setPushEventSettings': rpc(true) });
    await expect(adapter.registerPush!(ctx, { url: OURS, secret: 's', vendorTenantIds: [] }))
      .rejects.toMatchObject({ code: 'push_conflict' });
    expect(count('push.setPushEventSettings')).toBe(0);
    await adapter.registerPush!(ctx, { url: OURS, secret: 's', vendorTenantIds: [], replaceExisting: true });
    expect(count('push.setPushEventSettings')).toBe(1);
  });

  it('review: re-registering over our own URL is not a conflict', async () => {
    const { ctx, count } = makeCtx({ 'push.getPushEventSettings': settings(1, OURS), 'push.setPushEventSettings': rpc(true) });
    await adapter.registerPush!(ctx, { url: OURS, secret: 's', vendorTenantIds: [] });
    expect(count('push.setPushEventSettings')).toBe(1);
  });

  it('unregisterPush disables vendor push only while it still points at Breeze', async () => {
    const ours = makeCtx({ 'push.getPushEventSettings': settings(1, OURS), 'push.setPushEventSettings': rpc(true) });
    expect(await adapter.unregisterPush!(ours.ctx, { url: OURS })).toEqual({ changed: true });
    expect(ours.calls.at(-1)!.params).toEqual({ status: 0 });
    for (const [status, url] of [[1, 'https://siem.example.test/ingest'], [0, OURS], [1, null]] as const) {
      const other = makeCtx({ 'push.getPushEventSettings': settings(status, url), 'push.setPushEventSettings': rpc(true) });
      expect(await adapter.unregisterPush!(other.ctx, { url: OURS }), `${status} ${url}`).toEqual({ changed: false });
      expect(other.count('push.setPushEventSettings')).toBe(0);
    }
  });

  it('sendTestPush calls sendTestPushEvent', async () => {
    const { ctx, count } = makeCtx({ 'push.sendTestPushEvent': rpc(true) });
    await adapter.sendTestPush!(ctx);
    expect(count('push.sendTestPushEvent')).toBe(1);
  });

  it('a vendor refusal surfaces as a typed error', async () => {
    const { ctx } = makeCtx({ 'push.getPushEventSettings': settings(0, null), 'push.setPushEventSettings': ok('error-invalid-params-32602.json') });
    await expect(adapter.registerPush!(ctx, { url: 'https://x.example.test/h', secret: 's', vendorTenantIds: [] }))
      .rejects.toBeInstanceOf(EdrProviderRequestError);
  });
});

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
      ok: true, rootId: P0, rootName: 'Example Partner', rootType: 'partner', tenantCount: 3,
      capabilityNotes: ['quarantine: API not enabled on key', 'packages: API not enabled on key', 'accounts: API not enabled on key'],
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

  it('#12825: the quarantine probe calls v1.0; a method the vendor does not serve is noted, not a failure', async () => {
    const { ctx } = makeCtx({
      'general.getApiKeyDetails': { status: 403, body: fx('error-api-not-enabled-quarantine-403.json') },
      'companies.getCompanyDetails': ok('company-details-customer.json'),
      'incidents.getIncidentsList': ok('incidents-page.json'),
      'quarantine/computers.getQuarantineItemsList': ok('live-error-method-not-found-32601.json'),
    });
    const r = await adapter.testConnection(ctx);
    expect(r).toMatchObject({ ok: true, rootType: 'company' });
    expect((r as any).capabilityNotes).toEqual(['quarantine: method not served by the vendor']);
    const urls = (ctx.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((c) => c[0]);
    expect(urls.filter((u) => u.includes('/quarantine/'))).toEqual([`${ctx.baseUrl}/v1.0/jsonrpc/quarantine/computers`]);
  });
});

describe('listTenants', () => {
  it('partner key: walks sub-partners; customers AND partner companies (root, sub-partners) are tenants', async () => {
    // Live 2026-10-08: endpoints can be enrolled directly in a partner company (the MSP's own
    // machines). Those are only reachable if the partner company is itself a tenant.
    const { ctx } = makeCtx({
      'companies.getCompanyDetails': ok('company-details-partner.json'),
      'network.getCompaniesList': (p) => {
        if (p.parentId === P0) return p.filters.companyType === 1 ? ok('companies-list-root.json') : ok('companies-list-subpartner.json');
        if (p.parentId === SP) return p.filters.companyType === 1 ? rpc([{ id: '5f0a1b2c3d4e5f60718293b1', name: 'Nested Customer' }]) : rpc([]);
        throw new Error('unexpected parent');
      },
    });
    const t = await adapter.listTenants(ctx, { id: P0, type: 'partner' });
    expect(t.map((x) => [x.vendorTenantId, x.tenantType, x.parentId])).toEqual([
      [P0, 'partner', null],
      [C1, 'company', P0],
      [C2, 'company', P0],
      [SP, 'partner', P0],
      ['5f0a1b2c3d4e5f60718293b1', 'company', SP],
    ]);
    expect(t[0]!.name).toBe('Example Partner');
    expect(t.every((x) => x.apiHost === null && x.externalCode === null)).toBe(true);
  });

  it('customer key: returns exactly one tenant, the root company', async () => {
    const { ctx, count } = makeCtx({ 'companies.getCompanyDetails': ok('company-details-customer.json') });
    const t = await adapter.listTenants(ctx, { id: C1, type: 'company' });
    expect(t).toEqual([{ vendorTenantId: C1, name: 'Example Customer One', parentId: null, tenantType: 'company', externalCode: null, apiHost: null }]);
    expect(count('network.getCompaniesList')).toBe(0);
  });

  it('refuses to truncate a sub-partner chain deeper than 5 levels', async () => {
    const { ctx } = makeCtx({
      'companies.getCompanyDetails': ok('company-details-partner.json'),
      'network.getCompaniesList': (p) => (p.filters.companyType === 1 ? rpc([]) : rpc([{ id: `${p.parentId}x`, name: 'deeper' }])),
    });
    await expect(adapter.listTenants(ctx, { id: P0, type: 'partner' })).rejects.toMatchObject({ code: 'too_deep' });
  });

  it('a failing company list call throws rather than returning a partial tree', async () => {
    const { ctx } = makeCtx({
      'companies.getCompanyDetails': ok('company-details-partner.json'),
      'network.getCompaniesList': { status: 500, body: 'x' },
    }, { });
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

  it("keeps only the company's OWN items: a partner company's recursive inventory includes its customers' endpoints", async () => {
    // getNetworkInventoryItems(parentId, allItemsRecursively) on a partner company returns every
    // descendant company's endpoints too. Without the companyId filter, mapping the partner
    // company to one org would store other customers' endpoints in that org.
    const page = JSON.parse(fx('inventory-page2.json'));
    const managed = { ...page.result.items[0], details: { ...page.result.items[0].details, isManaged: true } };
    const foreign = { ...managed, id: '6a0000000000000000000f01', name: 'OTHER-CUSTOMER', companyId: C2 };
    page.result.items.push(foreign);
    page.result.total = 4;
    const { ctx } = makeCtx({ 'network.getNetworkInventoryItems': [ok('inventory-page1.json'), { body: JSON.stringify(page) }] });
    const eps = await adapter.listEndpoints(ctx, { vendorTenantId: C1, apiHost: null });
    expect(eps.map((e) => e.vendorEndpointId)).toEqual(['6a0000000000000000000a01', '6a0000000000000000000a02']);
  });

  it('H1: a managed item with no companyId throws malformed_response (tenant) instead of being dropped', async () => {
    const page = JSON.parse(fx('inventory-page2.json'));
    const managed = { ...page.result.items[0], details: { ...page.result.items[0].details, isManaged: true } };
    page.result.items.push({ ...managed, id: '6a0000000000000000000f02', companyId: undefined });
    page.result.total = 4;
    const { ctx } = makeCtx({ 'network.getNetworkInventoryItems': [ok('inventory-page1.json'), { body: JSON.stringify(page) }] });
    await expect(adapter.listEndpoints(ctx, { vendorTenantId: C1, apiHost: null }))
      .rejects.toMatchObject({ code: 'malformed_response', scope: 'tenant' });
  });

  it("countEndpoints counts the company's own managed endpoints (what a mapping would store)", async () => {
    const page = JSON.parse(fx('inventory-page2.json'));
    const managed = { ...page.result.items[0], details: { ...page.result.items[0].details, isManaged: true } };
    page.result.items.push({ ...managed, id: '6a0000000000000000000f01', companyId: C2 });
    const { ctx } = makeCtx({ 'network.getNetworkInventoryItems': [ok('inventory-page1.json'), { body: JSON.stringify(page) }] });
    expect(await adapter.countEndpoints!(ctx, { vendorTenantId: C1, apiHost: null })).toBe(2);
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

  it('M4: any other tenant/operation error stops enrichment, returns what was collected, warns the code only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, count } = makeCtx({
      'network.getManagedEndpointDetails': (p) =>
        p.endpointId === 'b' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Server error', data: { details: 'SECRET-BODY' } } }) } : ok('endpoint-details.json'),
    });
    const out = await adapter.enrichEndpoints!(ctx, { vendorTenantId: C1, apiHost: null }, ['a', 'b', 'c']);
    expect(out.map((d) => d.vendorEndpointId)).toEqual(['a']);
    expect(count('network.getManagedEndpointDetails')).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]!.join(' '));
    expect(msg).toContain('vendor_error');
    expect(msg).not.toContain('SECRET-BODY');
    warn.mockRestore();
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

  it('CR3: incidents with no company.id are counted and warned about once per memoized fetch (code only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inc = JSON.parse(fx('incidents-page.json'));
    inc.result.items.push({ ...inc.result.items[0], incidentId: 'nocompany1', company: undefined }, { ...inc.result.items[0], incidentId: 'nocompany2', company: {} });
    const { ctx } = makeCtx({ ...routes(), 'incidents.getIncidentsList': { body: JSON.stringify(inc) } });
    await adapter.listDetections(ctx, tenant(C1), null, NOW);
    await adapter.listDetections(ctx, tenant(C2), null, NOW);
    const calls = warn.mock.calls.map((c) => String(c.join(' '))).filter((m) => m.includes('company'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('2');
    warn.mockRestore();
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

  describe('a method the vendor does not serve (-32601, #12825)', () => {
    const notFound = (): Reply => ok('live-error-method-not-found-32601.json');

    it('quarantine: a degradation of that source, not a failed sync; incidents still delivered, quarantine cursor not advanced', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const old = '2026-10-08T10:00:00.000Z';
      const { ctx } = makeCtx({ ...routes(), 'quarantine/computers.getQuarantineItemsList': notFound() });
      const page = await adapter.listDetections(ctx, tenant(C1), JSON.stringify({ v: 1, quarantineAfter: old }), NOW);
      expect(page.detections.map((d) => d.vendorKind)).toEqual(['incident', 'incident']);
      expect(page.warnings).toEqual(['quarantine: method not served by the vendor']);
      expect(JSON.parse(page.cursor!)).toEqual({ v: 1, incidentsChangedAfter: NOW.toISOString(), quarantineAfter: old });
      // Logged, code only.
      expect(warn.mock.calls.map((c) => c.join(' '))).toContain('[edr:bitdefender] quarantine: vendor method not found (method_not_found); source skipped this run');
      warn.mockRestore();
    });

    it('incidents: the same degradation; quarantine still delivered', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ctx } = makeCtx({ ...routes(), 'incidents.getIncidentsList': notFound() });
      const page = await adapter.listDetections(ctx, tenant(C1), null, NOW);
      expect(page.detections.map((d) => d.vendorKind)).toEqual(['quarantine_item']);
      expect(page.warnings).toEqual(['incidents: method not served by the vendor']);
      expect(JSON.parse(page.cursor!)).toEqual({ v: 1, quarantineAfter: NOW.toISOString() });
      warn.mockRestore();
    });

    it('the quarantine list is called at v1.0, the version the vendor serves (v1.1 answers -32601 live)', async () => {
      const { ctx } = makeCtx(routes());
      await adapter.listDetections(ctx, tenant(C1), null, NOW);
      const urls = (ctx.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((c) => c[0]);
      expect(urls.filter((u) => u.includes('/quarantine/'))).toEqual([`${ctx.baseUrl}/v1.0/jsonrpc/quarantine/computers`]);
    });
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

describe('vendor times in the key owner timezone (#12821)', () => {
  const T1 = { vendorTenantId: C1, apiHost: null };
  const quietWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The "failing since" record is per process and per key; every test starts with none.
  beforeEach(() => __testOnly.resetAccountReadFailures());

  it('enrichment reads the key owner account timezone once per run and stores lastSeen in UTC', async () => {
    const { ctx, calls, count } = makeCtx({ 'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json') });
    const out = await adapter.enrichEndpoints!(ctx, T1, ['a', 'b']);
    expect(out.map((d) => d.lastSeenAt?.toISOString())).toEqual(['2026-11-27T22:17:34.000Z', '2026-11-27T22:17:34.000Z']);
    // No accountId: a personal key then reads the account that generated it.
    expect(calls.find((c) => c.key === 'accounts.getAccountDetails')!.params).toEqual({});
    await adapter.enrichEndpoints!(ctx, { vendorTenantId: C2, apiHost: null }, ['c']);
    expect(count('accounts.getAccountDetails')).toBe(1);
  });

  it('no ids to enrich -> no account read', async () => {
    const { ctx, count } = makeCtx({});
    expect(await adapter.enrichEndpoints!(ctx, T1, [])).toEqual([]);
    expect(count('accounts.getAccountDetails')).toBe(0);
  });

  it.each([
    ['Accounts API not enabled on the key', { status: 403, body: fx('error-api-not-enabled-accounts-403.json') }, 'api_not_enabled'],
    ['no timezone in the profile', rpc({ profile: { fullName: 'x' } }), 'timezone_missing'],
    ['a timezone the runtime does not know', rpc({ profile: { timezone: 'Mars/Olympus_Mons' } }), 'timezone_invalid'],
  ])('%s -> lastSeen stored as null (never read as UTC), other fields kept, one code-only warning per run', async (_l, reply, code) => {
    const warn = quietWarn();
    const { ctx } = makeCtx({
      'accounts.getAccountDetails': reply as Route,
      'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json'),
    });
    const out = await adapter.enrichEndpoints!(ctx, T1, ['a', 'b']);
    expect(out.map((d) => [d.lastSeenAt, d.agentVersion])).toEqual([[null, '8.26.11.679'], [null, '8.26.11.679']]);
    const msgs = warn.mock.calls.map((c) => String(c.join(' '))).filter((m) => m.includes('timezone'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(code);
    expect(msgs[0]).not.toContain('Mars');
    warn.mockRestore();
  });

  it('a 401 on the account read alone does not fail the run: lastSeen is left unset (kept), never stored as null', async () => {
    const warn = quietWarn();
    const { ctx } = makeCtx({
      'accounts.getAccountDetails': { status: 401, body: '{}' },
      'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json'),
    });
    const [d] = await adapter.enrichEndpoints!(ctx, T1, ['a']);
    expect(d).not.toHaveProperty('lastSeenAt');
    expect(d!.agentVersion).toBe('8.26.11.679');
    warn.mockRestore();
  });

  it('a dead key that also fails the other calls of the run fails the run for that reason (reauth)', async () => {
    const warn = quietWarn();
    const { ctx } = makeCtx({
      'accounts.getAccountDetails': { status: 401, body: '{}' },
      'network.getManagedEndpointDetails': { status: 401, body: '{}' },
    });
    await expect(adapter.enrichEndpoints!(ctx, T1, ['a'])).rejects.toMatchObject({ code: 'auth', reauth: true });
    warn.mockRestore();
  });

  it('an unavailable timezone is read once per run: a second tenant makes no account call and logs nothing new', async () => {
    const warn = quietWarn();
    const { ctx, count } = makeCtx({
      'accounts.getAccountDetails': { status: 403, body: fx('error-api-not-enabled-accounts-403.json') },
      'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json'),
    });
    await adapter.enrichEndpoints!(ctx, T1, ['a']);
    await adapter.enrichEndpoints!(ctx, { vendorTenantId: C2, apiHost: null }, ['b']);
    expect(count('accounts.getAccountDetails')).toBe(1);
    expect(warn.mock.calls.filter((c) => String(c.join(' ')).includes('timezone'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('a zone with surrounding whitespace is trimmed and used', async () => {
    const { ctx } = makeCtx({
      'accounts.getAccountDetails': rpc({ profile: { timezone: ' America/New_York ' } }),
      'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json'),
    });
    const [d] = await adapter.enrichEndpoints!(ctx, T1, ['a']);
    expect(d!.lastSeenAt?.toISOString()).toBe('2026-11-27T22:17:34.000Z');
  });

  it('an incident WITHOUT an offset is read in the account timezone, or stored with null times and a warning', async () => {
    const inc = JSON.parse(fx('live-incidents-personal-key.json'));
    Object.assign(inc.result.items[0], { company: { id: C1 }, created: '2026-11-25T16:26:45', lastIncidentChange: '2026-11-25T16:29:18' });
    const empty = rpc({ total: 0, page: 1, perPage: 100, pagesCount: 0, items: [] });
    const known = makeCtx({ 'incidents.getIncidentsList': { body: JSON.stringify(inc) }, 'quarantine/computers.getQuarantineItemsList': empty });
    const page = await adapter.listDetections(known.ctx, T1, null, NOW);
    expect(page.detections[0]).toMatchObject({ vendorKind: 'incident' });
    expect(page.detections[0]!.detectedAt?.toISOString()).toBe('2026-11-25T21:26:45.000Z');
    expect(page.detections[0]!.lastVendorUpdateAt?.toISOString()).toBe('2026-11-25T21:29:18.000Z');
    expect(page.warnings).toEqual([]);

    const warn = quietWarn();
    const unknown = makeCtx({
      'accounts.getAccountDetails': { status: 403, body: fx('error-api-not-enabled-accounts-403.json') },
      'incidents.getIncidentsList': { body: JSON.stringify(inc) },
      'quarantine/computers.getQuarantineItemsList': empty,
    });
    const p2 = await adapter.listDetections(unknown.ctx, T1, null, NOW);
    expect(p2.detections.map((d) => [d.detectedAt, d.lastVendorUpdateAt])).toEqual([[null, null]]);
    expect(p2.warnings).toEqual(['incidents: times not stored (Accounts API not enabled on key)']);
    warn.mockRestore();
  });

  it('a rate limit on the account read alone: detections still come back with a cursor; offset-less times unset, never guessed', async () => {
    const warn = quietWarn();
    const q = JSON.parse(fx('live-quarantine-service-key.json'));
    q.result.items[0].companyId = C1;
    const { ctx } = makeCtx({
      'accounts.getAccountDetails': { status: 429, body: fx('error-429-nginx.html'), headers: { 'Retry-After': '600' } },
      'incidents.getIncidentsList': rpc({ total: 0, page: 1, perPage: 1000, pagesCount: 0, items: [] }),
      'quarantine/computers.getQuarantineItemsList': { body: JSON.stringify(q) },
    });
    const page = await adapter.listDetections(ctx, T1, null, NOW);
    expect(page.detections).toHaveLength(1);
    expect(page.detections[0]).toMatchObject({ vendorKind: 'quarantine_item', detectedAt: undefined, lastVendorUpdateAt: undefined });
    expect(JSON.parse(page.cursor!).quarantineAfter).toBe(NOW.toISOString());
    expect(page.warnings).toEqual(['quarantine: times not updated (account timezone read failed)']);
    warn.mockRestore();
  });

  it('a rate limit on the account read alone does not fail inventory enrichment; lastSeen is left unset', async () => {
    const warn = quietWarn();
    const { ctx } = makeCtx({
      'accounts.getAccountDetails': { status: 429, body: fx('error-429-nginx.html'), headers: { 'Retry-After': '600' } },
      'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json'),
    });
    const [d] = await adapter.enrichEndpoints!(ctx, T1, ['a']);
    expect(d).not.toHaveProperty('lastSeenAt');
    expect(d!.agentVersion).toBe('8.26.11.679');
    const msgs = warn.mock.calls.map((c) => String(c.join(' '))).filter((m) => m.includes('timezone'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('(rate_limited)');
    warn.mockRestore();
  });

  it('quarantine times use the account timezone; incidents keep their own offset', async () => {
    const q = JSON.parse(fx('live-quarantine-service-key.json'));
    q.result.items[0].companyId = C1;
    const inc = JSON.parse(fx('live-incidents-personal-key.json'));
    inc.result.items[0].company.id = C1;
    const { ctx } = makeCtx({
      'incidents.getIncidentsList': { body: JSON.stringify(inc) },
      'quarantine/computers.getQuarantineItemsList': { body: JSON.stringify(q) },
    });
    const page = await adapter.listDetections(ctx, T1, null, NOW);
    const byKind = Object.fromEntries(page.detections.map((d) => [d.vendorKind, d.detectedAt?.toISOString()]));
    // 22:01:10 New York wall time (EDT, -4) is 02:01:10Z the next day.
    expect(byKind).toEqual({ incident: '2026-11-25T21:26:45.000Z', quarantine_item: '2026-10-12T02:01:10.000Z' });
    expect(page.warnings).toEqual([]);
  });

  it('incidents alone need no account read (they carry an offset)', async () => {
    const inc = JSON.parse(fx('live-incidents-personal-key.json'));
    inc.result.items[0].company.id = C1;
    const { ctx, count } = makeCtx({
      'incidents.getIncidentsList': { body: JSON.stringify(inc) },
      'quarantine/computers.getQuarantineItemsList': rpc({ total: 0, page: 1, perPage: 100, pagesCount: 0, items: [] }),
    });
    const page = await adapter.listDetections(ctx, T1, null, NOW);
    expect(page.detections[0]!.detectedAt?.toISOString()).toBe('2026-11-25T21:26:45.000Z');
    expect(count('accounts.getAccountDetails')).toBe(0);
  });

  it('quarantine with no readable timezone: detections kept with null times and a sync warning', async () => {
    const warn = quietWarn();
    const q = JSON.parse(fx('live-quarantine-service-key.json'));
    q.result.items[0].companyId = C1;
    const { ctx } = makeCtx({
      'accounts.getAccountDetails': { status: 403, body: fx('error-api-not-enabled-accounts-403.json') },
      'incidents.getIncidentsList': rpc({ total: 0, page: 1, perPage: 1000, pagesCount: 0, items: [] }),
      'quarantine/computers.getQuarantineItemsList': { body: JSON.stringify(q) },
    });
    const page = await adapter.listDetections(ctx, T1, null, NOW);
    expect(page.detections.map((d) => [d.vendorKind, d.detectedAt, d.lastVendorUpdateAt])).toEqual([['quarantine_item', null, null]]);
    expect(page.warnings).toEqual(['quarantine: times not stored (Accounts API not enabled on key)']);
    warn.mockRestore();
  });

  describe('account-read error -> outcome', () => {
    // A key of its own per case: the "failing since" window is kept per key across runs.
    let n = 0;
    const freshKey = () => ({ creds: { apiKey: `FRESHKEY${String(++n).padStart(4, '0')}0123456789abcdef` } });
    const rpcError = (code: number, message: string, details?: string): Reply => ({
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message, ...(details ? { data: { details } } : {}) } }),
    });
    const enrichWith = (reply: Route, over: Partial<EdrAdapterContext> = freshKey()) => makeCtx({
      'accounts.getAccountDetails': reply,
      'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json'),
    }, over);

    it.each([
      ['method not found (-32601)', rpcError(-32601, 'Method not found'), 'method_not_found'],
      ['invalid params (-32602)', ok('error-invalid-params-32602.json'), 'invalid_params'],
      ['forbidden for this key (-32001)', rpcError(-32001, 'Forbidden'), 'forbidden'],
      ['not on the licence', ok('error-licence-32001.json'), 'licence'],
    ])('permanent: %s -> lastSeen stored as null at once, with the code logged', async (_l, reply, code) => {
      const warn = quietWarn();
      const { ctx } = enrichWith(reply);
      const out = await adapter.enrichEndpoints!(ctx, T1, ['a']);
      expect(out.map((d) => d.lastSeenAt)).toEqual([null]);
      const msgs = warn.mock.calls.map((c) => String(c.join(' '))).filter((m) => m.includes('timezone'));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain(`(${code})`);
      warn.mockRestore();
    });

    it.each([
      ['a generic server error (-32000)', rpcError(-32000, 'Server error', 'try again later'), 'vendor_error'],
      ['an invalid request (-32600)', rpcError(-32600, 'Invalid Request'), 'vendor_error'],
      ['a parse error (-32700)', rpcError(-32700, 'Parse error'), 'vendor_error'],
      ['an unrecognised code', rpcError(-32099, 'Something'), 'vendor_error'],
      ['not found (-32002)', ok('error-not-found-32002.json'), 'not_found'],
      ['a non-2xx JSON reply without an error', { status: 404, body: '{"jsonrpc":"2.0","id":1}' }, 'http_error'],
    ])('transient: %s -> the run goes on; lastSeen left unset (the stored time stays), code logged', async (_l, reply, code) => {
      const warn = quietWarn();
      const { ctx } = enrichWith(reply);
      const [d] = await adapter.enrichEndpoints!(ctx, T1, ['a']);
      expect(d).not.toHaveProperty('lastSeenAt');
      expect(d!.agentVersion).toBe('8.26.11.679');
      const msgs = warn.mock.calls.map((c) => String(c.join(' '))).filter((m) => m.includes('timezone'));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain(`(${code})`);
      warn.mockRestore();
    });

    it('connection-scope on the account call only (a non-JSON 403): the run goes on, lastSeen left unset', async () => {
      const warn = quietWarn();
      const { ctx } = enrichWith({ status: 403, body: '<html>denied</html>' });
      const [d] = await adapter.enrichEndpoints!(ctx, T1, ['a']);
      expect(d).not.toHaveProperty('lastSeenAt');
      expect(d!.agentVersion).toBe('8.26.11.679');
      warn.mockRestore();
    });

    it('a network failure on the account read (the fetch itself throws) is transient: never fails the run, never logs the cause', async () => {
      const warn = quietWarn();
      const { ctx } = makeCtx({ 'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json') }, freshKey());
      const real = ctx.fetch;
      ctx.fetch = (async (url, init) => {
        if (JSON.parse(init.body!).method === 'getAccountDetails') throw new TypeError('boom SECRET');
        return real(url, init);
      }) as GuardedFetch;
      const [d] = await adapter.enrichEndpoints!(ctx, T1, ['a']);
      expect(d).not.toHaveProperty('lastSeenAt');
      const msgs = warn.mock.calls.map((c) => String(c.join(' '))).filter((m) => m.includes('timezone'));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).not.toContain('SECRET');
      warn.mockRestore();
    });

    it('a generic vendor error during detection sync: detections come back with a cursor; quarantine times unset', async () => {
      const warn = quietWarn();
      const q = JSON.parse(fx('live-quarantine-service-key.json'));
      q.result.items[0].companyId = C1;
      const { ctx } = makeCtx({
        'accounts.getAccountDetails': rpcError(-32000, 'Server error'),
        'incidents.getIncidentsList': rpc({ total: 0, page: 1, perPage: 1000, pagesCount: 0, items: [] }),
        'quarantine/computers.getQuarantineItemsList': { body: JSON.stringify(q) },
      }, freshKey());
      const page = await adapter.listDetections(ctx, T1, null, NOW);
      expect(page.detections.map((d) => [d.vendorDetectionId, d.detectedAt, d.lastVendorUpdateAt]))
        .toEqual([['6c0000000000000000000003', undefined, undefined]]);
      expect(page.cursor).not.toBeNull();
      expect(page.warnings).toEqual(['quarantine: times not updated (account timezone read failed)']);
      warn.mockRestore();
    });

    it('an incident with no offset while the read fails: created / last change unset; a non-terminal resolvedAt stays null', async () => {
      const warn = quietWarn();
      const inc = JSON.parse(fx('live-incidents-personal-key.json'));
      Object.assign(inc.result.items[0], { company: { id: C1 }, created: '2026-11-25T16:26:45', lastIncidentChange: '2026-11-25T16:29:18' });
      const { ctx } = makeCtx({
        'accounts.getAccountDetails': rpcError(-32000, 'Server error'),
        'incidents.getIncidentsList': { body: JSON.stringify(inc) },
        'quarantine/computers.getQuarantineItemsList': rpc({ total: 0, page: 1, perPage: 100, pagesCount: 0, items: [] }),
      }, freshKey());
      const page = await adapter.listDetections(ctx, T1, null, NOW);
      expect(page.detections.map((d) => [d.detectedAt, d.lastVendorUpdateAt, d.resolvedAt])).toEqual([[undefined, undefined, null]]);
      expect(page.warnings).toEqual(['incidents: times not updated (account timezone read failed)']);
      warn.mockRestore();
    });

    describe('bound: a read that keeps failing becomes "unavailable" (null), counted in attempts AND elapsed time', () => {
      const failing = rpcError(-32000, 'Server error');
      const H = 3_600_000;
      const t0 = Date.parse('2026-11-27T10:00:00Z');
      const at = (ms: number) => vi.setSystemTime(new Date(t0 + ms));
      /** One inventory enrichment run at the current time; returns the one detail. */
      const runOnce = async (key: Partial<EdrAdapterContext>, reply: Route = failing) =>
        (await adapter.enrichEndpoints!(enrichWith(reply, key).ctx, T1, ['a']))[0]!;
      const lastSeenOf = (d: Awaited<ReturnType<typeof runOnce>>) => ('lastSeenAt' in d ? d.lastSeenAt : 'unset');

      let warn: ReturnType<typeof quietWarn>;
      beforeEach(() => {
        warn = quietWarn();
        vi.useFakeTimers({ toFake: ['Date'] });
        return () => { vi.useRealTimers(); warn.mockRestore(); };
      });

      it('three failed runs spanning 3 hours with no success -> null, logged account_read_failing:<code>; never fails the run', async () => {
        const key = freshKey();
        at(0);
        expect(lastSeenOf(await runOnce(key))).toBe('unset');
        at(1.5 * H);
        expect(lastSeenOf(await runOnce(key))).toBe('unset');
        at(3 * H - 1);
        expect(lastSeenOf(await runOnce(key))).toBe('unset');
        // Another key's record is its own.
        expect(lastSeenOf(await runOnce(freshKey()))).toBe('unset');

        warn.mockClear();
        at(3 * H);
        const d = await runOnce(key);
        expect([lastSeenOf(d), d.agentVersion]).toEqual([null, '8.26.11.679']);
        const msgs = warn.mock.calls.map((c) => String(c.join(' '))).filter((m) => m.includes('timezone'));
        expect(msgs).toHaveLength(1);
        expect(msgs[0]).toContain('account_read_failing:vendor_error');
        expect(msgs[0]).not.toContain('Server error');

        // Detection sync past the bound: null times, and a warning that says the read is failing.
        const q = JSON.parse(fx('live-quarantine-service-key.json'));
        q.result.items[0].companyId = C1;
        const det = makeCtx({
          'accounts.getAccountDetails': failing,
          'incidents.getIncidentsList': rpc({ total: 0, page: 1, perPage: 1000, pagesCount: 0, items: [] }),
          'quarantine/computers.getQuarantineItemsList': { body: JSON.stringify(q) },
        }, key);
        const page = await adapter.listDetections(det.ctx, T1, null, NOW);
        expect(page.detections.map((x) => [x.detectedAt, x.lastVendorUpdateAt])).toEqual([[null, null]]);
        expect(page.warnings).toEqual(['quarantine: times not stored (account timezone read failing)']);
      });

      it('one failure, a 4-hour gap, then a second failure is NOT "failing for 3 hours": still unset; the third failure tips it', async () => {
        const key = freshKey();
        at(0);
        expect(lastSeenOf(await runOnce(key))).toBe('unset');
        at(4 * H);
        expect(lastSeenOf(await runOnce(key))).toBe('unset');
        at(4 * H + 60_000);
        expect(lastSeenOf(await runOnce(key))).toBeNull();
      });

      it('many failures inside 3 hours stay unset (attempts alone are not enough)', async () => {
        const key = freshKey();
        for (let i = 0; i < 10; i++) {
          at(i * 15 * 60_000);
          expect(lastSeenOf(await runOnce(key))).toBe('unset');
        }
      });

      it('a successful read clears the record: failures start counting again from zero', async () => {
        const key = freshKey();
        at(0); await runOnce(key);
        at(H); await runOnce(key);
        at(2 * H); await runOnce(key);
        at(3 * H); expect(lastSeenOf(await runOnce(key))).toBeNull();
        at(3 * H + 60_000);
        const okRun = await runOnce(key, { body: fx('account-details.json') });
        expect((okRun.lastSeenAt as Date).toISOString()).toBe('2026-11-27T22:17:34.000Z');
        at(3 * H + 120_000);
        expect(lastSeenOf(await runOnce(key))).toBe('unset');
        at(7 * H);
        expect(lastSeenOf(await runOnce(key))).toBe('unset');
      });

      it('a permanent reason clears a transient record (it is null on its own terms, not via the bound)', async () => {
        const key = freshKey();
        at(0); await runOnce(key);
        at(H); await runOnce(key);
        at(2 * H); expect(lastSeenOf(await runOnce(key, rpcError(-32601, 'Method not found')))).toBeNull();
        at(3 * H); expect(lastSeenOf(await runOnce(key))).toBe('unset');
      });

      it('resetAccountReadFailures forgets every key (tests do not depend on run order)', async () => {
        const key = freshKey();
        at(0); await runOnce(key);
        at(H); await runOnce(key);
        __testOnly.resetAccountReadFailures();
        at(3 * H); expect(lastSeenOf(await runOnce(key))).toBe('unset');
      });
    });
  });

  describe('a run where only the account read fails still persists everything that does not need the timezone', () => {
    const rpcError = (code: number, message: string): Reply => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }) });
    const quarantineFor = (companyId: string) => {
      const q = JSON.parse(fx('live-quarantine-service-key.json'));
      q.result.items[0].companyId = companyId;
      return { body: JSON.stringify(q) };
    };
    it.each([
      ['permanent (Accounts API not enabled)', null, { status: 403, body: fx('error-api-not-enabled-accounts-403.json') }],
      ['transient (generic vendor error)', 'unset', rpcError(-32000, 'Server error')],
      ['connection-scope on that call only (rate limited)', 'unset', { status: 429, body: fx('error-429-nginx.html'), headers: { 'Retry-After': '600' } }],
    ] as const)('%s: isolation state, identity and new detections come back; times are %s', async (_l, expectedTime, accountReply) => {
      const warn = quietWarn();
      const { ctx } = makeCtx({
        'accounts.getAccountDetails': accountReply as Route,
        'network.getNetworkInventoryItems': [ok('inventory-page1.json'), ok('inventory-page2.json')],
        'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json'),
        'incidents.getIncidentsList': rpc({ total: 0, page: 1, perPage: 1000, pagesCount: 0, items: [] }),
        'quarantine/computers.getQuarantineItemsList': quarantineFor(C1),
      });
      // Inventory, as the sync job runs it: list, then enrich.
      const eps = await adapter.listEndpoints(ctx, T1);
      expect(eps.map((e) => [e.vendorEndpointId, e.isolationState])).toEqual([
        ['6a0000000000000000000a01', 'isolated'],
        ['6a0000000000000000000a02', expect.any(String)],
      ]);
      const details = await adapter.enrichEndpoints!(ctx, T1, eps.map((e) => e.vendorEndpointId));
      expect(details.map((d) => d.agentVersion)).toEqual(['8.26.11.679', '8.26.11.679']);
      expect(details.map((d) => ('lastSeenAt' in d ? d.lastSeenAt : 'unset'))).toEqual([expectedTime, expectedTime]);
      // Detection sync: the new quarantine item is returned and the cursor advances.
      const page = await adapter.listDetections(ctx, T1, null, NOW);
      expect(page.detections.map((d) => [d.vendorDetectionId, d.status])).toEqual([['6c0000000000000000000003', expect.any(String)]]);
      expect(page.detections.map((d) => ('detectedAt' in d && d.detectedAt !== undefined ? d.detectedAt : 'unset'))).toEqual([expectedTime]);
      expect(JSON.parse(page.cursor!).quarantineAfter).toBe(NOW.toISOString());
      warn.mockRestore();
    });
  });

  it('re-isolate after a confirmed release while the account read fails transiently: the next inventory run shows not_isolated and isolate is offered', async () => {
    const warn = quietWarn();
    const facts = (isolationState: EdrActionTargetFacts['isolationState']): EdrActionTargetFacts => ({
      vendorEndpointId: '6a0000000000000000000a01', osPlatform: 'windows', isolationState, online: true,
      tenantUnsupportedActions: [], connectionCapabilityNotes: [],
    });
    const req = (action: 'unisolate'): EdrActionRequest => ({ action, target: { kind: 'endpoint', vendorEndpointId: '6a0000000000000000000a01' } });

    // Before: the endpoint is isolated, so isolate is refused.
    const before = makeCtx({ 'network.getNetworkInventoryItems': [ok('inventory-page1.json'), ok('inventory-page2.json')] });
    const [isolated] = await adapter.listEndpoints(before.ctx, T1);
    expect(isolated!.isolationState).toBe('isolated');
    expect(adapter.supportsAction!(facts(isolated!.isolationState), 'isolate')).toEqual({ ok: false, reason: 'Already isolated' });

    // Release: accepted, then confirmed by the live read.
    const release = makeCtx({
      'incidents.createRestoreEndpointFromIsolationTask': ok('action-restore-ok.json'),
      'network.getManagedEndpointDetails': rpc({ id: '6a0000000000000000000a01', isIsolated: false }),
    });
    expect(await adapter.performAction!(release.ctx, T1, req('unisolate'), '7f0c0000-0000-4000-8000-00000000a0f1')).toEqual({ status: 'succeeded' });
    expect(await adapter.reconcileAction!(release.ctx, T1, req('unisolate'))).toBe('applied');

    // Next inventory run: the account read fails transiently; the vendor now lists the endpoint released.
    const page1 = JSON.parse(fx('inventory-page1.json'));
    page1.result.items[0].details.isIsolated = false;
    const next = makeCtx({
      'accounts.getAccountDetails': { body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Server error' } }) },
      'network.getNetworkInventoryItems': [{ body: JSON.stringify(page1) }, ok('inventory-page2.json')],
      'network.getManagedEndpointDetails': ok('live-endpoint-details-personal-key.json'),
    });
    const [released] = await adapter.listEndpoints(next.ctx, T1);
    // The run does not fail on the account read, so this row is what inventory writes.
    await expect(adapter.enrichEndpoints!(next.ctx, T1, [released!.vendorEndpointId])).resolves.toHaveLength(1);
    expect(released!.isolationState).toBe('not_isolated');
    expect(adapter.supportsAction!(facts(released!.isolationState), 'isolate')).toEqual({ ok: true });
    warn.mockRestore();
  });

  it('testConnection notes a key without the Accounts API', async () => {
    const { ctx } = makeCtx({
      'general.getApiKeyDetails': ok('api-key-details.json'),
      'companies.getCompanyDetails': ok('company-details-customer.json'),
    });
    const r = await adapter.testConnection(ctx);
    expect((r as { capabilityNotes: string[] }).capabilityNotes).toContain('accounts: API not enabled on key');
  });
});

describe('response actions', () => {
  const T = { vendorTenantId: C1, apiHost: null };
  const ACT = '7f0c0000-0000-4000-8000-00000000a001';
  const INCIDENTS_OFF = 'note:incidents: API not enabled on key';
  const facts = (over: Partial<EdrActionTargetFacts> = {}): EdrActionTargetFacts => ({
    vendorEndpointId: 'ep1', osPlatform: 'windows', isolationState: 'not_isolated', online: true,
    tenantUnsupportedActions: [], connectionCapabilityNotes: [], ...over,
  });
  const endpointReq = (action: 'isolate' | 'unisolate' | 'scan' | 'update_agent'): EdrActionRequest =>
    ({ action, target: { kind: 'endpoint', vendorEndpointId: 'ep1' } });

  it('declares isolate/unisolate/scan with a 30/min actions budget', () => {
    expect(adapter.capabilities.actions).toEqual(['isolate', 'unisolate', 'scan']);
    expect(adapter.capabilities.operationBudgets?.actions).toEqual({ perMinute: 30 });
  });

  describe('supportsAction', () => {
    const cases: Array<[string, Partial<EdrActionTargetFacts>, EdrActionKey, EdrActionSupport]> = [
      ['rule 1: action outside capabilities', {}, 'kill_process', { ok: false, reason: 'Not supported by Bitdefender GravityZone' }],
      ['rule 2: endpoint not linked', { vendorEndpointId: null }, 'scan', { ok: false, reason: 'Endpoint not linked to this vendor' }],
      ['rule 3: isolate without incidents API', { connectionCapabilityNotes: [INCIDENTS_OFF] }, 'isolate',
        { ok: false, reason: 'The API key lacks the Incidents API (needed for isolation)' }],
      ['rule 3: unisolate without incidents API', { connectionCapabilityNotes: [INCIDENTS_OFF], isolationState: 'isolated' }, 'unisolate',
        { ok: false, reason: 'The API key lacks the Incidents API (needed for isolation)' }],
      ['rule 3 does not apply to scan', { connectionCapabilityNotes: [INCIDENTS_OFF] }, 'scan', { ok: true }],
      ['rule 4: licence denial', { tenantUnsupportedActions: ['scan'] }, 'scan',
        { ok: false, reason: "This company's GravityZone licence does not include this action" }],
      ['rule 5: already isolated', { isolationState: 'isolated' }, 'isolate', { ok: false, reason: 'Already isolated' }],
      ['rule 5: not isolated', { isolationState: 'not_isolated' }, 'unisolate', { ok: false, reason: 'Not isolated' }],
      ['rule 5: pending allows isolate', { isolationState: 'pending' }, 'isolate', { ok: true }],
      ['rule 5: pending allows unisolate', { isolationState: 'pending' }, 'unisolate', { ok: true }],
      ['rule 5: unknown allows isolate', { isolationState: 'unknown' }, 'isolate', { ok: true }],
      ['rule 5: null allows unisolate', { isolationState: null }, 'unisolate', { ok: true }],
      ['rule 5 does not apply to scan', { isolationState: 'isolated' }, 'scan', { ok: true }],
      ['rule 6: ok', {}, 'isolate', { ok: true }],
      ['order: not-supported beats unlinked', { vendorEndpointId: null }, 'rollback', { ok: false, reason: 'Not supported by Bitdefender GravityZone' }],
      ['order: unlinked beats incidents note', { vendorEndpointId: null, connectionCapabilityNotes: [INCIDENTS_OFF] }, 'isolate',
        { ok: false, reason: 'Endpoint not linked to this vendor' }],
      ['order: incidents note beats licence denial', { connectionCapabilityNotes: [INCIDENTS_OFF], tenantUnsupportedActions: ['isolate'] }, 'isolate',
        { ok: false, reason: 'The API key lacks the Incidents API (needed for isolation)' }],
      ['order: licence denial beats already-isolated', { isolationState: 'isolated', tenantUnsupportedActions: ['isolate'] }, 'isolate',
        { ok: false, reason: "This company's GravityZone licence does not include this action" }],
    ];
    it.each(cases)('%s', (_name, over, action, expected) => {
      expect(adapter.supportsAction!(facts(over), action)).toEqual(expected);
    });
  });

  describe('performAction', () => {
    const routes: Array<['isolate' | 'unisolate' | 'scan', string, Reply, unknown]> = [
      ['isolate', 'incidents.createIsolateEndpointTask', ok('action-isolate-ok.json'), { status: 'succeeded' }],
      ['unisolate', 'incidents.createRestoreEndpointFromIsolationTask', ok('action-restore-ok.json'), { status: 'succeeded' }],
      // #12822: a scan the vendor accepted is never recorded as done. It stays submitted, keyed by
      // the task name Breeze sent (plus the task id when the vendor returns one), until the scan
      // task list shows it finished.
      ['scan', 'network.createScanTask', ok('action-scan-ok.json'), { status: 'submitted', vendorActionId: `scan:${ACT}:6a0000000000000000000b01` }],
      ['scan', 'network.createScanTask', ok('action-scan-accepted-live.json'), { status: 'submitted', vendorActionId: `scan:${ACT}` }],
      ['scan', 'network.createScanTask', rpc(['6a0000000000000000000b01', '6a0000000000000000000b02']), { status: 'submitted', vendorActionId: `scan:${ACT}` }],
      // Review fix: a task-id answer to isolate/restore is still "accepted" — completion is
      // observed through inventory isIsolated / reconcileAction, never the scan-task list.
      ['isolate', 'incidents.createIsolateEndpointTask', rpc(['6a0000000000000000000c01']), { status: 'succeeded' }],
      ['unisolate', 'incidents.createRestoreEndpointFromIsolationTask', rpc(['6a0000000000000000000c02']), { status: 'succeeded' }],
    ];
    it.each(routes)('%s -> %s maps the result and passes the trace id (action id) as the JSON-RPC id', async (action, key, reply, expected) => {
      const { ctx, calls } = makeCtx({ [key]: reply });
      const spy = vi.mocked(ctx.fetch);
      expect(await adapter.performAction!(ctx, T, endpointReq(action), ACT)).toEqual(expected);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.key).toBe(key);
      const sent = JSON.parse(spy.mock.calls[0]![1].body!);
      expect(sent).toMatchObject({ id: ACT });
      expect(JSON.stringify(sent.params)).toContain('ep1');
    });

    it.each<EdrActionRequest>([
      endpointReq('update_agent'),
      { action: 'kill_process', target: { kind: 'process', vendorEndpointId: 'ep1', pid: 4 } },
      { action: 'rollback', target: { kind: 'detection', vendorDetectionId: 'd1', vendorKind: 'incident' } },
      { action: 'quarantine_delete', target: { kind: 'quarantine_item', vendorItemId: 'q1' } },
      { action: 'isolate', target: { kind: 'process', vendorEndpointId: 'ep1', pid: 4 } } as unknown as EdrActionRequest,
    ])('refuses $action / $target.kind with unsupported_action and no vendor call', async (req) => {
      const { ctx, calls } = makeCtx({});
      await expect(adapter.performAction!(ctx, T, req, ACT)).rejects.toMatchObject({
        code: 'unsupported_action', reauth: false, scope: 'operation',
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('getActionStatus (#12822)', () => {
    const NAME = `Breeze scan ${ACT}`;
    const list = (...items: Array<{ id: string; name?: string; status?: unknown }>) =>
      rpc({ total: items.length, page: 1, perPage: 100, pagesCount: items.length ? 1 : 0,
        items: items.map((i) => ({ name: NAME, startDate: '2026-11-27T16:58:02', ...i })) });

    it('finds the task by the name Breeze gave it, never by a taskId parameter (the vendor rejects one)', async () => {
      const FX_ACT = '7f0c0000-0000-4000-8000-00000000a003'; // the action the live-shape fixture's task is named after
      const { ctx, calls } = makeCtx({ 'network.getScanTasksList': ok('action-scan-task-status.json') });
      expect(await adapter.getActionStatus!(ctx, T, `scan:${FX_ACT}:6a0000000000000000000b01`)).toEqual({ status: 'succeeded' });
      expect(calls[0]!.params).toEqual({ name: `Breeze scan ${FX_ACT}`, page: 1, perPage: 100 });
      expect(calls[0]!.params).not.toHaveProperty('taskId');
    });

    it.each([[1, { status: 'submitted' }], [2, { status: 'submitted' }], [3, { status: 'succeeded' }],
      // Undocumented codes are not read as a failure or a success: the row waits for the timeout.
      [4, { status: 'submitted' }], [99, { status: 'submitted' }], [undefined, { status: 'submitted' }]])(
      'vendor status %s -> %j', async (code, expected) => {
        const { ctx } = makeCtx({ 'network.getScanTasksList': list({ id: 't1', status: code }) });
        expect(await adapter.getActionStatus!(ctx, T, `scan:${ACT}`)).toEqual(expected);
      },
    );

    it('not listed yet (or never) -> still submitted; the 24 h timeout then fails it as unconfirmed', async () => {
      const { ctx } = makeCtx({ 'network.getScanTasksList': ok('scan-tasks-list-empty.json') });
      expect(await adapter.getActionStatus!(ctx, T, `scan:${ACT}`)).toEqual({ status: 'submitted' });
    });

    it('a task whose name only starts with ours is not ours (the vendor filter is a prefix match)', async () => {
      const { ctx } = makeCtx({ 'network.getScanTasksList': list({ id: 't9', name: `${NAME}-copy`, status: 3 }) });
      expect(await adapter.getActionStatus!(ctx, T, `scan:${ACT}`)).toEqual({ status: 'submitted' });
    });

    it('with a vendor task id, only that task counts', async () => {
      const { ctx } = makeCtx({ 'network.getScanTasksList': list({ id: 'other', status: 3 }, { id: 't1', status: 2 }) });
      expect(await adapter.getActionStatus!(ctx, T, `scan:${ACT}:t1`)).toEqual({ status: 'submitted' });
      const done = makeCtx({ 'network.getScanTasksList': list({ id: 'other', status: 1 }, { id: 't1', status: 3 }) });
      expect(await adapter.getActionStatus!(done.ctx, T, `scan:${ACT}:t1`)).toEqual({ status: 'succeeded' });
    });

    it('several tasks under our name and no id: succeeded only when every one finished', async () => {
      const { ctx } = makeCtx({ 'network.getScanTasksList': list({ id: 'a', status: 3 }, { id: 'b', status: 1 }) });
      expect(await adapter.getActionStatus!(ctx, T, `scan:${ACT}`)).toEqual({ status: 'submitted' });
      const done = makeCtx({ 'network.getScanTasksList': list({ id: 'a', status: 3 }, { id: 'b', status: 3 }) });
      expect(await adapter.getActionStatus!(done.ctx, T, `scan:${ACT}`)).toEqual({ status: 'succeeded' });
    });

    it('a reference it does not recognise is left submitted with no vendor call, and says so (code only)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ctx, calls } = makeCtx({});
      expect(await adapter.getActionStatus!(ctx, T, '6a0000000000000000000b01')).toEqual({ status: 'submitted' });
      expect(calls).toHaveLength(0);
      expect(warn.mock.calls.map((c) => String(c.join(' '))).filter((m) => m.includes('scan reference'))).toHaveLength(1);
      warn.mockRestore();
    });

    it('an undocumented task status is logged (code only), never read as failed or finished', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ctx } = makeCtx({ 'network.getScanTasksList': list({ id: 't1', status: 4 }) });
      expect(await adapter.getActionStatus!(ctx, T, `scan:${ACT}:t1`)).toEqual({ status: 'submitted' });
      const msgs = warn.mock.calls.map((c) => String(c.join(' '))).filter((m) => m.includes('undocumented scan task status'));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain('4');
      warn.mockRestore();
    });

    it('end to end: the reference performAction returns is the one getActionStatus resolves', async () => {
      const { ctx } = makeCtx({
        'network.createScanTask': ok('action-scan-accepted-live.json'),
        'network.getScanTasksList': list({ id: 't1', status: 3 }),
      });
      const r = await adapter.performAction!(ctx, T, endpointReq('scan'), ACT);
      expect(r.status).toBe('submitted');
      expect(await adapter.getActionStatus!(ctx, T, (r as { vendorActionId: string }).vendorActionId)).toEqual({ status: 'succeeded' });
    });
  });

  describe('reconcileAction (read-only)', () => {
    const detail = (isIsolated?: boolean) => rpc({ id: 'ep1', ...(isIsolated === undefined ? {} : { isIsolated }) });
    it.each([
      ['isolate', true, 'applied'], ['isolate', false, 'not_applied'], ['isolate', undefined, 'unknown'],
      ['unisolate', true, 'not_applied'], ['unisolate', false, 'applied'], ['unisolate', undefined, 'unknown'],
    ] as const)('%s with isIsolated=%s -> %s', async (action, flag, verdict) => {
      const { ctx, calls } = makeCtx({ 'network.getManagedEndpointDetails': detail(flag) });
      expect(await adapter.reconcileAction!(ctx, T, endpointReq(action))).toBe(verdict);
      expect(calls.map((c) => c.key)).toEqual(['network.getManagedEndpointDetails']);
    });

    it('scan is always unknown and makes no vendor call', async () => {
      const { ctx, calls } = makeCtx({});
      expect(await adapter.reconcileAction!(ctx, T, endpointReq('scan'))).toBe('unknown');
      expect(calls).toHaveLength(0);
    });

    it('never calls a write method', async () => {
      const { ctx, calls } = makeCtx({ 'network.getManagedEndpointDetails': detail(true) });
      await adapter.reconcileAction!(ctx, T, endpointReq('isolate'));
      expect(calls.every((c) => !/\.create/.test(c.key))).toBe(true);
    });
  });
});
