import { beforeEach, describe, expect, it, vi } from 'vitest';

// Harness shape copied from featureConfigResolver.containment.test.ts: the db
// returns whatever rows each select is handed, so these tests exercise the
// resolver's own ranking, parsing and query shape. Real filtering (role/OS,
// status, ownership, inheritance) is pinned against Postgres in
// __tests__/integration/oemUpdatesResolver.integration.test.ts.
const { selectMock, gates } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  gates: { open: new Set<string>() },
}));

vi.mock('../../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...(args as [])) },
  getCurrentDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: vi.fn() }));

vi.mock('../../db/schema', () => ({
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
    featureType: 'configPolicyEffectiveFeatureLinks.featureType',
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
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', type: 'organizations.type' },
  partners: {},
  deviceGroupMemberships: { deviceId: 'deviceGroupMemberships.deviceId', groupId: 'deviceGroupMemberships.groupId' },
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

// Protective tier: the resolver must never consult the execution-target gate.
vi.mock('../executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: vi.fn(async () => ({ allowedGroupIds: [], refusedGroups: [{ id: 'g-self' }] })),
}));

vi.mock('./toolManifest', async (importOriginal) => {
  const original = await importOriginal<typeof import('./toolManifest')>();
  return { ...original, isCategoryOpen: (lane: string, category: string) => gates.open.has(`${lane}:${category}`) };
});

import { resolveExecutionSafeGroupIds } from '../executionTargetGating';
import { OEM_UPDATES_POLICY_DEFAULTS } from '@breeze/shared';
import { resolveOemUpdatesLinkForDevice, resolveOemUpdatesLinksForDevices } from './resolver';

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

const DEVICE = { id: 'device-1', orgId: 'org-1', siteId: 'site-1', deviceRole: 'workstation', osType: 'windows' };

function mockHierarchy(groupIds: string[] = [], orgType = 'customer') {
  selectMock
    .mockReturnValueOnce(makeChain([DEVICE]))
    .mockReturnValueOnce(makeChain([{ partnerId: 'partner-1', type: orgType }]))
    .mockReturnValueOnce(makeChain(groupIds.map((groupId) => ({ groupId }))));
}

const SCHEDULE = { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 };
const settings = (dellCategories: Record<string, boolean>, over: Record<string, unknown> = {}) => ({
  version: 1, enabled: true, schedule: SCHEDULE, catchUpNights: 7, reboot: 'overnight',
  vendors: { dell: { enabled: true, categories: dellCategories, blockedUpdateIds: [] } },
  ...over,
});

function row(inlineSettings: unknown, assignmentLevel: string, linkId: string, extra: Record<string, unknown> = {}) {
  return {
    linkId,
    sourcePolicyId: `source-${linkId}`,
    assignedPolicyId: `assigned-${linkId}`,
    inlineSettings,
    assignmentLevel,
    assignmentPriority: 0,
    assignmentCreatedAt: new Date(0),
    ...extra,
  };
}

async function resolveWith(rows: unknown[], groupIds: string[] = []) {
  mockHierarchy(groupIds);
  selectMock.mockReturnValueOnce(makeChain(rows));
  return resolveOemUpdatesLinkForDevice('device-1');
}

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReset();
  gates.open = new Set();
});

describe('resolveOemUpdatesLinkForDevice', () => {
  it('no link reaches the device → null', async () => {
    expect(await resolveWith([])).toBeNull();
  });

  it('an unknown device → null, without querying assignments', async () => {
    selectMock.mockReturnValueOnce(makeChain([]));
    expect(await resolveOemUpdatesLinkForDevice('missing')).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('closest wins, and the closer link replaces the farther one whole (no merge)', async () => {
    const partner = settings({ driver: true, application: true }, { catchUpNights: 14 });
    const org = { ...settings({ driver: true }), vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: ['X1'] } } };
    const result = await resolveWith([row(partner, 'partner', 'p'), row(org, 'organization', 'o')]);
    expect(result).toEqual({
      linkId: 'o',
      configPolicyId: 'source-o',
      assignedPolicyId: 'assigned-o',
      settings: org,
      invalidStoredSettings: false,
      armedAt: expect.any(Date),
    });
    // Nothing from the partner link leaks in: application stays off, catch-up stays 7.
    expect(result!.settings.vendors.dell!.categories.application).toBeUndefined();
    expect(result!.settings.catchUpNights).toBe(7);
  });

  it('reads the effective-links view for oem_updates, active policies only, with role and OS filters', async () => {
    await resolveWith([row(settings({ driver: true }), 'organization', 'o')]);
    const query = selectMock.mock.results[3]!.value;
    const joins = JSON.stringify(query.innerJoin.mock.calls);
    // Ownership: the device's org, or partner-wide for the device's partner.
    expect(JSON.stringify(query.innerJoin.mock.calls[0])).toContain('configurationPolicies.partnerId');
    expect(JSON.stringify(query.innerJoin.mock.calls[0])).toContain('partner-1');
    expect(joins).toContain('configPolicyEffectiveFeatureLinks.featureType');
    expect(joins).toContain('"oem_updates"');
    expect(joins).toContain('configurationPolicies.status');
    expect(joins).toContain('"active"');
    const where = JSON.stringify(query.where.mock.calls[0]);
    expect(where).toContain('configPolicyAssignments.roleFilter');
    expect(where).toContain('configPolicyAssignments.osFilter');
    expect(where).toContain('workstation');
    expect(where).toContain('windows');
  });

  it('a group override turning BIOS off still wins even for a refused group (protective tier)', async () => {
    gates.open = new Set(['dell:bios', 'dell:driver']);
    const broad = settings({ bios: true, driver: true });
    const groupOverride = settings({ bios: false, driver: true });
    const result = await resolveWith(
      [row(broad, 'organization', 'org'), row(groupOverride, 'device_group', 'grp', { assignmentTargetId: 'g-self' })],
      ['g-self'],
    );
    expect(result!.linkId).toBe('grp');
    expect(result!.settings.vendors.dell!.categories.bios).toBe(false);
    expect(resolveExecutionSafeGroupIds).not.toHaveBeenCalled();
    // The self-selected group is still a target.
    expect(JSON.stringify(selectMock.mock.results[3]!.value.where.mock.calls[0])).toContain('g-self');
  });

  it('opening a gate changes no stored link: a category the link never set stays absent', async () => {
    const stored = settings({ driver: true });
    gates.open = new Set(['dell:bios', 'dell:firmware', 'dell:driver', 'dell:application']);
    const result = await resolveWith([row(stored, 'organization', 'o')]);
    expect(result!.settings.vendors.dell!.categories).toEqual({ driver: true });
    expect(result!.settings.vendors.dell!.categories.bios).toBeUndefined();
  });

  it('unparseable settings resolve as disabled, logged once per link', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { ...settings({ driver: true }), windowHours: 99, secret: 'do-not-log' };
    const first = await resolveWith([row(bad, 'organization', 'bad-link')]);
    expect(first).toMatchObject({ linkId: 'bad-link', invalidStoredSettings: true, settings: OEM_UPDATES_POLICY_DEFAULTS });
    expect(first!.settings.enabled).toBe(false);
    await resolveWith([row(bad, 'organization', 'bad-link')]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('do-not-log');
    error.mockRestore();
  });

  it('a parked device gets no partner-level assignment', async () => {
    mockHierarchy([], 'unassigned_pool');
    selectMock.mockReturnValueOnce(makeChain([]));
    await resolveOemUpdatesLinkForDevice('device-1');
    const where = JSON.stringify(selectMock.mock.results[3]!.value.where.mock.calls[0]);
    expect(where).not.toContain('partner-1');
  });
});

describe('resolveOemUpdatesLinksForDevices', () => {
  const D2 = { id: 'device-2', orgId: 'org-2', siteId: 'site-2', deviceRole: 'workstation', osType: 'windows' };
  const D3 = { id: 'device-3', orgId: 'org-3', siteId: 'site-3', deviceRole: 'server', osType: 'windows' };

  function candidate(inlineSettings: unknown, level: string, targetId: string, linkId: string, extra: Record<string, unknown> = {}) {
    return {
      ...row(inlineSettings, level, linkId),
      policyOrgId: null,
      policyPartnerId: 'partner-1',
      assignmentTargetId: targetId,
      roleFilter: null,
      osFilter: null,
      ...extra,
    };
  }

  it('applies the same rules in memory, one chunk of fixed queries', async () => {
    const partnerWide = settings({ driver: true });
    const orgOff = settings({ driver: true }, { enabled: false });
    selectMock
      .mockReturnValueOnce(makeChain([DEVICE, D2, D3]))
      .mockReturnValueOnce(makeChain([
        { id: 'org-1', partnerId: 'partner-1', type: 'customer' },
        { id: 'org-2', partnerId: 'partner-1', type: 'customer' },
        { id: 'org-3', partnerId: 'partner-2', type: 'customer' },
      ]))
      .mockReturnValueOnce(makeChain([{ deviceId: 'device-1', groupId: 'g-self' }]))
      .mockReturnValueOnce(makeChain([
        candidate(partnerWide, 'partner', 'partner-1', 'pw'),
        candidate(orgOff, 'device_group', 'g-self', 'grp', { policyOrgId: 'org-1', policyPartnerId: null }),
        candidate(partnerWide, 'organization', 'org-3', 'foreign', { policyOrgId: 'org-1', policyPartnerId: null }),
        candidate(partnerWide, 'partner', 'partner-1', 'servers-only', { roleFilter: ['server'], assignmentPriority: -1 }),
      ]));

    const result = await resolveOemUpdatesLinksForDevices(['device-1', 'device-2', 'device-3', 'device-2']);
    // device-1: its (self-selected) group override wins over partner-wide.
    expect(result.get('device-1')).toMatchObject({ linkId: 'grp', settings: orgOff });
    // device-2: partner-wide reaches it; the server-only assignment does not.
    expect(result.get('device-2')).toMatchObject({ linkId: 'pw', assignedPolicyId: 'assigned-pw' });
    // device-3: another partner's device; an org-1 policy assigned to org-3 is not owned by org-3.
    expect(result.has('device-3')).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(4);
    expect(resolveExecutionSafeGroupIds).not.toHaveBeenCalled();
  });

  it('a parked device gets nothing partner-wide', async () => {
    selectMock
      .mockReturnValueOnce(makeChain([DEVICE]))
      .mockReturnValueOnce(makeChain([{ id: 'org-1', partnerId: 'partner-1', type: 'unassigned_pool' }]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([candidate(settings({ driver: true }), 'partner', 'partner-1', 'pw')]));
    expect((await resolveOemUpdatesLinksForDevices(['device-1'])).size).toBe(0);
  });

  it('chunks at 500 devices', async () => {
    selectMock.mockImplementation(() => makeChain([]));
    const ids = Array.from({ length: 1001 }, (_, i) => `device-${i}`);
    await resolveOemUpdatesLinksForDevices(ids);
    // Three chunks, each stopping after the empty device read.
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it('empty input → empty map, no queries', async () => {
    expect((await resolveOemUpdatesLinksForDevices([])).size).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
