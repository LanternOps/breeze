import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSelect, mockInsert, mockDelete, mockEvaluateFilter, mockDeviceMatchesFilter } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
  mockEvaluateFilter: vi.fn(),
  mockDeviceMatchesFilter: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: vi.fn(),
    delete: mockDelete,
  },
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
  deviceMatchesFilter: mockDeviceMatchesFilter,
  evaluateFilter: mockEvaluateFilter,
  extractFieldsFromFilter: vi.fn(),
  isFilterConditionGroup: vi.fn().mockReturnValue(true),
}));

import {
  evaluateDeviceMembershipForGroup,
  evaluateGroupMembership,
  pruneGroupMembershipsOutsideSite,
  updateDeviceMembership,
} from './groupMembership';

function selectChain(rows: unknown[], withLimit = false) {
  const terminal = withLimit
    ? { limit: vi.fn().mockResolvedValue(rows) }
    : Promise.resolve(rows);
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(terminal) }) };
}

function membershipJoinChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

describe('evaluateGroupMembership persisted site scope', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  });

  it('passes the persisted group site to filter evaluation', async () => {
    const filter = { operator: 'AND', conditions: [] };
    mockSelect
      .mockReturnValueOnce(selectChain([{
        id: 'group-1',
        orgId: 'org-1',
        siteId: 'site-1',
        type: 'dynamic',
        filterConditions: filter,
        filterFieldsUsed: ['osType'],
      }], true))
      .mockReturnValueOnce(selectChain([]));
    mockEvaluateFilter.mockResolvedValue({ deviceIds: [], totalCount: 0, evaluatedAt: new Date() });

    await evaluateGroupMembership('group-1');

    expect(mockEvaluateFilter).toHaveBeenCalledWith(filter, {
      orgId: 'org-1',
      allowedSiteIds: ['site-1'],
    });
  });

  it('does not evaluate a device outside the persisted group site', async () => {
    const filter = { operator: 'AND', conditions: [] };
    mockSelect
      .mockReturnValueOnce(selectChain([{
        id: 'group-1',
        orgId: 'org-1',
        siteId: 'site-1',
        type: 'dynamic',
        filterConditions: filter,
        filterFieldsUsed: ['osType'],
      }], true))
      .mockReturnValueOnce(selectChain([{ orgId: 'org-1', siteId: 'site-2' }], true))
      .mockReturnValueOnce(selectChain([], true));
    mockDeviceMatchesFilter.mockResolvedValue(false);

    const result = await evaluateDeviceMembershipForGroup('group-1', 'device-in-site-2');

    expect(result).toEqual({ evaluatedGroups: 1, added: 0, removed: 0 });
    expect(mockDeviceMatchesFilter).not.toHaveBeenCalled();
  });

  it('removes an existing membership when a device is outside the persisted group site', async () => {
    const filter = { operator: 'AND', conditions: [] };
    mockSelect
      .mockReturnValueOnce(selectChain([{
        id: 'group-1', orgId: 'org-1', siteId: 'site-1', type: 'dynamic',
        filterConditions: filter, filterFieldsUsed: ['osType'],
      }], true))
      .mockReturnValueOnce(selectChain([{ orgId: 'org-1', siteId: 'site-2' }], true))
      .mockReturnValueOnce(selectChain([{ deviceId: 'device-1', isPinned: false }], true));

    const result = await evaluateDeviceMembershipForGroup('group-1', 'device-1');

    expect(result).toEqual({ evaluatedGroups: 1, added: 0, removed: 1 });
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeviceMatchesFilter).not.toHaveBeenCalled();
  });

  it('reevaluates site-scoped dynamic groups when the device site changes', async () => {
    const filter = { operator: 'AND', conditions: [] };
    mockSelect
      .mockReturnValueOnce(selectChain([{
        id: 'group-1', siteId: 'site-1', filterConditions: filter, filterFieldsUsed: ['osType'],
      }]))
      .mockReturnValueOnce(selectChain([{
        id: 'group-1', orgId: 'org-1', siteId: 'site-1', type: 'dynamic',
        filterConditions: filter, filterFieldsUsed: ['osType'],
      }], true))
      .mockReturnValueOnce(selectChain([{ orgId: 'org-1', siteId: 'site-2' }], true))
      .mockReturnValueOnce(selectChain([{ deviceId: 'device-1', isPinned: false }], true));

    const result = await updateDeviceMembership('device-1', ['siteId'], 'org-1');

    expect(result).toEqual({ evaluatedGroups: 1, added: 0, removed: 1 });
  });

  it('prunes pinned and dynamic memberships outside a reassigned group site', async () => {
    mockSelect.mockReturnValueOnce(membershipJoinChain([
      { deviceId: 'pinned-old-site', siteId: 'site-1', isPinned: true },
      { deviceId: 'dynamic-old-site', siteId: 'site-1', isPinned: false },
      { deviceId: 'new-site-member', siteId: 'site-2', isPinned: false },
    ]));

    const result = await pruneGroupMembershipsOutsideSite('group-1', 'site-2', 'org-1');

    expect(result).toEqual({ removed: 2 });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });
});
