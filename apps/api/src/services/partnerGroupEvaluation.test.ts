import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  select: vi.fn(), insert: vi.fn(), delete: vi.fn(),
  outside: vi.fn((work: () => unknown) => work()),
  system: vi.fn((work: () => unknown) => work()),
  rows: vi.fn(), locks: vi.fn(), exportLock: vi.fn(), resolve: vi.fn(), schedule: vi.fn(),
}));
vi.mock('../db', () => ({
  db: { select: mocks.select, insert: mocks.insert, delete: mocks.delete },
  runOutsideDbContext: mocks.outside, withSystemDbAccessContext: mocks.system,
}));
vi.mock('./deviceGroupOwnership', () => ({
  acquirePartnerGroupRowLocks: mocks.rows, acquireGroupOrgMembershipLocks: mocks.locks,
  acquireMembershipExportOrgLock: mocks.exportLock,
}));
vi.mock('./groupMembership', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./groupMembership')>();
  return { ...actual, resolveEffectiveGroupMembers: mocks.resolve, schedulePeripheralMembershipChanges: mocks.schedule };
});
vi.mock('./quickSupportOrg', async () => {
  const { ne } = await import('drizzle-orm');
  const { organizations } = await import('../db/schema');
  return { excludeQuickSupportOrgs: () => ne(organizations.type, 'quick_support') };
});
import { GroupEvaluationError } from './groupMembership';
import { evaluatePartnerGroupForOrg, listPartnerGroupEvaluationOrgIds } from './partnerGroupEvaluation';

const dialect = new PgDialect();
const partnerId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const orgId = '33333333-3333-4333-8333-333333333333';
const group = { id: groupId, orgId: null, partnerId, type: 'dynamic', filterRevision: 4, filterConditions: { operator: 'AND', conditions: [] } };
function selectRows(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ limit, orderBy, then: Promise.resolve(rows).then.bind(Promise.resolve(rows)) });
  mocks.select.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where }) });
  return { where, orderBy, limit };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.select.mockReset();
  mocks.resolve.mockResolvedValue({ matched: new Set(['new-device']), pinned: new Set(), filterMs: 12 });
});

describe('partner group evaluation', () => {
  it('pages orgs by ascending UUID, 50 per page, excluding QS and holding orgs, with no 500-org cap', async () => {
    // A cursor already beyond 500 orgs is still a normal page, never a hard cap.
    const cursor = '00000000-0000-4000-8000-000000000501';
    const page = Array.from({ length: 50 }, (_, index) => ({ id: `org-${index + 502}` }));
    const query = selectRows(page);
    expect(await listPartnerGroupEvaluationOrgIds(partnerId, cursor)).toEqual(page.map(({ id }) => id));
    expect(query.limit).toHaveBeenCalledWith(50);
    expect(query.orderBy).toHaveBeenCalledOnce();
    const condition = query.where.mock.calls[0]?.[0];
    if (!(condition instanceof SQL)) throw new Error('missing SQL predicate');
    const compiled = dialect.sqlToQuery(condition);
    expect(compiled.sql).toContain('"organizations"."id" >');
    expect(compiled.params).toEqual([partnerId, 'quick_support', 'unassigned_pool', cursor]);
    expect(mocks.outside).toHaveBeenCalledOnce();
    expect(mocks.system).toHaveBeenCalledWith(expect.any(Function), 'partnerGroupEvaluation.discover');
  });

  it('locks before resolving and writes only the evaluation org, scheduling after successful writes', async () => {
    selectRows([group]);
    selectRows([{ id: orgId }]); selectRows([group]);
    selectRows([{ deviceId: 'old-device', isPinned: false }]);
    selectRows([{ id: 'new-device' }]);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ deviceId: 'new-device' }]) }) });
    mocks.insert.mockReturnValue({ values });
    mocks.delete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ deviceId: 'old-device' }]) }) });
    const result = await evaluatePartnerGroupForOrg(groupId, orgId, { expectedRevision: 4 });
    expect(result).toMatchObject({ orgId, ok: true, status: 'evaluated', added: 1, removed: 1, matched: 1 });
    expect(mocks.rows).toHaveBeenCalledWith([groupId]);
    expect(mocks.locks).toHaveBeenCalledWith([{ groupId, orgId }], 'exclusive');
    expect(mocks.rows.mock.invocationCallOrder[0]).toBeLessThan(mocks.locks.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.locks.mock.invocationCallOrder[0]).toBeLessThan(mocks.resolve.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.resolve).toHaveBeenCalledWith(group, orgId);
    expect(mocks.exportLock).toHaveBeenCalledWith(orgId);
    expect(mocks.exportLock.mock.invocationCallOrder[0]).toBeLessThan(mocks.insert.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.exportLock.mock.invocationCallOrder[0]).toBeLessThan(mocks.delete.mock.invocationCallOrder[0] ?? 0);
    expect(result.filterMs).toBe(12);
    for (const [rows] of values.mock.calls) {
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ orgId, groupId })]));
    }
    expect(mocks.schedule).toHaveBeenCalledWith(['new-device', 'old-device'], 'dynamic_membership_changed');
    expect(mocks.system).toHaveBeenCalledWith(expect.any(Function), 'partnerGroupEvaluation.org');
  });

  it('reports a filter failure without deleting previous members or adding audit rows', async () => {
    selectRows([group]); selectRows([{ id: orgId }]); selectRows([group]);
    mocks.resolve.mockRejectedValueOnce(new GroupEvaluationError(groupId, 'engine_error', new Error('statement timeout')));
    expect(await evaluatePartnerGroupForOrg(groupId, orgId)).toMatchObject({
      orgId, ok: false, status: 'failed', error: `device group ${groupId}: engine_error`, added: 0, removed: 0,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('returns gone for a NULL filter without deleting existing members', async () => {
    selectRows([{ ...group, filterConditions: null }]);
    selectRows([{ deviceId: 'previous-member', isPinned: false }]);
    expect(await evaluatePartnerGroupForOrg(groupId, orgId)).toMatchObject({ status: 'gone', added: 0, removed: 0 });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('rethrows a non-GroupEvaluationError from the transaction so the queue retries', async () => {
    selectRows([group]); selectRows([{ id: orgId }]); selectRows([group]);
    const failure = new Error('connection lost');
    mocks.resolve.mockRejectedValueOnce(failure);
    await expect(evaluatePartnerGroupForOrg(groupId, orgId)).rejects.toBe(failure);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('returns superseded when the revision changed during the exclusive lock wait', async () => {
    selectRows([group]); selectRows([{ id: orgId }]); selectRows([{ ...group, filterRevision: 5 }]);
    expect(await evaluatePartnerGroupForOrg(groupId, orgId, { expectedRevision: 4 }))
      .toMatchObject({ status: 'superseded', added: 0, removed: 0 });
    expect(mocks.locks).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [{ ...group, filterConditions: null }] }, { rows: [{ ...group, type: 'static' }] }, { rows: [{ ...group, orgId }] }])(
    'returns gone for an ineligible definition after the exclusive lock wait %#', async ({ rows }) => {
      selectRows([group]); selectRows([{ id: orgId }]); selectRows(rows);
      expect(await evaluatePartnerGroupForOrg(groupId, orgId)).toMatchObject({ status: 'gone' });
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
    },
  );

  it('resolves the fresh filter after the exclusive lock wait without an expected revision', async () => {
    const fresh = { ...group, filterRevision: 5, filterConditions: { operator: 'OR', conditions: [] } };
    selectRows([group]); selectRows([{ id: orgId }]); selectRows([fresh]);
    selectRows([{ deviceId: 'new-device', isPinned: false }]);
    expect(await evaluatePartnerGroupForOrg(groupId, orgId)).toMatchObject({ status: 'evaluated' });
    expect(mocks.resolve).toHaveBeenCalledWith(fresh, orgId);
  });

  it('returns superseded before acquiring membership locks or writing', async () => {
    selectRows([group]);
    expect(await evaluatePartnerGroupForOrg(groupId, orgId, { expectedRevision: 3 }))
      .toMatchObject({ status: 'superseded', added: 0, removed: 0 });
    expect(mocks.locks).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [{ ...group, orgId }] }, { rows: [{ ...group, type: 'static' }] }])('returns gone for a missing or ineligible definition $rows', async ({ rows }) => {
    selectRows(rows);
    expect(await evaluatePartnerGroupForOrg(groupId, orgId)).toMatchObject({ status: 'gone' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('skips foreign, Quick Support and holding orgs rejected by the eligible org query', async () => {
    selectRows([group]); const query = selectRows([]);
    expect(await evaluatePartnerGroupForOrg(groupId, orgId)).toMatchObject({ status: 'skipped' });
    const predicate = query.where.mock.calls[0]?.[0];
    if (!(predicate instanceof SQL)) throw new Error('missing org SQL');
    expect(dialect.sqlToQuery(predicate).params).toEqual([orgId, partnerId, 'quick_support', 'unassigned_pool']);
    expect(mocks.locks).not.toHaveBeenCalled();
  });
});


describe('partner export lock protocol', () => {
  it('does not take an export lock or write when the diff is empty', async () => {
    selectRows([group]); selectRows([{ id: orgId }]); selectRows([group]);
    selectRows([{ deviceId: 'new-device', isPinned: false }]);
    expect(await evaluatePartnerGroupForOrg(groupId, orgId)).toMatchObject({ ok: true, added: 0, removed: 0 });
    expect(mocks.exportLock).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('rechecks additions after the export lock and excludes devices moved out meanwhile', async () => {
    selectRows([group]); selectRows([{ id: orgId }]); selectRows([group]); selectRows([]);
    const recheck = selectRows([]);
    expect(await evaluatePartnerGroupForOrg(groupId, orgId)).toMatchObject({ ok: true, added: 0, removed: 0 });
    expect(mocks.exportLock).toHaveBeenCalledWith(orgId);
    expect(mocks.exportLock.mock.invocationCallOrder[0]).toBeLessThan(recheck.where.mock.invocationCallOrder[0] ?? 0);
    const predicate = recheck.where.mock.calls[0]?.[0];
    if (!(predicate instanceof SQL)) throw new Error('missing device recheck');
    const query = dialect.sqlToQuery(predicate);
    expect(query.sql).toContain('"devices"."org_id"');
    expect(query.params).toEqual([orgId, 'new-device']);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('logs and counts only returned deletions with group, org and device predicates', async () => {
    mocks.resolve.mockResolvedValueOnce({ matched: new Set(), pinned: new Set(), filterMs: 9 });
    selectRows([group]); selectRows([{ id: orgId }]); selectRows([group]);
    selectRows([{ deviceId: 'moved-device', isPinned: false }]);
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    mocks.delete.mockReturnValue({ where });
    expect(await evaluatePartnerGroupForOrg(groupId, orgId)).toMatchObject({ ok: true, added: 0, removed: 0 });
    const predicate = where.mock.calls[0]?.[0];
    if (!(predicate instanceof SQL)) throw new Error('missing delete predicate');
    expect(dialect.sqlToQuery(predicate).params).toEqual([groupId, orgId, 'moved-device']);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});
