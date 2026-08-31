import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

vi.mock('../../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
  getCurrentDbAccessContext: vi.fn(() => null),
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
  roles: { id: 'id' },
  devices: { id: 'id', siteId: 'site_id', orgId: 'org_id' },
  aiAgentRuns: { id: 'id', orgId: 'org_id', deviceId: 'device_id', agentId: 'agent_id' },
}));

// The full tool registry drags in every aiTools* domain module (and their
// schema imports), which this file's partial schema mock cannot satisfy —
// mock just the shapes resolveIntentTargetScope reads. The REAL registry is
// pinned by intentApprovers.deviceTargets.contract.test.ts, which asserts
// every DEVICE_COMPLETE_TARGET_TOOLS entry declares deviceArgs for real.
vi.mock('../aiTools', () => ({
  aiTools: new Map<string, { deviceArgs?: readonly string[] }>([
    ['execute_command', { deviceArgs: ['deviceId'] }],
    ['run_script', { deviceArgs: ['deviceIds'] }],
    ['manage_services', { deviceArgs: ['deviceId'] }],
    // Registered but NOT in DEVICE_COMPLETE_TARGET_TOOLS — the canonical
    // indirect-target tool (targetType: all/group/filter, no deviceArgs).
    ['manage_deployments', {}],
  ]),
}));

// aiGuardrails transitively imports the whole tool hub too; only
// requiredPermissionsForTool is consumed here.
vi.mock('../aiGuardrails', () => ({
  requiredPermissionsForTool: vi.fn(),
}));

// Keep the REAL pure helpers (hasPermission / canAccessOrg / canAccessSite /
// PERMISSIONS) so eligibility semantics are exercised for real — only the
// per-user permission resolution is stubbed.
vi.mock('../permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../permissions')>();
  return { ...actual, getUserPermissions: vi.fn() };
});

import { db } from '../../db';
import { devices, organizationUsers, partnerUsers, users } from '../../db/schema';
import { requiredPermissionsForTool } from '../aiGuardrails';
import { getUserPermissions, type UserPermissions } from '../permissions';
import {
  DEVICE_COMPLETE_TARGET_TOOLS,
  isAgentIntentDecideAuthorized,
  resolveAgentIntentApprovers,
  resolveIntentApprovers,
  resolveIntentTargetScope,
} from './intentApprovers';

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

// ============================================================
// Wave 3b — agent-intent eligibility (action-and-target, spec §3.4)
// ============================================================

/** Builder for the permission sets getUserPermissions returns per user. */
function makePerms(overrides: Partial<UserPermissions> = {}): UserPermissions {
  return {
    permissions: [{ resource: 'devices', action: 'execute' }],
    partnerId: null,
    orgId: 'org-1',
    roleId: 'role-x',
    scope: 'organization',
    ...overrides,
  };
}

function stubPermsByUser(byUser: Record<string, UserPermissions | null>) {
  vi.mocked(getUserPermissions).mockImplementation(async (userId: string) => byUser[userId] ?? null);
}

/**
 * resolveAgentIntentApprovers issues exactly these selects, in order, inside
 * runOutsideDbContext(() => withSystemDbAccessContext(...)):
 *   1. org partner:     select().from(organizations).where().limit()
 *   2. org members:     select().from(organizationUsers).innerJoin(users).where()
 *   3. partner members: select().from(partnerUsers).innerJoin(users).where()
 * (3 is skipped when the org has no partner.) NO granting-roles query — the
 * candidate pool is every active member; RBAC is evaluated per user via
 * getUserPermissions, not via an approvals:decide role restriction.
 */
function queueAgentApproverSelects(opts: {
  org: Array<{ partnerId: string | null }>;
  orgMembers: Array<{ userId: string }>;
  partnerMembers?: Array<{ userId: string; orgAccess: string; orgIds: string[] | null }>;
}) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(opts.org) }),
    }),
  } as any);

  const orgMembersWhere = vi.fn().mockResolvedValue(opts.orgMembers);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where: orgMembersWhere }),
    }),
  } as any);

  if (opts.partnerMembers) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(opts.partnerMembers) }),
      }),
    } as any);
  }

  return { orgMembersWhere };
}

/** Device-site lookup: select({id, siteId}).from(devices).where(inArray(...)). */
function queueDeviceSiteSelect(rows: Array<{ id: string; siteId: string }>) {
  const where = vi.fn().mockResolvedValue(rows);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where }),
  } as any);
  return { where };
}

const DEVICES_EXECUTE = [{ resource: 'devices', action: 'execute' }];

describe('resolveAgentIntentApprovers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(requiredPermissionsForTool).mockReturnValue(DEVICES_EXECUTE);
  });

  it('excludes a member missing the action permission', async () => {
    queueAgentApproverSelects({
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-a' }, { userId: 'u-b' }],
      partnerMembers: [],
    });
    stubPermsByUser({
      'u-a': makePerms(),
      'u-b': makePerms({ permissions: [{ resource: 'devices', action: 'read' }] }),
    });

    const result = await resolveAgentIntentApprovers({
      orgId: 'org-1',
      toolName: 'execute_command',
      input: { deviceId: 'dev-1' },
      targetScope: { kind: 'devices', siteIds: ['site-1'] },
    });
    expect(result).toEqual(['u-a']);
  });

  it('excludes a member whose allowedSiteIds miss a target site', async () => {
    queueAgentApproverSelects({
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-a' }, { userId: 'u-b' }],
      partnerMembers: [],
    });
    stubPermsByUser({
      'u-a': makePerms(),
      'u-b': makePerms({ allowedSiteIds: ['site-2'] }),
    });

    const result = await resolveAgentIntentApprovers({
      orgId: 'org-1',
      toolName: 'execute_command',
      input: { deviceId: 'dev-1' },
      targetScope: { kind: 'devices', siteIds: ['site-1'] },
    });
    expect(result).toEqual(['u-a']);
  });

  it('indirect target scope admits ONLY site-unrestricted members', async () => {
    queueAgentApproverSelects({
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-a' }, { userId: 'u-b' }],
      partnerMembers: [],
    });
    // u-b's restriction even COVERS the run device's site — irrelevant: an
    // indirect target (deployment/group/filter) can reach devices anywhere in
    // the org, so only a site-unrestricted human could lawfully do it themselves.
    stubPermsByUser({
      'u-a': makePerms(),
      'u-b': makePerms({ allowedSiteIds: ['site-1'] }),
    });

    const result = await resolveAgentIntentApprovers({
      orgId: 'org-1',
      toolName: 'manage_deployments',
      input: { targetType: 'all' },
      targetScope: { kind: 'indirect' },
    });
    expect(result).toEqual(['u-a']);
  });

  it('includes a partner-only technician (partnerId passed to getUserPermissions)', async () => {
    queueAgentApproverSelects({
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [],
      partnerMembers: [
        { userId: 'u-tech', orgAccess: 'all', orgIds: null },
        { userId: 'u-tech-elsewhere', orgAccess: 'selected', orgIds: ['org-other'] },
      ],
    });
    stubPermsByUser({
      'u-tech': makePerms({ scope: 'partner', partnerId: 'partner-1', orgId: null, orgAccess: 'all' }),
    });

    const result = await resolveAgentIntentApprovers({
      orgId: 'org-1',
      toolName: 'execute_command',
      input: { deviceId: 'dev-1' },
      targetScope: { kind: 'devices', siteIds: ['site-1'] },
    });
    expect(result).toEqual(['u-tech']);
    // The partner axis is only evaluated when context.partnerId is supplied
    // (permissions.ts) — omitting it silently discards every partner-only tech.
    expect(getUserPermissions).toHaveBeenCalledWith('u-tech', { orgId: 'org-1', partnerId: 'partner-1' });
  });

  it('returns [] when the tool has no RBAC mapping', async () => {
    vi.mocked(requiredPermissionsForTool).mockReturnValue(null);

    const result = await resolveAgentIntentApprovers({
      orgId: 'org-1',
      toolName: 'unmapped_tool',
      input: {},
      targetScope: { kind: 'devices', siteIds: ['site-1'] },
    });
    expect(result).toEqual([]);
    // Deny-all short-circuits before any membership lookup.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('never consults recipients', async () => {
    // `ai_agents.recipients` is notification-only and must NEVER influence
    // eligibility. Structural pin: the resolver issues exactly the three
    // membership selects (org partner, org members, partner members) — no
    // agent-row read, no recipients module involvement — and the only other
    // inputs are per-user permission resolutions.
    queueAgentApproverSelects({
      org: [{ partnerId: 'partner-1' }],
      orgMembers: [{ userId: 'u-a' }],
      partnerMembers: [],
    });
    stubPermsByUser({ 'u-a': makePerms() });

    const result = await resolveAgentIntentApprovers({
      orgId: 'org-1',
      toolName: 'execute_command',
      input: { deviceId: 'dev-1' },
      targetScope: { kind: 'devices', siteIds: ['site-1'] },
    });
    expect(result).toEqual(['u-a']);
    expect(db.select).toHaveBeenCalledTimes(3);
    expect(getUserPermissions).toHaveBeenCalledTimes(1);
  });
});

describe('resolveIntentTargetScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
  });

  it('unions deviceArgs devices with the run device and dedupes sites', async () => {
    queueDeviceSiteSelect([
      { id: 'dev-1', siteId: 'site-1' },
      { id: 'dev-2', siteId: 'site-2' },
      { id: 'dev-3', siteId: 'site-1' },
    ]);

    const scope = await resolveIntentTargetScope(
      'run_script',
      { scriptId: 'script-1', deviceIds: ['dev-1', 'dev-2'] },
      { deviceId: 'dev-3' },
      'org-1',
    );
    expect(scope.kind).toBe('devices');
    if (scope.kind !== 'devices') throw new Error('unreachable');
    expect([...scope.siteIds].sort()).toEqual(['site-1', 'site-2']);
  });

  it('returns indirect for any tool outside DEVICE_COMPLETE_TARGET_TOOLS', async () => {
    const scope = await resolveIntentTargetScope(
      'manage_deployments',
      { targetType: 'all' },
      { deviceId: 'dev-1' },
      'org-1',
    );
    expect(scope).toEqual({ kind: 'indirect' });
    // Fails closed WITHOUT resolving anything from deviceArgs / the run device.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('throws on an unknown device id', async () => {
    queueDeviceSiteSelect([{ id: 'dev-1', siteId: 'site-1' }]);

    await expect(
      resolveIntentTargetScope('execute_command', { deviceId: 'dev-404' }, { deviceId: 'dev-1' }, 'org-1'),
    ).rejects.toThrow(/dev-404/);
  });

  it('pins the device read to the intent org so a cross-tenant device id fails like a nonexistent one', async () => {
    // Review finding 1: the system-scoped devices select MUST carry an org
    // predicate. Without it, an org-A proposal citing an existing org-B
    // device UUID would (a) silently pull the foreign device's site into the
    // fan-out scope and (b) act as a cross-tenant device-UUID existence
    // oracle (existing foreign id → intent created; nonexistent id → throw).
    // The queued row simulates Postgres filtering the foreign device out via
    // the org pin: only the in-org device comes back.
    const { where } = queueDeviceSiteSelect([{ id: 'dev-1', siteId: 'site-1' }]);

    await expect(
      resolveIntentTargetScope(
        'execute_command',
        { deviceId: 'dev-foreign' },
        { deviceId: 'dev-1' },
        'org-1',
      ),
    ).rejects.toThrow(/dev-foreign/);

    // Structural pin on the WHERE clause itself: ids restricted AND org
    // pinned — not just the inArray alone.
    expect(where).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledWith(
      and(inArray(devices.id as never, ['dev-foreign', 'dev-1']), eq(devices.orgId as never, 'org-1')),
    );
  });

  it('fails closed to indirect when no device id can be resolved at all', async () => {
    // A DEVICE_COMPLETE_TARGET_TOOLS tool with malformed/absent device args
    // AND a detached run (device_id NULL after a device move) must not yield
    // {kind:'devices', siteIds: []} — an empty site list would vacuously pass
    // every candidate's site check.
    const scope = await resolveIntentTargetScope('execute_command', {}, { deviceId: null }, 'org-1');
    expect(scope).toEqual({ kind: 'indirect' });
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('isAgentIntentDecideAuthorized', () => {
  const intent = {
    id: 'intent-1',
    orgId: 'org-1',
    actionName: 'execute_command',
    arguments: { deviceId: 'dev-1' } as Record<string, unknown>,
    requestingAgentRunId: 'run-1',
    // P2-2 (#4189): unscoped — every pre-existing case in this describe block
    // resolves its target from the RUN, exactly as before the scope columns
    // existed. The scoped cases live in the block below.
    scopeKind: null as 'device' | 'ticket' | null,
    scopeDeviceId: null as string | null,
    scopeTicketId: null as string | null,
  };

  /**
   * Select order: 1. run row (select().from(aiAgentRuns).where().limit()),
   * 2. org partner (select().from(organizations).where().limit()),
   * 3. device sites (select().from(devices).where()).
   */
  function queueDecideSelects(opts: {
    run: Array<{ orgId: string; deviceId: string | null }>;
    org?: Array<{ partnerId: string | null }>;
    deviceSites?: Array<{ id: string; siteId: string }>;
  }) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(opts.run) }),
      }),
    } as any);
    if (opts.org) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(opts.org) }),
        }),
      } as any);
    }
    if (opts.deviceSites) queueDeviceSiteSelect(opts.deviceSites);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(requiredPermissionsForTool).mockReturnValue(DEVICES_EXECUTE);
  });

  it('authorizes a user with the action permission and access to every target site', async () => {
    queueDecideSelects({
      run: [{ orgId: 'org-1', deviceId: 'dev-2' }],
      org: [{ partnerId: 'partner-1' }],
      deviceSites: [
        { id: 'dev-1', siteId: 'site-1' },
        { id: 'dev-2', siteId: 'site-1' },
      ],
    });
    stubPermsByUser({ 'u-a': makePerms({ allowedSiteIds: ['site-1'] }) });

    await expect(isAgentIntentDecideAuthorized('u-a', intent)).resolves.toBe(true);
  });

  it('denies a user whose site restriction misses a target site', async () => {
    queueDecideSelects({
      run: [{ orgId: 'org-1', deviceId: null }],
      org: [{ partnerId: 'partner-1' }],
      deviceSites: [{ id: 'dev-1', siteId: 'site-1' }],
    });
    stubPermsByUser({ 'u-b': makePerms({ allowedSiteIds: ['site-2'] }) });

    await expect(isAgentIntentDecideAuthorized('u-b', intent)).resolves.toBe(false);
  });

  it('fails closed when the intent has no requesting run', async () => {
    await expect(
      isAgentIntentDecideAuthorized('u-a', { ...intent, requestingAgentRunId: null }),
    ).resolves.toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('fails closed when the run does not exist or belongs to another org', async () => {
    queueDecideSelects({ run: [], org: [{ partnerId: 'partner-1' }] });
    await expect(isAgentIntentDecideAuthorized('u-a', intent)).resolves.toBe(false);
  });

  it('fails closed when the tool has no RBAC mapping', async () => {
    vi.mocked(requiredPermissionsForTool).mockReturnValue(null);
    await expect(isAgentIntentDecideAuthorized('u-a', intent)).resolves.toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('fails closed (false, not throw) when a cited device no longer exists', async () => {
    queueDecideSelects({
      run: [{ orgId: 'org-1', deviceId: null }],
      org: [{ partnerId: 'partner-1' }],
      deviceSites: [], // dev-1 has been deleted since the proposal was created
    });
    stubPermsByUser({ 'u-a': makePerms() });

    await expect(isAgentIntentDecideAuthorized('u-a', intent)).resolves.toBe(false);
  });

  it('pins the decide-time device read to the INTENT org (cross-tenant cited device fails closed)', async () => {
    // Review finding 1, decide-time leg: the device-site resolution must be
    // scoped to intent.orgId, so a cited device that exists in another tenant
    // is filtered out by the org pin and behaves exactly like a deleted one.
    queueDecideSelects({
      run: [{ orgId: 'org-1', deviceId: null }],
      org: [{ partnerId: 'partner-1' }],
    });
    // dev-1 exists — in ANOTHER org, so the org-pinned select returns nothing.
    const { where } = queueDeviceSiteSelect([]);
    stubPermsByUser({ 'u-a': makePerms() });

    await expect(isAgentIntentDecideAuthorized('u-a', intent)).resolves.toBe(false);
    expect(where).toHaveBeenCalledWith(
      and(inArray(devices.id as never, ['dev-1']), eq(devices.orgId as never, 'org-1')),
    );
  });

  // -------------------------------------------------------------------------
  // P2-2 (Task A3, #4189): explicit device scope
  // -------------------------------------------------------------------------

  const scopedIntent = { ...intent, scopeKind: 'device' as const, scopeDeviceId: 'dev-scope' };

  /** Scoped select order: 1. run, 2. org partner, 3. the scoped device's
   *  CURRENT org, 4. device sites. */
  function queueScopedDecideSelects(opts: {
    run?: Array<{ orgId: string; deviceId: string | null }>;
    scopedDevice?: Array<{ orgId: string }>;
    deviceSites?: Array<{ id: string; siteId: string }>;
  }) {
    queueDecideSelects({
      run: opts.run ?? [{ orgId: 'org-1', deviceId: null }],
      org: [{ partnerId: 'partner-1' }],
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(opts.scopedDevice ?? []) }),
      }),
    } as any);
    if (opts.deviceSites) queueDeviceSiteSelect(opts.deviceSites);
  }

  it('authorizes against the SCOPE device when the run has none', async () => {
    queueScopedDecideSelects({
      scopedDevice: [{ orgId: 'org-1' }],
      // The tool's own deviceArgs still resolve; the scope contributes
      // dev-scope, which the arguments must already match (creation-time
      // assertArgsMatchScope) — here both are seeded so the union is a
      // single site.
      deviceSites: [{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-scope', siteId: 'site-1' }],
    });
    stubPermsByUser({ 'u-a': makePerms({ allowedSiteIds: ['site-1'] }) });

    await expect(isAgentIntentDecideAuthorized('u-a', scopedIntent)).resolves.toBe(true);
  });

  it('fails closed for a tombstoned scope — without touching the DB at all', async () => {
    await expect(
      isAgentIntentDecideAuthorized('u-a', { ...scopedIntent, scopeDeviceId: null }),
    ).resolves.toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('fails closed when the scoped device no longer exists', async () => {
    queueScopedDecideSelects({ scopedDevice: [] });
    stubPermsByUser({ 'u-a': makePerms() });

    await expect(isAgentIntentDecideAuthorized('u-a', scopedIntent)).resolves.toBe(false);
  });

  it('fails closed when the scoped device now belongs to another org', async () => {
    // Controller ruling: the DB-side cascade org-move leaves scope_device_id
    // live; decide is one of the two backstops (release is the other).
    queueScopedDecideSelects({ scopedDevice: [{ orgId: 'org-2' }] });
    stubPermsByUser({ 'u-a': makePerms() });

    await expect(isAgentIntentDecideAuthorized('u-a', scopedIntent)).resolves.toBe(false);
  });
});

describe('DEVICE_COMPLETE_TARGET_TOOLS', () => {
  it('contains exactly the hand-verified mutating device tools', () => {
    expect([...DEVICE_COMPLETE_TARGET_TOOLS].sort()).toEqual([
      'execute_command',
      'manage_services',
      'run_script',
    ]);
  });
});
