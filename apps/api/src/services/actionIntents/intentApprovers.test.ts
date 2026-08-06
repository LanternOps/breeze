import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

vi.mock('../../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  organizations: { id: 'id', partnerId: 'partner_id' },
  organizationUsers: { userId: 'user_id', orgId: 'org_id', roleId: 'role_id' },
  partnerUsers: { userId: 'user_id', partnerId: 'partner_id', roleId: 'role_id', orgAccess: 'org_access', orgIds: 'org_ids' },
  rolePermissions: { roleId: 'role_id', permissionId: 'permission_id' },
  permissions: { id: 'id', resource: 'resource', action: 'action' },
  users: { id: 'id', status: 'status' },
}));

import { db } from '../../db';
import { organizationUsers, partnerUsers, users } from '../../db/schema';
import { resolveIntentApprovers } from './intentApprovers';

/**
 * The resolver issues these selects in order:
 *   1. granting roles:  select().from(rolePermissions).innerJoin(permissions).where()
 *   2. org partner:     select().from(organizations).where().limit()
 *   3. org members:     select().from(organizationUsers).innerJoin(users).where()
 *   4. partner members: select().from(partnerUsers).innerJoin(users).where()
 * (4 is skipped when the org has no partner.) Both 3 and 4 join `users` and
 * require status='active' so disabled/invited accounts are never counted as
 * eligible approvers (nor as the sole-operator fallback).
 */
function queueSelects(opts: {
  grantingRoles: Array<{ roleId: string }>;
  org: Array<{ partnerId: string | null }>;
  orgMembers: Array<{ userId: string }>;
  partnerMembers: Array<{ userId: string; orgAccess: string; orgIds: string[] | null }>;
}) {
  const joinWhere = vi.fn().mockResolvedValue(opts.grantingRoles);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where: joinWhere }),
    }),
  } as any);

  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(opts.org) }),
    }),
  } as any);

  const orgMembersWhere = vi.fn().mockResolvedValue(opts.orgMembers);
  const orgMembersInnerJoin = vi.fn().mockReturnValue({ where: orgMembersWhere });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ innerJoin: orgMembersInnerJoin }),
  } as any);

  const partnerMembersWhere = vi.fn().mockResolvedValue(opts.partnerMembers);
  const partnerMembersInnerJoin = vi.fn().mockReturnValue({ where: partnerMembersWhere });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ innerJoin: partnerMembersInnerJoin }),
  } as any);

  return { orgMembersInnerJoin, orgMembersWhere, partnerMembersInnerJoin, partnerMembersWhere };
}

describe('resolveIntentApprovers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
  });

  it('returns distinct userIds across org members AND partner members with org_access covering the org', async () => {
    queueSelects({
      grantingRoles: [{ roleId: 'role-decide' }, { roleId: 'role-decide' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-org' }],
      partnerMembers: [
        { userId: 'u-all', orgAccess: 'all', orgIds: null },
        { userId: 'u-sel-yes', orgAccess: 'selected', orgIds: ['org-1', 'org-9'] },
        { userId: 'u-sel-no', orgAccess: 'selected', orgIds: ['org-other'] },
        { userId: 'u-none', orgAccess: 'none', orgIds: null },
      ],
    });

    const result = await resolveIntentApprovers('org-1');
    expect([...result].sort()).toEqual(['u-all', 'u-org', 'u-sel-yes']);
  });

  it('includes a role whose only grant is a wildcard (resource=* or action=*)', async () => {
    queueSelects({
      grantingRoles: [{ roleId: 'role-superadmin' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-admin' }],
      partnerMembers: [],
    });

    const result = await resolveIntentApprovers('org-1');
    expect(result).toEqual(['u-admin']);
  });

  it('returns [] when no role grants approvals:decide', async () => {
    queueSelects({
      grantingRoles: [],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [],
      partnerMembers: [],
    });

    const result = await resolveIntentApprovers('org-1');
    expect(result).toEqual([]);
    // Short-circuits before any membership lookup.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('skips the partner-members lookup when the org has no partner', async () => {
    const joinWhere = vi.fn().mockResolvedValue([{ roleId: 'role-decide' }]);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: joinWhere }),
      }),
    } as any);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ partnerId: null }]) }),
      }),
    } as any);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ userId: 'u-org' }]) }),
      }),
    } as any);

    const result = await resolveIntentApprovers('org-1');
    expect(result).toEqual(['u-org']);
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it('returns [] when eligible members exist but none carry a granting role', async () => {
    queueSelects({
      grantingRoles: [{ roleId: 'role-decide' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [],
      partnerMembers: [],
    });

    const result = await resolveIntentApprovers('org-1');
    expect(result).toEqual([]);
  });

  it('joins users and requires status=active on both the org-member and partner-member candidate queries', async () => {
    // 'u-disabled' held an approvals:decide role but is a disabled admin —
    // Postgres never returns it once the users-status join is in place, so
    // the fixture reflects that (this file's mocks always model what the DB
    // would already have filtered to; see header comment).
    const { orgMembersInnerJoin, orgMembersWhere, partnerMembersInnerJoin, partnerMembersWhere } = queueSelects({
      grantingRoles: [{ roleId: 'role-decide' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-active' }],
      partnerMembers: [{ userId: 'u-partner-active', orgAccess: 'all', orgIds: null }],
    });

    const result = await resolveIntentApprovers('org-1');

    expect([...result].sort()).toEqual(['u-active', 'u-partner-active']);

    // The org-member query joins `users` on organizationUsers.userId and
    // gates on status='active'.
    expect(orgMembersInnerJoin).toHaveBeenCalledWith(users, eq(users.id, organizationUsers.userId));
    expect(orgMembersWhere).toHaveBeenCalledWith(
      and(
        eq(organizationUsers.orgId, 'org-1'),
        inArray(organizationUsers.roleId, ['role-decide']),
        eq(users.status, 'active'),
      ),
    );

    // The partner-axis query joins `users` on partnerUsers.userId and gates
    // on status='active' too — this is the query CRITICAL-2 added, and the
    // one most likely to be missed when patching only the org-member query.
    expect(partnerMembersInnerJoin).toHaveBeenCalledWith(users, eq(users.id, partnerUsers.userId));
    expect(partnerMembersWhere).toHaveBeenCalledWith(
      and(
        eq(partnerUsers.partnerId, 'partner-1'),
        inArray(partnerUsers.roleId, ['role-decide']),
        eq(users.status, 'active'),
      ),
    );
  });

  it('sole-operator implication: an active requester is the only result when every other candidate is filtered out as non-active', async () => {
    // 'u-disabled-1' (org-scope) and 'u-disabled-2' (partner-scope) also hold
    // the granting role but are disabled/invited, so — mirroring real DB
    // behavior once the users-status join lands — only the active requester
    // survives the fixture.
    queueSelects({
      grantingRoles: [{ roleId: 'role-decide' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-requester' }],
      partnerMembers: [],
    });

    const result = await resolveIntentApprovers('org-1');
    expect(result).toEqual(['u-requester']);
  });
});
