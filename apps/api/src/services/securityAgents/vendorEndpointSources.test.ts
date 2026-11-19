import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each db.select() call takes the next queued result set, in query order.
const queued: unknown[][] = [];
const selectCalls: number[] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin', 'limit']) c[m] = vi.fn(() => c);
  c.then = (resolve: (value: unknown[]) => unknown, reject?: (err: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      selectCalls.push(1);
      return chain(queued.shift() ?? []);
    }),
  },
}));

import { classifyOrgCoverage, type DeviceCoverageInput, type VendorEndpointView } from './coverageReconciler';
import { listVendors } from './securityAgentVendors';
import {
  getVendorEndpointSource,
  sentinelOneEndpointSource,
  VENDOR_VIEW_STALE_MS,
} from './vendorEndpointSources';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const PARTNER = '00000000-0000-4000-8000-0000000000b1';
const INTEGRATION = '00000000-0000-4000-8000-0000000000d1';

const fresh = () => new Date(Date.now() - 60_000);

function queueS1(opts: {
  org?: Array<{ partnerId: string | null }>;
  integrations?: Array<{ id: string; lastSyncAt: Date | null }>;
  agents?: Array<{ id: string; orgId: string; deviceId: string | null; hostname: string | null; status: string | null }>;
}) {
  queued.push(opts.org ?? [{ partnerId: PARTNER }]);
  queued.push(opts.integrations ?? [{ id: INTEGRATION, lastSyncAt: fresh() }]);
  queued.push(opts.agents ?? []);
}

beforeEach(() => {
  queued.length = 0;
  selectCalls.length = 0;
});

describe('edr_endpoints source for framework vendors (#8170)', () => {
  const TENANT = '00000000-0000-4000-8000-0000000000f1';
  const OTHER_TENANT = '00000000-0000-4000-8000-0000000000f2';
  const live = (over: Record<string, unknown> = {}) => ({ id: TENANT, lastInventorySyncAt: fresh(), connectionActive: true, connectionStatus: 'connected', ...over });
  const endpoint = (over: Record<string, unknown> = {}) => ({ id: 'ep-1', orgId: ORG, deviceId: null, hostname: 'PC-1', online: true, ...over });
  const source = () => getVendorEndpointSource('bitdefender')!;
  const queueEdr = (opts: { org?: Array<{ partnerId: string | null }>; tenants?: unknown[]; endpoints?: unknown[] }) => {
    queued.push(opts.org ?? [{ partnerId: PARTNER }]);
    queued.push(opts.tenants ?? [live()]);
    queued.push(opts.endpoints ?? []);
  };

  it('every framework vendor has a source; it claims no vendor-side org, so mismatched_org is never produced', () => {
    for (const vendor of listVendors().filter((entry) => entry.orgSource === 'edr_framework')) {
      const entry = getVendorEndpointSource(vendor.key);
      expect(entry?.vendor).toBe(vendor.key);
      expect(entry?.reportsVendorOrg).toBe(false);
    }
  });

  it('maps rows: linked, unlinked and offline', async () => {
    queueEdr({ endpoints: [endpoint({ deviceId: 'dev-1' }), endpoint({ id: 'ep-2', hostname: 'PC-2', online: false }), endpoint({ id: 'ep-3', online: null })] });
    await expect(source().listForOrg(ORG)).resolves.toEqual([
      { endpointId: 'ep-1', orgId: ORG, deviceId: 'dev-1', hostname: 'PC-1', online: true },
      { endpointId: 'ep-2', orgId: ORG, deviceId: null, hostname: 'PC-2', online: false },
      { endpointId: 'ep-3', orgId: ORG, deviceId: null, hostname: 'PC-1', online: null },
    ]);
  });

  it('a fresh sync with no endpoints is an empty view, not unavailable', async () => {
    queueEdr({ endpoints: [] });
    await expect(source().listForOrg(ORG)).resolves.toEqual([]);
  });

  it.each([
    ['the org has no partner', { org: [{ partnerId: null }] }],
    ['the org has no mapped tenant', { tenants: [] }],
    ['a tenant was never synced', { tenants: [live({ lastInventorySyncAt: null })] }],
    ['a tenant is stale', { tenants: [live({ lastInventorySyncAt: new Date(Date.now() - VENDOR_VIEW_STALE_MS - 1000) })] }],
    ['the connection is inactive', { tenants: [live({ connectionActive: false })] }],
    ['the connection needs reauth', { tenants: [live({ connectionStatus: 'reauth_required' })] }],
    ['one of two tenants is stale', { tenants: [live(), live({ id: OTHER_TENANT, lastInventorySyncAt: null })] }],
  ])('unavailable (null), never empty, when %s', async (_name, opts) => {
    queueEdr({ ...opts, endpoints: [endpoint()] });
    await expect(source().listForOrg(ORG)).resolves.toBeNull();
    // Stops at the failed check: no endpoint read.
    expect(selectCalls.length).toBeLessThanOrEqual(2);
  });

  it("reads only: three selects and nothing else, in the caller's context", async () => {
    queueEdr({});
    await source().listForOrg(ORG);
    expect(selectCalls).toHaveLength(3);
  });

  it('through the reconciler: linked is covered, offline is vendor_offline, unlinked is vendor_only', async () => {
    queueEdr({ endpoints: [
      endpoint({ id: 'ep-linked', deviceId: 'dev-1', hostname: 'one' }),
      endpoint({ id: 'ep-off', deviceId: 'dev-2', hostname: 'two', online: false }),
      endpoint({ id: 'ep-free', hostname: 'stranger' }),
    ] });
    const endpoints = (await source().listForOrg(ORG))!;
    const device = (deviceId: string, hostname: string): DeviceCoverageInput => ({
      deviceId, orgId: ORG, hostnames: [hostname], install: 'installed', installRemediationStatus: null, installArmed: true,
    });
    const result = classifyOrgCoverage({
      orgId: ORG,
      reportsVendorOrg: source().reportsVendorOrg,
      devices: [device('dev-1', 'one'), device('dev-2', 'two')],
      endpoints,
      knownDeviceHostnames: new Set(),
    });
    expect(result.decisions.get('dev-1')?.state).toBe('covered');
    expect(result.decisions.get('dev-2')?.state).toBe('vendor_offline');
    expect(result.vendorOnly.map((entry) => entry.endpointId)).toEqual(['ep-free']);
  });
});

describe('vendor endpoint source registry (#6960 W04)', () => {
  it('SentinelOne has a source (s1_agents); the DNS vendors still have none', () => {
    expect(getVendorEndpointSource('sentinelone')).toBe(sentinelOneEndpointSource);
    expect(getVendorEndpointSource('huntress')?.vendor).toBe('huntress');
    expect(getVendorEndpointSource('controld')).toBeNull();
    expect(getVendorEndpointSource('nextdns')).toBeNull();
  });

  it('the SentinelOne source reports a vendor-side org (its org comes from the site mapping)', () => {
    expect(sentinelOneEndpointSource.vendor).toBe('sentinelone');
    expect(sentinelOneEndpointSource.reportsVendorOrg).toBe(true);
  });
});

describe('sentinelOneEndpointSource.listForOrg — view availability', () => {
  it.each<[string, Parameters<typeof queueS1>[0]]>([
    ['the org has no partner', { org: [{ partnerId: null }] }],
    ['the org is gone', { org: [] }],
    ['no active integration for the partner', { integrations: [] }],
    ['the integration never synced', { integrations: [{ id: INTEGRATION, lastSyncAt: null }] }],
    ['the last sync is stale', { integrations: [{ id: INTEGRATION, lastSyncAt: new Date(Date.now() - VENDOR_VIEW_STALE_MS - 60_000) }] }],
  ])('returns null (unavailable, never []) when %s', async (_name, opts) => {
    queueS1(opts);
    await expect(sentinelOneEndpointSource.listForOrg(ORG)).resolves.toBeNull();
  });

  it('a fresh sync with no agents is an empty view, not unavailable', async () => {
    queueS1({});
    await expect(sentinelOneEndpointSource.listForOrg(ORG)).resolves.toEqual([]);
  });

  it('maps s1_agents rows: hostname from metadata.computerName, status online/offline, unknown status is null', async () => {
    queueS1({
      agents: [
        { id: 'a1', orgId: ORG, deviceId: 'd1', hostname: 'PC-1', status: 'online' },
        { id: 'a2', orgId: ORG, deviceId: null, hostname: null, status: 'offline' },
        { id: 'a3', orgId: OTHER_ORG, deviceId: null, hostname: 'pc-3', status: null },
      ],
    });
    await expect(sentinelOneEndpointSource.listForOrg(ORG)).resolves.toEqual([
      { endpointId: 'a1', orgId: ORG, deviceId: 'd1', hostname: 'PC-1', online: true },
      { endpointId: 'a2', orgId: ORG, deviceId: null, hostname: null, online: false },
      { endpointId: 'a3', orgId: OTHER_ORG, deviceId: null, hostname: 'pc-3', online: null },
    ]);
    expect(selectCalls.length).toBe(3);
  });
});

describe('sentinelOneEndpointSource.listForOrg — absent rows (#9248)', () => {
  it('drops rows sync marked absent so a decommissioned endpoint is not counted as covered', async () => {
    queueS1({ agents: [
      { id: 'a1', orgId: ORG, deviceId: 'd1', hostname: 'ws-1', status: 'online' },
      { id: 'a2', orgId: ORG, deviceId: 'd2', hostname: 'ws-2', status: 'absent' },
    ] });
    const views = (await sentinelOneEndpointSource.listForOrg(ORG)) as VendorEndpointView[];
    expect(views.map((v) => v.endpointId)).toEqual(['a1']);
  });
});

describe('SentinelOne views through the reconciler', () => {
  function device(overrides: Partial<DeviceCoverageInput> = {}): DeviceCoverageInput {
    return {
      deviceId: 'd1', orgId: ORG, hostnames: ['pc-1'], install: 'missing', installRemediationStatus: 'none', installArmed: true, ...overrides,
    };
  }

  async function classifyFromRows(
    agents: NonNullable<Parameters<typeof queueS1>[0]['agents']>,
    devices: DeviceCoverageInput[] = [device()],
    knownDeviceHostnames: string[] = [],
  ) {
    queueS1({ agents });
    const endpoints = (await sentinelOneEndpointSource.listForOrg(ORG)) as VendorEndpointView[];
    return classifyOrgCoverage({
      orgId: ORG,
      reportsVendorOrg: sentinelOneEndpointSource.reportsVendorOrg,
      devices,
      endpoints,
      knownDeviceHostnames: new Set(knownDeviceHostnames),
    });
  }

  it.each<[string, Parameters<typeof classifyFromRows>[0], Partial<DeviceCoverageInput>, { state: string; reasonCode: string | null }]>([
    ['linked online agent in the org -> covered', [{ id: 'a1', orgId: ORG, deviceId: 'd1', hostname: 'PC-1', status: 'online' }], {}, { state: 'covered', reasonCode: null }],
    ['linked offline agent -> vendor_offline', [{ id: 'a1', orgId: ORG, deviceId: 'd1', hostname: 'PC-1', status: 'offline' }], {}, { state: 'vendor_offline', reasonCode: null }],
    ['unlinked in-org agent by computerName -> covered', [{ id: 'a1', orgId: ORG, deviceId: null, hostname: ' pc-1 ', status: 'online' }], {}, { state: 'covered', reasonCode: null }],
    ["an agent under another org's site, carrying this installed device's name -> mismatched_org (no redeploy)",
      [{ id: 'a1', orgId: OTHER_ORG, deviceId: null, hostname: 'PC-1', status: 'online' }], { install: 'installed' },
      { state: 'mismatched_org', reasonCode: 'vendor_org_mismatch' }],
    ['an agent under an unmapped site has no row: the installed device stays pending', [], { install: 'installed' },
      { state: 'pending', reasonCode: 'awaiting_vendor_report' }],
  ])('%s', async (_name, agents, overrides, expected) => {
    const { decisions } = await classifyFromRows(agents, [device(overrides)]);
    expect(decisions.get('d1')).toMatchObject(expected);
  });

  it('an unlinked in-org agent that matches no Breeze device is vendor_only', async () => {
    const { vendorOnly } = await classifyFromRows([{ id: 'stray', orgId: ORG, deviceId: null, hostname: 'unknown-box', status: 'online' }]);
    expect(vendorOnly.map((v) => v.endpointId)).toEqual(['stray']);
  });
});
