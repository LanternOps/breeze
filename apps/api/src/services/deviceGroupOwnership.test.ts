import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
import { db } from '../db';
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

  it('returns only visible partner ids, ignores unknown ids, and deduplicates', async () => {
    const where = vi.fn().mockResolvedValue([
      { id: 'partner-group', orgId: null },
      { id: 'org-group', orgId: 'org-a' },
      { id: 'partner-group', orgId: null },
    ]);
    vi.mocked(db.select).mockReturnValue({ from: vi.fn().mockReturnValue({ where }) } as never);
    expect(await findPartnerOwnedGroupIds(['partner-group', 'org-group', 'unknown', 'partner-group']))
      .toEqual(['partner-group']);
    expect(dialect.sqlToQuery(where.mock.calls[0]![0] as SQL).params)
      .toEqual(['partner-group', 'org-group', 'unknown']);
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
