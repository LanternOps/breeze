/**
 * Unit coverage for the diagnostics + write shape of `evaluateGroupMembership`
 * (the whole-group dynamic materialization).
 *
 * The defect these guard: a dynamic group was created, the server-side preview
 * reported 3 matching devices, and `device_group_memberships` stayed at 0 rows
 * with NOTHING in the API logs. The route fired the evaluation and did not
 * await it, so the detached promise resumed after the request's
 * `withDbAccessContext` transaction had committed; its next query was stranded
 * on a closed transaction handle and never executed. The promise never settled,
 * so the route's `.catch()` never ran either.
 *
 * The route fix (awaiting) lives in `routes/groups.ts` and is proved end-to-end
 * by `__tests__/integration/dynamicGroupMembershipMaterialization.integration.test.ts`.
 * What is tested HERE is the second half of the fix — that the service can no
 * longer fail quietly:
 *   - a group row the caller cannot SEE (the signature of a missing/torn-down
 *     RLS access context) is logged as an error instead of returning a bland
 *     zero summary,
 *   - a materialization that comes up short of what the filter matched is
 *     logged with the group id and BOTH counts,
 *   - a healthy materialization logs nothing and stamps the group's own org on
 *     every membership row it writes.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockSelect,
  mockInsert,
  mockDelete,
  mockUpdate,
  mockEvaluateFilter,
  mockHasDbAccessContext,
  mockGetCurrentDbAccessContext,
  mockSchedulePeripheralPolicyDevice,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
  mockUpdate: vi.fn(),
  mockEvaluateFilter: vi.fn(),
  mockHasDbAccessContext: vi.fn(),
  mockGetCurrentDbAccessContext: vi.fn(),
  mockSchedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job'),
}));

vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice: mockSchedulePeripheralPolicyDevice,
}));

vi.mock('../db', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
  hasDbAccessContext: mockHasDbAccessContext,
  getCurrentDbAccessContext: mockGetCurrentDbAccessContext,
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
  evaluateFilter: mockEvaluateFilter,
  extractFieldsFromFilter: vi.fn().mockReturnValue([]),
}));

import { evaluateGroupMembership } from './groupMembership';

const FILTER = { operator: 'AND' as const, conditions: [] };

function groupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'group-1',
    orgId: 'org-a',
    siteId: null,
    type: 'dynamic',
    filterConditions: FILTER,
    filterFieldsUsed: [],
    ...overrides,
  };
}

/** `db.select().from().where().limit()` (single-row lookups). */
function limitChain(rows: unknown[]) {
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }) };
}

/** `db.select().from().where()` (list + count queries). */
function whereChain(rows: unknown[]) {
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }) };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
/** Rows handed to each `db.insert(...).values(...)` call, in order. */
let insertedRows: unknown[][];

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  insertedRows = [];
  mockInsert.mockImplementation(() => ({
    values: (rows: unknown[]) => {
      insertedRows.push(rows);
      return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
    },
  }));
  mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  mockUpdate.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
  mockHasDbAccessContext.mockReturnValue(true);
  mockGetCurrentDbAccessContext.mockReturnValue({ scope: 'organization', orgId: 'org-a' });
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('evaluateGroupMembership — silent-failure diagnostics', () => {
  it('logs an error naming the group and the DB access context when the group row is invisible', async () => {
    // Exactly what a contextless / torn-down-context read looks like under
    // forced RLS: the SELECT succeeds and returns nothing.
    mockSelect.mockReturnValueOnce(limitChain([]));
    mockHasDbAccessContext.mockReturnValue(false);

    const result = await evaluateGroupMembership('group-1');

    expect(result).toEqual({ evaluatedGroups: 0, added: 0, removed: 0, matched: 0, materialized: 0 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0]);
    expect(message).toContain('group-1');
    expect(message).toContain('dbAccessContext=none');
    expect(message).toContain('NOT materialized');
    expect(mockEvaluateFilter).not.toHaveBeenCalled();
  });

  it('stays quiet for a group that exists but is not a dynamic group', async () => {
    mockSelect.mockReturnValueOnce(limitChain([groupRow({ type: 'static' })]));

    const result = await evaluateGroupMembership('group-1');

    expect(result).toEqual({ evaluatedGroups: 0, added: 0, removed: 0 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a shortfall with the matched count and the count that actually landed', async () => {
    mockSelect
      .mockReturnValueOnce(limitChain([groupRow()]))       // group lookup
      .mockReturnValueOnce(whereChain([]))                  // resolver memberships
      .mockReturnValueOnce(whereChain([]))                  // current memberships
      .mockReturnValueOnce(whereChain([{ count: 0 }]));     // post-write verification
    mockEvaluateFilter.mockResolvedValue({
      deviceIds: ['dev-1', 'dev-2', 'dev-3'],
      totalCount: 3,
      evaluatedAt: new Date(),
    });

    const result = await evaluateGroupMembership('group-1');

    expect(result).toMatchObject({ added: 3, matched: 3, materialized: 0 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0]);
    expect(message).toContain('materialization shortfall');
    expect(message).toContain('group-1');
    expect(message).toContain('org-a');
    expect(message).toContain('matched 3 device(s)');
    expect(message).toContain('found 0');
  });

  it('logs nothing and stamps the group org on every row when materialization succeeds', async () => {
    mockSelect
      .mockReturnValueOnce(limitChain([groupRow()]))
      .mockReturnValueOnce(whereChain([]))
      .mockReturnValueOnce(whereChain([]))
      .mockReturnValueOnce(whereChain([{ count: 2 }]));
    mockEvaluateFilter.mockResolvedValue({
      deviceIds: ['dev-1', 'dev-2'],
      totalCount: 2,
      evaluatedAt: new Date(),
    });

    const result = await evaluateGroupMembership('group-1');

    expect(result).toMatchObject({ evaluatedGroups: 1, added: 2, removed: 0, matched: 2, materialized: 2 });
    expect(errorSpy).not.toHaveBeenCalled();

    // Memberships carry the GROUP's org, never a device-derived one.
    expect(insertedRows[0]).toEqual([
      { deviceId: 'dev-1', groupId: 'group-1', orgId: 'org-a', addedBy: 'dynamic_rule' },
      { deviceId: 'dev-2', groupId: 'group-1', orgId: 'org-a', addedBy: 'dynamic_rule' },
    ]);
    expect(mockSchedulePeripheralPolicyDevice).toHaveBeenCalledWith('dev-1', 'dynamic_membership_changed');
    expect(mockSchedulePeripheralPolicyDevice).toHaveBeenCalledWith('dev-2', 'dynamic_membership_changed');
  });

  it('counts a pinned non-matching member towards the expected total', async () => {
    mockSelect
      .mockReturnValueOnce(limitChain([groupRow()]))
      .mockReturnValueOnce(whereChain([{ deviceId: 'pinned-1', isPinned: true }]))
      .mockReturnValueOnce(whereChain([{ deviceId: 'pinned-1', isPinned: true }]))
      .mockReturnValueOnce(whereChain([{ count: 2 }])); // pinned-1 + dev-1
    mockEvaluateFilter.mockResolvedValue({
      deviceIds: ['dev-1'],
      totalCount: 1,
      evaluatedAt: new Date(),
    });

    const result = await evaluateGroupMembership('group-1');

    expect(result).toMatchObject({ added: 1, removed: 0, matched: 1, materialized: 2 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('writes the membership log as one batched insert instead of one per device', async () => {
    mockSelect
      .mockReturnValueOnce(limitChain([groupRow()]))
      .mockReturnValueOnce(whereChain([]))
      .mockReturnValueOnce(whereChain([]))
      .mockReturnValueOnce(whereChain([{ count: 3 }]));
    mockEvaluateFilter.mockResolvedValue({
      deviceIds: ['dev-1', 'dev-2', 'dev-3'],
      totalCount: 3,
      evaluatedAt: new Date(),
    });

    await evaluateGroupMembership('group-1');

    // 1 membership insert + 1 batched log insert — NOT 1 + 3.
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(insertedRows[1]).toHaveLength(3);
    expect((insertedRows[1] as unknown[])[0]).toEqual({
      groupId: 'group-1',
      deviceId: 'dev-1',
      orgId: 'org-a',
      action: 'added',
      reason: 'filter_match',
    });
  });
});
