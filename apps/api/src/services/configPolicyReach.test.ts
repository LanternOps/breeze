/**
 * Unit tests for policy reach (#12465, plan W02a R2).
 *
 * The REAL shared resolver (resolveAssignmentDevices) and the REAL role/OS
 * predicate run; only the driver and the group gating are faked. The db fake
 * dispatches each select on the table it reads and on the compiled WHERE
 * params, so it answers like a tiny database instead of a statement queue:
 *  - configuration_policies: the requested policies, or (WHERE names
 *    parent_policy_id) their children;
 *  - config_policy_assignments: the rows of the policies in the IN list;
 *  - devices / device_group_memberships: the candidate devices of ONE target
 *    (the target id is the first WHERE param in every resolver branch);
 *  - devices selected as { id, orgId }: the org lookup over the union.
 * RLS, the real SQL and the caller's context are exercised by
 * configPolicyReach.integration.test.ts against Postgres.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { selectMock, state, mockResolveSafe, mockAudit, mockAccessCondition } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  state: {
    policies: [] as Array<{ id: string; orgId: string | null; partnerId: string | null; parentPolicyId?: string | null }>,
    assignments: [] as Array<{ configPolicyId: string; level: string; targetId: string; roleFilter: string[] | null; osFilter: string[] | null }>,
    devices: [] as Array<{ id: string; orgId: string; siteId: string; partnerId: string; groups: string[]; deviceRole: string | null; osType: string | null }>,
    candidateSelects: 0,
    childWhere: [] as unknown[],
    /** The LIMIT each child read carried (undefined: none). */
    childLimits: [] as Array<number | undefined>,
    accessWhere: [] as unknown[],
    /** Devices the final read no longer returns (deleted between reads). */
    vanished: [] as string[],
    tableReads: new Map<unknown, number>(),
    finalReads: 0,
  },
  mockResolveSafe: vi.fn(async (groupIds: string[]) => ({
    allowedGroupIds: groupIds,
    refusedGroups: [] as Array<{ id: string; refusedFields: string[] }>,
  })),
  mockAudit: vi.fn(),
  mockAccessCondition: vi.fn((): unknown => undefined),
}));

vi.mock('../db', () => ({ db: { select: selectMock } }));

vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: (ids: string[]) => mockResolveSafe(ids),
  auditRefusedExecutionGroups: (...args: unknown[]) => mockAudit(...args),
}));

vi.mock('./configurationPolicy', () => ({
  policyAccessCondition: () => mockAccessCondition(),
}));

import {
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships,
  devices,
} from '../db/schema';
import {
  REACH_CHILD_POLICY_LIMIT,
  REACH_STATEMENT_BUDGET,
  computePolicyReach,
  expandAssignmentsToDevices,
  readablePolicyIds,
} from './configPolicyReach';

const dialect = new PgDialect();
const compile = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

function answer(cols: Record<string, unknown>, table: unknown, where: unknown, limit?: number): unknown[] {
  const { sql, params } = where ? compile(where) : { sql: '', params: [] as unknown[] };
  if (table === configurationPolicies) {
    if (!sql.includes('"parent_policy_id"') && sql.includes('access_marker')) {
      state.accessWhere.push(where);
      return state.policies.filter((p) => params.includes(p.id)).map((p) => ({ id: p.id }));
    }
    if (sql.includes('"parent_policy_id"')) {
      state.childWhere.push(where);
      state.childLimits.push(limit);
      // The child read is ordered (parent, id) and capped, like the real SQL.
      const children = state.policies
        .filter((p) => p.parentPolicyId && params.includes(p.parentPolicyId))
        .sort((a, b) => `${a.parentPolicyId}|${a.id}`.localeCompare(`${b.parentPolicyId}|${b.id}`));
      return limit === undefined ? children : children.slice(0, limit);
    }
    return state.policies.filter((p) => params.includes(p.id));
  }
  if (table === configPolicyAssignments) {
    return state.assignments.filter((a) => params.includes(a.configPolicyId));
  }
  if (table === devices && !('deviceRole' in cols)) {
    const ids = params[0] as string[];
    state.finalReads += 1;
    return state.devices
      .filter((d) => ids.includes(d.id) && !state.vanished.includes(d.id))
      .map((d) => ({ id: d.id, orgId: d.orgId, siteId: d.siteId }));
  }
  if (table === devices) {
    state.candidateSelects += 1;
    const target = params[0];
    // The org clamp (an org-owned policy, or the org-level target itself).
    const orgClamped = sql.includes('"devices"."org_id"');
    return state.devices
      .filter((d) => [d.id, d.orgId, d.siteId, d.partnerId].includes(target as string))
      .filter((d) => !orgClamped || params.includes(d.orgId))
      .map((d) => ({ id: d.id, deviceRole: d.deviceRole, osType: d.osType }));
  }
  if (table === deviceGroupMemberships) {
    state.candidateSelects += 1;
    const group = params[0] as string;
    return state.devices
      .filter((d) => d.groups.includes(group))
      .map((d) => ({ id: d.id, deviceRole: d.deviceRole, osType: d.osType }));
  }
  throw new Error('unexpected table');
}

selectMock.mockImplementation((cols: Record<string, unknown>) => {
  let table: unknown;
  let where: unknown;
  let limit: number | undefined;
  const c: Record<string, unknown> = {};
  for (const m of ['innerJoin', 'leftJoin', 'groupBy', 'orderBy']) c[m] = () => c;
  c.limit = (n: number) => { limit = n; return c; };
  c.from = (t: unknown) => {
    table = t;
    state.tableReads.set(t, (state.tableReads.get(t) ?? 0) + 1);
    return c;
  };
  c.where = (w: unknown) => { where = w; return c; };
  c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve().then(() => answer(cols, table, where, limit)).then(resolve, reject);
  return c;
});

const PARTNER = 'partner-1';
const ORG_A = 'org-a';
const ORG_B = 'org-b';

function device(id: string, over: Partial<(typeof state.devices)[number]> = {}) {
  return { id, orgId: ORG_A, siteId: 'site-a1', partnerId: PARTNER, groups: [], deviceRole: 'workstation', osType: 'windows', ...over };
}
function row(configPolicyId: string, level: string, targetId: string, filters: { roleFilter?: string[] | null; osFilter?: string[] | null } = {}) {
  return { configPolicyId, level, targetId, roleFilter: filters.roleFilter ?? null, osFilter: filters.osFilter ?? null };
}
const auth = { scope: 'partner', partnerId: PARTNER } as never;

afterEach(() => {
  state.policies = [];
  state.assignments = [];
  state.devices = [];
  state.candidateSelects = 0;
  state.childWhere = [];
  state.childLimits = [];
  state.accessWhere = [];
  state.vanished = [];
  state.tableReads = new Map();
  state.finalReads = 0;
  vi.clearAllMocks();
  mockAccessCondition.mockReturnValue(undefined);
});

describe('computePolicyReach', () => {
  it('reach unions a policy\'s targets once', async () => {
    state.devices = [device('d1'), device('d2', { siteId: 'site-a2' }), device('d3', { groups: ['g1'] })];
    state.policies = [{ id: 'p1', orgId: ORG_A, partnerId: null }];
    // The org row covers d1-d3; the site and group rows overlap it.
    state.assignments = [row('p1', 'organization', ORG_A), row('p1', 'site', 'site-a1'), row('p1', 'device_group', 'g1')];

    const reach = await computePolicyReach(auth, ['p1']);

    expect(reach.get('p1')).toEqual({ direct: 3, throughChildren: 0, organizations: 1 });
  });

  it('throughChildren excludes devices already reached directly', async () => {
    state.devices = [device('d1'), device('d2', { siteId: 'site-a2' }), device('d3', { siteId: 'site-a3' })];
    state.policies = [
      { id: 'parent', orgId: null, partnerId: PARTNER },
      { id: 'child', orgId: ORG_A, partnerId: null, parentPolicyId: 'parent' },
    ];
    state.assignments = [
      row('parent', 'site', 'site-a1'),
      row('child', 'site', 'site-a1'), // already direct
      row('child', 'site', 'site-a2'),
      row('child', 'site', 'site-a3'),
    ];

    const reach = await computePolicyReach(auth, ['parent']);

    expect(reach.get('parent')).toEqual({ direct: 1, throughChildren: 2, organizations: 1 });
  });

  it('role and OS filters narrow the count', async () => {
    state.devices = [
      device('ws-win'),
      device('ws-mac', { osType: 'macos' }),
      device('srv-win', { deviceRole: 'server' }),
      device('no-role', { deviceRole: null }),
    ];
    state.policies = [
      { id: 'roles', orgId: ORG_A, partnerId: null },
      { id: 'both', orgId: ORG_A, partnerId: null },
      { id: 'none', orgId: ORG_A, partnerId: null },
    ];
    state.assignments = [
      row('roles', 'organization', ORG_A, { roleFilter: ['workstation'] }),
      row('both', 'organization', ORG_A, { roleFilter: ['workstation'], osFilter: ['windows'] }),
      row('none', 'organization', ORG_A, { roleFilter: [] }),
    ];

    const reach = await computePolicyReach(auth, ['roles', 'both', 'none']);

    expect(reach.get('roles')?.direct).toBe(2);
    expect(reach.get('both')?.direct).toBe(1);
    expect(reach.get('none')).toEqual({ direct: 0, throughChildren: 0, organizations: 0 });
  });

  it('organizations counts distinct device orgs', async () => {
    state.devices = [
      device('a1'),
      device('a2', { siteId: 'site-a2' }),
      device('b1', { orgId: ORG_B, siteId: 'site-b1' }),
    ];
    state.policies = [
      { id: 'parent', orgId: null, partnerId: PARTNER },
      { id: 'child-b', orgId: ORG_B, partnerId: null, parentPolicyId: 'parent' },
    ];
    state.assignments = [row('parent', 'organization', ORG_A), row('child-b', 'organization', ORG_B)];

    const reach = await computePolicyReach(auth, ['parent']);

    // Two from org A directly, one from org B through the child: two orgs.
    expect(reach.get('parent')).toEqual({ direct: 2, throughChildren: 1, organizations: 2 });
  });

  it('memo reuses one expansion across policies', async () => {
    state.devices = [device('d1'), device('d2')];
    state.policies = [
      { id: 'p1', orgId: null, partnerId: PARTNER },
      { id: 'p2', orgId: null, partnerId: PARTNER },
    ];
    state.assignments = [row('p1', 'organization', ORG_A), row('p2', 'organization', ORG_A)];

    const reach = await computePolicyReach(auth, ['p1', 'p2']);

    expect(reach.get('p1')?.direct).toBe(2);
    expect(reach.get('p2')?.direct).toBe(2);
    expect(state.candidateSelects).toBe(1);
  });

  it('memo keeps a null filter (all devices) apart from an empty one (no device)', async () => {
    state.devices = [device('d1')];
    state.policies = [
      { id: 'all', orgId: null, partnerId: PARTNER },
      { id: 'nothing', orgId: null, partnerId: PARTNER },
    ];
    state.assignments = [row('all', 'organization', ORG_A), row('nothing', 'organization', ORG_A, { roleFilter: [] })];

    const reach = await computePolicyReach(auth, ['all', 'nothing']);

    expect(reach.get('all')?.direct).toBe(1);
    expect(reach.get('nothing')?.direct).toBe(0);
    expect(state.candidateSelects).toBe(2);
  });

  it('reach never writes an audit row', async () => {
    // A group keyed on an agent-reported field: the scheduler audits it; reach must not.
    mockResolveSafe.mockResolvedValue({ allowedGroupIds: [], refusedGroups: [{ id: 'g1', refusedFields: ['hostname'] }] });
    state.devices = [device('d1', { groups: ['g1'] })];
    state.policies = [{ id: 'p1', orgId: ORG_A, partnerId: null }];
    state.assignments = [row('p1', 'device_group', 'g1')];

    const reach = await computePolicyReach(auth, ['p1']);

    // Counted the way the scheduler resolves it ('resolve'), with no audit.
    expect(reach.get('p1')?.direct).toBe(1);
    expect(mockResolveSafe).toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('omits a policy the caller cannot read and counts an inactive one', async () => {
    state.devices = [device('d1')];
    // 'ghost' is not returned by the (RLS-scoped) policy read.
    state.policies = [{ id: 'p1', orgId: ORG_A, partnerId: null }];
    state.assignments = [row('p1', 'organization', ORG_A)];

    const reach = await computePolicyReach(auth, ['p1', 'ghost']);

    expect([...reach.keys()]).toEqual(['p1']);
  });

  it('narrows the children through the caller\'s policy access condition', async () => {
    const { sql } = await import('drizzle-orm');
    mockAccessCondition.mockReturnValue(sql`access_marker = 1`);
    state.policies = [{ id: 'p1', orgId: null, partnerId: PARTNER }];

    await computePolicyReach(auth, ['p1']);

    expect(state.childWhere).toHaveLength(1);
    expect(compile(state.childWhere[0]).sql).toContain('access_marker = 1');
  });

  it('expands each child under the child\'s own owner, not the parent\'s', async () => {
    state.devices = [device('a1'), device('b1', { orgId: ORG_B, siteId: 'site-b1' })];
    state.policies = [
      { id: 'parent', orgId: null, partnerId: PARTNER },
      { id: 'child-a', orgId: ORG_A, partnerId: null, parentPolicyId: 'parent' },
    ];
    state.assignments = [row('child-a', 'partner', PARTNER)];

    const reach = await computePolicyReach(auth, ['parent']);

    // A (legacy) partner row on an org-owned child is clamped to the child's org.
    expect(reach.get('parent')).toEqual({ direct: 0, throughChildren: 1, organizations: 1 });
  });

  it('reads policies, children, assignments and the final device set once each, whatever the page size', async () => {
    state.devices = [device('d1'), device('d2', { siteId: 'site-a2' })];
    state.policies = [];
    state.assignments = [];
    for (let i = 0; i < 3; i += 1) {
      state.policies.push({ id: `p${i}`, orgId: null, partnerId: PARTNER });
      state.policies.push({ id: `c${i}`, orgId: ORG_A, partnerId: null, parentPolicyId: `p${i}` });
      state.assignments.push(row(`p${i}`, 'site', 'site-a1'), row(`c${i}`, 'site', 'site-a2'));
    }

    await computePolicyReach(auth, ['p0', 'p1', 'p2']);

    expect(state.tableReads.get(configurationPolicies)).toBe(2); // policies, then children
    expect(state.tableReads.get(configPolicyAssignments)).toBe(1);
    expect(state.finalReads).toBe(1);
  });

  it('keys the memo on the owner: an org-owned child never reuses a partner-owned expansion', async () => {
    // The same partner-level row on a partner-owned parent (unclamped) and on an
    // org-owned child (clamped to org A) are two expansions, not one.
    state.devices = [device('a1'), device('b1', { orgId: ORG_B, siteId: 'site-b1' })];
    state.policies = [
      { id: 'parent', orgId: null, partnerId: PARTNER },
      { id: 'child', orgId: ORG_A, partnerId: null, parentPolicyId: 'parent' },
    ];
    state.assignments = [row('parent', 'partner', PARTNER), row('child', 'partner', PARTNER)];

    const reach = await computePolicyReach(auth, ['parent', 'child']);

    expect(reach.get('parent')).toEqual({ direct: 2, throughChildren: 0, organizations: 2 });
    expect(reach.get('child')).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });
    expect(state.candidateSelects).toBe(2);
  });

  it('counts only the devices in a site-restricted caller\'s sites', async () => {
    state.devices = [
      device('a1'),
      device('a2', { siteId: 'site-a2' }),
      device('a3', { siteId: 'site-a2' }),
    ];
    state.policies = [
      { id: 'parent', orgId: ORG_A, partnerId: null },
      { id: 'child', orgId: ORG_A, partnerId: null, parentPolicyId: 'parent' },
    ];
    state.assignments = [row('parent', 'site', 'site-a1'), row('child', 'organization', ORG_A)];
    const siteAuth = { scope: 'organization', orgId: ORG_A, allowedSiteIds: ['site-a2'] } as never;

    const reach = await computePolicyReach(siteAuth, ['parent']);

    // a1 (site-a1) is outside the caller's sites, so it is in neither count.
    expect(reach.get('parent')).toEqual({ direct: 0, throughChildren: 2, organizations: 1 });
    // Control: unrestricted, a1 counts directly.
    expect((await computePolicyReach(auth, ['parent'])).get('parent')).toEqual({ direct: 1, throughChildren: 2, organizations: 1 });
  });

  it('counts nothing for a caller restricted to no site', async () => {
    state.devices = [device('a1')];
    state.policies = [{ id: 'p1', orgId: ORG_A, partnerId: null }];
    state.assignments = [row('p1', 'organization', ORG_A)];

    const reach = await computePolicyReach({ scope: 'organization', orgId: ORG_A, allowedSiteIds: [] } as never, ['p1']);

    expect(reach.get('p1')).toEqual({ direct: 0, throughChildren: 0, organizations: 0 });
  });

  it('counts only the pinned devices of a device-bound caller', async () => {
    state.devices = [device('a1'), device('a2')];
    state.policies = [{ id: 'p1', orgId: ORG_A, partnerId: null }];
    state.assignments = [row('p1', 'organization', ORG_A)];

    const reach = await computePolicyReach({ scope: 'organization', orgId: ORG_A, allowedDeviceIds: ['a2'] } as never, ['p1']);

    expect(reach.get('p1')).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });
  });

  it('drops a device the final read no longer returns from every count', async () => {
    state.devices = [device('a1'), device('b1', { orgId: ORG_B, siteId: 'site-b1' })];
    state.vanished = ['b1'];
    state.policies = [{ id: 'p1', orgId: null, partnerId: PARTNER }];
    state.assignments = [row('p1', 'partner', PARTNER)];

    const reach = await computePolicyReach(auth, ['p1']);

    expect(reach.get('p1')).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });
  });

  it('issues no statement for an empty id list', async () => {
    expect((await computePolicyReach(auth, [])).size).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('expandAssignmentsToDevices', () => {
  it('returns the union and fills the memo once per key', async () => {
    state.devices = [device('d1'), device('d2', { siteId: 'site-a2' })];
    const memo = new Map<string, string[]>();
    const scope = { policyOrgId: ORG_A, policyPartnerId: null };

    const budget = { remaining: 10 };

    const first = await expandAssignmentsToDevices(
      [row('x', 'site', 'site-a1'), row('x', 'organization', ORG_A)],
      scope,
      memo,
      budget,
    );
    const second = await expandAssignmentsToDevices([row('y', 'site', 'site-a1')], scope, memo, budget);

    expect([...first.deviceIds].sort()).toEqual(['d1', 'd2']);
    expect(first.complete).toBe(true);
    expect([...second.deviceIds]).toEqual(['d1']);
    expect(second.complete).toBe(true);
    expect(memo.size).toBe(2);
    expect(state.candidateSelects).toBe(2);
    // A memo hit is free: only the two misses were charged.
    expect(budget.remaining).toBe(8);
  });

  it('charges a device group two statements and skips a row it cannot afford', async () => {
    state.devices = [device('d1', { groups: ['g1'] }), device('d2', { siteId: 'site-a2' })];
    const memo = new Map<string, string[]>();
    const budget = { remaining: 2 };

    const out = await expandAssignmentsToDevices(
      [row('x', 'device_group', 'g1'), row('x', 'site', 'site-a2')],
      { policyOrgId: ORG_A, policyPartnerId: null },
      memo,
      budget,
    );

    expect([...out.deviceIds]).toEqual(['d1']);
    expect(out.complete).toBe(false);
    expect(budget.remaining).toBe(0);
    expect(mockResolveSafe).toHaveBeenCalledTimes(1);
    expect(state.candidateSelects).toBe(1);
  });
});

/** Every statement the service issued: driver selects plus the (mocked) group gating read. */
const statementsRun = () => selectMock.mock.calls.length + mockResolveSafe.mock.calls.length;

describe('computePolicyReach work bound (#12465 round two)', () => {
  it('a policy set past the budget runs at most REACH_STATEMENT_BUDGET statements and is marked partial', async () => {
    // One distinct site target per row: every row is a memo miss.
    state.policies = [];
    state.assignments = [];
    state.devices = [];
    for (let i = 0; i < 3; i += 1) state.policies.push({ id: `p${i}`, orgId: null, partnerId: PARTNER });
    for (let i = 0; i < REACH_STATEMENT_BUDGET; i += 1) {
      state.devices.push(device(`d${i}`, { siteId: `s${i}` }));
      state.assignments.push(row(`p${i % 3}`, i % 5 === 0 ? 'device_group' : 'site', `s${i}`));
    }

    const reach = await computePolicyReach(auth, ['p0', 'p1', 'p2']);

    // Unbounded, this set costs 4 fixed reads + 160 site rows + 40 group rows x 2.
    expect(statementsRun()).toBeLessThanOrEqual(REACH_STATEMENT_BUDGET);
    // Policies expand in id order: p0 (81 statements) and p1 (80) fit, p2 runs out.
    expect(reach.get('p0')).toEqual({ direct: 53, throughChildren: 0, organizations: 1 });
    expect(reach.get('p1')?.partial).toBeUndefined();
    expect(reach.get('p2')?.partial).toBe(true);
    // A lower bound: p2 has 53 site rows, each reaching one device.
    expect(reach.get('p2')!.direct).toBeGreaterThan(0);
    expect(reach.get('p2')!.direct).toBeLessThan(53);
  });

  it('keeps answering memo hits after the budget runs out, so a policy whose rows are all cached stays exact', async () => {
    state.devices = [device('d1'), device('d2', { siteId: 'site-a2' })];
    state.policies = [
      { id: 'p1', orgId: null, partnerId: PARTNER },
      { id: 'p2', orgId: null, partnerId: PARTNER },
      { id: 'p3', orgId: null, partnerId: PARTNER },
    ];
    // Fixed reads (4) + one site expansion = 5: p1's second row cannot be afforded.
    state.assignments = [
      row('p1', 'site', 'site-a1'),
      row('p1', 'site', 'site-a2'),
      row('p2', 'site', 'site-a1'),
      // A skipped miss does not stop the policy: the cached row after it still counts.
      row('p3', 'site', 'site-a2'),
      row('p3', 'site', 'site-a1'),
    ];

    const reach = await computePolicyReach(auth, ['p1', 'p2', 'p3'], { statementBudget: 5, childPolicyLimit: 10 });

    expect(statementsRun()).toBeLessThanOrEqual(5);
    expect(reach.get('p1')).toEqual({ direct: 1, throughChildren: 0, organizations: 1, partial: true });
    expect(reach.get('p2')).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });
    expect(reach.get('p3')).toEqual({ direct: 1, throughChildren: 0, organizations: 1, partial: true });
  });

  it('a parent whose child ran out of budget is partial and its throughChildren is a lower bound', async () => {
    state.devices = [device('d1'), device('d2', { siteId: 'site-a2' }), device('d3', { siteId: 'site-a3' })];
    state.policies = [
      { id: 'parent', orgId: null, partnerId: PARTNER },
      { id: 'child', orgId: null, partnerId: PARTNER, parentPolicyId: 'parent' },
    ];
    // Fixed 4 + parent's row + child's first row = 6; the child's second row is skipped.
    state.assignments = [row('parent', 'site', 'site-a1'), row('child', 'site', 'site-a2'), row('child', 'site', 'site-a3')];

    const reach = await computePolicyReach(auth, ['parent'], { statementBudget: 6, childPolicyLimit: 10 });

    expect(reach.get('parent')).toEqual({ direct: 1, throughChildren: 1, organizations: 1, partial: true });
  });

  it("expands every parent's own rows before any child's, and reports no throughChildren for a parent it could not finish", async () => {
    // A complete child next to a parent whose own rows ran out would count the
    // parent's unexpanded devices as "through children": an overcount.
    state.devices = [device('d1'), device('d2', { siteId: 'site-a2', groups: ['g2'] })];
    state.policies = [
      { id: 'parent', orgId: null, partnerId: PARTNER },
      { id: 'child', orgId: null, partnerId: PARTNER, parentPolicyId: 'parent' },
    ];
    // Fixed 4 + the parent's site row leaves 1: the parent's group row (2) is
    // skipped, the child's site row (1) still fits. d2 is truly a direct
    // device (through the group), so "through children: 1" would be wrong.
    state.assignments = [row('parent', 'site', 'site-a1'), row('parent', 'device_group', 'g2'), row('child', 'site', 'site-a2')];

    const reach = await computePolicyReach(auth, ['parent'], { statementBudget: 6, childPolicyLimit: 10 });

    expect(state.candidateSelects).toBe(2); // the child's row did run

    expect(reach.get('parent')).toEqual({ direct: 1, throughChildren: 0, organizations: 1, partial: true });
  });

  it('caps the child policies read and marks only the parents the cap cut as partial', async () => {
    state.devices = [device('d1'), device('d2', { siteId: 'site-a2' }), device('d3', { siteId: 'site-a3' })];
    state.policies = [
      { id: 'pa', orgId: null, partnerId: PARTNER },
      { id: 'pb', orgId: null, partnerId: PARTNER },
      { id: 'pc', orgId: null, partnerId: PARTNER },
      { id: 'ca1', orgId: null, partnerId: PARTNER, parentPolicyId: 'pa' },
      { id: 'cb1', orgId: null, partnerId: PARTNER, parentPolicyId: 'pb' },
      { id: 'cb2', orgId: null, partnerId: PARTNER, parentPolicyId: 'pb' },
      { id: 'cc1', orgId: null, partnerId: PARTNER, parentPolicyId: 'pc' },
    ];
    state.assignments = [row('ca1', 'site', 'site-a1'), row('cb1', 'site', 'site-a2'), row('cb2', 'site', 'site-a3'), row('cc1', 'site', 'site-a1')];

    // Ordered (parent, id), a cap of 2 keeps ca1 and cb1: pb lost cb2, and pc
    // sorts after the cut, so nothing says it is complete.
    const reach = await computePolicyReach(auth, ['pa', 'pb', 'pc'], { statementBudget: 100, childPolicyLimit: 2 });

    expect(reach.get('pa')).toEqual({ direct: 0, throughChildren: 1, organizations: 1 });
    expect(reach.get('pb')).toEqual({ direct: 0, throughChildren: 1, organizations: 1, partial: true });
    expect(reach.get('pc')).toEqual({ direct: 0, throughChildren: 0, organizations: 0, partial: true });
    // The database reads one row past the cap, never the whole child set.
    expect(state.childLimits).toEqual([3]);
  });

  it('an under-budget request is unchanged and carries no partial key', async () => {
    state.devices = [device('d1'), device('d2', { siteId: 'site-a2' })];
    state.policies = [
      { id: 'parent', orgId: null, partnerId: PARTNER },
      { id: 'child', orgId: null, partnerId: PARTNER, parentPolicyId: 'parent' },
    ];
    state.assignments = [row('parent', 'site', 'site-a1'), row('child', 'site', 'site-a2')];

    const reach = await computePolicyReach(auth, ['parent']);

    expect(reach.get('parent')).toEqual({ direct: 1, throughChildren: 1, organizations: 1 });
    expect(Object.keys(reach.get('parent')!)).not.toContain('partial');
    expect(REACH_CHILD_POLICY_LIMIT).toBeGreaterThan(0);
  });
});

describe('readablePolicyIds', () => {
  it('keeps only the ids the caller\'s policy access condition admits', async () => {
    const { sql } = await import('drizzle-orm');
    mockAccessCondition.mockReturnValue(sql`access_marker = 1`);
    state.policies = [{ id: 'p1', orgId: ORG_A, partnerId: null }];

    const ids = await readablePolicyIds(auth, ['p1', 'hidden']);

    expect(ids).toEqual(['p1']);
    expect(state.accessWhere).toHaveLength(1);
    expect(compile(state.accessWhere[0]).params).toEqual(expect.arrayContaining(['p1', 'hidden']));
  });

  it('issues no statement for an empty list', async () => {
    expect(await readablePolicyIds(auth, [])).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
