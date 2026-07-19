import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

import { db } from '../../db';
import { resolveIntentApprovers } from './intentApprovers';

/**
 * The resolver issues these selects in order:
 *   1. granting roles:  select().from(rolePermissions).innerJoin(permissions).where()
 *   2. org partner:     select().from(organizations).where().limit()
 *   3. org members:     select().from(organizationUsers).where()
 *   4. partner members: select().from(partnerUsers).where()
 * (4 is skipped when the org has no partner.)
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

  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(opts.orgMembers),
    }),
  } as any);

  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(opts.partnerMembers),
    }),
  } as any);
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
        where: vi.fn().mockResolvedValue([{ userId: 'u-org' }]),
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
});
