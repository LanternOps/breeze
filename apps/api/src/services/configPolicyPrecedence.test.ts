/**
 * Unit tests for "Outranked on N devices" (#12472, plan W05a O1).
 *
 * The driver, the group gating and the W02a expansion are faked; the ranking,
 * the caps and the caller ceiling are real. The db fake dispatches each select
 * on the table it reads and on the shape it selects, so it answers like a tiny
 * database instead of a statement queue:
 *  - config_policy_effective_feature_links: the policy's effective features;
 *  - configuration_policies: the policy's owner;
 *  - config_policy_assignments selected without `featureTypes`: its own rows;
 *  - config_policy_assignments selected with `featureTypes`: the competitor
 *    rows, filtered on the compiled join (status, the policy itself, the
 *    feature list) the way the SQL filters them;
 *  - devices: the final device read over the reach.
 * The real SQL, RLS and parity with resolveEffectiveConfig are exercised by
 * configPolicyPrecedence.integration.test.ts against Postgres.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

type Row = {
  id: string;
  level: string;
  targetId: string;
  roleFilter: string[] | null;
  osFilter: string[] | null;
  priority: number;
  createdAt: Date;
};

type Competitor = Row & {
  configPolicyId: string;
  status: 'active' | 'inactive';
  policyOrgId: string | null;
  policyPartnerId: string | null;
  features: string[];
};

const { state, expandMock, resolveSafeMock } = vi.hoisted(() => ({
  state: {
    policy: null as null | { id: string; orgId: string | null; partnerId: string | null },
    features: [] as string[],
    own: [] as Row[],
    competitors: [] as Competitor[],
    /** target id -> devices that target reaches */
    targets: new Map<string, string[]>(),
    devices: [] as Array<{ id: string; orgId: string; siteId: string | null }>,
    refusedGroups: [] as string[],
    competitorLimit: undefined as number | undefined,
    expandedTargets: [] as string[],
  },
  expandMock: vi.fn(),
  resolveSafeMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: { select: (cols: unknown) => chain(cols), selectDistinct: (cols: unknown) => chain(cols) } }));

vi.mock('./configurationPolicy', () => ({ policyAccessCondition: () => undefined }));

vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: (ids: string[]) => resolveSafeMock(ids),
}));

vi.mock('./configPolicyReach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./configPolicyReach')>()),
  expandAssignmentsToDevices: (...args: unknown[]) => expandMock(...args),
}));

import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configurationPolicies,
  devices,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import {
  PRECEDENCE_COMPETITOR_ROW_LIMIT,
  PRECEDENCE_SCAN_CAP,
  computePolicyPrecedence,
} from './configPolicyPrecedence';

const dialect = new PgDialect();
const compile = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

function chain(cols: unknown) {
  let table: unknown;
  let where: unknown;
  let limit: number | undefined;
  const joins: unknown[] = [];
  const c: Record<string, unknown> = {};
  for (const m of ['leftJoin', 'groupBy', 'orderBy']) c[m] = () => c;
  c.innerJoin = (_t: unknown, on: unknown) => { joins.push(on); return c; };
  c.limit = (n: number) => { limit = n; return c; };
  c.from = (t: unknown) => { table = t; return c; };
  c.where = (w: unknown) => { where = w; return c; };
  c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve().then(() => answer(cols as Record<string, unknown>, table, where, joins, limit)).then(resolve, reject);
  return c;
}

function answer(cols: Record<string, unknown>, table: unknown, where: unknown, joins: unknown[], limit?: number): unknown[] {
  if (table === configurationPolicies) return state.policy ? [state.policy] : [];
  if (table === configPolicyEffectiveFeatureLinks) return state.features.map((featureType) => ({ featureType }));
  if (table === configPolicyAssignments && !('featureTypes' in cols)) return state.own;
  if (table === configPolicyAssignments) {
    state.competitorLimit = limit;
    const joinParams = joins.flatMap((j) => compile(j).params);
    const joinSql = joins.map((j) => compile(j).sql).join(' ');
    const rows = state.competitors
      .filter((r) => !joinParams.includes('active') || r.status === 'active')
      .filter((r) => !joinSql.includes('<>') || r.configPolicyId !== state.policy?.id)
      .map((r) => ({ ...r, featureTypes: r.features.filter((f) => joinParams.includes(f)) }))
      .filter((r) => r.featureTypes.length > 0);
    return limit === undefined ? rows : rows.slice(0, limit);
  }
  if (table === devices) {
    const ids = compile(where).params[0] as string[];
    return state.devices.filter((d) => ids.includes(d.id));
  }
  throw new Error('unexpected table');
}

expandMock.mockImplementation(async (
  rows: Array<{ level: string; targetId: string }>,
  _scope: unknown,
  memo: Map<string, string[]>,
  budget: { remaining: number },
) => {
  const deviceIds = new Set<string>();
  let complete = true;
  for (const row of rows) {
    let expanded = memo.get(row.targetId);
    if (!expanded) {
      const cost = row.level === 'device_group' ? 2 : 1;
      if (budget.remaining < cost) { complete = false; continue; }
      budget.remaining -= cost;
      state.expandedTargets.push(row.targetId);
      expanded = state.targets.get(row.targetId) ?? [];
      memo.set(row.targetId, expanded);
    }
    for (const id of expanded) deviceIds.add(id);
  }
  return { deviceIds, complete };
});

resolveSafeMock.mockImplementation(async (ids: string[]) => ({
  allowedGroupIds: ids.filter((id) => !state.refusedGroups.includes(id)),
  refusedGroups: ids.filter((id) => state.refusedGroups.includes(id)).map((id) => ({ id, refusedFields: ['hostname'] })),
}));

const POLICY = 'policy-own';
const ORG = 'org-1';
const SITE = 'site-1';
const PARTNER = 'partner-1';
const T0 = new Date('2026-01-01T00:00:00Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const auth = {
  scope: 'partner',
  partnerId: PARTNER,
  orgId: null,
  accessibleOrgIds: [ORG],
} as unknown as AuthContext;

let rowSeq = 0;
function own(level: string, targetId: string, reaches: string[], extra: Partial<Row> = {}): void {
  state.targets.set(targetId, reaches);
  state.own.push({ id: `own-${++rowSeq}`, level, targetId, roleFilter: null, osFilter: null, priority: 0, createdAt: T0, ...extra });
}

function competitor(
  policyId: string,
  level: string,
  targetId: string,
  reaches: string[],
  extra: Partial<Competitor> = {},
): void {
  state.targets.set(targetId, reaches);
  state.competitors.push({
    id: `cmp-${++rowSeq}`,
    configPolicyId: policyId,
    status: 'active',
    policyOrgId: ORG,
    policyPartnerId: null,
    features: ['patch'],
    level,
    targetId,
    roleFilter: null,
    osFilter: null,
    priority: 0,
    createdAt: T0,
    ...extra,
  });
}

function seedDevices(...ids: string[]): void {
  for (const id of ids) state.devices.push({ id, orgId: ORG, siteId: SITE });
}

function base(features: string[] = ['patch']): void {
  state.policy = { id: POLICY, orgId: ORG, partnerId: null };
  state.features = features;
}

afterEach(() => {
  state.policy = null;
  state.features = [];
  state.own = [];
  state.competitors = [];
  state.targets = new Map();
  state.devices = [];
  state.refusedGroups = [];
  state.competitorLimit = undefined;
  state.expandedTargets = [];
  expandMock.mockClear();
  resolveSafeMock.mockClear();
});

describe('computePolicyPrecedence', () => {
  it('a more specific competitor outranks', async () => {
    base();
    seedDevices('d1', 'd2', 'd3');
    own('organization', ORG, ['d1', 'd2', 'd3']);
    competitor('policy-device', 'device', 'd2', ['d2']);

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 3, outranked: 1 } },
    });
  });

  it('a less specific competitor never outranks', async () => {
    base();
    seedDevices('d1');
    own('site', SITE, ['d1'], { priority: 50, createdAt: later(10) });
    competitor('policy-org', 'organization', ORG, ['d1'], { priority: 0, createdAt: T0 });

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 0 } },
    });
  });

  it('priority breaks a level tie', async () => {
    base();
    seedDevices('d1', 'd2');
    own('site', SITE, ['d1', 'd2'], { priority: 5 });
    competitor('policy-low-number', 'site', 'site-alias-a', ['d1'], { priority: 1, createdAt: later(5) });
    competitor('policy-high-number', 'site', 'site-alias-b', ['d2'], { priority: 9, createdAt: later(-5) });

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 2, outranked: 1 } },
    });
  });

  it('assignment age breaks a priority tie', async () => {
    base();
    seedDevices('d1', 'd2');
    own('site', SITE, ['d1', 'd2'], { priority: 3, createdAt: later(10) });
    competitor('policy-older', 'site', 'site-alias-a', ['d1'], { priority: 3, createdAt: later(1) });
    competitor('policy-newer', 'site', 'site-alias-b', ['d2'], { priority: 3, createdAt: later(20) });

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 2, outranked: 1 } },
    });
  });

  it('a full tie is not counted as outranked', async () => {
    base();
    seedDevices('d1');
    own('site', SITE, ['d1'], { priority: 3, createdAt: T0 });
    competitor('policy-tied', 'site', 'site-alias', ['d1'], { priority: 3, createdAt: T0 });

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 0 } },
    });
  });

  it('an inactive competitor never outranks', async () => {
    base();
    seedDevices('d1', 'd2');
    own('organization', ORG, ['d1', 'd2']);
    competitor('policy-active', 'device', 'd1', ['d1']);
    competitor('policy-inactive', 'device', 'd2', ['d2'], { status: 'inactive' });

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 2, outranked: 1 } },
    });
  });

  it('the policy never competes with itself', async () => {
    base();
    seedDevices('d1');
    own('organization', ORG, ['d1']);
    // A second, more specific row of the SAME policy is its own best row, not a competitor.
    competitor(POLICY, 'device', 'd1', ['d1']);

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 0 } },
    });
  });

  it('an inherited feature is counted for the child', async () => {
    // The effective-links view returns the parent's feature for the child.
    base(['patch', 'backup']);
    seedDevices('d1');
    own('organization', ORG, ['d1']);
    competitor('policy-backup-only', 'device', 'd1', ['d1'], { features: ['backup'] });

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 0 }, backup: { reached: 1, outranked: 1 } },
    });
  });

  it("a competitor outranks only on the features it has", async () => {
    base(['patch']);
    seedDevices('d1');
    own('organization', ORG, ['d1']);
    competitor('policy-backup-only', 'device', 'd1', ['d1'], { features: ['backup'] });

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 0 } },
    });
  });

  it('the best own row on each device is the one compared', async () => {
    base();
    seedDevices('d1', 'd2');
    own('organization', ORG, ['d1', 'd2']);
    own('device', 'd1', ['d1']);
    competitor('policy-site', 'site', SITE, ['d1', 'd2']);

    // d1: own device row beats the site row. d2: only the org row, which loses.
    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 2, outranked: 1 } },
    });
  });

  it('a policy with no features answers an empty feature map', async () => {
    base([]);
    seedDevices('d1');
    own('organization', ORG, ['d1']);
    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({ capped: false, features: {} });
  });

  it('a policy with no assignments reaches nothing', async () => {
    base(['patch']);
    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 0, outranked: 0 } },
    });
  });

  it('a policy the caller context cannot read answers null', async () => {
    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toBeNull();
  });

  it('over the cap returns capped', async () => {
    base();
    seedDevices('d1', 'd2', 'd3');
    own('organization', ORG, ['d1', 'd2', 'd3']);

    await expect(computePolicyPrecedence(auth, POLICY, { scanCap: 2 })).resolves.toEqual({ capped: true });
    await expect(computePolicyPrecedence(auth, POLICY, { scanCap: 3 })).resolves.toMatchObject({ capped: false });
    expect(PRECEDENCE_SCAN_CAP).toBe(5000);
  });

  it('the cap counts only devices inside the caller ceiling', async () => {
    base();
    state.devices.push({ id: 'd1', orgId: ORG, siteId: SITE }, { id: 'd2', orgId: ORG, siteId: 'site-hidden' });
    own('organization', ORG, ['d1', 'd2']);
    competitor('policy-device', 'device', 'd2', ['d2']);
    const siteTech = { ...auth, scope: 'organization', orgId: ORG, allowedSiteIds: [SITE] } as unknown as AuthContext;

    await expect(computePolicyPrecedence(siteTech, POLICY, { scanCap: 1 })).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 0 } },
    });
  });

  it('a device pin narrows the counts', async () => {
    base();
    seedDevices('d1', 'd2');
    own('organization', ORG, ['d1', 'd2']);
    competitor('policy-device', 'device', 'd2', ['d2']);
    const pinned = { ...auth, allowedDeviceIds: ['d1'] } as unknown as AuthContext;

    await expect(computePolicyPrecedence(pinned, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 0 } },
    });
  });

  it('an own expansion the budget cannot afford answers capped', async () => {
    base();
    seedDevices('d1', 'd2');
    own('device', 'd1', ['d1']);
    own('device', 'd2', ['d2']);

    // Six fixed reads plus one expansion: the second own row is skipped.
    await expect(computePolicyPrecedence(auth, POLICY, { statementBudget: 7 })).resolves.toEqual({ capped: true });
    await expect(computePolicyPrecedence(auth, POLICY, { statementBudget: 8 })).resolves.toMatchObject({ capped: false });
  });

  it('a competitor expansion the budget cannot afford answers capped, never an undercount', async () => {
    base();
    seedDevices('d1', 'd2');
    own('organization', ORG, ['d1', 'd2']);
    competitor('policy-a', 'device', 'd1', ['d1']);
    competitor('policy-b', 'device', 'd2', ['d2']);

    await expect(computePolicyPrecedence(auth, POLICY, { statementBudget: 8 })).resolves.toEqual({ capped: true });
    await expect(computePolicyPrecedence(auth, POLICY, { statementBudget: 9 })).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 2, outranked: 2 } },
    });
  });

  it('more competitor rows than the read limit answers capped', async () => {
    base();
    seedDevices('d1', 'd2');
    own('organization', ORG, ['d1', 'd2']);
    competitor('policy-a', 'device', 'd1', ['d1']);
    competitor('policy-b', 'device', 'd2', ['d2']);

    await expect(computePolicyPrecedence(auth, POLICY, { competitorRowLimit: 1 })).resolves.toEqual({ capped: true });
    expect(state.competitorLimit).toBe(2);
    await expect(computePolicyPrecedence(auth, POLICY, { competitorRowLimit: 2 })).resolves.toMatchObject({ capped: false });
    expect(PRECEDENCE_COMPETITOR_ROW_LIMIT).toBeGreaterThan(0);
  });

  it('a competitor that cannot beat the weakest own row is never expanded', async () => {
    base();
    seedDevices('d1');
    own('organization', ORG, ['d1']);
    competitor('policy-partner', 'partner', PARTNER, ['d1'], { policyOrgId: null, policyPartnerId: PARTNER });

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 0 } },
    });
    expect(state.expandedTargets).toEqual([ORG]);
  });

  it('an execution-gated feature ignores rows from a refused dynamic group, a protective one does not', async () => {
    base(['patch', 'automation']);
    seedDevices('d1');
    state.refusedGroups = ['group-hostname'];
    own('device_group', 'group-hostname', ['d1']);
    competitor('policy-partner', 'partner', PARTNER, ['d1'], {
      policyOrgId: null,
      policyPartnerId: PARTNER,
      features: ['patch', 'automation'],
    });

    // The resolver drops this policy's automation row on d1, so the weaker
    // partner-level policy wins automation; patch still comes from the group.
    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 0 }, automation: { reached: 1, outranked: 1 } },
    });
  });

  it("a competitor's refused group never outranks on an execution-gated feature", async () => {
    base(['patch', 'automation']);
    seedDevices('d1');
    state.refusedGroups = ['group-tagged'];
    own('organization', ORG, ['d1']);
    competitor('policy-group', 'device_group', 'group-tagged', ['d1'], { features: ['patch', 'automation'] });

    await expect(computePolicyPrecedence(auth, POLICY)).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 1, outranked: 1 }, automation: { reached: 1, outranked: 0 } },
    });
  });

  it('the answer carries counts only, never a competitor', async () => {
    base();
    seedDevices('d1');
    own('organization', ORG, ['d1']);
    competitor('policy-secret-competitor', 'device', 'd1', ['d1'], { id: 'assignment-secret' });

    const result = await computePolicyPrecedence(auth, POLICY);
    expect(result).toEqual({ capped: false, features: { patch: { reached: 1, outranked: 1 } } });
    const body = JSON.stringify(result);
    expect(body).not.toContain('policy-secret-competitor');
    expect(body).not.toContain('assignment-secret');
  });
});
