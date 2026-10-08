import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';

const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  statements: 0,
  redis: null as null | { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> },
}));
vi.mock('../../db', () => {
  // A query takes its canned rows (and counts as a statement) when awaited.
  const query = () => {
    const chain: any = {
      then: (yes: any, no: any) => {
        m.statements += 1;
        return Promise.resolve(m.rows.shift() ?? []).then(yes, no);
      },
    };
    for (const key of ['from', 'where', 'limit', 'innerJoin', 'orderBy']) chain[key] = () => chain;
    return chain;
  };
  return { db: { select: query } };
});
vi.mock('../configPolicyOwnership', async () => {
  const { db } = await import('../../db');
  return {
    policyOwnershipCondition: () => undefined,
    withDevicePartnerPolicyVisibility: async (_db: unknown, _partnerId: unknown, fn: (executor: unknown) => unknown) => fn(db),
  };
});
vi.mock('../featureConfigResolver', () => ({
  buildRoleOsFilterConditions: () => [],
  matchesRoleOsFilter: () => true,
}));
vi.mock('../redis', () => ({ getRedis: () => m.redis }));

import { DeviceHierarchyMismatchError, type DeviceHierarchy } from '../deviceHierarchy';
import { getDeviceWorkloadInventorySettings } from './settings';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const PARTNER = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const POLICY = '55555555-5555-4555-8555-555555555555';

const policyRow = (over: Record<string, unknown> = {}) => ({
  policyId: POLICY,
  policyName: 'Policy',
  level: 'partner',
  assignmentPriority: 0,
  assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
  roleFilter: null,
  osFilter: null,
  enabled: true,
  dockerEnabled: true,
  podmanEnabled: false,
  hypervEnabled: true,
  proxmoxEnabled: true,
  intervalMinutes: 30,
  ...over,
});
/** Selects in a cache miss: device org, device row, org partner, groups, policy rows. */
const missRows = (policies: unknown[]) => [
  [{ orgId: ORG }],
  [{ orgId: ORG, siteId: SITE, deviceRole: 'server', osType: 'linux' }],
  [{ partnerId: PARTNER }],
  [],
  policies,
];

beforeEach(() => {
  m.rows = [];
  m.statements = 0;
  m.redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') };
});

it('serves a cache hit without resolving and without writing the cache', async () => {
  const settings = { ...WORKLOAD_INVENTORY_DEFAULTS, enabled: true };
  m.redis!.get.mockResolvedValue(JSON.stringify({ orgId: ORG, settings }));
  m.rows = [[{ orgId: ORG }]];
  expect(await getDeviceWorkloadInventorySettings(DEVICE)).toEqual({ orgId: ORG, settings });
  expect(m.redis!.set).not.toHaveBeenCalled();
});

it('ignores a cache entry stamped with another org (the device moved) and re-resolves', async () => {
  m.redis!.get.mockResolvedValue(
    JSON.stringify({ orgId: '99999999-9999-4999-8999-999999999999', settings: { ...WORKLOAD_INVENTORY_DEFAULTS, enabled: true } }),
  );
  m.rows = missRows([]);
  const resolved = await getDeviceWorkloadInventorySettings(DEVICE);
  expect(resolved.settings).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
  expect(m.redis!.set).toHaveBeenCalledWith(
    `workloads:settings:device:${DEVICE}`,
    expect.any(String),
    'EX',
    120,
  );
});

it('falls back to the resolver when the cache entry is unreadable', async () => {
  m.redis!.get.mockResolvedValue('not json');
  m.rows = missRows([policyRow()]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toMatchObject({ enabled: true, intervalMinutes: 30 });
});

it('resolves without Redis', async () => {
  m.redis = null;
  m.rows = missRows([]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
});

it('returns defaults (enabled: false) when no policy applies', async () => {
  m.rows = missRows([]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
});

it('maps the winning policy row onto the settings', async () => {
  m.rows = missRows([policyRow()]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toEqual({
    enabled: true,
    dockerEnabled: true,
    podmanEnabled: false,
    hypervEnabled: true,
    proxmoxEnabled: true,
    intervalMinutes: 30,
  });
});

it('the nearer level wins over a partner-wide policy even when the partner-wide one is enabled', async () => {
  m.rows = missRows([
    policyRow({ level: 'partner', enabled: true }),
    policyRow({ level: 'organization', enabled: false }),
  ]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings.enabled).toBe(false);
});

it('within one level the lower priority number wins, then the older assignment', async () => {
  m.rows = missRows([
    policyRow({ level: 'site', assignmentPriority: 5, enabled: false }),
    policyRow({ level: 'site', assignmentPriority: 1, enabled: true, intervalMinutes: 45 }),
  ]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toMatchObject({ enabled: true, intervalMinutes: 45 });
});

it('throws when the device is not visible (never resolves defaults for a device it cannot see)', async () => {
  m.rows = [[]];
  await expect(getDeviceWorkloadInventorySettings(DEVICE)).rejects.toThrow('not visible');
});

describe('with the heartbeat\'s passed device hierarchy (#8053)', () => {
  const hierarchy: DeviceHierarchy = {
    deviceId: DEVICE,
    orgId: ORG,
    siteId: SITE,
    deviceRole: 'server',
    osType: 'linux',
    org: { partnerId: PARTNER, type: 'customer' },
    site: { id: SITE, name: 'HQ', timezone: 'UTC' },
    groupIds: [],
  };

  it('a cache hit reads nothing from the database', async () => {
    const settings = { ...WORKLOAD_INVENTORY_DEFAULTS, enabled: true };
    m.redis!.get.mockResolvedValue(JSON.stringify({ orgId: ORG, settings }));
    expect(await getDeviceWorkloadInventorySettings(DEVICE, { hierarchy })).toEqual({ orgId: ORG, settings });
    expect(m.statements).toBe(0);
  });

  it('a cache miss issues only the policy query and resolves the same winner', async () => {
    m.rows = [[policyRow({ level: 'organization', intervalMinutes: 45 })]];
    const resolved = await getDeviceWorkloadInventorySettings(DEVICE, { hierarchy });
    expect(resolved).toEqual({ orgId: ORG, settings: expect.objectContaining({ enabled: true, intervalMinutes: 45 }) });
    expect(m.statements).toBe(1);
  });

  it('stamps the cache with the hierarchy\'s org, so a moved device re-resolves', async () => {
    m.redis!.get.mockResolvedValue(
      JSON.stringify({ orgId: '99999999-9999-4999-8999-999999999999', settings: { ...WORKLOAD_INVENTORY_DEFAULTS, enabled: true } }),
    );
    m.rows = [[]];
    expect((await getDeviceWorkloadInventorySettings(DEVICE, { hierarchy })).settings).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
    expect(m.redis!.set).toHaveBeenCalledWith(`workloads:settings:device:${DEVICE}`, JSON.stringify({ orgId: ORG, settings: WORKLOAD_INVENTORY_DEFAULTS }), 'EX', 120);
  });

  it('refuses another device\'s hierarchy', async () => {
    await expect(
      getDeviceWorkloadInventorySettings(DEVICE, { hierarchy: { ...hierarchy, deviceId: POLICY } }),
    ).rejects.toBeInstanceOf(DeviceHierarchyMismatchError);
    expect(m.statements).toBe(0);
  });
});
