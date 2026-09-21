import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================
// Mocks for the two #6263 W01 security resolvers. Copied harness shape from
// featureConfigResolver.test.ts's `vi.mock('../db', ...)` / schema / drizzle-orm
// factories — vi.mock factories are hoisted, so only literal values live here.
// ============================================
const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...(args as [])) },
  getCurrentDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: vi.fn(),
}));

vi.mock('../db/schema', () => ({
  configurationPolicies: {
    id: 'configurationPolicies.id',
    orgId: 'configurationPolicies.orgId',
    partnerId: 'configurationPolicies.partnerId',
    status: 'configurationPolicies.status',
  },
  configPolicyEffectiveFeatureLinks: {
    id: 'configPolicyEffectiveFeatureLinks.id',
    configPolicyId: 'configPolicyEffectiveFeatureLinks.configPolicyId',
    sourcePolicyId: 'configPolicyEffectiveFeatureLinks.sourcePolicyId',
    inherited: 'configPolicyEffectiveFeatureLinks.inherited',
    featureType: 'configPolicyEffectiveFeatureLinks.featureType',
    featurePolicyId: 'configPolicyEffectiveFeatureLinks.featurePolicyId',
    inlineSettings: 'configPolicyEffectiveFeatureLinks.inlineSettings',
  },
  configPolicyAssignments: {
    id: 'configPolicyAssignments.id',
    configPolicyId: 'configPolicyAssignments.configPolicyId',
    level: 'configPolicyAssignments.level',
    targetId: 'configPolicyAssignments.targetId',
    priority: 'configPolicyAssignments.priority',
    createdAt: 'configPolicyAssignments.createdAt',
    roleFilter: 'configPolicyAssignments.roleFilter',
    osFilter: 'configPolicyAssignments.osFilter',
  },
  configPolicyAlertRules: {},
  configPolicyAutomations: {},
  configPolicyComplianceRules: {},
  configPolicyPatchSettings: {},
  configPolicyMaintenanceSettings: {},
  configPolicyBackupSettings: {},
  backupProfiles: {},
  backupConfigs: {},
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    deviceRole: 'devices.deviceRole',
    osType: 'devices.osType',
    isEphemeral: 'devices.isEphemeral',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    type: 'organizations.type',
  },
  partners: {},
  deviceGroupMemberships: {
    deviceId: 'deviceGroupMemberships.deviceId',
    groupId: 'deviceGroupMemberships.groupId',
  },
  sites: {},
  softwarePolicies: {},
}));

vi.mock('drizzle-orm', () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
    {
      param: (value: unknown) => ({ op: 'param', value }),
      join: (chunks: unknown[], separator: unknown) => ({ op: 'join', chunks, separator }),
    },
  );

  return {
    and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
    or: (...conditions: unknown[]) => ({ op: 'or', conditions }),
    eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
    ne: (column: unknown, value: unknown) => ({ op: 'ne', column, value }),
    isNull: (column: unknown) => ({ op: 'isNull', column }),
    inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
    asc: (value: unknown) => ({ op: 'asc', value }),
    sql,
    SQL: class SQL {},
  };
});

import {
  resolveSecurityScanSettingsForDevice,
  resolveAllSecurityScanScheduledDevices,
} from './featureConfigResolver';

// Generic thenable chain: every method returns itself, and awaiting resolves
// to `result`. Good enough here because these tests arrange the exact rows
// the resolver's own (unmocked) `sortByHierarchy` / filter logic must handle
// — the join CONDITION itself isn't under test in this file.
function makeChain(result: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled: any, onRejected?: any) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return chain;
}

// The three loadDeviceHierarchy reads: device, org -> partnerId, device-group
// memberships.
function mockHierarchyReads(device: Record<string, unknown> | null) {
  selectMock
    .mockReturnValueOnce(makeChain(device ? [device] : []))
    .mockReturnValueOnce(makeChain(device ? [{ partnerId: null }] : []))
    .mockReturnValueOnce(makeChain([]));
}

const DEVICE = {
  id: 'device-1',
  orgId: 'org-a',
  siteId: 'site-1',
  deviceRole: 'workstation',
  osType: 'windows',
};

describe('resolveSecurityScanSettingsForDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
  });

  it('returns null when no security feature link reaches the device', async () => {
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(makeChain([]));

    await expect(resolveSecurityScanSettingsForDevice('device-1')).resolves.toBeNull();
  });

  it('returns null for an unknown device rather than defaults', async () => {
    mockHierarchyReads(null);

    await expect(resolveSecurityScanSettingsForDevice('unknown-device')).resolves.toBeNull();
  });

  it('closest assignment wins: a device-level link overrides an org-level one', async () => {
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(
      makeChain([
        {
          inlineSettings: { autoQuarantine: true },
          assignmentLevel: 'organization',
          assignmentPriority: 0,
          assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          inlineSettings: { autoQuarantine: false },
          assignmentLevel: 'device',
          assignmentPriority: 0,
          assignmentCreatedAt: new Date('2026-01-02T00:00:00Z'),
        },
      ]),
    );

    const settings = await resolveSecurityScanSettingsForDevice('device-1');
    expect(settings?.autoQuarantine).toBe(false);
  });

  it('parses the winning blob through parseSecurityScanSettings (removed toggles dropped)', async () => {
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(
      makeChain([
        {
          inlineSettings: { realTimeProtection: true, maxFileSizeMb: '9999' },
          assignmentLevel: 'device',
          assignmentPriority: 0,
          assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]),
    );

    const settings = await resolveSecurityScanSettingsForDevice('device-1');
    expect(settings).not.toHaveProperty('realTimeProtection');
    expect(settings?.maxFileSizeMb).toBe(512);
  });
});

describe('resolveAllSecurityScanScheduledDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
  });

  it('returns [] when no active config policy carries a security link', async () => {
    selectMock.mockReturnValueOnce(makeChain([]));

    await expect(resolveAllSecurityScanScheduledDevices()).resolves.toEqual([]);
  });

  it('omits policies whose settings have scheduledScans false', async () => {
    selectMock.mockReturnValueOnce(
      makeChain([
        {
          configPolicyId: 'policy-off',
          inlineSettings: { scheduledScans: false },
          orgId: 'org-a',
          partnerId: null,
        },
      ]),
    );

    await expect(resolveAllSecurityScanScheduledDevices()).resolves.toEqual([]);
  });

  it('excludes a candidate device whose winning link belongs to a different policy', async () => {
    const policyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const policyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const deviceD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    // 1. links query
    selectMock.mockReturnValueOnce(
      makeChain([
        { configPolicyId: policyA, inlineSettings: { scheduledScans: true }, orgId: 'org-a', partnerId: null },
        { configPolicyId: policyB, inlineSettings: { scheduledScans: true }, orgId: 'org-a', partnerId: null },
      ]),
    );
    // 2. assignments query — A at org level, B at device level for deviceD
    selectMock.mockReturnValueOnce(
      makeChain([
        { configPolicyId: policyA, level: 'organization', targetId: 'org-a' },
        { configPolicyId: policyB, level: 'device', targetId: deviceD },
      ]),
    );
    // resolveAssignmentDeviceIds for policyA's 'organization' assignment
    selectMock.mockReturnValueOnce(makeChain([{ id: deviceD }]));
    // policyB's 'device' assignment needs no DB read (returns [targetId] directly)

    // Verification: resolveSecurityScanConfigPolicyIdForDevice(deviceD) for
    // policyA's candidate set, then again for policyB's. Each call is a
    // loadDeviceHierarchy (3 reads) + the winner-join read. Both policies
    // compete for the same device, and B (device-level) always wins.
    for (let i = 0; i < 2; i++) {
      mockHierarchyReads(DEVICE);
      selectMock.mockReturnValueOnce(
        makeChain([
          {
            configPolicyId: policyB,
            assignmentLevel: 'device',
            assignmentPriority: 0,
            assignmentCreatedAt: new Date('2026-01-02T00:00:00Z'),
          },
        ]),
      );
    }

    const entries = await resolveAllSecurityScanScheduledDevices();
    const a = entries.find((e) => e.configPolicyId === policyA);
    expect(a?.deviceIds ?? []).not.toContain(deviceD);
  });

  it('carries the policy ownership axes through so the caller can resolve a timezone', async () => {
    const policyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const deviceId = 'device-1';

    selectMock.mockReturnValueOnce(
      makeChain([
        { configPolicyId: policyId, inlineSettings: { scheduledScans: true }, orgId: 'org-a', partnerId: null },
      ]),
    );
    selectMock.mockReturnValueOnce(makeChain([{ configPolicyId: policyId, level: 'device', targetId: deviceId }]));

    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(
      makeChain([
        {
          configPolicyId: policyId,
          assignmentLevel: 'device',
          assignmentPriority: 0,
          assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]),
    );

    const entries = await resolveAllSecurityScanScheduledDevices();
    expect(entries[0]).toHaveProperty('orgId');
    expect(entries[0]).toHaveProperty('partnerId');
  });
});
