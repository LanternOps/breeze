/**
 * Statement budget for the applies-to summary (#12306, Strix finding on PR #12512).
 *
 * The policy list runs `loadAppliesToSummaries` for a whole page inside the
 * request transaction, so its statement count must not grow with the page.
 * This file mocks only the driver and keeps the REAL `authorizeAssignmentTarget`
 * family, with a site- or device-restricted caller (an unrestricted caller
 * short-circuits before any query and would hide per-row authorization). Each
 * policy gets its own distinct device and device-group targets, so no memo can
 * collapse them. A statement is one awaited chain (`then`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectMock, tableResults, executed } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  tableResults: new Map<unknown, unknown[]>(),
  executed: [] as unknown[],
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
}));

import { loadAppliesToSummaries } from './configPolicyAppliesTo';
import {
  configPolicyAssignments,
  deviceGroupMemberships,
  deviceGroups,
  devices,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';

const SITE_OK = '33333333-3333-4333-8333-333333333333';

function uuid(prefix: string, i: number): string {
  return `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

// A subquery built with `.as()` keeps the table it reads, so the outer
// `from(subquery)` resolves to that table's fixture rows. Any column read on it
// is a harmless SQL placeholder.
const SOURCE = Symbol('source');
function subquery(table: unknown) {
  return new Proxy({ [SOURCE]: table } as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return undefined;
    },
  });
}

function chain(table: unknown) {
  const source = (table as Record<symbol, unknown>)?.[SOURCE] ?? table;
  const c: Record<string, unknown> = {};
  for (const m of ['where', 'groupBy', 'orderBy', 'leftJoin', 'innerJoin', 'limit']) {
    c[m] = () => c;
  }
  c.as = () => subquery(source);
  c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    executed.push(source);
    return Promise.resolve(tableResults.get(source) ?? []).then(resolve, reject);
  };
  return c;
}

function siteRestricted(): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as never, partnerId: 'p1', orgId: 'o1', scope: 'organization',
    accessibleOrgIds: ['o1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds: [SITE_OK],
    canAccessSite: (s: string | null | undefined) => s === SITE_OK,
  } as unknown as AuthContext;
}

function deviceRestricted(deviceIds: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as never, partnerId: 'p1', orgId: 'o1', scope: 'organization',
    accessibleOrgIds: ['o1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds: [SITE_OK],
    canAccessSite: (s: string | null | undefined) => s === SITE_OK,
    allowedDeviceIds: deviceIds,
  } as unknown as AuthContext;
}

/** N policies, each assigned to its own device and its own device group. */
function seedPage(n: number) {
  const policyIds: string[] = [];
  const assignments: unknown[] = [];
  const deviceRows: unknown[] = [];
  const groupRows: unknown[] = [];
  const memberRows: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    const policyId = uuid('aaaaaaaa', i);
    const deviceId = uuid('dddddddd', i);
    const groupId = uuid('eeeeeeee', i);
    policyIds.push(policyId);
    const base = { configPolicyId: policyId, priority: 0, roleFilter: null, osFilter: null, total: 2, anyPartner: false };
    assignments.push(
      { ...base, id: uuid('11111111', i), level: 'device_group', targetId: groupId, createdAt: new Date('2026-01-01T00:00:00Z'), rn: 1 },
      { ...base, id: uuid('22222222', i), level: 'device', targetId: deviceId, createdAt: new Date('2026-01-01T00:00:00Z'), rn: 2 },
    );
    deviceRows.push({ id: deviceId, siteId: SITE_OK, displayName: `Device ${i}`, hostname: `h-${i}` });
    groupRows.push({ id: groupId, siteId: SITE_OK, name: `Group ${i}` });
    memberRows.push({ groupId, deviceId, allInScope: true, memberCount: 1 });
  }
  tableResults.set(configPolicyAssignments, assignments);
  tableResults.set(devices, deviceRows);
  tableResults.set(deviceGroups, groupRows);
  tableResults.set(deviceGroupMemberships, memberRows);
  return { policyIds, deviceIds: deviceRows.map((r) => (r as { id: string }).id) };
}

async function statementsFor(n: number, makeAuth: (deviceIds: string[]) => AuthContext) {
  tableResults.clear();
  executed.length = 0;
  const { policyIds, deviceIds } = seedPage(n);
  const result = await loadAppliesToSummaries(makeAuth(deviceIds), policyIds);
  // Sanity: the fixture really produced targets, so the count is not of an empty run.
  expect(result.get(policyIds[n - 1]!)!.targets).toHaveLength(2);
  return executed.length;
}

/**
 * The most statements one summary may issue for any page size: the windowed
 * assignment read, the child count, at most three authorization reads (device
 * sites, device-group sites, device-group membership), and at most four name
 * reads in each of the two fill rounds.
 */
const STATEMENT_CEILING = 1 + 1 + 3 + 2 * 4;

beforeEach(() => {
  selectMock.mockReset();
  selectMock.mockImplementation(() => ({ from: (table: unknown) => chain(table) }));
});

describe('loadAppliesToSummaries statement budget', () => {
  it('a site-restricted caller costs the same for 1 policy as for 100', async () => {
    const one = await statementsFor(1, () => siteRestricted());
    const hundred = await statementsFor(100, () => siteRestricted());
    expect(hundred).toBe(one);
    expect(hundred).toBeLessThanOrEqual(STATEMENT_CEILING);
  });

  it('a device-restricted caller costs the same for 1 policy as for 100', async () => {
    const one = await statementsFor(1, deviceRestricted);
    const hundred = await statementsFor(100, deviceRestricted);
    expect(hundred).toBe(one);
    expect(hundred).toBeLessThanOrEqual(STATEMENT_CEILING);
  });
});
