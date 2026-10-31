import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EdrProviderRequestError, type EdrAdapterContext, type EdrDetectionRef, type GuardedFetch } from '../types';
import { emsisoftAdapter as adapter } from './adapter';

const fx = (n: string) => readFileSync(join(__dirname, '__fixtures__', n), 'utf8');
const API_KEY = 'SECRETKEY0123456789abcdef';
const WS1 = '00000000-0000-4000-8000-0000000000b1';
const WS2 = '00000000-0000-4000-8000-0000000000b2';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const D3 = '00000000-0000-4000-8000-0000000000d3';
const INC = '00000000-0000-4000-8000-0000000000c1';
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
const NOW = new Date('2026-10-25T12:00:00.000Z');
const DAY = 86_400_000;

type Reply = { status?: number; body: string; headers?: Record<string, string> };
type Route = Reply | Reply[] | ((url: URL) => Reply);

/** Routes by pathname; arrays are consumed in order (the last one repeats). Unrouted paths throw loudly. */
function makeCtx(routes: Record<string, Route>, over: Partial<EdrAdapterContext> = {}) {
  const calls: URL[] = [];
  const counters: Record<string, number> = {};
  const fetch: GuardedFetch = vi.fn(async (rawUrl) => {
    const url = new URL(rawUrl);
    calls.push(url);
    const route = routes[url.pathname];
    if (!route) throw new Error(`unrouted ${url.pathname}`);
    const i = (counters[url.pathname] = (counters[url.pathname] ?? -1) + 1);
    const r = typeof route === 'function' ? route(url) : Array.isArray(route) ? route[Math.min(i, route.length - 1)]! : route;
    return { status: r.status ?? 200, headers: new Headers(r.headers ?? {}), text: async () => r.body };
  });
  const ctx: EdrAdapterContext = {
    creds: { apiKey: API_KEY }, baseUrl: null, region: null, fetch, limiter: { acquire: async () => {} }, runCache: new Map(), ...over,
  };
  const count = (path: string) => calls.filter((c) => c.pathname === path).length;
  return { ctx, calls, count };
}

const ok = (name: string): Reply => ({ body: fx(name) });
const json = (v: unknown, status = 200): Reply => ({ status, body: JSON.stringify(v) });
const list = (data: unknown[]): Reply => json({ data, totalCount: data.length });
const dev = (guid: string, name: string) => ({ guid, name });
const incident = (over: Record<string, unknown> = {}) => ({
  guid: INC, type: 'File', verdict: 'New', actionTaken: 'None', actionsTaken: ['None'], highestSeverity: 'Suspicious',
  lastDetectionAt: '2026-10-24T07:00:00Z', involvedDevices: ['PC01'], sha1: SHA1, knownFileNames: ['x.example.test'], ...over,
});
const ref = (id: string, over: Partial<EdrDetectionRef> = {}): EdrDetectionRef =>
  ({ vendorDetectionId: id, vendorKind: 'incident', vendorRef: SHA1, groupKey: INC, ...over });
const T = (id: string) => ({ vendorTenantId: id, apiHost: null });

async function rejection(p: Promise<unknown>): Promise<EdrProviderRequestError> {
  try { await p; } catch (e) { return e as EdrProviderRequestError; }
  throw new Error('expected rejection');
}

describe('emsisoft adapter declaration', () => {
  it('exact host allowlist, no base URL, polled detections, re-read status model, no actions in PR-A', () => {
    expect(adapter.hostAllowlist).toEqual(['api.emsisoft.com']);
    expect(adapter.baseUrlPolicy).toBeNull();
    expect(adapter.capabilities).toMatchObject({
      tenantModel: 'partner', perTenantHost: false, detectionDelivery: 'poll', detectionStatusModel: 'reread_open_on_inventory',
      actions: [], endpointIdentifiers: ['hostname', 'fqdn'], installer: 'none', maxActionTargets: 1,
      firstSyncLookbackDays: 30, tenantFetchConcurrency: 1, rereadOpenPerRun: 20,
      defaultIntervals: { detectionsMinutes: 15, inventoryMinutes: 60 },
    });
    expect(adapter.capabilities.endpointIdentifiers).not.toContain('mac');
    expect(adapter.capabilities.endpointIdentifiers).not.toContain('ip');
    expect(adapter.performAction).toBeUndefined();
    expect(typeof adapter.rereadDetectionStatus).toBe('function');
  });

  it('credentials: a strict apiKey-only object', () => {
    expect(adapter.credentialsSchema.safeParse({ apiKey: API_KEY }).success).toBe(true);
    expect(adapter.credentialsSchema.safeParse({ apiKey: API_KEY, extra: 1 }).success).toBe(false);
    expect(adapter.credentialsSchema.safeParse({ apiKey: 'short' }).success).toBe(false);
    expect(adapter.credentialFields).toEqual([{ name: 'apiKey', label: 'API key', secret: true, required: true }]);
  });

  it('bad credentials fail as a connection-scope config error that never echoes the value', async () => {
    const { ctx } = makeCtx({}, { creds: { apiKey: 'tiny-secret-value', nope: 1 } });
    const err = await rejection(adapter.listTenants(ctx, { id: 'x', type: 'partner' }));
    expect(err).toMatchObject({ code: 'config', scope: 'connection', reauth: false });
    expect(err.message).not.toContain('tiny-secret-value');
  });
});

describe('testConnection', () => {
  const routes = (account: Reply, extra: Record<string, Route> = {}): Record<string, Route> => ({
    '/v1/account': account,
    '/v1/workspaces': ok('workspaces-page1.json'),
    [`/v1/workspaces/${WS1}/devices`]: ok('devices-page1.json'),
    ...extra,
  });

  it('one partner -> a partner root with the partner guid', async () => {
    const { ctx } = makeCtx(routes(ok('account-partner.json'), { '/v1/workspaces': list([dev(WS1, 'A'), dev(WS2, 'B')]) }));
    expect(await adapter.testConnection(ctx)).toEqual({
      ok: true, rootId: '00000000-0000-4000-8000-0000000000a1', rootName: 'example-partner', rootType: 'partner',
      tenantCount: 2, capabilityNotes: [],
    });
  });

  it('two partners -> refused (not reauth): the root must be one stable id', async () => {
    const { ctx } = makeCtx(routes(ok('account-two-partners.json')));
    const r = await adapter.testConnection(ctx);
    expect(r).toMatchObject({ ok: false, reauth: false });
    expect((r as { error: string }).error).toMatch(/several Emsisoft partner accounts/);
  });

  it('no partner -> a 32-hex workspace_user root, equal for differently-cased/spaced emails, email nowhere in the result', async () => {
    const a = await adapter.testConnection(makeCtx(routes(ok('account-no-partner.json'))).ctx);
    const b = await adapter.testConnection(makeCtx(routes(json({ email: 'a@example.test', partners: [] }))).ctx);
    for (const r of [a, b]) {
      expect(r).toMatchObject({ ok: true, rootType: 'workspace_user', rootName: 'Emsisoft workspace user' });
      expect((r as { rootId: string }).rootId).toMatch(/^user:[0-9a-f]{32}$/);
    }
    expect((a as { rootId: string }).rootId).toBe((b as { rootId: string }).rootId);
    expect((a as { rootId: string }).rootId).toBe(`user:${createHash('sha256').update('a@example.test').digest('hex').slice(0, 32)}`);
    expect(JSON.stringify(a)).not.toMatch(/example\.test/i);
  });

  it('no partner and no email -> refused', async () => {
    const r = await adapter.testConnection(makeCtx(routes(json({ partners: [] }))).ctx);
    expect(r).toMatchObject({ ok: false, reauth: false, error: 'Emsisoft did not return an account identity for this key' });
  });

  it('/account 401 -> reauth', async () => {
    const r = await adapter.testConnection(makeCtx(routes({ status: 401, body: '{}' })).ctx);
    expect(r).toMatchObject({ ok: false, reauth: true });
  });

  it('/workspaces 401 after an OK /account -> ok:false, NOT reauth', async () => {
    const { ctx } = makeCtx(routes(ok('account-partner.json'), { '/v1/workspaces': { status: 401, body: '{}' } }));
    expect(await adapter.testConnection(ctx)).toEqual({ ok: false, reauth: false, error: "The key's user cannot list workspaces" });
  });

  it('a device-probe 401 -> a note, still ok:true', async () => {
    const { ctx } = makeCtx(routes(ok('account-partner.json'), { [`/v1/workspaces/${WS1}/devices`]: { status: 401, body: '{}' } }));
    const r = await adapter.testConnection(ctx);
    expect(r).toMatchObject({ ok: true, tenantCount: 2 });
    expect((r as { capabilityNotes: string[] }).capabilityNotes).toEqual([
      'workspaces: device access denied for at least one workspace (licence-manager role?)',
    ]);
  });

  it('a non-forbidden probe failure is surfaced as a note, never a clean bill of health', async () => {
    const { ctx } = makeCtx(routes(ok('account-partner.json'), { [`/v1/workspaces/${WS1}/devices`]: { status: 500, body: '' } }));
    const r = await adapter.testConnection(ctx);
    expect(r).toMatchObject({ ok: true });
    expect((r as { capabilityNotes: string[] }).capabilityNotes).toEqual(['workspaces: device probe failed (vendor_error)']);
  });

  it('a connection-scope probe failure (rate limited) fails the test rather than reporting ok', async () => {
    const { ctx } = makeCtx(routes(ok('account-partner.json'), { [`/v1/workspaces/${WS1}/devices`]: { status: 429, body: '', headers: { 'Retry-After': '0' } } }));
    expect(await adapter.testConnection(ctx)).toMatchObject({ ok: false, reauth: false });
  });

  it('the probe asks for ONE device (Take=1) rather than paging the whole fleet', async () => {
    const { ctx, calls } = makeCtx(routes(ok('account-partner.json')));
    await adapter.testConnection(ctx);
    const probe = calls.find((c) => c.pathname === `/v1/workspaces/${WS1}/devices`)!;
    expect(probe.searchParams.get('Take')).toBe('1');
  });

  it('zero workspaces is fine: no probe', async () => {
    const { ctx, count } = makeCtx(routes(ok('account-partner.json'), { '/v1/workspaces': list([]) }));
    expect(await adapter.testConnection(ctx)).toMatchObject({ ok: true, tenantCount: 0 });
    expect(count(`/v1/workspaces/${WS1}/devices`)).toBe(0);
  });
});

describe('listTenants / listEndpoints / countEndpoints', () => {
  it('listTenants: pages, keeps an expired workspace, no external code (mapping is name-suggestion only)', async () => {
    const { ctx } = makeCtx({ '/v1/workspaces': [ok('workspaces-page1.json'), ok('workspaces-page2.json')] });
    const tenants = await adapter.listTenants(ctx, { id: 'root', type: 'partner' });
    expect(tenants.map((t) => t.vendorTenantId)).toEqual([WS1, WS2, '00000000-0000-4000-8000-0000000000b3']);
    expect(tenants[1]).toEqual({
      vendorTenantId: WS2, name: 'Example Workspace Two', parentId: null, tenantType: 'workspace', externalCode: null, apiHost: null,
    });
  });

  it('listEndpoints: first-sight values from the device list', async () => {
    const { ctx } = makeCtx({ [`/v1/workspaces/${WS1}/devices`]: ok('devices-page1.json') });
    const eps = await adapter.listEndpoints(ctx, T(WS1));
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({ vendorEndpointId: D1, vendorTenantId: WS1, hostname: 'PC01', health: 'unknown', online: null, macAddresses: [] });
    expect(eps[1]).toMatchObject({ hostname: 'srv01', fqdn: 'srv01.corp.example.test' });
  });

  it('countEndpoints is the same list\'s length', async () => {
    const { ctx } = makeCtx({ [`/v1/workspaces/${WS1}/devices`]: ok('devices-page1.json') });
    expect(await adapter.countEndpoints!(ctx, T(WS1))).toBe(2);
  });

  it('all-or-nothing: a failing page throws and returns no partial list', async () => {
    const page = (n: number) => json({ data: Array.from({ length: 100 }, (_, i) => dev(`00000000-0000-4000-8000-${(n * 100 + i + 1).toString(16).padStart(12, '0')}`, `H${n}-${i}`)), totalCount: 250 });
    const { ctx } = makeCtx({ [`/v1/workspaces/${WS1}/devices`]: [page(0), page(1), { status: 500, body: '' }] });
    expect(await rejection(adapter.listEndpoints(ctx, T(WS1)))).toMatchObject({ code: 'vendor_error', scope: 'tenant' });
  });
});

describe('enrichEndpoints', () => {
  const path = (id: string) => `/v1/devices/${id}/details`;

  it('maps each device detail', async () => {
    const { ctx } = makeCtx({ [path(D1)]: ok('device-details.json'), [path(D2)]: ok('device-details-workgroup.json') });
    const out = await adapter.enrichEndpoints!(ctx, T(WS1), [D1, D2]);
    expect(out.map((d) => d.vendorEndpointId)).toEqual([D1, D2]);
    expect(out[0]).toMatchObject({ health: 'healthy', fqdn: 'pc01.corp.example.test' });
    expect(out[1]).toMatchObject({ health: 'unhealthy', fqdn: null });
  });

  it('skips an id on 404 / 400 and carries on', async () => {
    const { ctx } = makeCtx({ [path(D1)]: { status: 404, body: '' }, [path(D2)]: { status: 400, body: '{}' }, [path(D3)]: ok('device-details.json') });
    const out = await adapter.enrichEndpoints!(ctx, T(WS1), [D1, D2, D3]);
    expect(out.map((d) => d.vendorEndpointId)).toEqual([D3]);
  });

  it('stops on forbidden (operation) and returns what was gathered', async () => {
    const { ctx, count } = makeCtx({ [path(D1)]: ok('device-details.json'), [path(D2)]: { status: 403, body: '' }, [path(D3)]: ok('device-details.json') });
    const out = await adapter.enrichEndpoints!(ctx, T(WS1), [D1, D2, D3]);
    expect(out.map((d) => d.vendorEndpointId)).toEqual([D1]);
    expect(count(path(D3))).toBe(0);
  });

  it('rethrows a connection-scope error (e.g. rate limited)', async () => {
    const { ctx } = makeCtx({ [path(D1)]: { status: 429, body: '', headers: { 'Retry-After': '0' } } });
    await expect(adapter.enrichEndpoints!({ ...ctx }, T(WS1), [D1])).rejects.toMatchObject({ code: 'rate_limited', scope: 'connection' });
  });
});

describe('listDetections', () => {
  const incidentsPath = (ws: string) => `/v1/workspaces/${ws}/incidents`;
  const devicesPath = (ws: string) => `/v1/workspaces/${ws}/devices`;

  it('the discovery window is [now-30d, now] whatever the cursor holds, and the cursor only records windowEnd', async () => {
    const { ctx, calls } = makeCtx({ [incidentsPath(WS1)]: ok('incidents-empty.json') });
    const stale = JSON.stringify({ v: 1, windowEnd: '2026-10-24T00:00:00.000Z' });
    const page = await adapter.listDetections(ctx, T(WS1), stale, NOW);
    const q = calls[0]!.searchParams;
    expect(q.get('DateFrom')).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
    expect(q.get('DateTo')).toBe(NOW.toISOString());
    expect(JSON.parse(page.cursor!)).toEqual({ v: 1, windowEnd: NOW.toISOString() });
    expect(page).toMatchObject({ detections: [], warnings: [] });
  });

  it('one detection per distinct device, attributed from the SAME workspace device list', async () => {
    const { ctx } = makeCtx({
      [incidentsPath(WS1)]: list([incident({ involvedDevices: ['PC01', 'srv01.corp.example.test'] })]),
      [devicesPath(WS1)]: ok('devices-page1.json'),
    });
    const { detections } = await adapter.listDetections(ctx, T(WS1), null, NOW);
    expect(detections.map((d) => [d.vendorDetectionId, d.vendorEndpointId])).toEqual([
      [`${INC}:pc01`, D1], [`${INC}:srv01.corp.example.test`, D2],
    ]);
    expect(detections.every((d) => d.vendorRef === SHA1 && d.groupKey === INC)).toBe(true);
  });

  it('the device list is fetched ONCE for three incidents, and zero times when none names a device', async () => {
    const three = makeCtx({
      [incidentsPath(WS1)]: list([incident({ guid: '00000000-0000-4000-8000-0000000000c1' }), incident({ guid: '00000000-0000-4000-8000-0000000000c2' }), incident({ guid: '00000000-0000-4000-8000-0000000000c3' })]),
      [devicesPath(WS1)]: ok('devices-page1.json'),
    });
    await adapter.listDetections(three.ctx, T(WS1), null, NOW);
    expect(three.count(devicesPath(WS1))).toBe(1);

    const none = makeCtx({ [incidentsPath(WS1)]: list([incident({ involvedDevices: [] }), incident({ guid: '00000000-0000-4000-8000-0000000000c2', involvedDevices: null })]) });
    const { detections } = await adapter.listDetections(none.ctx, T(WS1), null, NOW);
    expect(none.count(devicesPath(WS1))).toBe(0);
    expect(detections.map((d) => d.vendorEndpointId)).toEqual([null, null]);
  });

  it('a same-name device in ANOTHER workspace never resolves (two tenants, one shared runCache)', async () => {
    const shared = new Map<string, Promise<unknown>>();
    const { ctx } = makeCtx({
      [incidentsPath(WS1)]: list([incident()]),
      [incidentsPath(WS2)]: list([incident({ guid: '00000000-0000-4000-8000-0000000000c9' })]),
      [devicesPath(WS1)]: list([dev(D1, 'PC01')]),
      [devicesPath(WS2)]: list([dev(D3, 'OTHER')]),
    }, { runCache: shared });
    const a = await adapter.listDetections(ctx, T(WS1), null, NOW);
    const b = await adapter.listDetections(ctx, T(WS2), null, NOW);
    expect(a.detections[0]!.vendorEndpointId).toBe(D1);
    expect(b.detections[0]!.vendorEndpointId).toBeNull();
    expect(b.detections[0]!.details).toMatchObject({ deviceNameAmbiguous: false });
  });

  it('two devices with one name in a workspace -> unattributed + deviceNameAmbiguous', async () => {
    const { ctx } = makeCtx({
      [incidentsPath(WS1)]: list([incident()]),
      [devicesPath(WS1)]: list([dev(D1, 'PC01'), dev(D2, 'pc01.')]),
    });
    const { detections } = await adapter.listDetections(ctx, T(WS1), null, NOW);
    expect(detections[0]!.vendorEndpointId).toBeNull();
    expect(detections[0]!.details).toMatchObject({ deviceNameAmbiguous: true });
  });

  it('forbidden on /incidents THROWS as a tenant failure (an empty success would read as "no threats")', async () => {
    const { ctx } = makeCtx({ [incidentsPath(WS1)]: { status: 403, body: '{}' } });
    expect(await rejection(adapter.listDetections(ctx, T(WS1), null, NOW))).toMatchObject({ code: 'forbidden', scope: 'tenant', reauth: false });
  });
});

describe('rereadDetectionStatus', () => {
  const incPath = `/v1/workspaces/${WS1}/incidents/${SHA1}`;

  it('ONE vendor call for three sibling refs, applied to all three', async () => {
    const { ctx, count } = makeCtx({ [incPath]: ok('incident-detail.json') });
    const refs = [ref(`${INC}:a`), ref(`${INC}:b`), ref(`${INC}:c`)];
    const out = await adapter.rereadDetectionStatus!(ctx, T(WS1), refs);
    expect(count(incPath)).toBe(1);
    expect(out.map((u) => u.vendorDetectionId)).toEqual(refs.map((r) => r.vendorDetectionId));
    expect(out.every((u) => u.status === 'false_positive')).toBe(true);
  });

  it('a vendor "not found" (404, or a 400 IncidentNotFound) omits the group and never closes it', async () => {
    for (const reply of [{ status: 404, body: '' }, { status: 400, body: fx('error-400-incident-not-found.json') }]) {
      const { ctx } = makeCtx({ [incPath]: reply });
      expect(await adapter.rereadDetectionStatus!(ctx, T(WS1), [ref(`${INC}:a`)])).toEqual([]);
    }
  });

  it('a null-vendorRef ref is omitted with NO vendor call', async () => {
    const { ctx, calls } = makeCtx({});
    expect(await adapter.rereadDetectionStatus!(ctx, T(WS1), [ref('x', { vendorRef: null })])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('one dead group (unrelated 400) is omitted; the other groups still update; the call resolves', async () => {
    const SHA2 = 'a'.repeat(40);
    const SHA3 = 'b'.repeat(40);
    const { ctx } = makeCtx({
      [incPath]: { status: 400, body: '{"code":"SomethingElse"}' },
      [`/v1/workspaces/${WS1}/incidents/${SHA2}`]: { status: 400, body: fx('error-400-incident-not-found.json') },
      [`/v1/workspaces/${WS1}/incidents/${SHA3}`]: ok('incident-detail.json'),
    });
    const out = await adapter.rereadDetectionStatus!(ctx, T(WS1), [
      ref('d1', { groupKey: 'g1' }),
      ref('d2', { groupKey: 'g2', vendorRef: SHA2 }),
      ref('d3', { groupKey: 'g3', vendorRef: SHA3 }),
    ]);
    expect(out.map((u) => u.vendorDetectionId)).toEqual(['d3']);
  });

  it('a tenant-scope error (forbidden on the workspace) fails the tenant; a connection-scope error fails the run', async () => {
    const forbidden = makeCtx({ [incPath]: { status: 403, body: '' } });
    expect(await rejection(adapter.rereadDetectionStatus!(forbidden.ctx, T(WS1), [ref('a')]))).toMatchObject({ code: 'forbidden', scope: 'tenant' });
    const limited = makeCtx({ [incPath]: { status: 429, body: '', headers: { 'Retry-After': '0' } } });
    expect(await rejection(adapter.rereadDetectionStatus!(limited.ctx, T(WS1), [ref('a')]))).toMatchObject({ code: 'rate_limited', scope: 'connection' });
  });

  it('skipped groups are counted by code in a code-only warning (a dead re-read must be visible)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx } = makeCtx({ [incPath]: { status: 400, body: '{"code":"SomethingElse"}' } });
    expect(await adapter.rereadDetectionStatus!(ctx, T(WS1), [ref('a')])).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[edr:emsisoft] status re-read skipped incident groups', { invalid_params: 1 });
    warn.mockRestore();
  });

  it('refs with a NULL groupKey are separate groups (one call and one verdict each), never collapsed into one', async () => {
    const SHA2 = 'c'.repeat(40);
    const { ctx, count } = makeCtx({
      [incPath]: ok('incident-detail.json'),
      [`/v1/workspaces/${WS1}/incidents/${SHA2}`]: json({ verdict: 'New', actionTaken: 'None', actionsTaken: ['None'], severity: 'Malicious', detections: [] }),
    });
    const out = await adapter.rereadDetectionStatus!(ctx, T(WS1), [
      ref('a', { groupKey: null }), ref('b', { groupKey: null, vendorRef: SHA2 }),
    ]);
    expect(count(incPath)).toBe(1);
    expect(count(`/v1/workspaces/${WS1}/incidents/${SHA2}`)).toBe(1);
    expect(out.map((u) => [u.vendorDetectionId, u.status])).toEqual([['a', 'false_positive'], ['b', 'open']]);
  });

  it('refs sharing a vendorRef across groups cost one call', async () => {
    const { ctx, count } = makeCtx({ [incPath]: ok('incident-detail.json') });
    const out = await adapter.rereadDetectionStatus!(ctx, T(WS1), [ref('a', { groupKey: 'g1' }), ref('b', { groupKey: 'g2' })]);
    expect(count(incPath)).toBe(1);
    expect(out).toHaveLength(2);
  });
});

describe('observed rate-limit header log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs once per run: { none: true } when the vendor sends nothing, never the key', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { ctx } = makeCtx({ [`/v1/workspaces/${WS1}/devices`]: ok('devices-page1.json') });
    await adapter.listEndpoints(ctx, T(WS1));
    await adapter.listEndpoints(ctx, T(WS1));
    const lines = info.mock.calls.filter((c) => String(c[0]).includes('[edr:emsisoft]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toEqual({ none: true });
    expect(JSON.stringify(lines)).not.toContain(API_KEY);
  });

  it('logs the observed headers when present, still once per run', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const dpath = `/v1/workspaces/${WS1}/devices`;
    const { ctx } = makeCtx({ [dpath]: [{ ...ok('devices-page1.json'), headers: { 'X-RateLimit-Remaining': '59' } }, { ...ok('devices-page1.json'), headers: { 'X-RateLimit-Remaining': '58' } }] });
    await adapter.listEndpoints(ctx, T(WS1));
    await adapter.listEndpoints(ctx, T(WS1));
    const lines = info.mock.calls.filter((c) => String(c[0]).includes('[edr:emsisoft]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toEqual({ 'x-ratelimit-remaining': '59' });
  });
});
