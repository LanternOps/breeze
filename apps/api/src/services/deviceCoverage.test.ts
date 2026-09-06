import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock — the contractService.test.ts pattern. Every
// builder method returns the same chain; awaiting it yields the next queued
// result. contractQuantities and groupMembership are DELIBERATELY NOT mocked:
// their reads go through this same db, which is what makes the query-count
// assertions below a real contract rather than a restatement of the mocks.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

const { selectMock, deviceMatchesFilterMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), deviceMatchesFilterMock: vi.fn(),
}));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin', 'groupBy']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve);
  selectMock.mockImplementation(() => chain);
  return {
    db: { select: selectMock },
    hasDbAccessContext: () => true,
    getCurrentDbAccessContext: () => ({ scope: 'system', orgId: null }),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
  };
});
// groupMembership pulls the peripheral queue in transitively; it opens BullMQ at
// import time and this suite never schedules anything.
vi.mock('../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: vi.fn() }));
vi.mock('./filterEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./filterEngine')>();
  return { ...actual, deviceMatchesFilter: deviceMatchesFilterMock };
});

import { contractLinesCoveringDevice, DeviceCoverageError } from './deviceCoverage';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const SITE_B = '44444444-4444-4444-8444-444444444444';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';

const identity = (over: Record<string, unknown> = {}) => [{
  id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_A, deviceRole: 'server',
  status: 'online', isEphemeral: false, ...over,
}];
const billableRow = [{ id: DEVICE_ID, role: 'server', siteId: SITE_A }];
const contractLineRow = (over: Record<string, unknown> = {}) => ({
  contractId: 'c1', contractName: 'Acme MSA', contractStatus: 'active',
  line: {
    id: 'l1', lineType: 'per_device_role', description: 'Managed servers', siteId: null,
    deviceRoles: ['server'], deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    ...over,
  },
});
const groupRow = (over: Record<string, unknown> = {}) => ({
  id: GROUP_ID, orgId: ORG_ID, name: 'VIP Laptops', type: 'static', siteId: null, filterConditions: null, ...over,
});
const actor = { accessibleOrgIds: [ORG_ID] };

beforeEach(() => {
  results.length = 0;
  vi.clearAllMocks();
  deviceMatchesFilterMock.mockResolvedValue(false);
});

describe('contractLinesCoveringDevice (#3205 W06)', () => {
  it('rejects a malformed id as DEVICE_NOT_FOUND with ZERO queries', async () => {
    await expect(contractLinesCoveringDevice('not-a-uuid', actor))
      .rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('a missing device and a device outside accessibleOrgIds are the SAME 404', async () => {
    queueResult([]);
    await expect(contractLinesCoveringDevice(DEVICE_ID, actor)).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
    queueResult(identity({ orgId: 'other-org' }));
    await expect(contractLinesCoveringDevice(DEVICE_ID, actor)).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
  });

  it('accessibleOrgIds null (system/worker) reaches any org', async () => {
    queueResult(identity({ orgId: 'some-other-org' }));
    queueResult(billableRow);
    queueResult([]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, { accessibleOrgIds: null });
    expect(res).toMatchObject({ orgId: 'some-other-org', uncovered: true, notBillable: false });
  });

  it.each([
    ['decommissioned', { status: 'decommissioned' }, 'decommissioned'],
    ['ephemeral', { isEphemeral: true }, 'ephemeral'],
    ['a concurrent move (neither flag set)', {}, 'not_billable'],
  ])('not billable — %s — labels the reason, does no contract work, and never throws', async (_n, over, reason) => {
    queueResult(identity(over));
    queueResult([]);   // billableDeviceById → null
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res).toMatchObject({ notBillable: true, notBillableReason: reason, lines: [], uncovered: false });
    expect(selectMock).toHaveBeenCalledTimes(2);   // identity + billableDeviceById, nothing else
  });

  it('billable with no active contract lines: 3 reads, no group query, uncovered', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res).toMatchObject({ notBillable: false, notBillableReason: null, lines: [], uncovered: true });
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it('projects a role line: matchedBy role, roles verbatim, no deviceGroup', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([contractLineRow()]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res.uncovered).toBe(false);
    expect(res.lines).toEqual([{
      contractId: 'c1', contractName: 'Acme MSA', contractStatus: 'active', lineId: 'l1',
      lineType: 'per_device_role', description: 'Managed servers', matchedBy: 'role',
      siteId: null, deviceRoles: ['server'], deviceGroup: null,
    }]);
  });

  it('per_device splits org vs site, and a line at another site does not cover', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([
      contractLineRow({ id: 'l-org', lineType: 'per_device', deviceRoles: null, description: 'All devices' }),
      contractLineRow({ id: 'l-site', lineType: 'per_device', deviceRoles: null, siteId: SITE_A, description: 'HQ devices' }),
      contractLineRow({ id: 'l-other', lineType: 'per_device', deviceRoles: null, siteId: SITE_B, description: 'Branch devices' }),
    ]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res.lines.map((l) => [l.lineId, l.matchedBy, l.siteId]))
      .toEqual([['l-org', 'org', null], ['l-site', 'site', SITE_A]]);
  });

  it('a site-deleted per_device line covers nothing instead of widening to org-wide', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([
      contractLineRow({
        id: 'l-site-deleted', lineType: 'per_device', deviceRoles: null,
        siteId: null, siteName: 'Retired HQ', description: 'Retired site devices',
      }),
    ]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res).toMatchObject({ lines: [], uncovered: true });
  });

  it('a static group line: batch read + 1 membership read + 0 deviceMatchesFilter', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([contractLineRow({
      id: 'l-g', lineType: 'per_device_group', deviceRoles: null,
      deviceGroupId: GROUP_ID, deviceGroupName: 'VIP Laptops', description: 'VIP',
    })]);
    queueResult([groupRow()]);
    queueResult([{ isPinned: false }]);   // membership row exists → static member
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res.lines).toEqual([expect.objectContaining({
      matchedBy: 'group', deviceRoles: null, deviceGroup: { id: GROUP_ID, name: 'VIP Laptops' },
    })]);
    expect(selectMock).toHaveBeenCalledTimes(5);
    expect(deviceMatchesFilterMock).not.toHaveBeenCalled();
  });

  it('a group bound to ANOTHER site is skipped entirely: no membership read, no filter run', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([contractLineRow({
      id: 'l-g', lineType: 'per_device_group', deviceRoles: null,
      deviceGroupId: GROUP_ID, deviceGroupName: 'Branch VIPs',
    })]);
    queueResult([groupRow({ type: 'dynamic', siteId: SITE_B, filterConditions: { operator: 'AND', conditions: [] } })]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res).toMatchObject({ lines: [], uncovered: true });
    expect(selectMock).toHaveBeenCalledTimes(4);
    expect(deviceMatchesFilterMock).not.toHaveBeenCalled();
  });

  it('a group line whose group is gone covers nothing and does NOT throw (Decision 7)', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([
      contractLineRow({ id: 'l-null', lineType: 'per_device_group', deviceRoles: null, deviceGroupId: null, deviceGroupName: 'Retired' }),
      contractLineRow({ id: 'l-gone', lineType: 'per_device_group', deviceRoles: null, deviceGroupId: GROUP_ID, deviceGroupName: 'Deleted' }),
    ]);
    queueResult([]);   // batch read returns nothing for GROUP_ID
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res).toMatchObject({ lines: [], uncovered: true });
    expect(selectMock).toHaveBeenCalledTimes(4);
  });

  it('a GroupEvaluationError REJECTS as GROUP_EVALUATION_FAILED — it never resolves with lines: []', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([contractLineRow({
      id: 'l-g', lineType: 'per_device_group', deviceRoles: null,
      deviceGroupId: GROUP_ID, deviceGroupName: 'VIP Laptops',
    })]);
    queueResult([groupRow({ type: 'dynamic', filterConditions: { nope: true } })]);
    const err = await contractLinesCoveringDevice(DEVICE_ID, actor).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceCoverageError);
    expect(err).toMatchObject({
      status: 500, code: 'GROUP_EVALUATION_FAILED',
      details: { groupId: GROUP_ID, groupName: 'VIP Laptops', reason: 'invalid_filter' },
    });
  });

  it('any other error propagates unchanged — never swallowed into an empty coverage', async () => {
    const boom = new Error('kaboom');
    // mockImplementationOnce jumps the queue, so this hits the FIRST read.
    selectMock.mockImplementationOnce(() => { throw boom; });
    await expect(contractLinesCoveringDevice(DEVICE_ID, actor)).rejects.toBe(boom);
  });

  it('the three-state invariant holds on every fixture', async () => {
    const fixtures: Array<() => void> = [
      () => { queueResult(identity({ status: 'decommissioned' })); queueResult([]); },
      () => { queueResult(identity()); queueResult(billableRow); queueResult([]); },
      () => { queueResult(identity()); queueResult(billableRow); queueResult([contractLineRow()]); },
    ];
    for (const setup of fixtures) {
      results.length = 0;
      setup();
      const r = await contractLinesCoveringDevice(DEVICE_ID, actor);
      expect(r.uncovered).toBe(!r.notBillable && r.lines.length === 0);
      if (r.notBillable) { expect(r.lines).toEqual([]); expect(r.uncovered).toBe(false); }
    }
  });
});
