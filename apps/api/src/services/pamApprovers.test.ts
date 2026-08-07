import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  organizations: { id: 'id', partnerId: 'partner_id' },
  organizationUsers: { userId: 'user_id', orgId: 'org_id', roleId: 'role_id' },
  partnerUsers: { userId: 'user_id', partnerId: 'partner_id', roleId: 'role_id', orgAccess: 'org_access', orgIds: 'org_ids' },
  rolePermissions: { roleId: 'role_id', permissionId: 'permission_id' },
  permissions: { id: 'id', resource: 'resource', action: 'action' },
  mobileDevices: { userId: 'user_id', status: 'status', notificationsEnabled: 'notifications_enabled' },
  users: { id: 'users.id', status: 'users.status' },
}));

import { db } from '../db';
import { resolveElevationApprovers } from './pamApprovers';

/**
 * The resolver issues these selects in order:
 *   1. granting roles:  select().from(rolePermissions).innerJoin(permissions).where()
 *   2. org partner:     select().from(organizations).where().limit()
 *   3. org members:     select().from(organizationUsers).innerJoin(users).where()
 *   4. partner members: select().from(partnerUsers).innerJoin(users).where()
 *   5. mobile devices:  select().from(mobileDevices).where()
 * (4 is skipped when the org has no partner; 5 is skipped when no candidates.)
 *
 * 3 and 4 gained their `users` innerJoin in #3174. `spies` exposes the
 * arguments those two calls actually received so a test can assert on the real
 * join target and predicate rather than on what the mock was told to return —
 * the mock resolves its rows regardless of the WHERE, so a test that only
 * checked returned ids could not fail if the status gate were deleted.
 */
const spies = {
  orgMembersInnerJoin: vi.fn(),
  orgMembersWhere: vi.fn(),
  partnerMembersInnerJoin: vi.fn(),
  partnerMembersWhere: vi.fn(),
};

/** Serialize a drizzle condition so a test can look for a column/value in it. */
function conditionText(cond: unknown): string {
  return JSON.stringify(cond, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) ?? '';
}

function queueSelects(opts: {
  grantingRoles: Array<{ roleId: string }>;
  org: Array<{ partnerId: string | null }>;
  orgMembers: Array<{ userId: string }>;
  partnerMembers: Array<{ userId: string; orgAccess: string; orgIds: string[] | null }>;
  mobile: Array<{ userId: string }>;
}) {
  // 1. innerJoin chain
  const joinWhere = vi.fn().mockResolvedValue(opts.grantingRoles);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where: joinWhere }),
    }),
  } as any);

  // 2. org partner (where().limit())
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(opts.org) }),
    }),
  } as any);

  // 3. org members (innerJoin().where())
  spies.orgMembersWhere.mockResolvedValue(opts.orgMembers);
  spies.orgMembersInnerJoin.mockReturnValue({ where: spies.orgMembersWhere });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ innerJoin: spies.orgMembersInnerJoin }),
  } as any);

  // 4. partner members (innerJoin().where())
  spies.partnerMembersWhere.mockResolvedValue(opts.partnerMembers);
  spies.partnerMembersInnerJoin.mockReturnValue({ where: spies.partnerMembersWhere });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ innerJoin: spies.partnerMembersInnerJoin }),
  } as any);

  // 5. mobile devices (where())
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(opts.mobile),
    }),
  } as any);
}

describe('resolveElevationApprovers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    for (const s of Object.values(spies)) s.mockReset();
  });

  it('returns distinct userIds with an active mobile device (org + partner members)', async () => {
    queueSelects({
      grantingRoles: [{ roleId: 'role-exec' }, { roleId: 'role-exec' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-org' }],
      partnerMembers: [
        { userId: 'u-all', orgAccess: 'all', orgIds: null },
        { userId: 'u-sel-yes', orgAccess: 'selected', orgIds: ['org-1', 'org-9'] },
        { userId: 'u-sel-no', orgAccess: 'selected', orgIds: ['org-other'] },
        { userId: 'u-none', orgAccess: 'none', orgIds: null },
      ],
      // u-sel-yes has no mobile device → filtered out by the device query.
      mobile: [{ userId: 'u-org' }, { userId: 'u-all' }, { userId: 'u-org' }],
    });

    const result = await resolveElevationApprovers('org-1');
    expect([...result].sort()).toEqual(['u-all', 'u-org']);
  });

  it('includes a role whose only grant is a wildcard (resource=* or action=*)', async () => {
    // The granting-roles query matches the concrete devices:execute pair AND
    // the wildcard rows (resource='*' / action='*'), mirroring hasPermission().
    // A superadmin role (whose grant is the wildcard row) must therefore be
    // resolved as an eligible approver.
    queueSelects({
      grantingRoles: [{ roleId: 'role-superadmin' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-admin' }],
      partnerMembers: [],
      mobile: [{ userId: 'u-admin' }],
    });

    const result = await resolveElevationApprovers('org-1');
    expect(result).toEqual(['u-admin']);
  });

  it('returns [] when no role grants devices:execute', async () => {
    queueSelects({
      grantingRoles: [],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [],
      partnerMembers: [],
      mobile: [],
    });

    const result = await resolveElevationApprovers('org-1');
    expect(result).toEqual([]);
    // Short-circuits before any membership lookup.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  // #3174: memberships survive an account being disabled or left in 'invited',
  // so both candidate queries must join `users` and require status='active'.
  // These assert the join target and the predicate that reach drizzle, not the
  // ids the mock was primed to return — the latter cannot fail if the gate goes.
  it('gates direct org members on an active user account', async () => {
    queueSelects({
      grantingRoles: [{ roleId: 'role-exec' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-org' }],
      partnerMembers: [],
      mobile: [{ userId: 'u-org' }],
    });

    await resolveElevationApprovers('org-1');

    expect(spies.orgMembersInnerJoin).toHaveBeenCalledTimes(1);
    expect(spies.orgMembersInnerJoin.mock.calls[0]?.[0]).toEqual({
      id: 'users.id',
      status: 'users.status',
    });
    const where = conditionText(spies.orgMembersWhere.mock.calls[0]?.[0]);
    expect(where).toContain('users.status');
    expect(where).toContain('active');
  });

  it('gates partner members on an active user account', async () => {
    queueSelects({
      grantingRoles: [{ roleId: 'role-exec' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [],
      partnerMembers: [{ userId: 'u-all', orgAccess: 'all', orgIds: null }],
      mobile: [{ userId: 'u-all' }],
    });

    await resolveElevationApprovers('org-1');

    expect(spies.partnerMembersInnerJoin).toHaveBeenCalledTimes(1);
    expect(spies.partnerMembersInnerJoin.mock.calls[0]?.[0]).toEqual({
      id: 'users.id',
      status: 'users.status',
    });
    const where = conditionText(spies.partnerMembersWhere.mock.calls[0]?.[0]);
    expect(where).toContain('users.status');
    expect(where).toContain('active');
  });

  it('returns [] when eligible members have no active mobile device', async () => {
    queueSelects({
      grantingRoles: [{ roleId: 'role-exec' }],
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-org' }],
      partnerMembers: [],
      mobile: [],
    });

    const result = await resolveElevationApprovers('org-1');
    expect(result).toEqual([]);
  });
});
