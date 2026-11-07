import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================
// Mocks for containment resolution. Harness shape copied
// verbatim from featureConfigResolver.security.test.ts — vi.mock factories are
// hoisted, so only literal values live here.
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
    updatedAt: 'configPolicyEffectiveFeatureLinks.updatedAt',
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

vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: vi.fn(async (ids: string[]) => ({ allowedGroupIds: ids, refusedGroups: [] })),
}));

import { resolveExecutionSafeGroupIds } from './executionTargetGating';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { createHash } from 'node:crypto';
import { resolveContainmentPolicy } from './featureConfigResolver';

// Generic thenable chain: every method returns itself, and awaiting resolves to
// `result`. The resolver's own (unmocked) sortByHierarchy + parse logic is what
// these tests exercise. The SQL join condition is NOT under test here — the
// mock returns whatever rows it is handed — so the partner-wide ownership
// predicate is asserted structurally below, not by row filtering.
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
function mockHierarchyReads(device: Record<string, unknown> | null, partnerId: string | null = 'partner-1') {
  selectMock
    .mockReturnValueOnce(makeChain(device ? [device] : []))
    .mockReturnValueOnce(makeChain(device ? [{ partnerId, type: 'customer' }] : []))
    .mockReturnValueOnce(makeChain([]));
}

const DEVICE = {
  id: 'device-1',
  orgId: 'org-child',
  siteId: 'site-1',
  deviceRole: 'workstation',
  osType: 'windows',
};

const DEFAULTS = {
  version: 1, extraAllow: [], defaultTtlHours: 72, deadManMinutes: 0,
  remoteRelay: true, requireSignedReleaseToken: false,
};
const DEFAULT_REVISION = 'c1:' + createHash('sha256').update(JSON.stringify(DEFAULTS)).digest('hex').slice(0, 32);

function row(inlineSettings: unknown, assignmentLevel = 'organization', featureLinkId = 'link-1') {
  return { featureLinkId, sourcePolicyId: 'policy-' + featureLinkId, inlineSettings,
    assignmentLevel, assignmentPriority: 0, assignmentCreatedAt: new Date(0) };
}
function resolveRows(rows: unknown[]) {
  mockHierarchyReads(DEVICE);
  selectMock.mockReturnValueOnce(makeChain(rows));
  return resolveContainmentPolicy('device-1');
}

beforeEach(() => { vi.clearAllMocks(); selectMock.mockReset(); });

describe('resolveContainmentPolicy', () => {
  it('no policy returns W1 defaults and their content revision', async () => {
    expect(await resolveRows([])).toEqual({ ...DEFAULTS, revision: DEFAULT_REVISION,
      isPlatformDefault: true, invalidStoredSettings: false, sourcePolicyId: null, featureLinkId: null, refusedGroups: [] });
  });

  it('unknown device returns the same defaults without querying assignments', async () => {
    selectMock.mockReturnValueOnce(makeChain([]));
    expect(await resolveContainmentPolicy('unknown')).toEqual({ ...DEFAULTS, revision: DEFAULT_REVISION,
      isPlatformDefault: true, invalidStoredSettings: false, sourcePolicyId: null, featureLinkId: null, refusedGroups: [] });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('organization override beats partner default and keeps the winning source', async () => {
    const result = await resolveRows([
      row({ version: 1, defaultTtlHours: 48 }, 'partner', 'partner-link'),
      row({ version: 1, defaultTtlHours: 24 }, 'organization', 'org-link'),
    ]);
    expect(result).toMatchObject({ defaultTtlHours: 24, isPlatformDefault: false,
      invalidStoredSettings: false, sourcePolicyId: 'policy-org-link', featureLinkId: 'org-link' });
  });

  it('uses partner ownership and the containment feature within the caller RLS context', async () => {
    await resolveRows([row({ version: 1 }, 'partner')]);
    const query = selectMock.mock.results[3]!.value;
    expect(JSON.stringify(query.innerJoin.mock.calls[0])).toContain('configurationPolicies.partnerId');
    expect(JSON.stringify(query.innerJoin.mock.calls[0])).toContain('partner-1');
    expect(JSON.stringify(query.innerJoin.mock.calls[1])).toContain('containment');
    // Only active policies grant permits, and role/OS assignment filters apply.
    expect(JSON.stringify(query.innerJoin.mock.calls[0])).toContain('active');
    const where = JSON.stringify(query.where.mock.calls);
    for (const needle of ['roleFilter', 'osFilter', 'workstation', 'windows']) expect(where).toContain(needle);
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it('removes execution-unsafe groups from the assignment targets', async () => {
    selectMock.mockReturnValueOnce(makeChain([DEVICE]))
      .mockReturnValueOnce(makeChain([{ partnerId: 'partner-1', type: 'customer' }]))
      .mockReturnValueOnce(makeChain([{ groupId: 'self-selected-group' }]))
      .mockReturnValueOnce(makeChain([]));
    vi.mocked(resolveExecutionSafeGroupIds).mockResolvedValueOnce({ allowedGroupIds: [], refusedGroups: [] });
    await resolveContainmentPolicy('device-1');
    expect(resolveExecutionSafeGroupIds).toHaveBeenCalledWith(['self-selected-group']);
    const query = selectMock.mock.results[3]!.value;
    expect(JSON.stringify(query.where.mock.calls)).not.toContain('self-selected-group');
  });

  describe('refused groups (#10100)', () => {
    const refused = [
      { id: 'carries-policy', refusedFields: ['os_version'] },
      { id: 'no-policy-here', refusedFields: ['hostname'] },
    ];
    const reads = (assignments: unknown[], memberships = [{ groupId: 'carries-policy' }, { groupId: 'no-policy-here' }]) => {
      selectMock.mockReturnValueOnce(makeChain([DEVICE]))
        .mockReturnValueOnce(makeChain([{ partnerId: 'partner-1', type: 'customer' }]))
        .mockReturnValueOnce(makeChain(memberships))
        .mockReturnValueOnce(makeChain(assignments))
        .mockReturnValueOnce(makeChain([{ targetId: 'carries-policy' }]));
      vi.mocked(resolveExecutionSafeGroupIds).mockResolvedValueOnce({ allowedGroupIds: [], refusedGroups: refused });
    };
    it('names only the refused groups that carry a containment policy', async () => {
      reads([]);
      const result = await resolveContainmentPolicy('device-1');
      expect(result.refusedGroups).toEqual([refused[0]]);
      expect(result.isPlatformDefault).toBe(true);
    });
    it('still gives a refused group nothing: its policy does not win and its permits do not apply', async () => {
      reads([]);
      const result = await resolveContainmentPolicy('device-1');
      expect(result.extraAllow).toEqual([]);
      expect(JSON.stringify(selectMock.mock.results[3]!.value.where.mock.calls)).not.toContain('carries-policy');
    });
    it('looks them up by containment feature, active status and the device-group level', async () => {
      reads([]);
      await resolveContainmentPolicy('device-1');
      const lookup = selectMock.mock.results[4]!.value;
      expect(JSON.stringify(lookup.innerJoin.mock.calls)).toContain('containment');
      expect(JSON.stringify(lookup.innerJoin.mock.calls)).toContain('active');
      const where = JSON.stringify(lookup.where.mock.calls);
      for (const needle of ['device_group', 'carries-policy', 'no-policy-here']) expect(where).toContain(needle);
    });
    it('reports them next to a policy that won from another level', async () => {
      reads([row({ version: 1 }, 'organization')]);
      const result = await resolveContainmentPolicy('device-1');
      expect(result).toMatchObject({ isPlatformDefault: false, refusedGroups: [refused[0]] });
    });
    it('does not change the revision: a refusal is not a settings change', async () => {
      reads([]);
      expect((await resolveContainmentPolicy('device-1')).revision).toBe(DEFAULT_REVISION);
    });
    it('runs no extra query when nothing was refused', async () => {
      await resolveRows([]);
      expect(selectMock).toHaveBeenCalledTimes(4);
    });
  });

  it.each([null, {}, { version: 2 }, { version: 1, extraAllow: [{ host: 'private.example.test', proto: 'tcp', ports: [443], label: 'private', unexpected: true }] }])(
    'malformed stored settings %j fail closed with only issue paths logged', async (settings) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await resolveRows([row(settings)]);
        expect(result).toEqual({ ...DEFAULTS, revision: expect.stringMatching(/^c1i:[0-9a-f]{32}$/),
          isPlatformDefault: false, invalidStoredSettings: true, sourcePolicyId: 'policy-link-1', featureLinkId: 'link-1', refusedGroups: [] });
        // A policy going invalid is itself a revision change.
        expect(result.revision).not.toBe(DEFAULT_REVISION);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('containment'), {
          deviceId: 'device-1', featureLinkId: 'link-1', sourcePolicyId: 'policy-link-1', issues: expect.any(Array),
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
      } finally { warn.mockRestore(); }
    },
  );

  it('equivalent parsed settings have the same revision regardless of key order or metadata', async () => {
    const first = await resolveRows([row({ version: 1, remoteRelay: false, defaultTtlHours: 24 })]);
    const second = await resolveRows([row({ defaultTtlHours: 24, remoteRelay: false, version: 1 }, 'device', 'other-link')]);
    expect(first.revision).toMatch(/^c1:[0-9a-f]{32}$/);
    expect(second.revision).toBe(first.revision);
    expect((await resolveRows([row({ version: 1 })])).revision).toBe(DEFAULT_REVISION);
  });

  it.each([
    { defaultTtlHours: 24 }, { deadManMinutes: 15 }, { remoteRelay: false }, { requireSignedReleaseToken: true },
    { extraAllow: [{ host: 'relay.example.test', proto: 'tcp', ports: [443], label: 'Relay' }] },
  ])('changes revision for changed settings %j', async (settings) => {
    expect((await resolveRows([row({ version: 1, ...settings })])).revision).not.toBe(DEFAULT_REVISION);
  });

  it('returns fresh default arrays on each call', async () => {
    const a = await resolveRows([]);
    a.extraAllow.push({ host: 'relay.example.test', proto: 'tcp', ports: [443], label: 'Relay' });
    expect((await resolveRows([])).extraAllow).toEqual([]);
  });
});
