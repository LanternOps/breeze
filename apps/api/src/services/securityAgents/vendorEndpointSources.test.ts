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
