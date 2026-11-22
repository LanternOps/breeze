/**
 * Unit tests for the applies-to summary read model (#12306, plan W01a A2).
 *
 * The db mock dispatches each `select()` chain on the table passed to `from()`
 * (a `.as()` subquery resolves to the table it reads), so the tests do not
 * depend on statement order. The display order, the per-policy window and the
 * window totals are computed in SQL, so the fixtures arrive already windowed
 * (see `windowed`); RLS, the SQL ordering and the 50-row window are exercised by
 * configPolicyAppliesToSummary.integration.test.ts against Postgres. The
 * statement budget is pinned by configPolicyAppliesTo.queryBudget.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectMock, authorizeMock, tableResults, fromCalls, inArrayCalls } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  authorizeMock: vi.fn(),
  tableResults: new Map<unknown, unknown[]>(),
  fromCalls: [] as unknown[],
  inArrayCalls: [] as Array<{ column: unknown; values: unknown[] }>,
}));

// Records which ids each IN list carried, so the tests can bound the name lookups.
vi.mock('drizzle-orm', async (importOriginal) => {
  const original = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...original,
    inArray: (column: never, values: never) => {
      inArrayCalls.push({ column, values: [...(values as unknown[])] });
      return original.inArray(column, values);
    },
  };
});

vi.mock('../db', () => ({
  db: { select: selectMock },
}));

vi.mock('./configurationPolicy', () => ({
  authorizeAssignmentTargets: authorizeMock,
  assignmentTargetKey: (level: string, targetId: string) => `${level}:${targetId}`,
  policyAccessCondition: vi.fn(() => undefined),
}));

import { loadAppliesToSummaries } from './configPolicyAppliesTo';
import {
  configPolicyAssignments,
  configurationPolicies,
  deviceGroups,
  devices,
  organizations,
  sites,
} from '../db/schema';

const POLICY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POLICY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const DEVICE = '55555555-5555-4555-8555-555555555555';
const DEVICE_2 = '66666666-6666-4666-8666-666666666666';

const auth = { scope: 'partner' } as never;

const SOURCE = Symbol('source');

function chain(table: unknown) {
  const source = (table as Record<symbol, unknown> | undefined)?.[SOURCE] ?? table;
  const result = () => Promise.resolve(tableResults.get(source) ?? []);
  const c: Record<string, unknown> = {};
  for (const m of ['where', 'groupBy', 'orderBy', 'leftJoin', 'innerJoin', 'limit']) {
    c[m] = () => c;
  }
  c.as = () => ({ [SOURCE]: source });
  c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => result().then(resolve, reject);
  return c;
}

function assignment(over: Partial<{
  id: string; configPolicyId: string; level: string; targetId: string;
  priority: number; roleFilter: string[] | null; osFilter: string[] | null; createdAt: Date;
}>) {
  return {
    id: over.id ?? `asg-${Math.random().toString(16).slice(2)}`,
    configPolicyId: over.configPolicyId ?? POLICY_A,
    level: over.level ?? 'site',
    targetId: over.targetId ?? SITE,
    priority: over.priority ?? 0,
    roleFilter: over.roleFilter ?? null,
    osFilter: over.osFilter ?? null,
    createdAt: over.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}

/**
 * What the windowed SQL read returns for these rows, taken as already in
 * display order: `rn` by position within each policy, and each policy's
 * `total`/`anyPartner` over all of its rows.
 */
function windowed(rows: ReturnType<typeof assignment>[]) {
  const position = new Map<string, number>();
  const total = new Map<string, number>();
  const anyPartner = new Map<string, boolean>();
  for (const row of rows) {
    total.set(row.configPolicyId, (total.get(row.configPolicyId) ?? 0) + 1);
    if (row.level === 'partner') anyPartner.set(row.configPolicyId, true);
  }
  return rows.map((row) => {
    const rn = (position.get(row.configPolicyId) ?? 0) + 1;
    position.set(row.configPolicyId, rn);
    return { ...row, rn, total: total.get(row.configPolicyId)!, anyPartner: anyPartner.get(row.configPolicyId) ?? false };
  });
}

function setAssignments(rows: ReturnType<typeof assignment>[]) {
  tableResults.set(configPolicyAssignments, windowed(rows));
}

/** A batch authorizer that admits a target when `admit(level, targetId)` holds. */
function admitWhen(admit: (level: string, targetId: string) => boolean) {
  return async (_auth: unknown, targets: Array<{ level: string; targetId: string }>) =>
    new Map(targets.map((t) => [`${t.level}:${t.targetId}`, admit(t.level, t.targetId)]));
}

beforeEach(() => {
  vi.clearAllMocks();
  tableResults.clear();
  fromCalls.length = 0;
  inArrayCalls.length = 0;
  selectMock.mockImplementation(() => ({
    from: (table: unknown) => {
      fromCalls.push(table);
      return chain(table);
    },
  }));
  authorizeMock.mockImplementation(admitWhen(() => true));
});

describe('loadAppliesToSummaries', () => {
  it('empty ids return an empty map and run no query', async () => {
    const result = await loadAppliesToSummaries(auth, []);
    expect(result.size).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('keeps the SQL display order and caps targets at 3', async () => {
    // The level/priority/age order is SQL's job (integration-tested); here the
    // rows arrive in display order and only the first three survive.
    setAssignments([
      assignment({ id: 'a-partner', level: 'partner', targetId: PARTNER }),
      assignment({ id: 'a-org', level: 'organization', targetId: ORG }),
      assignment({ id: 'a-site', level: 'site', targetId: SITE }),
      assignment({ id: 'a-group', level: 'device_group', targetId: GROUP }),
      assignment({ id: 'a-device', level: 'device', targetId: DEVICE }),
    ]);
    tableResults.set(organizations, [{ id: ORG, name: 'Acme' }]);
    tableResults.set(sites, [{ id: SITE, name: 'Main office' }]);
    tableResults.set(deviceGroups, [{ id: GROUP, name: 'Laptops' }]);
    tableResults.set(devices, [{ id: DEVICE, displayName: 'Front desk', hostname: 'fd-01' }]);

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;

    expect(summary.assignmentCount).toBe(5);
    expect(summary.targets.map((t) => t.assignmentId)).toEqual(['a-partner', 'a-org', 'a-site']);
    expect(summary.targets.map((t) => t.name)).toEqual([null, 'Acme', 'Main office']);
  });

  it('assignmentCount counts rows the caller may not list', async () => {
    setAssignments([
      assignment({ id: 'a-org', level: 'organization', targetId: ORG }),
      assignment({ id: 'a-site', level: 'site', targetId: SITE }),
    ]);
    tableResults.set(organizations, [{ id: ORG, name: 'Acme' }]);
    tableResults.set(sites, [{ id: SITE, name: 'Main office' }]);
    // A site-restricted caller: the organization row is refused.
    authorizeMock.mockImplementation(admitWhen((level) => level !== 'organization'));

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;

    expect(summary.assignmentCount).toBe(2);
    expect(summary.targets).toHaveLength(1);
    expect(summary.targets[0]).toMatchObject({ assignmentId: 'a-site', level: 'site', name: 'Main office' });
  });

  it('a refused row fills no slot, so a later listable row still makes the cap', async () => {
    setAssignments([
      assignment({ id: 'o1', level: 'organization', targetId: ORG }),
      assignment({ id: 'o2', level: 'organization', targetId: PARTNER }),
      assignment({ id: 'o3', level: 'organization', targetId: GROUP }),
      assignment({ id: 'a-site', level: 'site', targetId: SITE }),
    ]);
    tableResults.set(sites, [{ id: SITE, name: 'Main office' }]);
    authorizeMock.mockImplementation(admitWhen((level) => level !== 'organization'));

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;
    expect(summary.assignmentCount).toBe(4);
    expect(summary.targets.map((t) => t.assignmentId)).toEqual(['a-site']);
    // No name lookup for rows the caller may not list.
    expect(fromCalls).not.toContain(organizations);
  });

  it('authorizes the whole page in one batch', async () => {
    setAssignments([
      assignment({ configPolicyId: POLICY_A, level: 'device_group', targetId: GROUP }),
      assignment({ configPolicyId: POLICY_B, level: 'device_group', targetId: GROUP }),
    ]);
    tableResults.set(deviceGroups, [{ id: GROUP, name: 'Laptops' }]);

    const result = await loadAppliesToSummaries(auth, [POLICY_A, POLICY_B]);
    expect(authorizeMock).toHaveBeenCalledTimes(1);
    expect(authorizeMock).toHaveBeenCalledWith(auth, [
      { level: 'device_group', targetId: GROUP },
      { level: 'device_group', targetId: GROUP },
    ]);
    expect(result.get(POLICY_A)!.targets).toHaveLength(1);
    expect(result.get(POLICY_B)!.targets).toHaveLength(1);
  });

  it('a partner-level row sets allOrganizations and carries name null', async () => {
    setAssignments([
      assignment({ id: 'a-partner', level: 'partner', targetId: PARTNER, roleFilter: ['server'], osFilter: ['windows'] }),
    ]);

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;

    expect(summary.allOrganizations).toBe(true);
    expect(summary.targets).toEqual([{
      assignmentId: 'a-partner',
      level: 'partner',
      targetId: PARTNER,
      name: null,
      roleFilter: ['server'],
      osFilter: ['windows'],
    }]);
  });

  it('allOrganizations holds even when the caller may not list the partner row', async () => {
    setAssignments([
      assignment({ level: 'partner', targetId: PARTNER }),
    ]);
    authorizeMock.mockImplementation(admitWhen(() => false));

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;
    expect(summary.allOrganizations).toBe(true);
    expect(summary.assignmentCount).toBe(1);
    expect(summary.targets).toEqual([]);
  });

  it('a device target is named displayName, else hostname', async () => {
    setAssignments([
      assignment({ id: 'named', level: 'device', targetId: DEVICE, createdAt: new Date('2026-01-01T00:00:00Z') }),
      assignment({ id: 'bare', level: 'device', targetId: DEVICE_2, createdAt: new Date('2026-01-02T00:00:00Z') }),
    ]);
    tableResults.set(devices, [
      { id: DEVICE, displayName: 'Front desk', hostname: 'fd-01' },
      { id: DEVICE_2, displayName: null, hostname: 'srv-02' },
    ]);

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;
    expect(summary.targets.map((t) => [t.assignmentId, t.name])).toEqual([
      ['named', 'Front desk'],
      ['bare', 'srv-02'],
    ]);
  });

  it('a target whose name lookup returns nothing is left out of targets but counted', async () => {
    setAssignments([
      assignment({ id: 'a-org', level: 'organization', targetId: ORG }),
      assignment({ id: 'a-site', level: 'site', targetId: SITE }),
    ]);
    // The organization row is not legible in the caller's context.
    tableResults.set(organizations, []);
    tableResults.set(sites, [{ id: SITE, name: 'Main office' }]);

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;
    expect(summary.assignmentCount).toBe(2);
    expect(summary.targets.map((t) => t.assignmentId)).toEqual(['a-site']);
  });

  it('caps each policy at 3 on its own, not across the page', async () => {
    const rows = [];
    for (const policy of [POLICY_A, POLICY_B]) {
      for (let i = 0; i < 4; i += 1) {
        rows.push(assignment({
          id: `${policy.slice(0, 1)}-${i}`,
          configPolicyId: policy,
          level: 'device',
          targetId: DEVICE,
          createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
        }));
      }
    }
    setAssignments(rows);
    tableResults.set(devices, [{ id: DEVICE, displayName: 'Front desk', hostname: 'fd-01' }]);

    const result = await loadAppliesToSummaries(auth, [POLICY_A, POLICY_B]);
    expect(result.get(POLICY_A)!.targets.map((t) => t.assignmentId)).toEqual(['a-0', 'a-1', 'a-2']);
    expect(result.get(POLICY_B)!.targets.map((t) => t.assignmentId)).toEqual(['b-0', 'b-1', 'b-2']);
    expect(result.get(POLICY_A)!.assignmentCount).toBe(4);
    expect(result.get(POLICY_B)!.assignmentCount).toBe(4);
  });

  it('names only the rows needed to fill the cap', async () => {
    // A policy assigned to 40 devices, every one listable and named.
    const ids = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    setAssignments(ids.map((id, i) => assignment({
      id: `d-${i}`,
      level: 'device',
      targetId: id,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    })));
    tableResults.set(devices, ids.map((id, i) => ({ id, displayName: `Device ${i}`, hostname: `h-${i}` })));

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;

    expect(summary.assignmentCount).toBe(40);
    expect(summary.targets.map((t) => t.assignmentId)).toEqual(['d-0', 'd-1', 'd-2']);
    expect(authorizeMock).toHaveBeenCalledTimes(1);
    const deviceLookups = inArrayCalls.filter((call) => call.column === devices.id);
    expect(deviceLookups).toHaveLength(1);
    expect(deviceLookups[0]!.values).toEqual(ids.slice(0, 3));
  });

  it('names nothing when the caller may list none of the window', async () => {
    // A site-restricted caller and a policy on 120 devices outside their sites;
    // the window (rows 1-50 in SQL) arrives, every target is refused.
    const ids = Array.from({ length: 120 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    tableResults.set(configPolicyAssignments, windowed(ids.map((id, i) => assignment({
      id: `d-${i}`,
      level: 'device',
      targetId: id,
    }))).slice(0, 50));
    authorizeMock.mockImplementation(admitWhen(() => false));

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;

    // The count is the window total over all 120 rows, not the 50 read.
    expect(summary.assignmentCount).toBe(120);
    expect(summary.targets).toEqual([]);
    expect(authorizeMock).toHaveBeenCalledTimes(1);
    expect(authorizeMock.mock.calls[0]![1]).toHaveLength(50);
    expect(fromCalls).not.toContain(devices);
  });

  it('keeps looking past rows it cannot name until the cap fills', async () => {
    // The first five targets are not legible; the sixth and seventh are.
    const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    setAssignments(ids.map((id, i) => assignment({
      id: `d-${i}`,
      level: 'device',
      targetId: id,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    })));
    tableResults.set(devices, [
      { id: ids[5], displayName: 'Six', hostname: 'h-5' },
      { id: ids[6], displayName: 'Seven', hostname: 'h-6' },
    ]);

    const summary = (await loadAppliesToSummaries(auth, [POLICY_A])).get(POLICY_A)!;
    expect(summary.assignmentCount).toBe(7);
    expect(summary.targets.map((t) => t.name)).toEqual(['Six', 'Seven']);
  });

  it('childPolicyCount counts children', async () => {
    tableResults.set(configurationPolicies, [
      { parentPolicyId: POLICY_A, count: 2 },
      { parentPolicyId: POLICY_B, count: '1' },
    ]);

    const result = await loadAppliesToSummaries(auth, [POLICY_A, POLICY_B]);
    expect(result.get(POLICY_A)!.childPolicyCount).toBe(2);
    expect(result.get(POLICY_B)!.childPolicyCount).toBe(1);
  });

  it('a policy with no rows and no children is present with zeros', async () => {
    const result = await loadAppliesToSummaries(auth, [POLICY_A]);
    expect(result.get(POLICY_A)).toEqual({
      assignmentCount: 0,
      allOrganizations: false,
      targets: [],
      childPolicyCount: 0,
    });
    // Nothing to name, so no name lookup ran.
    for (const table of [organizations, sites, deviceGroups, devices]) {
      expect(fromCalls).not.toContain(table);
    }
  });
});
