import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { select: vi.fn(), execute: vi.fn() },
  getCurrentDbAccessContext: vi.fn(() => ({
    scope: 'organization', orgId: 'org-a', accessibleOrgIds: ['org-a'], accessiblePartnerIds: [], currentPartnerId: null,
  })),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  acquireGroupOrgMembershipLocks, acquirePartnerGroupRowLocks, acquireMembershipExportOrgLock, membershipLockKeysQuery,
  findPartnerOwnedGroupIds, groupOwnerMatchesMembershipOrg, isPartnerOwnedGroup,
  partnerGroupTargetRefusal, PARTNER_GROUP_READ_ONLY_BODY,
} from './deviceGroupOwnership';

const dialect = new PgDialect();
beforeEach(() => vi.clearAllMocks());

describe('deviceGroupOwnership', () => {
  it('identifies partner ownership only when orgId is null', () => {
    expect(isPartnerOwnedGroup({ orgId: null })).toBe(true);
    expect(isPartnerOwnedGroup({ orgId: 'org-a' })).toBe(false);
  });

  it('builds an independent org-or-partner owner predicate', () => {
    const { sql } = dialect.sqlToQuery(groupOwnerMatchesMembershipOrg());
    expect(sql).toContain('"device_groups"."org_id" = "device_group_memberships"."org_id"');
    expect(sql).toMatch(/"device_groups"\."org_id" IS NULL AND "device_groups"\."partner_id" =\s*\(SELECT "organizations"\."partner_id" FROM "organizations"/);
    expect(sql).toContain('"organizations"."id" = "device_group_memberships"."org_id"');
  });

  it('reads in system scope, filters to org_id IS NULL, and deduplicates', async () => {
    // Org-session JWTs carry no partner id, so a request-scoped read would not
    // see a partner group at all; the lookup must leave the caller's context.
    const where = vi.fn().mockResolvedValue([{ id: 'partner-group' }, { id: 'partner-group' }]);
    vi.mocked(db.select).mockReturnValue({ from: vi.fn().mockReturnValue({ where }) } as never);
    expect(await findPartnerOwnedGroupIds(['partner-group', 'org-group', 'unknown', 'partner-group']))
      .toEqual(['partner-group']);
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    // The partner pinning (no cross-partner existence oracle) is proven against
    // real Postgres in partnerDeviceGroupFanout.integration.test.ts.
  });

  it('returns [] without querying when the context names no partner and no org', async () => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValueOnce({
      scope: 'organization', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [], currentPartnerId: null,
    } as never);
    expect(await findPartnerOwnedGroupIds(['partner-group'])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('reads unconstrained without a second connection when already in system scope', async () => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValueOnce({ scope: 'system', orgId: null, accessibleOrgIds: null } as never);
    const where = vi.fn().mockResolvedValue([{ id: 'partner-group' }]);
    vi.mocked(db.select).mockReturnValue({ from: vi.fn().mockReturnValue({ where }) } as never);
    expect(await findPartnerOwnedGroupIds(['partner-group'])).toEqual(['partner-group']);
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    const query = dialect.sqlToQuery(where.mock.calls[0]![0] as SQL);
    expect(query.sql).toContain('"device_groups"."org_id" is null');
  });

  it('returns [] without querying when there is no ambient DB context to scope by', async () => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValueOnce(undefined);
    expect(await findPartnerOwnedGroupIds(['partner-group'])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('does not query for empty input', async () => {
    expect(await findPartnerOwnedGroupIds([])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns the target refusal code, ids and explanatory message', () => {
    expect(partnerGroupTargetRefusal(['a', 'b'])).toEqual({
      error: 'Partner-wide device groups can only be targeted by partner configuration policies (a, b)',
      code: 'PARTNER_GROUP_TARGET_UNSUPPORTED', groupIds: ['a', 'b'],
    });
  });

  it('exports the read-only refusal body', () => {
    expect(PARTNER_GROUP_READ_ONLY_BODY).toEqual({
      error: 'Partner-wide device groups are read-only here', code: 'PARTNER_GROUP_READ_ONLY',
    });
  });
});


describe('partner membership lock ordering', () => {
  it('builds namespaced PostgreSQL bigint keys with deduplicated input pairs', () => {
    const query = dialect.sqlToQuery(membershipLockKeysQuery([
      { groupId: 'g2', orgId: 'o' }, { groupId: 'g1', orgId: 'o' }, { groupId: 'g2', orgId: 'o' },
    ]));
    expect(query.sql).toContain('hashtextextended');
    expect(query.sql).toContain('device_group_membership:');
    expect(query.params).toEqual(['g2', 'o', 'g1', 'o']);
  });

  it.each(['shared', 'exclusive'] as const)('acquires every %s lock once in numeric bigint order', async (mode) => {
    vi.mocked(db.execute).mockResolvedValueOnce([
      { key: '9223372036854775806' }, { key: '-2' }, { key: '11' }, { key: '3' }, { key: '-2' },
    ] as never).mockResolvedValue([] as never);
    await acquireGroupOrgMembershipLocks([{ groupId: 'g', orgId: 'o' }], mode);
    const queries = vi.mocked(db.execute).mock.calls.slice(1).map(([query]) => {
      if (typeof query === 'string') throw new Error('expected structured SQL');
      return dialect.sqlToQuery(query.getSQL());
    });
    expect(queries.map((query) => query.params)).toEqual([['-2'], ['3'], ['11'], ['9223372036854775806']]);
    expect(queries.every((query) => query.sql.includes(mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock('))).toBe(true);
  });

  it('locks group rows in ascending id order and only for partner owners', async () => {
    vi.mocked(db.execute).mockResolvedValue([] as never);
    await acquirePartnerGroupRowLocks(['g2', 'g1', 'g2']);
    const call = vi.mocked(db.execute).mock.calls[0];
    if (!call || typeof call[0] === 'string') throw new Error('expected structured SQL');
    const query = dialect.sqlToQuery(call[0].getSQL());
    expect(query.sql).toContain('ORDER BY id FOR KEY SHARE');
    expect(query.sql).toContain('org_id IS NULL AND partner_id IS NOT NULL');
    expect(query.params).toEqual(['g2', 'g1']);
  });

  it('takes no locks for empty group/pair input', async () => {
    await acquirePartnerGroupRowLocks([]);
    await acquireGroupOrgMembershipLocks([], 'shared');
    expect(db.execute).not.toHaveBeenCalled();
  });
});


it('takes the existing export org lock before membership mutations', async () => {
  vi.mocked(db.execute).mockResolvedValue([] as never);
  await acquireMembershipExportOrgLock('org-id');
  const call = vi.mocked(db.execute).mock.calls[0];
  if (!call || typeof call[0] === 'string') throw new Error('expected structured SQL');
  const query = dialect.sqlToQuery(call[0].getSQL());
  expect(query.sql).toContain('public.breeze_partner_export_lock_orgs_exclusive(ARRAY[');
  expect(query.sql).toContain('::uuid[]');
  expect(query.params).toEqual(['org-id']);
});
