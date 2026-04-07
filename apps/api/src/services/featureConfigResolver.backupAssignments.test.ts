import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
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
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
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

import { resolveAllBackupAssignedDevices } from './featureConfigResolver';

describe('resolveAllBackupAssignedDevices tenancy scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps partner-level backup assignments constrained to the requested org', async () => {
    const orgId = 'org-a';
    const partnerId = 'partner-1';

    selectMock
      .mockReturnValueOnce(
        makeSelectChain([
          {
            backupSettings: { schedule: { frequency: 'daily', time: '01:00' } },
            featureLinkId: 'feature-1',
            configId: 'config-1',
            assignmentLevel: 'partner',
            assignmentTargetId: partnerId,
            assignmentPriority: 1,
            assignmentCreatedAt: new Date('2026-04-01T00:00:00Z'),
          },
        ])
      )
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
});
