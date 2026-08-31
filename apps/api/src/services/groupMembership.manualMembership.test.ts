/**
 * Unit coverage for the two helpers extracted for #3159: the shared tenancy
 * guard (`validateManualMembershipDevices`) and the shared membership writer
 * (`addManualGroupMemberships`), used by both group-create (`POST /groups`)
 * and `POST /:id/devices`. See the doc comments on both functions in
 * `groupMembership.ts` for the invariants being tested here.
 *
 * Mocking style copied from `groupMembership.materialization.test.ts` (the
 * established db-mocking harness for this directory).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSelect, mockInsert, mockSchedulePeripheralPolicyDevice } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockSchedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job'),
}));

vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice: mockSchedulePeripheralPolicyDevice,
}));

vi.mock('../db', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: vi.fn(),
    delete: vi.fn(),
  },
  hasDbAccessContext: vi.fn().mockReturnValue(true),
  getCurrentDbAccessContext: vi.fn().mockReturnValue({ scope: 'organization', orgId: 'org-a' }),
}));

vi.mock('../db/schema', () => ({
  deviceGroups: {
    id: 'group.id',
    type: 'group.type',
    filterConditions: 'group.filterConditions',
    filterFieldsUsed: 'group.filterFieldsUsed',
    orgId: 'group.orgId',
    siteId: 'group.siteId',
  },
  devices: { id: 'device.id', orgId: 'device.orgId', siteId: 'device.siteId' },
  deviceGroupMemberships: {
    groupId: 'membership.groupId',
    deviceId: 'membership.deviceId',
    isPinned: 'membership.isPinned',
  },
  groupMembershipLog: {},
}));

vi.mock('./filterEngine', () => ({
  deviceMatchesFilter: vi.fn(),
  evaluateFilter: vi.fn(),
  extractFieldsFromFilter: vi.fn().mockReturnValue([]),
}));

import { addManualGroupMemberships, validateManualMembershipDevices } from './groupMembership';

const ORG_ID = 'org-a';
const ORG_ID_2 = 'org-b';
const SITE_ID = 'site-x';
const SITE_ID_2 = 'site-y';
const GROUP_ID = 'group-1';
const D1 = 'device-1';
const D2 = 'device-2';

/** `db.select().from().where()` (list queries, no `.limit()`). */
function whereChain(rows: unknown[]) {
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }) };
}

let insertedRows: unknown[][];

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows = [];
  mockInsert.mockImplementation(() => ({
    values: (rows: unknown[]) => {
      insertedRows.push(rows);
      return Promise.resolve(undefined);
    },
  }));
});

describe('validateManualMembershipDevices', () => {
  it('returns ok without querying the database when deviceIds is empty', async () => {
    const result = await validateManualMembershipDevices({ deviceIds: [], orgId: ORG_ID, siteId: null });

    expect(result).toEqual({ ok: true });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('accepts devices that are all in the same org with no site boundary', async () => {
    mockSelect.mockReturnValueOnce(whereChain([
      { id: D1, orgId: ORG_ID, siteId: null },
      { id: D2, orgId: ORG_ID, siteId: null },
    ]));

    const result = await validateManualMembershipDevices({
      deviceIds: [D1, D2],
      orgId: ORG_ID,
      siteId: null,
    });

    expect(result).toEqual({ ok: true });
  });

  it('rejects a device belonging to a different org', async () => {
    mockSelect.mockReturnValueOnce(whereChain([
      { id: D1, orgId: ORG_ID_2, siteId: null },
    ]));

    const result = await validateManualMembershipDevices({
      deviceIds: [D1],
      orgId: ORG_ID,
      siteId: null,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { invalidDevices?: string[] }).invalidDevices).toContain(D1);
  });

  it('rejects a requested device the query does not return at all (RLS-invisible or nonexistent)', async () => {
    mockSelect.mockReturnValueOnce(whereChain([]));

    const result = await validateManualMembershipDevices({
      deviceIds: [D1],
      orgId: ORG_ID,
      siteId: null,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { invalidDevices?: string[] }).invalidDevices).toContain(D1);
  });

  it('rejects a device outside the group site with 403', async () => {
    mockSelect.mockReturnValueOnce(whereChain([
      { id: D1, orgId: ORG_ID, siteId: SITE_ID_2 },
    ]));

    const result = await validateManualMembershipDevices({
      deviceIds: [D1],
      orgId: ORG_ID,
      siteId: SITE_ID,
    });

    expect(result).toEqual({ ok: false, status: 403, error: 'Access to this site denied' });
  });

  it('accepts every device sitting in the group site', async () => {
    mockSelect.mockReturnValueOnce(whereChain([
      { id: D1, orgId: ORG_ID, siteId: SITE_ID },
      { id: D2, orgId: ORG_ID, siteId: SITE_ID },
    ]));

    const result = await validateManualMembershipDevices({
      deviceIds: [D1, D2],
      orgId: ORG_ID,
      siteId: SITE_ID,
    });

    expect(result).toEqual({ ok: true });
  });

  it('dedupes duplicate ids in the request', async () => {
    mockSelect.mockReturnValueOnce(whereChain([
      { id: D1, orgId: ORG_ID, siteId: null },
    ]));

    const result = await validateManualMembershipDevices({
      deviceIds: [D1, D1],
      orgId: ORG_ID,
      siteId: null,
    });

    expect(result).toEqual({ ok: true });
    expect((result as { invalidDevices?: string[] }).invalidDevices).toBeUndefined();
  });
});

describe('addManualGroupMemberships', () => {
  it('skips devices that are already members', async () => {
    mockSelect.mockReturnValueOnce(whereChain([{ deviceId: D1 }]));

    const result = await addManualGroupMemberships({
      groupId: GROUP_ID,
      orgId: ORG_ID,
      deviceIds: [D1, D2],
    });

    expect(result).toEqual({ added: [D2], skipped: 1 });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(insertedRows[0]).toEqual([
      { deviceId: D2, groupId: GROUP_ID, orgId: ORG_ID, addedBy: 'manual' },
    ]);
    expect(mockSchedulePeripheralPolicyDevice).toHaveBeenCalledWith(D2, 'manual_membership_changed');
  });

  it('does nothing for an empty deviceIds list', async () => {
    const result = await addManualGroupMemberships({
      groupId: GROUP_ID,
      orgId: ORG_ID,
      deviceIds: [],
    });

    expect(result).toEqual({ added: [], skipped: 0 });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('inserts one row per device when the request repeats an id', async () => {
    mockSelect.mockReturnValueOnce(whereChain([]));

    const result = await addManualGroupMemberships({
      groupId: GROUP_ID,
      orgId: ORG_ID,
      deviceIds: [D1, D1],
    });

    // `(device_id, group_id)` is the membership primary key, so a duplicate in
    // the payload has to collapse before the insert rather than becoming a
    // constraint violation surfacing as a 500.
    expect(result).toEqual({ added: [D1], skipped: 0 });
    expect(insertedRows[0]).toEqual([
      { deviceId: D1, groupId: GROUP_ID, orgId: ORG_ID, addedBy: 'manual' },
    ]);
    expect(mockSchedulePeripheralPolicyDevice).toHaveBeenCalledWith(D1, 'manual_membership_changed');
  });
});
