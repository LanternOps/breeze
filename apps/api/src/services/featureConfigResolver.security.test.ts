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

  it('a single partner-wide policy fans out to devices in more than one org', async () => {
    const policyId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const partnerId = 'partner-1';
    const orgA = 'org-a';
    const orgB = 'org-b';
    const deviceA = 'device-a';
    const deviceB = 'device-b';

    // 1. links query — one partner-wide link (orgId NULL, partnerId set).
    selectMock.mockReturnValueOnce(
      makeChain([
        { configPolicyId: policyId, inlineSettings: { scheduledScans: true }, orgId: null, partnerId },
      ]),
    );
    // 2. assignments query — assigned at the partner level.
    selectMock.mockReturnValueOnce(
      makeChain([{ configPolicyId: policyId, level: 'partner', targetId: partnerId }]),
    );
    // 3. resolveAssignmentDeviceIds('partner', partnerId) — the partner owns
    // two DISTINCT orgs, this is the cross-org fan-out under test.
    selectMock.mockReturnValueOnce(makeChain([{ id: orgA }, { id: orgB }]));
    // 4. devices query scoped to those two orgs — one device per org.
    selectMock.mockReturnValueOnce(makeChain([{ id: deviceA }, { id: deviceB }]));

    // Verification runs deviceA and deviceB CONCURRENTLY (Promise.all inside
    // the resolver's batch loop): both devices run loadDeviceHierarchy +
    // the winner-join read in lockstep, one `await` apart, so the two
    // devices' selects interleave COLUMN BY COLUMN (deviceA's device-select,
    // deviceB's device-select, deviceA's org-select, deviceB's org-select,
    // ...) rather than device-by-device. Content is identical for both
    // devices (same generic hierarchy, same winning policy), so pushing two
    // copies of each shape in query-position order is correct regardless of
    // which physical device consumes which copy.
    const winnerRow = {
      configPolicyId: policyId,
      assignmentLevel: 'partner',
      assignmentPriority: 0,
      assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    selectMock
      .mockReturnValueOnce(makeChain([DEVICE])) // deviceA: device select
      .mockReturnValueOnce(makeChain([DEVICE])) // deviceB: device select
      .mockReturnValueOnce(makeChain([{ partnerId: null }])) // deviceA: org select
      .mockReturnValueOnce(makeChain([{ partnerId: null }])) // deviceB: org select
      .mockReturnValueOnce(makeChain([])) // deviceA: device-group memberships
      .mockReturnValueOnce(makeChain([])) // deviceB: device-group memberships
      .mockReturnValueOnce(makeChain([winnerRow])) // deviceA: winner-join
      .mockReturnValueOnce(makeChain([winnerRow])); // deviceB: winner-join

    const entries = await resolveAllSecurityScanScheduledDevices();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.configPolicyId).toBe(policyId);
    expect(entry.orgId).toBeNull();
    expect(entry.partnerId).toBe(partnerId);
    // The discriminating assertion: deviceIds must span BOTH orgs the
    // partner-wide policy fanned out to, not merely exist as a non-empty list.
    expect(new Set(entry.deviceIds)).toEqual(new Set([deviceA, deviceB]));
  });
});
