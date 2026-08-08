import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Site-axis fail-closed contract for `getRemediationRun`.
 *
 * RLS covers the org axis; the site axis is app-layer only. `getFleetFinding`
 * already returns `null` (a 404 at the route) when a site-restricted caller can
 * see none of a finding's member devices — `getRemediationRun` must behave
 * identically, because a run's metadata (which finding, which script or
 * command, how many devices, when, by whom) describes activity on devices the
 * caller is not allowed to see.
 *
 * The db double below is the same queue-based shape used by dispatch.test.ts:
 * each `db.select(...)` consumes the next queued row set in call order.
 * `getRemediationRun` issues exactly two selects — the run row, then its
 * target rows.
 */
const h = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];

  function makeSelectChain(rows: unknown[]) {
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    chain.from = pass;
    chain.innerJoin = pass;
    chain.leftJoin = pass;
    chain.where = pass;
    chain.orderBy = pass;
    chain.limit = pass;
    chain.offset = pass;
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  }

  const mockSelect = vi.fn(() => makeSelectChain(selectQueue.shift() ?? []));
  return { selectQueue, mockSelect };
});

vi.mock('../../db', () => ({ db: { select: h.mockSelect } }));

vi.mock('../../db/schema', () => ({
  devices: { id: 'd.id', siteId: 'd.siteId', hostname: 'd.hostname', displayName: 'd.displayName' },
  organizations: { id: 'o.id', name: 'o.name' },
}));

vi.mock('../../db/schema/fleetFindings', () => ({
  fleetFindings: { id: 'ff.id', orgId: 'ff.orgId' },
  fleetFindingDevices: { findingId: 'ffd.findingId', deviceId: 'ffd.deviceId' },
  fleetRemediationRuns: { id: 'frr.id', orgId: 'frr.orgId', createdAt: 'frr.createdAt' },
  fleetRemediationRunTargets: { runId: 'frt.runId' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  desc: (column: unknown) => ({ op: 'desc', column }),
}));

import { getRemediationRun } from './query';

const ORG_1 = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_1 = 'ee111111-1111-4111-8111-111111111111';
const FINDING_1 = 'f1111111-1111-4111-8111-111111111111';
const SITE_1 = 's1111111-1111-4111-8111-111111111111';
const SITE_2 = 's2222222-2222-4222-8222-222222222222';
const DEVICE_1 = 'd1111111-1111-4111-8111-111111111111';
const DEVICE_2 = 'd2222222-2222-4222-8222-222222222222';

function makeAuth(allowedSiteIds?: string[]): any {
  return {
    user: { id: USER_ID, email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
    scope: 'organization',
    orgId: ORG_1,
    accessibleOrgIds: [ORG_1],
    canAccessOrg: () => true,
    orgCondition: () => undefined,
    allowedSiteIds,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_1,
    orgId: ORG_1,
    findingId: FINDING_1,
    findingRevision: 3,
    actionKind: 'command',
    scriptId: null,
    commandType: 'reboot',
    parameterSnapshot: {},
    status: 'succeeded',
    targetCount: 2,
    succeededCount: 2,
    failedCount: 0,
    skippedCount: 0,
    createdBy: USER_ID,
    createdAt: new Date('2026-08-07T12:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function targetRow(deviceId: string, siteIdSnapshot: string | null) {
  return {
    runId: RUN_1,
    targetDeviceUuid: deviceId,
    hostnameSnapshot: 'WS-01',
    siteIdSnapshot,
    status: 'succeeded',
    skipReason: null,
    deviceCommandId: 'cmd-1',
    resultSummary: null,
    queuedAt: null,
    completedAt: null,
  };
}

beforeEach(() => {
  h.selectQueue.length = 0;
  h.mockSelect.mockClear();
});

describe('getRemediationRun — site-axis fail-closed', () => {
  it('returns null when the run row is not found or not in an accessible org', async () => {
    h.selectQueue.push([]);
    expect(await getRemediationRun(makeAuth(), RUN_1)).toBeNull();
  });

  it('returns null for a site-restricted caller with zero in-scope targets', async () => {
    // The run is in the caller's org (RLS lets the row through), but every one
    // of its targets is at a site the caller cannot see. Returning the run with
    // an empty `targets` array would still disclose that a fleet-wide reboot
    // happened, how many devices it hit, and who fired it.
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([targetRow(DEVICE_1, SITE_2), targetRow(DEVICE_2, SITE_2)]);

    expect(await getRemediationRun(makeAuth([SITE_1]), RUN_1)).toBeNull();
  });

  it('returns null for a caller with an EMPTY allowedSiteIds list (no sites at all)', async () => {
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([targetRow(DEVICE_1, SITE_1)]);

    expect(await getRemediationRun(makeAuth([]), RUN_1)).toBeNull();
  });

  it('returns null when a site-restricted caller sees a run whose targets carry no site snapshot', async () => {
    // `siteIdSnapshot` is nullable (a skipped target for a device that no
    // longer exists). Unattributable targets must not be treated as visible.
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([targetRow(DEVICE_1, null)]);

    expect(await getRemediationRun(makeAuth([SITE_1]), RUN_1)).toBeNull();
  });

  it('returns the run with only the in-scope targets under partial visibility', async () => {
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([targetRow(DEVICE_1, SITE_1), targetRow(DEVICE_2, SITE_2)]);

    const run = await getRemediationRun(makeAuth([SITE_1]), RUN_1);

    expect(run).not.toBeNull();
    expect(run!.id).toBe(RUN_1);
    // Run-level counts are the TRUE totals; only the target list narrows.
    expect(run!.targetCount).toBe(2);
    expect(run!.targets).toHaveLength(1);
    expect(run!.targets[0]!.deviceId).toBe(DEVICE_1);
  });

  it('returns every target for an unrestricted caller (allowedSiteIds undefined)', async () => {
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([targetRow(DEVICE_1, SITE_1), targetRow(DEVICE_2, SITE_2)]);

    const run = await getRemediationRun(makeAuth(), RUN_1);

    expect(run).not.toBeNull();
    expect(run!.targets).toHaveLength(2);
  });

  it('returns a target-less run for an unrestricted caller (not a 404 — nothing is being hidden)', async () => {
    // Only the site axis fails closed. An unrestricted caller looking at a run
    // that genuinely has no target rows must still see the run.
    h.selectQueue.push([runRow({ targetCount: 0 })]);
    h.selectQueue.push([]);

    const run = await getRemediationRun(makeAuth(), RUN_1);

    expect(run).not.toBeNull();
    expect(run!.targets).toEqual([]);
  });
});
