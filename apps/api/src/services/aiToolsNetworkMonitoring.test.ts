import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000c2';
const SITE = '00000000-0000-4000-8000-0000000000a1';
const OTHER_SITE = '00000000-0000-4000-8000-0000000000a2';
const ASSET = '00000000-0000-4000-8000-0000000000b1';
const TPL = '00000000-0000-4000-8000-0000000000d1';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';
const GUEST = '00000000-0000-4000-8000-0000000000f1';
const DEV = '00000000-0000-4000-8000-0000000000f2';

const h = vi.hoisted(() => {
  const queue: unknown[] = [];
  const chain = (): unknown => {
    const p: unknown = new Proxy(function noop() { /* chain */ }, {
      get(_t, prop) {
        if (prop === 'then') {
          const result = queue.shift();
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
        }
        return () => p;
      },
    });
    return p;
  };
  return {
    queue,
    db: {
      select: vi.fn(() => chain()),
      insert: vi.fn(() => chain()),
      update: vi.fn(() => chain()),
      delete: vi.fn(() => chain()),
    },
    mfa: { ok: true },
    svc: {
      resolveAssetForMutation: vi.fn(),
      resolveOrgIdForAsset: vi.fn(),
      runAssetProbe: vi.fn(),
      loadAssetMetricHistory: vi.fn(),
      loadSnmpDashboard: vi.fn(),
      getConnection: vi.fn(),
      getDecryptedApiKey: vi.fn(),
      listCollectors: vi.fn(),
      listControllerSitesForIntegration: vi.fn(),
      enqueueUnifiSync: vi.fn(),
      createUnifiClient: vi.fn(),
    },
  };
});

vi.mock('../db', () => ({
  db: h.db,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_c: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasSatisfiedMfa: () => h.mfa.ok,
}));
vi.mock('./assetAccessScope', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAssetForMutation: h.svc.resolveAssetForMutation,
  resolveOrgIdForAsset: h.svc.resolveOrgIdForAsset,
}));
vi.mock('./assetProbeRun', () => ({ runAssetProbe: h.svc.runAssetProbe }));
vi.mock('./snmpMetricHistory', () => ({ loadAssetMetricHistory: h.svc.loadAssetMetricHistory, MAX_INSTANCES_PER_OID: 64 }));
vi.mock('./snmpDashboard', () => ({ loadSnmpDashboard: h.svc.loadSnmpDashboard }));
vi.mock('./unifi/unifiConnectionService', () => ({
  getConnection: h.svc.getConnection, getDecryptedApiKey: h.svc.getDecryptedApiKey,
}));
vi.mock('./unifi/unifiCollectorService', () => ({ listCollectors: h.svc.listCollectors }));
vi.mock('./unifi/unifiControllerSiteService', () => ({ listControllerSitesForIntegration: h.svc.listControllerSitesForIntegration }));
vi.mock('./unifi/unifiClient', () => ({
  createUnifiClient: h.svc.createUnifiClient,
  UnifiApiError: class UnifiApiError extends Error { status = 502; },
}));
vi.mock('../jobs/unifiWorker', () => ({ enqueueUnifiSync: h.svc.enqueueUnifiSync }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerSnmpTemplateTools } from './aiToolsSnmpTemplates';
import { registerSnmpMetricsTools } from './aiToolsSnmpMetrics';
import { registerNetworkProbeTools } from './aiToolsNetworkProbe';
import { registerKnownGuestTools } from './aiToolsKnownGuests';
import { registerUnifiTools } from './aiToolsUnifi';

const tools = new Map<string, AiTool>();
for (const register of [
  registerSnmpTemplateTools, registerSnmpMetricsTools, registerNetworkProbeTools, registerKnownGuestTools, registerUnifiTools,
]) register(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1' },
  scope: 'organization',
  orgId: ORG,
  partnerId: null,
  partnerOrgAccess: undefined,
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  allowedSiteIds: undefined,
  canAccessSite: undefined,
  token: { mfa: true },
  ...over,
}) as unknown as AuthContext;
const partnerAuth = (over: Record<string, unknown> = {}) => makeAuth({
  scope: 'partner', orgId: null, partnerId: PARTNER, partnerOrgAccess: 'all',
  accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG, ...over,
});
const restricted = (sites: string[]) => ({ allowedSiteIds: sites, canAccessSite: (s: string | null | undefined) => !!s && sites.includes(s) });

const call = async (name: string, input: Record<string, unknown>, auth = makeAuth()) =>
  JSON.parse(await tools.get(name)!.handler(input, auth)) as Record<string, any>;

const builtin = { id: TPL, orgId: null, name: 'Built-in', isBuiltIn: true, oids: [], description: null, vendor: null, deviceType: null, createdAt: new Date() };
const custom = { id: TPL, orgId: ORG, name: 'Edge', isBuiltIn: false, oids: [{ oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' }], description: null, vendor: null, deviceType: null, createdAt: new Date() };
const OID = { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' };

beforeEach(() => {
  vi.clearAllMocks();
  h.queue.length = 0;
  h.mfa.ok = true;
});

describe('registry shape', () => {
  it('registers exactly the six tools, each description within the 300-char budget', () => {
    expect([...tools.keys()].sort()).toEqual([
      'get_snmp_metrics', 'get_unifi_status', 'manage_known_guests', 'manage_snmp_templates',
      'probe_network_asset', 'trigger_unifi_sync',
    ]);
    for (const tool of tools.values()) {
      expect(tool.definition.description!.length).toBeLessThanOrEqual(300);
      const props = (tool.definition.input_schema as { properties: Record<string, { description?: string }> }).properties;
      for (const [key, value] of Object.entries(props)) {
        if (value.description) expect(value.description.length, `${tool.definition.name}.${key}`).toBeLessThanOrEqual(160);
      }
    }
  });
});

describe('MFA parity: every REST write route carries requireMfa()', () => {
  const writes: Array<[string, Record<string, unknown>, () => AuthContext]> = [
    ['manage_snmp_templates', { action: 'create', name: 'X', oids: [OID] }, () => makeAuth()],
    ['manage_snmp_templates', { action: 'update', templateId: TPL, name: 'X' }, () => makeAuth()],
    ['manage_snmp_templates', { action: 'delete', templateId: TPL }, () => makeAuth()],
    ['probe_network_asset', { assetId: ASSET }, () => makeAuth()],
    ['manage_known_guests', { action: 'add', macAddress: 'aa:bb:cc:dd:ee:ff', label: 'x' }, () => partnerAuth()],
    ['manage_known_guests', { action: 'delete', guestId: GUEST }, () => partnerAuth()],
    ['trigger_unifi_sync', {}, () => partnerAuth()],
  ];
  it.each(writes)('%s %j is refused without a satisfied MFA claim and touches nothing', async (name, input, auth) => {
    h.mfa.ok = false;
    const out = await call(name, input, auth());
    expect(out.code).toBe('MFA_REQUIRED');
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.db.delete).not.toHaveBeenCalled();
    expect(h.svc.runAssetProbe).not.toHaveBeenCalled();
    expect(h.svc.enqueueUnifiSync).not.toHaveBeenCalled();
  });

  it('reads do not need the MFA claim', async () => {
    h.mfa.ok = false;
    h.queue.push([]);
    const out = await call('manage_snmp_templates', { action: 'list' });
    expect(out.templates).toEqual([]);
  });
});

describe('manage_snmp_templates', () => {
  it('rejects an unknown action', async () => {
    expect((await call('manage_snmp_templates', { action: 'purge' })).error).toMatch(/Unknown action/);
  });

  it('a site-restricted or device-restricted caller cannot write the org-wide row, but can read', async () => {
    for (const over of [restricted([SITE]), { allowedDeviceIds: [DEV] }]) {
      for (const input of [
        { action: 'create', name: 'X', oids: [OID] },
        { action: 'update', templateId: TPL, name: 'X' },
        { action: 'delete', templateId: TPL },
      ]) {
        const out = await call('manage_snmp_templates', input, makeAuth(over));
        expect(out.code, JSON.stringify(input)).toBe('ACCESS_DENIED');
      }
    }
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.db.delete).not.toHaveBeenCalled();
    h.queue.push([custom]);
    const read = await call('manage_snmp_templates', { action: 'list' }, makeAuth(restricted([SITE])));
    expect(read.templates).toHaveLength(1);
    expect(read.templates[0].oidCount).toBe(1);
    expect(read.templates[0].oids).toBeUndefined();
  });

  it('create validates with the route schema and binds the caller org', async () => {
    const bad = await call('manage_snmp_templates', { action: 'create', name: 'X', oids: [{ oid: '1.3.6.1' }] });
    expect(bad.code).toBe('VALIDATION_ERROR');
    expect(h.db.insert).not.toHaveBeenCalled();

    h.queue.push([custom]);
    const ok = await call('manage_snmp_templates', { action: 'create', name: 'Edge', oids: [OID] });
    expect(ok).toMatchObject({ created: true, template: { id: TPL, source: 'custom' } });
    expect(h.db.insert).toHaveBeenCalledTimes(1);
  });

  it('an org caller cannot create in another org', async () => {
    const out = await call('manage_snmp_templates', { action: 'create', name: 'X', oids: [OID], orgId: OTHER_ORG });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it('update/delete: a hidden, built-in or org-less row is refused and nothing is written', async () => {
    h.queue.push([]); // hidden / other org: not found
    expect((await call('manage_snmp_templates', { action: 'update', templateId: TPL, name: 'X' })).code).toBe('NOT_FOUND');
    h.queue.push([builtin]);
    expect((await call('manage_snmp_templates', { action: 'update', templateId: TPL, name: 'X' })).code).toBe('BUILT_IN');
    h.queue.push([builtin]);
    expect((await call('manage_snmp_templates', { action: 'delete', templateId: TPL })).code).toBe('BUILT_IN');
    // QW3: a custom system-scope row (no org) is never written by a tenant caller, even a system-scope one.
    h.queue.push([{ ...custom, orgId: null }]);
    expect((await call('manage_snmp_templates', { action: 'update', templateId: TPL, name: 'X' }, makeAuth({ scope: 'system', canAccessOrg: () => true }))).code).toBe('NOT_FOUND');
    // a row of an org the caller cannot reach
    h.queue.push([{ ...custom, orgId: OTHER_ORG }]);
    expect((await call('manage_snmp_templates', { action: 'delete', templateId: TPL })).code).toBe('NOT_FOUND');
    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.db.delete).not.toHaveBeenCalled();
  });

  it('update with no fields is a validation error; with fields it writes once', async () => {
    h.queue.push([custom]);
    expect((await call('manage_snmp_templates', { action: 'update', templateId: TPL })).code).toBe('VALIDATION_ERROR');
    h.queue.push([custom], [{ ...custom, name: 'Renamed' }]);
    const ok = await call('manage_snmp_templates', { action: 'update', templateId: TPL, name: 'Renamed' });
    expect(ok).toMatchObject({ updated: true, updatedFields: ['name'], template: { name: 'Renamed' } });
    expect(h.db.update).toHaveBeenCalledTimes(1);
  });

  it('delete refuses a template still used by a device, and returns the removed row as the restore point', async () => {
    h.queue.push([custom], [{ id: 'dev' }]);
    expect((await call('manage_snmp_templates', { action: 'delete', templateId: TPL })).code).toBe('IN_USE');
    expect(h.db.delete).not.toHaveBeenCalled();
    h.queue.push([custom], [], [custom]);
    const ok = await call('manage_snmp_templates', { action: 'delete', templateId: TPL });
    expect(ok).toMatchObject({ deleted: true, template: { id: TPL, oids: custom.oids } });
    expect(h.db.delete).toHaveBeenCalledTimes(1);
  });

  it('validate_oids flags a malformed and a duplicate OID', async () => {
    h.queue.push([]);
    const out = await call('manage_snmp_templates', { action: 'validate_oids', oids: [{ oid: 'sysUpTime' }, { oid: '1.3.6.1.2.1.1.3.0' }, { oid: '1.3.6.1.2.1.1.3.0' }] });
    expect(out.valid).toBe(false);
    expect(out.results[0].valid).toBe(false);
    expect(out.results[1].valid).toBe(true);
    expect(out.results[2].errors[0]).toMatch(/Duplicate/);
  });

  it('browse_oids returns the built-in catalog filtered by the query', async () => {
    h.queue.push([]);
    const out = await call('manage_snmp_templates', { action: 'browse_oids', query: 'ifinoctets' });
    expect(out.total).toBeGreaterThanOrEqual(1);
    expect(out.results[0]).toMatchObject({ name: 'ifInOctets', source: 'catalog' });
  });
});

describe('error and size helpers', () => {
  it('an unexpected throw reaches the model as a generic error, never the raw message', async () => {
    h.queue.push(Promise.reject(new Error('connection string postgres://user:s3cret@db failed')));
    const out = await call('manage_snmp_templates', { action: 'list' });
    expect(out).toEqual({ error: 'Operation failed. Check server logs for details.' });
    expect(JSON.stringify(out)).not.toMatch(/s3cret|postgres/);
  });

  it('an oversized result is refused instead of flooding the context', async () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ ...custom, id: `${i}`, name: 'x'.repeat(1000) }));
    h.queue.push(big);
    expect((await call('manage_snmp_templates', { action: 'list' })).code).toBe('result_too_large');
  });
});

describe('get_snmp_metrics', () => {
  const asset = { id: ASSET, orgId: ORG, siteId: SITE, linkedDeviceId: null };

  it('history: an out-of-site asset is the same not-found as a missing one and the query never runs', async () => {
    h.svc.resolveOrgIdForAsset.mockResolvedValue({ orgId: ORG });
    h.queue.push([{ ...asset, siteId: OTHER_SITE }]);
    const hidden = await call('get_snmp_metrics', { action: 'history', assetId: ASSET, oid: '1.3.6.1.2.1.2.2.1.10' }, makeAuth(restricted([SITE])));
    h.queue.push([]);
    const missing = await call('get_snmp_metrics', { action: 'history', assetId: ASSET, oid: '1.3.6.1.2.1.2.2.1.10' }, makeAuth(restricted([SITE])));
    expect(hidden).toEqual(missing);
    expect(hidden.code).toBe('NOT_FOUND');
    expect(h.svc.loadAssetMetricHistory).not.toHaveBeenCalled();
  });

  it('history: an empty site or device allowlist sees nothing without a query', async () => {
    for (const over of [restricted([]), { allowedDeviceIds: [] }]) {
      const out = await call('get_snmp_metrics', { action: 'history', assetId: ASSET, oid: '1.3.6.1' }, makeAuth(over));
      expect(out.code).toBe('NOT_FOUND');
    }
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it('history: a device-bound caller only sees assets linked to an allowed device', async () => {
    h.svc.resolveOrgIdForAsset.mockResolvedValue({ orgId: ORG });
    h.queue.push([{ ...asset, linkedDeviceId: null }]);
    const out = await call('get_snmp_metrics', { action: 'history', assetId: ASSET, oid: '1.3.6.1' }, makeAuth({ allowedDeviceIds: [DEV] }));
    expect(out.code).toBe('NOT_FOUND');
    expect(h.svc.loadAssetMetricHistory).not.toHaveBeenCalled();
  });

  it('history: an in-site asset runs the shared query with the route inputs', async () => {
    h.svc.resolveOrgIdForAsset.mockResolvedValue({ orgId: ORG });
    h.queue.push([asset]);
    h.svc.loadAssetMetricHistory.mockResolvedValue({ ok: true, body: { series: [], truncatedSeries: false, bucket: '5m' } });
    const out = await call('get_snmp_metrics', { action: 'history', assetId: ASSET, oid: '1.3.6.1.2.1.2.2.1.10', bucket: '5m', delta: true }, makeAuth(restricted([SITE])));
    expect(out.bucket).toBe('5m');
    expect(h.svc.loadAssetMetricHistory).toHaveBeenCalledWith(
      { id: ASSET, orgId: ORG },
      expect.objectContaining({ oid: '1.3.6.1.2.1.2.2.1.10', bucket: '5m', delta: '1' }),
    );
  });

  it('history: a route validation failure is a validation error, not a crash', async () => {
    h.svc.resolveOrgIdForAsset.mockResolvedValue({ orgId: ORG });
    h.queue.push([asset]);
    h.svc.loadAssetMetricHistory.mockResolvedValue({ ok: false, status: 400, error: 'range too wide' });
    const out = await call('get_snmp_metrics', { action: 'history', assetId: ASSET, oid: '1.3.6.1' });
    expect(out).toEqual({ error: 'range too wide', code: 'VALIDATION_ERROR' });
  });

  it('dashboard: a device-bound caller is refused; a site-restricted caller is narrowed to their sites', async () => {
    const refused = await call('get_snmp_metrics', { action: 'dashboard' }, makeAuth({ allowedDeviceIds: [DEV] }));
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(h.svc.loadSnmpDashboard).not.toHaveBeenCalled();

    h.svc.loadSnmpDashboard.mockResolvedValue({ data: { totals: { devices: 1 } } });
    const ok = await call('get_snmp_metrics', { action: 'dashboard' }, makeAuth(restricted([SITE])));
    expect(ok.data.totals.devices).toBe(1);
    expect(h.svc.loadSnmpDashboard).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, allowedSiteIds: [SITE] }));
  });

  it('dashboard: an empty site allowlist is refused without a query', async () => {
    expect((await call('get_snmp_metrics', { action: 'dashboard' }, makeAuth(restricted([])))).code).toBe('ACCESS_DENIED');
    expect(h.svc.loadSnmpDashboard).not.toHaveBeenCalled();
  });

  it('dashboard: an org caller cannot name another org', async () => {
    const out = await call('get_snmp_metrics', { action: 'dashboard', orgId: OTHER_ORG });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.svc.loadSnmpDashboard).not.toHaveBeenCalled();
  });
});

describe('probe_network_asset', () => {
  const asset = { id: ASSET, orgId: ORG, siteId: SITE, linkedDeviceId: null, ipAddress: '192.0.2.10' };

  it('a resolver refusal (404 or 403) is one answer', async () => {
    h.svc.resolveAssetForMutation.mockResolvedValueOnce({ error: 'Asset not found', status: 404 });
    const a = await call('probe_network_asset', { assetId: ASSET });
    h.svc.resolveAssetForMutation.mockResolvedValueOnce({ error: 'Access to this site denied', status: 403 });
    const b = await call('probe_network_asset', { assetId: ASSET });
    expect(a).toEqual(b);
    expect(a.code).toBe('NOT_FOUND');
    expect(h.svc.runAssetProbe).not.toHaveBeenCalled();
  });

  it('the route locking resolver is given the caller site allowlist', async () => {
    h.svc.resolveAssetForMutation.mockResolvedValue({ asset });
    h.svc.runAssetProbe.mockResolvedValue({ status: 200, body: { probe: { state: 'ok' }, reachability: null } });
    await call('probe_network_asset', { assetId: ASSET }, makeAuth(restricted([SITE])));
    expect(h.svc.resolveAssetForMutation).toHaveBeenCalledWith(expect.anything(), { allowedSiteIds: [SITE] }, ASSET);
  });

  it('an empty allowlist never reaches the resolver; an unlinked asset is hidden from a device-bound caller', async () => {
    expect((await call('probe_network_asset', { assetId: ASSET }, makeAuth(restricted([])))).code).toBe('NOT_FOUND');
    expect(h.svc.resolveAssetForMutation).not.toHaveBeenCalled();
    h.svc.resolveAssetForMutation.mockResolvedValue({ asset });
    expect((await call('probe_network_asset', { assetId: ASSET }, makeAuth({ allowedDeviceIds: [DEV] }))).code).toBe('NOT_FOUND');
    expect(h.svc.runAssetProbe).not.toHaveBeenCalled();
  });

  it('a dispatch that never reached the agent is an error, not an "unreachable" asset', async () => {
    h.svc.resolveAssetForMutation.mockResolvedValue({ asset });
    h.svc.runAssetProbe.mockResolvedValue({ status: 200, body: { probe: { state: 'failed', error: 'dispatch offline: relay seal failed: boom' }, reachability: null } });
    const out = await call('probe_network_asset', { assetId: ASSET });
    expect(out.code).toBe('DISPATCH_FAILED');
    expect(JSON.stringify(out)).not.toMatch(/relay|boom/);
  });

  it('maps the probe outcomes: 200 verbatim, 202 with a hint, 409/422 as a coded error', async () => {
    h.svc.resolveAssetForMutation.mockResolvedValue({ asset });
    h.svc.runAssetProbe.mockResolvedValueOnce({ status: 200, body: { probe: { state: 'ok', responseMs: 3 }, reachability: null } });
    expect((await call('probe_network_asset', { assetId: ASSET })).probe.state).toBe('ok');
    h.svc.runAssetProbe.mockResolvedValueOnce({ status: 202, body: { probe: { state: 'pending' }, reachability: null } });
    expect((await call('probe_network_asset', { assetId: ASSET })).note).toMatch(/get_network_asset_reachability/);
    h.svc.runAssetProbe.mockResolvedValueOnce({ status: 409, body: { error: 'No online agent in this asset’s site', code: 'NO_AGENT_IN_SITE' } });
    expect(await call('probe_network_asset', { assetId: ASSET })).toEqual({ error: 'No online agent in this asset’s site', code: 'NO_AGENT_IN_SITE' });
  });
});

describe('manage_known_guests', () => {
  it('needs full partner scope for every action, reads included', async () => {
    for (const auth of [makeAuth(), partnerAuth({ partnerOrgAccess: 'selected' }), makeAuth({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: undefined })]) {
      expect((await call('manage_known_guests', { action: 'list' }, auth)).code).toBe('ACCESS_DENIED');
    }
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it('a system caller without a partner is refused', async () => {
    const out = await call('manage_known_guests', { action: 'list' }, makeAuth({ scope: 'system', partnerId: null }));
    expect(out).toEqual({ error: 'Partner context required', code: 'ACCESS_DENIED' });
  });

  it('list projects the row (no addedBy user id)', async () => {
    h.queue.push([{ id: GUEST, macAddress: 'aa:bb:cc:dd:ee:ff', label: 'Kiosk', notes: null, createdAt: new Date() }]);
    const out = await call('manage_known_guests', { action: 'list' }, partnerAuth());
    expect(out.guests).toHaveLength(1);
    expect(out.truncated).toBe(false);
  });

  it('add validates the MAC with the route rule and treats a duplicate as already-exists', async () => {
    expect((await call('manage_known_guests', { action: 'add', macAddress: 'not-a-mac', label: 'x' }, partnerAuth())).code).toBe('VALIDATION_ERROR');
    expect(h.db.insert).not.toHaveBeenCalled();
    h.queue.push([]);
    expect((await call('manage_known_guests', { action: 'add', macAddress: 'AA:BB:CC:DD:EE:FF', label: 'x' }, partnerAuth())).code).toBe('ALREADY_EXISTS');
    h.queue.push([{ id: GUEST, macAddress: 'aa:bb:cc:dd:ee:ff', label: 'x', notes: null, createdAt: new Date() }]);
    const ok = await call('manage_known_guests', { action: 'add', macAddress: 'AA:BB:CC:DD:EE:FF', label: 'x' }, partnerAuth());
    expect(ok.added).toBe(true);
  });

  it('delete of another partner’s (or a missing) id is not-found', async () => {
    h.queue.push([]);
    expect((await call('manage_known_guests', { action: 'delete', guestId: GUEST }, partnerAuth())).code).toBe('NOT_FOUND');
    h.queue.push([{ id: GUEST, macAddress: 'aa:bb:cc:dd:ee:ff', label: 'x' }]);
    expect((await call('manage_known_guests', { action: 'delete', guestId: GUEST }, partnerAuth())).deleted).toBe(true);
  });
});

describe('get_unifi_status / trigger_unifi_sync', () => {
  const conn = { id: 'integration-1', baseUrl: 'https://api.example.test', connectionType: 'cloud', status: 'active', accountLabel: 'Acme', lastSyncAt: null, lastSyncStatus: 'ok', lastSyncError: null };

  it('both tools need full partner scope; an org token gets the partner-scope message', async () => {
    for (const [name, input] of [['get_unifi_status', { action: 'status' }], ['trigger_unifi_sync', {}]] as const) {
      expect((await call(name, input, makeAuth())).code).toBe('ACCESS_DENIED');
      expect((await call(name, input, partnerAuth({ partnerOrgAccess: 'selected' }))).code).toBe('ACCESS_DENIED');
    }
    expect(h.svc.getConnection).not.toHaveBeenCalled();
    expect(h.svc.enqueueUnifiSync).not.toHaveBeenCalled();
  });

  it('a partner token cannot name another partner; a system token must name one', async () => {
    expect((await call('get_unifi_status', { action: 'status', partnerId: '00000000-0000-4000-8000-0000000000ff' }, partnerAuth())).error).toMatch(/denied/);
    expect((await call('get_unifi_status', { action: 'status' }, makeAuth({ scope: 'system' }))).error).toMatch(/partnerId is required/);
  });

  it('status reports not connected, and connected without any key material', async () => {
    h.svc.getConnection.mockResolvedValueOnce(null);
    expect(await call('get_unifi_status', { action: 'status' }, partnerAuth())).toEqual({ connected: false });
    h.svc.getConnection.mockResolvedValueOnce(conn);
    const out = await call('get_unifi_status', { action: 'status' }, partnerAuth());
    expect(out).toMatchObject({ connected: true, accountLabel: 'Acme' });
    expect(JSON.stringify(out)).not.toMatch(/baseUrl|apiKey|api\.example/);
  });

  it('collectors and mappings are narrowed to the caller’s sites; collectors carry no device or key fields', async () => {
    h.svc.getConnection.mockResolvedValue(conn);
    h.svc.listCollectors.mockResolvedValue([
      { id: 'c1', siteId: SITE, unifiHostId: 'h', controllerUrl: 'https://10.0.0.1', isEnabled: true, pollIntervalSeconds: 60, status: 'ok', firmwareOk: true, lastPollAt: null, lastPollStatus: 'ok', lastPollError: null, collectorDeviceId: DEV, integrationId: 'i', orgId: ORG },
      { id: 'c2', siteId: OTHER_SITE, unifiHostId: 'h2', controllerUrl: 'https://10.0.0.2', isEnabled: true, pollIntervalSeconds: 60, status: 'ok', firmwareOk: true, lastPollAt: null, lastPollStatus: 'ok', lastPollError: null, collectorDeviceId: DEV, integrationId: 'i', orgId: ORG },
    ]);
    const out = await call('get_unifi_status', { action: 'collectors' }, partnerAuth(restricted([SITE])));
    expect(out.collectors.map((c: { id: string }) => c.id)).toEqual(['c1']);
    expect(out.collectors[0].collectorDeviceId).toBeUndefined();
    expect(out.collectors[0].orgId).toBeUndefined();

    h.queue.push([{ id: 'm1', siteId: SITE }, { id: 'm2', siteId: OTHER_SITE }]);
    const maps = await call('get_unifi_status', { action: 'mappings' }, partnerAuth(restricted([SITE])));
    expect(maps.mappings.map((m: { id: string }) => m.id)).toEqual(['m1']);
  });

  it('telemetry: an unknown site, another org’s site and an out-of-site site are one answer', async () => {
    h.svc.getConnection.mockResolvedValue(conn);
    h.queue.push([]);
    const missing = await call('get_unifi_status', { action: 'telemetry', siteId: SITE }, partnerAuth());
    h.queue.push([{ id: SITE, orgId: OTHER_ORG }]);
    const otherOrg = await call('get_unifi_status', { action: 'telemetry', siteId: SITE }, partnerAuth());
    h.queue.push([{ id: SITE, orgId: ORG }]);
    const outOfSite = await call('get_unifi_status', { action: 'telemetry', siteId: SITE }, partnerAuth(restricted([OTHER_SITE])));
    expect(missing).toEqual(otherOrg);
    expect(missing).toEqual(outOfSite);
    expect(missing.code).toBe('NOT_FOUND');
  });

  it('telemetry returns the projected rows', async () => {
    h.svc.getConnection.mockResolvedValue(conn);
    h.queue.push([{ id: SITE, orgId: ORG }], [{ unifiDeviceId: 'd1', name: 'AP' }], [{ mac: 'aa:bb:cc:dd:ee:ff' }]);
    const out = await call('get_unifi_status', { action: 'telemetry', siteId: SITE }, partnerAuth());
    expect(out.devices).toHaveLength(1);
    expect(out.clients).toHaveLength(1);
    expect(out.truncated).toBe(false);
  });

  it('hosts: a vendor failure is summarised, never relayed', async () => {
    h.svc.getConnection.mockResolvedValue(conn);
    h.svc.getDecryptedApiKey.mockResolvedValue('secret-key');
    h.svc.createUnifiClient.mockReturnValue({
      listHosts: vi.fn().mockRejectedValue(new Error('upstream said: Authorization: Bearer secret-key')),
      listSites: vi.fn().mockResolvedValue([]),
    });
    const out = await call('get_unifi_status', { action: 'hosts' }, partnerAuth());
    expect(JSON.stringify(out)).not.toMatch(/secret-key|Bearer/);
    expect(out.error).toMatch(/Operation failed/);
  });

  it('hosts: a vendor API error is coded, a rejected key says to reconnect, and the body is not relayed', async () => {
    const { UnifiApiError } = await import('./unifi/unifiClient');
    h.svc.getConnection.mockResolvedValue(conn);
    h.svc.getDecryptedApiKey.mockResolvedValue('k');
    const failing = (status: number) => h.svc.createUnifiClient.mockReturnValue({
      listHosts: vi.fn().mockRejectedValue(Object.assign(new UnifiApiError('body: secret-key', status), { status })),
      listSites: vi.fn().mockResolvedValue([]),
    });
    failing(401);
    expect((await call('get_unifi_status', { action: 'hosts' }, partnerAuth())).code).toBe('UPSTREAM_AUTH');
    failing(502);
    const out = await call('get_unifi_status', { action: 'hosts' }, partnerAuth());
    expect(out).toEqual({ error: 'The UniFi cloud request failed (HTTP 502)', code: 'UPSTREAM_ERROR' });
  });

  it('hosts and controller_sites span every site, so a site-restricted partner caller is refused', async () => {
    h.svc.getConnection.mockResolvedValue(conn);
    for (const action of ['hosts', 'controller_sites']) {
      expect((await call('get_unifi_status', { action }, partnerAuth(restricted([SITE])))).code, action).toBe('ACCESS_DENIED');
    }
    expect(h.svc.createUnifiClient).not.toHaveBeenCalled();
    expect(h.svc.listControllerSitesForIntegration).not.toHaveBeenCalled();
  });

  it('hosts lists every host that has a site, whatever its type', async () => {
    h.svc.getConnection.mockResolvedValue(conn);
    h.svc.getDecryptedApiKey.mockResolvedValue('k');
    h.svc.createUnifiClient.mockReturnValue({
      listHosts: vi.fn().mockResolvedValue([
        { id: 'h1', name: 'Console', model: 'UDM', type: 'console' },
        { id: 'h2', name: 'No sites', model: 'UDM', type: 'console' },
        { id: 'h3', name: 'Cloud key', model: 'CK', type: 'cloudkey' },
      ]),
      listSites: vi.fn().mockResolvedValue([{ id: 's1', name: 'Main', hostId: 'h1' }, { id: 's3', name: 'x', hostId: 'h3' }]),
    });
    const out = await call('get_unifi_status', { action: 'hosts' }, partnerAuth());
    expect(out.hosts).toEqual([
      { id: 'h1', name: 'Console', model: 'UDM', type: 'console', sites: [{ id: 's1', name: 'Main' }] },
      { id: 'h3', name: 'Cloud key', model: 'CK', type: 'cloudkey', sites: [{ id: 's3', name: 'x' }] },
    ]);
    expect(out.omitted).toEqual({ hostsWithoutSites: 1, sitesWithoutHostId: 0 });
  });

  it('sync_runs projects the row shape (no partner or integration id)', async () => {
    h.svc.getConnection.mockResolvedValue(conn);
    h.queue.push([{ id: 'r1', trigger: 'manual', status: 'ok', startedAt: new Date(), finishedAt: null, hostsSeen: 1, devicesCreated: 0, devicesUpdated: 0, devicesUnchanged: 1, devicesRemoved: 0, error: null, integrationId: 'x', partnerId: PARTNER }]);
    const out = await call('get_unifi_status', { action: 'sync_runs' }, partnerAuth());
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].partnerId).toBeUndefined();
  });

  it('trigger_unifi_sync: not connected is an error; connected enqueues once for the caller’s partner', async () => {
    h.svc.getConnection.mockResolvedValueOnce(null);
    expect((await call('trigger_unifi_sync', {}, partnerAuth())).code).toBe('NOT_CONNECTED');
    expect(h.svc.enqueueUnifiSync).not.toHaveBeenCalled();
    h.svc.getConnection.mockResolvedValueOnce(conn);
    const ok = await call('trigger_unifi_sync', {}, partnerAuth());
    expect(ok.queued).toBe(true);
    expect(h.svc.enqueueUnifiSync).toHaveBeenCalledTimes(1);
    expect(h.svc.enqueueUnifiSync).toHaveBeenCalledWith('integration-1', PARTNER, 'manual');
  });
});
