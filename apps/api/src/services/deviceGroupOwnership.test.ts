import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  getCurrentDbAccessContext: vi.fn(() => ({
    scope: 'organization', orgId: 'org-a', accessibleOrgIds: ['org-a'], accessiblePartnerIds: [], currentPartnerId: null,
  })),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
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
