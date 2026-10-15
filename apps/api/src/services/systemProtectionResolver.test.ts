import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================
// Mocks for resolveSystemProtectionForDevice (#4609 W03). Harness shape copied
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

import { resolveSystemProtectionForDevice } from './featureConfigResolver';

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
  beforePatching: true,
  beforeScripts: false,
  beforeSoftwareInstall: false,
  labelPrefix: 'Breeze',
};

function row(
  inlineSettings: unknown,
  assignmentLevel: string,
  updatedAt = new Date('2026-01-01T00:00:00Z'),
  createdAt = new Date('2026-01-01T00:00:00Z'),
) {
  return {
    featureLinkId: 'link-1',
    sourcePolicyId: 'policy-src-1',
    inlineSettings,
    assignmentLevel,
    assignmentPriority: 0,
    assignmentCreatedAt: createdAt,
    linkUpdatedAt: updatedAt,
  };
}

describe('resolveSystemProtectionForDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
  });

  it('returns the platform defaults when no policy exists anywhere in the hierarchy', async () => {
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(makeChain([]));

    const res = await resolveSystemProtectionForDevice('device-1');
    expect(res).toEqual({
      settings: DEFAULTS,
      policyRevision: null,
      isPlatformDefault: true,
      invalidStoredSettings: false,
    });
  });

  it('returns the platform defaults for an unknown device', async () => {
    mockHierarchyReads(null);

    const res = await resolveSystemProtectionForDevice('nope');
    expect(res.isPlatformDefault).toBe(true);
    expect(res.settings).toEqual(DEFAULTS);
    // No policy-link query is issued for an unknown device.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('closest wins: a device-level false beats a partner-wide true', async () => {
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(
      makeChain([
        row({ beforeScripts: true }, 'partner'),
        row({ beforeScripts: false }, 'device', new Date('2026-02-01T00:00:00Z')),
      ]),
    );

    const res = await resolveSystemProtectionForDevice('device-1');
    expect(res.settings.beforeScripts).toBe(false);
    expect(res.isPlatformDefault).toBe(false);
    expect(res.policyRevision).toBe('2026-02-01T00:00:00.000Z');
  });

  it('a partner-level assignment applies to a device in a child org when nothing closer exists', async () => {
    mockHierarchyReads(DEVICE, 'partner-1');
    selectMock.mockReturnValueOnce(
      makeChain([
        row({ beforeScripts: true, beforeSoftwareInstall: true }, 'partner', new Date('2026-03-04T05:06:07Z')),
      ]),
    );

    const res = await resolveSystemProtectionForDevice('device-1');
    expect(res.settings).toEqual({ ...DEFAULTS, beforeScripts: true, beforeSoftwareInstall: true });
    expect(res.policyRevision).toBe('2026-03-04T05:06:07.000Z');
    expect(res.isPlatformDefault).toBe(false);

    // The policy join carries the hierarchy ownership predicate, which admits
    // partner-owned (org_id NULL) policies for this device's partner. The real
    // row filtering is SQL; assert the predicate references the device's
    // partner so a regression that drops it (org-only ownership) goes red.
    const linkQuery = selectMock.mock.results[3]!.value;
    const policyJoinArgs = JSON.stringify(linkQuery.innerJoin.mock.calls[0]);
    expect(policyJoinArgs).toContain('configurationPolicies.partnerId');
    expect(policyJoinArgs).toContain('partner-1');
    expect(JSON.stringify(linkQuery.innerJoin.mock.calls[1])).toContain('system_protection');
  });

  it('partially-specified settings merge over the defaults', async () => {
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(makeChain([row({ beforeScripts: true }, 'organization')]));

    const res = await resolveSystemProtectionForDevice('device-1');
    expect(res.settings.beforePatching).toBe(true); // default retained
    expect(res.settings.beforeScripts).toBe(true); // explicit
    expect(res.settings.labelPrefix).toBe('Breeze');
    expect(res.invalidStoredSettings).toBe(false);
  });

  it('a null stored blob on a winning link resolves to the defaults as an explicit policy', async () => {
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(makeChain([row(null, 'organization')]));

    const res = await resolveSystemProtectionForDevice('device-1');
    expect(res.settings).toEqual(DEFAULTS);
    expect(res.isPlatformDefault).toBe(false);
    expect(res.invalidStoredSettings).toBe(false);
  });

  it('malformed stored settings fall back to the platform defaults without throwing, and say so', async () => {
    // Stored JSON bypassing the write-time validator must never throw into a
    // caller (a heartbeat or command build). It resolves to the legacy-parity
    // defaults — never to "everything off" — and flags the fallback so the
    // caller can report it instead of it being silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(
      makeChain([row({ beforeScripts: 'sometimes', beforePatching: false }, 'organization')]),
    );

    const res = await resolveSystemProtectionForDevice('device-1');
    expect(res.settings).toEqual(DEFAULTS);
    expect(res.settings.beforePatching).toBe(true);
    expect(res.invalidStoredSettings).toBe(true);
    expect(res.isPlatformDefault).toBe(false);
    expect(res.policyRevision).toBe('2026-01-01T00:00:00.000Z');
    // Names the offending link and the policy that owns its settings, so the
    // bad row can be found from the log line alone.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('system_protection'),
      expect.objectContaining({ deviceId: 'device-1', featureLinkId: 'link-1', sourcePolicyId: 'policy-src-1' }),
    );
    warn.mockRestore();
  });

  it('an unknown stored key is treated as malformed, not silently kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(makeChain([row({ beforeScripts: true, onFailure: 'abort' }, 'device')]));

    const res = await resolveSystemProtectionForDevice('device-1');
    expect(res.invalidStoredSettings).toBe(true);
    expect(res.settings).toEqual(DEFAULTS);
    expect(res.settings).not.toHaveProperty('onFailure');
    warn.mockRestore();
  });

  it('returns a fresh settings object each call (the frozen defaults are never handed out)', async () => {
    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(makeChain([]));
    const a = await resolveSystemProtectionForDevice('device-1');
    expect(Object.isFrozen(a.settings)).toBe(false);
    a.settings.beforeScripts = true;

    mockHierarchyReads(DEVICE);
    selectMock.mockReturnValueOnce(makeChain([]));
    const b = await resolveSystemProtectionForDevice('device-1');
    expect(b.settings.beforeScripts).toBe(false);
  });
});
