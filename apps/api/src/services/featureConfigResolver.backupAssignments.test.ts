import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, systemDepth, selectDepths } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  // Depth of the simulated system DB access context, and the depth each
  // db.select() ran at — lets a test prove a query executed INSIDE
  // withSystemDbAccessContext (the only way RLS shows partner-wide rows).
  systemDepth: { value: 0 },
  selectDepths: [] as number[],
}));

function makeSelectChain(
  resolveResult: unknown | ((condition: unknown) => unknown)
) {
  const chain: Record<string, any> = {
    _result: typeof resolveResult === 'function' ? [] : resolveResult,
    _condition: undefined,
  };

  chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(chain._result).then(onFulfilled, onRejected);
  chain.catch = (onRejected: (reason: unknown) => unknown) =>
    Promise.resolve(chain._result).catch(onRejected);
  chain.finally = (onFinally: () => void) =>
    Promise.resolve(chain._result).finally(onFinally);

  for (const method of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy']) {
    chain[method] = vi.fn(() => chain);
  }

  chain.where = vi.fn((condition: unknown) => {
    chain._condition = condition;
    chain._result =
      typeof resolveResult === 'function' ? resolveResult(condition) : resolveResult;
    return chain;
  });

  chain.limit = vi.fn(() => Promise.resolve(chain._result));

  return chain;
}

type MockCondition =
  | { op: 'eq'; column: unknown; value: unknown }
  | { op: 'and'; conditions: MockCondition[] }
  | { op: 'inArray'; column: unknown; values: unknown[] }
  | { op: string; [key: string]: unknown };

function findEqValue(condition: unknown, column: unknown): unknown {
  if (!condition || typeof condition !== 'object') return undefined;

  const typed = condition as MockCondition;
  if (typed.op === 'eq' && typed.column === column) {
    return typed.value;
  }

  if (typed.op === 'and' && Array.isArray(typed.conditions)) {
    for (const child of typed.conditions) {
      const value = findEqValue(child, column);
      if (value !== undefined) return value;
    }
  }

  return undefined;
}

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => {
      selectDepths.push(systemDepth.value);
      return selectMock(...(args as []));
    },
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  // Track nesting so a test can assert WHICH queries ran system-scoped.
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    systemDepth.value += 1;
    try {
      return await fn();
    } finally {
      systemDepth.value -= 1;
    }
  }),
  // Default: an org-scoped request context (the case that cannot see
  // partner-wide policy rows and must therefore escalate).
  getCurrentDbAccessContext: vi.fn(() =>
    systemDepth.value > 0
      ? { scope: 'system', orgId: null, accessibleOrgIds: null }
      : { scope: 'organization', orgId: 'org-a', accessibleOrgIds: ['org-a'] }
  ),
}));

vi.mock('../db/schema', () => ({
  configurationPolicies: {
    id: 'configurationPolicies.id',
    orgId: 'configurationPolicies.orgId',
    status: 'configurationPolicies.status',
  },
  configPolicyFeatureLinks: {
    id: 'configPolicyFeatureLinks.id',
    configPolicyId: 'configPolicyFeatureLinks.configPolicyId',
    featureType: 'configPolicyFeatureLinks.featureType',
    featurePolicyId: 'configPolicyFeatureLinks.featurePolicyId',
  },
  configPolicyAssignments: {
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
  configPolicyBackupSettings: {
    featureLinkId: 'configPolicyBackupSettings.featureLinkId',
    schedule: 'configPolicyBackupSettings.schedule',
    backupProfileId: 'configPolicyBackupSettings.backupProfileId',
    destinationConfigId: 'configPolicyBackupSettings.destinationConfigId',
  },
  backupProfiles: {
    id: 'backupProfiles.id',
    selections: 'backupProfiles.selections',
  },
  backupConfigs: {
    id: 'backupConfigs.id',
    orgId: 'backupConfigs.orgId',
    isDefault: 'backupConfigs.isDefault',
    isActive: 'backupConfigs.isActive',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    settings: 'organizations.settings',
  },
  // resolveDeviceTimezone joins partners for the #1318 partner-tz fallback.
  partners: {
    id: 'partners.id',
    timezone: 'partners.timezone',
    settings: 'partners.settings',
  },
  deviceGroupMemberships: {
    deviceId: 'deviceGroupMemberships.deviceId',
    groupId: 'deviceGroupMemberships.groupId',
  },
  sites: {
    id: 'sites.id',
    timezone: 'sites.timezone',
  },
  softwarePolicies: {},
}));

vi.mock('drizzle-orm', () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: 'sql',
      strings,
      values,
    }),
    {
      param: (value: unknown) => ({ op: 'param', value }),
      // resolveBackupConfigForDevice ORs the hierarchy target conditions together.
      join: (chunks: unknown[], separator: unknown) => ({ op: 'join', chunks, separator }),
    }
  );

  return {
    and: (...conditions: MockCondition[]) => ({ op: 'and', conditions }),
    eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
    inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
    asc: (value: unknown) => ({ op: 'asc', value }),
    sql,
    SQL: class SQL {},
  };
});

import * as dbModule from '../db';
import {
  resolveAllBackupAssignedDevices,
  resolveBackupConfigForDevice,
} from './featureConfigResolver';

// Typed handles on the mocked db module (vi.fn instances declared in the factory).
const dbMock = dbModule as unknown as {
  withSystemDbAccessContext: ReturnType<typeof vi.fn>;
  runOutsideDbContext: ReturnType<typeof vi.fn>;
  getCurrentDbAccessContext: ReturnType<typeof vi.fn>;
};

describe('resolveAllBackupAssignedDevices tenancy scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemDepth.value = 0;
    selectDepths.length = 0;
  });

  it('keeps partner-level backup assignments constrained to the requested org', async () => {
    const orgId = 'org-a';
    const partnerId = 'partner-1';

    selectMock
      // 1. org → partnerId lookup (partner-wide policy coverage)
      .mockReturnValueOnce(makeSelectChain([{ partnerId }]))
      // 2. feature links + settings + assignments
      .mockReturnValueOnce(
        makeSelectChain([
          {
            backupSettings: { schedule: { frequency: 'daily', time: '01:00' } },
            featureLinkId: 'feature-1',
            featurePolicyId: 'config-1',
            profileSelections: null,
            assignmentLevel: 'partner',
            assignmentTargetId: partnerId,
            assignmentPriority: 1,
            assignmentCreatedAt: new Date('2026-04-01T00:00:00Z'),
          },
        ])
      )
      // 3. org default destination lookup (none configured)
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(
        makeSelectChain((condition: unknown) => {
          const resolvedPartnerId = findEqValue(condition, 'organizations.partnerId');
          const resolvedOrgId = findEqValue(condition, 'devices.orgId');

          const devicesForPartner = [
            { id: 'device-org-a', orgId: 'org-a', partnerId: 'partner-1' },
            { id: 'device-org-b', orgId: 'org-b', partnerId: 'partner-1' },
          ];

          return devicesForPartner
            .filter((row) => resolvedPartnerId === undefined || row.partnerId === resolvedPartnerId)
            .filter((row) => resolvedOrgId === undefined || row.orgId === resolvedOrgId)
            .map((row) => ({ id: row.id }));
        })
      )
      .mockReturnValueOnce(
        makeSelectChain([{ timezone: 'UTC', orgSettings: { timezone: 'UTC' } }])
      );

    const result = await resolveAllBackupAssignedDevices(orgId);

    expect(result).toEqual([
      expect.objectContaining({
        deviceId: 'device-org-a',
        featureLinkId: 'feature-1',
        configId: 'config-1',
        resolvedTimezone: 'UTC',
      }),
    ]);
  });

  // Partner-wide config policies have org_id NULL; an org-scoped request context
  // never passes breeze_has_partner_access, so RLS hides those rows entirely and
  // the device reads as "unprotected". The policy join must therefore run inside
  // a system DB access context (#1105 heartbeat probe-config precedent).
  it('reads config policies inside a system DB access context, and expands devices in the caller context', async () => {
    const orgId = 'org-a';
    const partnerId = 'partner-1';

    selectMock
      .mockReturnValueOnce(makeSelectChain([{ partnerId }]))
      .mockReturnValueOnce(
        makeSelectChain([
          {
            backupSettings: {
              schedule: { frequency: 'daily', time: '01:00' },
              destinationConfigId: 'config-1',
            },
            featureLinkId: 'feature-1',
            featurePolicyId: null,
            profileSelections: null,
            assignmentLevel: 'organization',
            assignmentTargetId: orgId,
            assignmentPriority: 1,
            assignmentCreatedAt: new Date('2026-04-01T00:00:00Z'),
          },
        ])
      )
      // org default destination lookup
      .mockReturnValueOnce(makeSelectChain([]))
      // organization-level device expansion
      .mockReturnValueOnce(makeSelectChain([{ id: 'device-org-a' }]))
      // resolveDeviceTimezone
      .mockReturnValueOnce(
        makeSelectChain([{ timezone: 'UTC', orgSettings: { timezone: 'UTC' } }])
      );

    const result = await resolveAllBackupAssignedDevices(orgId);

    expect(result).toHaveLength(1);
    expect(dbMock.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(dbMock.runOutsideDbContext).toHaveBeenCalledTimes(1);
    // select #0 = org→partner lookup, #1 = the config-policy join, rest = device
    // expansion + timezone. ONLY the policy join is escalated: widening the whole
    // resolver to system scope would let a caller see devices RLS denies them.
    expect(selectDepths[0]).toBe(0);
    expect(selectDepths[1]).toBe(1);
    expect(selectDepths.slice(2).every((depth) => depth === 0)).toBe(true);
    // Context must be closed again once the read completes.
    expect(systemDepth.value).toBe(0);
  });
});

describe('resolveBackupConfigForDevice partner-wide visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemDepth.value = 0;
    selectDepths.length = 0;
  });

  it('reads the config-policy join in a system context while the device hierarchy stays caller-scoped', async () => {
    selectMock
      // loadDeviceHierarchy: device → org → group memberships
      .mockReturnValueOnce(
        makeSelectChain([
          {
            id: 'device-1',
            orgId: 'org-a',
            siteId: 'site-1',
            deviceRole: 'workstation',
            osType: 'windows',
          },
        ])
      )
      .mockReturnValueOnce(makeSelectChain([{ partnerId: 'partner-1' }]))
      .mockReturnValueOnce(makeSelectChain([]))
      // the config-policy join (must be system-scoped)
      .mockReturnValueOnce(
        makeSelectChain([
          {
            backupSettings: {
              schedule: { frequency: 'daily', time: '01:00' },
              destinationConfigId: 'config-1',
              backupProfileId: null,
            },
            featureLinkId: 'feature-1',
            featurePolicyId: null,
            inlineSettings: null,
            profileSelections: null,
            assignmentLevel: 'organization',
            assignmentPriority: 1,
            assignmentCreatedAt: new Date('2026-04-01T00:00:00Z'),
          },
        ])
      )
      // resolveDeviceTimezone
      .mockReturnValueOnce(
        makeSelectChain([{ timezone: 'UTC', orgSettings: { timezone: 'UTC' } }])
      );

    const resolved = await resolveBackupConfigForDevice('device-1');

    expect(resolved).toMatchObject({ featureLinkId: 'feature-1', configId: 'config-1' });
    expect(dbMock.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(dbMock.runOutsideDbContext).toHaveBeenCalledTimes(1);
    // selects 0-2 = device hierarchy (caller context), 3 = policy join (system).
    expect(selectDepths.slice(0, 3)).toEqual([0, 0, 0]);
    expect(selectDepths[3]).toBe(1);
    expect(systemDepth.value).toBe(0);
  });
});
