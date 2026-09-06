import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, systemDepth, selectDepths, systemStats } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  // Depth of the simulated system DB access context, and the depth each
  // db.select() ran at — lets a test prove a query executed INSIDE
  // withSystemDbAccessContext (the only way RLS shows partner-wide rows).
  systemDepth: { value: 0 },
  selectDepths: [] as number[],
  // Peak simultaneous system contexts. Each one is a real
  // `baseDb.transaction` holding its own pooled connection, so this is the
  // connection-hold guard: it must stay at 1 no matter how many devices the
  // resolver fans out over (#2822 / #1105 class).
  systemStats: { maxDepth: 0 },
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

// Async factory so the mock can model the REAL AsyncLocalStorage semantics of
// db/index.ts. A plain shared counter is NOT good enough: with `Promise.all`,
// one branch entering a system context would make a concurrent sibling's
// `getCurrentDbAccessContext()` report 'system' and skip its own escape — so a
// per-item connection fan-out would look like a single shared context and the
// connection-hold guard below would pass vacuously. With ALS, a reader sees
// 'system' only when IT is genuinely inside the context.
vi.mock('../db', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const systemAls = new AsyncLocalStorage<true>();

  return {
    db: {
      select: (...args: unknown[]) => {
        selectDepths.push(systemAls.getStore() ? 1 : 0);
        return selectMock(...(args as []));
      },
    },

    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) =>
      systemAls.exit(() => fn())
    ),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    // `systemDepth` counts SIMULTANEOUS system contexts — each one is a real
    // `baseDb.transaction` holding its own pooled connection in production.
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      systemDepth.value += 1;
      systemStats.maxDepth = Math.max(systemStats.maxDepth, systemDepth.value);
      try {
        return await systemAls.run(true, fn);
      } finally {
        systemDepth.value -= 1;
      }
    }),
    // Default: an org-scoped request context (the case that cannot see
    // partner-wide policy rows and must therefore escalate).
    getCurrentDbAccessContext: vi.fn(() =>
      systemAls.getStore()
        ? { scope: 'system', orgId: null, accessibleOrgIds: null }
        : { scope: 'organization', orgId: 'org-a', accessibleOrgIds: ['org-a'] }
    ),
  };
});

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
    status: 'devices.status',
    isEphemeral: 'devices.isEphemeral',
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
    // clearAllMocks does NOT drain a mockReturnValueOnce queue. An unconsumed
    // entry would shift every select in the NEXT test by one and produce a
    // baffling `null` result, so reset the implementation outright.
    selectMock.mockReset();
    systemDepth.value = 0;
    selectDepths.length = 0;
    systemStats.maxDepth = 0;
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
      // Timezone resolution now issues a shared org->partner lookup plus one
      // device read each; a persistent implementation keeps this
      // order-independent.
      .mockImplementation(() =>
        makeSelectChain([{
          siteTimezone: null,
          orgSettings: { timezone: 'UTC' },
          partnerId: 'partner-1',
          timezone: 'UTC',
          settings: {},
        }])
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
      // Timezone resolution: ONE shared org->partner lookup for the batch
      // (2 selects), then one device/org/site read per device.
      .mockImplementation(() =>
        makeSelectChain([{
          siteTimezone: null,
          orgSettings: { timezone: 'UTC' },
          partnerId,
          timezone: 'UTC',
          settings: {},
        }])
      );

    const result = await resolveAllBackupAssignedDevices(orgId);

    expect(result).toHaveLength(1);
    // ONE escape, down from two (#4673 W03). The config-policy join no longer
    // escapes: `<table>_partner_wide_select` grants partner-wide rows to the
    // caller's own context, so the only remaining system context is the single
    // one wrapping the timezone fan-out (resolveDeviceTimezone's `partners`
    // join is partner-AXIS, which no SELECT-only branch covers — see
    // db/partnerAxisRead.ts and #2822). Never 1 + N — see the two-device test
    // below.
    expect(dbMock.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(dbMock.runOutsideDbContext).toHaveBeenCalledTimes(1);
    // Exact topology, asserted as a whole array rather than by index: a
    // `.slice(...).every(...)` goes vacuously true if a select is ever removed,
    // which would silently retire this guard.
    // #0 org→partner lookup | #1 config-policy join (CALLER — W03) | #2 org
    // default destination | #3 device expansion | #4 the batch org lookup |
    // #5 the ONE shared partners read (SYSTEM) | #6 the per-device site/org
    // read. Everything except the partner-AXIS read is caller-scoped — device
    // EXPANSION (#3) especially, since that is the read RLS must keep guarding,
    // and now the config-policy join (#1) too.
    expect(selectDepths).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(systemStats.maxDepth).toBe(1);
    // Context must be closed again once the read completes.
    expect(systemDepth.value).toBe(0);
  });

  // CONNECTION-HOLD GUARD (#2822 review, #1105 class). resolveDeviceTimezone
  // takes a partner-axis escape, and every escape is a real
  // `baseDb.transaction` holding its own pooled connection. Resolving
  // timezones per device inside a bare `Promise.all` therefore costs N
  // SIMULTANEOUS connections — and this resolver runs on org-scoped REQUEST
  // routes (routes/backup/{jobs,dashboard,hyperv,mssql}.ts,
  // readinessCalculator.ts), where the skip-when-system branch does not fire.
  // Against the 25-connection ceiling, with no postgres-js acquire timeout,
  // that is a hang rather than an error.
  //
  // The single-device test above CANNOT see this — with N=1, "one escape per
  // device" and "one escape total" are the same number. This test uses TWO
  // devices specifically so the escape count stops scaling with N.
  it('takes ONE system context for the whole timezone fan-out, not one per device', async () => {
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
      // organization-level device expansion — TWO devices
      .mockReturnValueOnce(
        makeSelectChain([{ id: 'device-org-a' }, { id: 'device-org-b' }])
      )
      // resolveDeviceTimezone runs under `Promise.all`, so the two devices'
      // selects INTERLEAVE and a `mockReturnValueOnce` queue would hand device
      // B the row meant for device A's partner read. Use a persistent
      // implementation returning a row that satisfies both the device/org/site
      // read and the partner read, so the mock is order-independent.
      .mockImplementation(() =>
        makeSelectChain([{
          siteTimezone: null,
          orgSettings: { timezone: 'UTC' },
          partnerId,
          timezone: 'UTC',
          settings: {},
        }])
      );

    const result = await resolveAllBackupAssignedDevices(orgId);

    expect(result).toHaveLength(2);
    // Still 1 with two devices — the count does not scale with N. It was 3
    // (1 policy join + 1 per device) before the timezone batching, 2 after it,
    // and 1 since #4673 W03 dropped the policy join's escape. The partner
    // timezone is resolved once for the whole batch, so there is exactly ONE
    // `partners` read rather than N identical ones.
    expect(dbMock.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(dbMock.runOutsideDbContext).toHaveBeenCalledTimes(1);
    // The real assertion: never more than one system transaction — and
    // therefore never more than one extra pooled connection — at any instant.
    expect(systemStats.maxDepth).toBe(1);
    // #0 org→partner | #1 policy join (CALLER — W03) | #2 org default
    // destination | #3 device expansion (CALLER — the read RLS must keep
    // guarding) | #4 the batch org lookup | #5 the ONE shared partners read
    // (SYSTEM) | #6,#7 the per-device site/org reads (CALLER).
    //
    // The key property: exactly ONE depth-1 select in the timezone tail no
    // matter how many devices there are. Pre-fix this was one per device.
    expect(selectDepths.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(selectDepths.slice(4).filter((d) => d === 1)).toHaveLength(1);
    expect(systemDepth.value).toBe(0);
  });
});

describe('resolveBackupConfigForDevice partner-wide visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain a mockReturnValueOnce queue. An unconsumed
    // entry would shift every select in the NEXT test by one and produce a
    // baffling `null` result, so reset the implementation outright.
    selectMock.mockReset();
    systemDepth.value = 0;
    selectDepths.length = 0;
    systemStats.maxDepth = 0;
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
      // the config-policy join (runs in the CALLER's context since W03)
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
      // resolveDeviceTimezone: device/org/site in the CALLER'S context, then
      // the partner-axis read escaped on its own (#2822).
      .mockReturnValueOnce(
        makeSelectChain([{ siteTimezone: null, orgSettings: { timezone: 'UTC' }, partnerId: 'partner-1' }])
      )
      .mockReturnValueOnce(makeSelectChain([{ timezone: 'UTC', settings: {} }]));

    const resolved = await resolveBackupConfigForDevice('device-1');

    expect(resolved).toMatchObject({ featureLinkId: 'feature-1', configId: 'config-1' });
    // ONE escape: resolveDeviceTimezone's partner-AXIS read (#2822). The policy
    // join no longer takes one — #4673 W03 removed it once
    // `<table>_partner_wide_select` made partner-wide rows legible to the
    // caller's own context.
    expect(dbMock.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(dbMock.runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(systemStats.maxDepth).toBe(1);
    // 0-2 device hierarchy (caller) | 3 policy join (CALLER — W03) | 4 timezone
    // device/org/site read (CALLER — RLS still selects the device) | 5 the
    // partner-axis read (system).
    expect(selectDepths).toEqual([0, 0, 0, 0, 0, 1]);
    expect(systemDepth.value).toBe(0);
  });
});

// A decommissioned device is a soft-deleted one (routes/devices/core.ts's
// `DELETE /:id` only flips `status`) and an ephemeral device is a Quick Support
// session box the reaper purges within 6h. Neither can accept a backup, yet
// every fan-out branch used to sweep them into the assigned set: a device
// decommissioned on 2026-08-08 kept getting a fresh `backup_jobs` row every day
// at 04:00 UTC, each failing with `Agent not connected`, and a
// `recovery_readiness` row scoring 0 that pinned the low-readiness alert
// (#3968).
describe('resolveAllBackupAssignedDevices excludes decommissioned and ephemeral devices (#3968)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    systemDepth.value = 0;
    selectDepths.length = 0;
    systemStats.maxDepth = 0;
  });

  /**
   * Renders a captured predicate tree back into readable SQL-ish text,
   * splicing each interpolated column sentinel into its `sql` template.
   *
   * Asserting on the rendered predicate — rather than on rows a hand-shaped
   * mock filtered for us — is what makes these assertions discriminating: a
   * mock can be taught to drop decommissioned rows all by itself, but only the
   * real predicate can put the exclusion into the SQL Postgres runs. Delete the
   * exclusion from the resolver and this text stops containing it.
   */
  function renderCondition(condition: unknown): string {
    if (condition === null || condition === undefined) return '';
    if (typeof condition !== 'object') return String(condition);

    const node = condition as Record<string, any>;
    if (node.op === 'sql') {
      const strings: readonly string[] = node.strings ?? [];
      const values: unknown[] = node.values ?? [];
      return strings
        .map((chunk, index) => chunk + (index < values.length ? renderCondition(values[index]) : ''))
        .join('');
    }
    if (node.op === 'and') {
      return ((node.conditions ?? []) as unknown[]).map(renderCondition).join(' AND ');
    }
    if (node.op === 'eq') return `${renderCondition(node.column)} = ${JSON.stringify(node.value)}`;
    if (node.op === 'inArray') return `${renderCondition(node.column)} IN (…)`;
    return JSON.stringify(node);
  }

  /**
   * Runs the resolver for one assignment level and returns the predicate its
   * device-expansion query handed to Drizzle. Every level resolves through its
   * own switch branch, so each one needs its own capture — the whole point of
   * #3968 is that a per-branch predicate is easy to miss on one branch.
   */
  async function captureDeviceExpansionPredicate(
    assignmentLevel: string,
    assignmentTargetId: string
  ): Promise<string> {
    const orgId = 'org-a';
    const partnerId = 'partner-1';
    let captured: unknown;

    selectMock
      // org → partnerId lookup
      .mockReturnValueOnce(makeSelectChain([{ partnerId }]))
      // feature links + settings + assignments
      .mockReturnValueOnce(
        makeSelectChain([
          {
            backupSettings: { schedule: { frequency: 'daily', time: '01:00' } },
            featureLinkId: 'feature-1',
            featurePolicyId: 'config-1',
            profileSelections: null,
            assignmentLevel,
            assignmentTargetId,
            assignmentPriority: 1,
            assignmentCreatedAt: new Date('2026-04-01T00:00:00Z'),
          },
        ])
      )
      // org default destination lookup
      .mockReturnValueOnce(makeSelectChain([]))
      // the device expansion for this branch
      .mockReturnValueOnce(
        makeSelectChain((condition: unknown) => {
          captured = condition;
          // `device_group` selects `deviceId`, every other branch selects `id`.
          return [{ id: 'device-live', deviceId: 'device-live' }];
        })
      )
      .mockImplementation(() =>
        makeSelectChain([
          {
            siteTimezone: null,
            orgSettings: { timezone: 'UTC' },
            partnerId,
            timezone: 'UTC',
            settings: {},
          },
        ])
      );

    const result = await resolveAllBackupAssignedDevices(orgId);

    // Guard the guard: if the branch never resolved a device the predicate
    // capture would be silently empty and every assertion below vacuous.
    expect(result.map((entry) => entry.deviceId)).toEqual(['device-live']);
    expect(captured).toBeDefined();

    return renderCondition(captured);
  }

  // Table-driven over EVERY branch of the switch. The resolver has five
  // assignment levels and the bug was that none of them filtered; a test that
  // covered only `organization` would have gone green on a four-branch fix.
  const branches: Array<{ level: string; targetId: string }> = [
    { level: 'device', targetId: 'device-live' },
    { level: 'device_group', targetId: 'group-1' },
    { level: 'site', targetId: 'site-1' },
    { level: 'organization', targetId: 'org-a' },
    { level: 'partner', targetId: 'partner-1' },
  ];

  it.each(branches)(
    'excludes decommissioned devices from the $level assignment fan-out',
    async ({ level, targetId }) => {
      const predicate = await captureDeviceExpansionPredicate(level, targetId);

      expect(predicate).toMatch(/devices\.status\s*(<>|!=)\s*'decommissioned'/);
    }
  );

  it.each(branches)(
    'excludes ephemeral Quick Support devices from the $level assignment fan-out',
    async ({ level, targetId }) => {
      const predicate = await captureDeviceExpansionPredicate(level, targetId);

      expect(predicate).toMatch(/devices\.isEphemeral\s*=\s*false/);
    }
  );

  // The exclusion must never cost the tenancy predicate it sits beside: a
  // partner-wide policy is visible to every org under the partner, so dropping
  // the org re-tenanting would attribute another org's devices to this one.
  it.each(branches)(
    'keeps the org re-tenanting predicate on the $level assignment fan-out',
    async ({ level, targetId }) => {
      const predicate = await captureDeviceExpansionPredicate(level, targetId);

      expect(predicate).toContain('devices.orgId = "org-a"');
    }
  );
});
