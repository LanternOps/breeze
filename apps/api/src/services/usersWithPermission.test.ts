import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PERMISSION_GRANTS as PERMISSIONS } from '@breeze/shared';

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
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
  users: { id: 'id', status: 'status' },
}));

import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { resolvePartnerUsersWithPermission, resolveUsersWithPermissionForOrg } from './usersWithPermission';

const dialect = new PgDialect();

// Captures the `where(...)` argument passed to the granting-roles query (the
// first select issued), keyed by call order, so `renderedWhere` can compile it
// to real parameterized SQL — asserting the compiled query, not object
// identity (see intentApprovers.test.ts, which this file's mock scaffolding
// mirrors).
let roleWhereArgs: unknown[] = [];

function mockGrantingRoles(rows: Array<{ roleId: string }>) {
  const where = vi.fn().mockImplementation((arg: unknown) => {
    roleWhereArgs.push(arg);
    return Promise.resolve(rows);
  });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where }),
    }),
  } as any);
}

function mockOrg(row: { partnerId: string | null }) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([row]) }),
    }),
  } as any);
}

function mockOrgMembers(rows: Array<{ userId: string }>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any);
}

let partnerWhereArgs: unknown[] = [];

function mockPartnerMembers(rows: Array<{ userId: string; orgAccess: string; orgIds: string[] | null }>) {
  const where = vi.fn().mockImplementation((arg: unknown) => {
    partnerWhereArgs.push(arg);
    return Promise.resolve(rows);
  });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where }),
    }),
  } as any);
}

function renderedWhere(index: number): string {
  const arg = roleWhereArgs[index];
  const { sql, params } = dialect.sqlToQuery(arg as never);
  return `${sql} ${JSON.stringify(params)}`;
}

describe('resolveUsersWithPermissionForOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    // `clearAllMocks` clears calls but KEEPS implementations, so a scope pinned
    // by one test would leak into the next. Reset the ambient scope explicitly.
    vi.mocked(getCurrentDbAccessContext).mockReturnValue(undefined);
    roleWhereArgs = [];
    partnerWhereArgs = [];
  });

  it('matches wildcard grants (*:*) for billing:manage', async () => {
    mockGrantingRoles([{ roleId: 'r-super' }]);
    mockOrg({ partnerId: 'p1' });
    mockOrgMembers([]);
    mockPartnerMembers([{ userId: 'u-admin', orgAccess: 'all', orgIds: null }]);
    await expect(resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE)).resolves.toEqual(['u-admin']);
  });

  it('excludes partner users whose selected org list does not cover the org', async () => {
    mockGrantingRoles([{ roleId: 'r1' }]);
    mockOrg({ partnerId: 'p1' });
    mockOrgMembers([]);
    mockPartnerMembers([{ userId: 'u-other', orgAccess: 'selected', orgIds: ['org2'] }]);
    await expect(resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE)).resolves.toEqual([]);
  });

  it('returns [] when no role grants the permission', async () => {
    mockGrantingRoles([]);
    await expect(resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE)).resolves.toEqual([]);
  });

  it('renders the permission pair into the role query', async () => {
    mockGrantingRoles([]);
    await resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE);
    expect(renderedWhere(0)).toContain('billing');
    expect(renderedWhere(0)).toContain('manage');
  });

  // W02 finding #3: `withSystemDbAccessContext` is a PASSTHROUGH when a context
  // already exists (db/index.ts) — under an org-scoped request context the
  // partner_users read (Shape 3, partner-axis RLS) silently returns ZERO rows
  // and every partner admin drops out of the result. The escape must be taken
  // explicitly, exactly like `readWithPartnerAxisVisibility`.
  it('escapes an org-scoped ambient context before reading partner_users (finding #3)', async () => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValue({ scope: 'organization' } as never);
    mockGrantingRoles([]);

    await resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE);

    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('does NOT escape when the ambient context is already system-scoped (finding #3)', async () => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValue({ scope: 'system' } as never);
    mockGrantingRoles([]);

    await resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE);

    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});

describe('resolvePartnerUsersWithPermission', () => {
  const PERM = { resource: 'connected_apps', action: 'manage' };
  const rows = [
    { userId: 'u1', orgAccess: 'all', orgIds: null },
    { userId: 'u2', orgAccess: 'selected', orgIds: ['A'] },
    { userId: 'u3', orgAccess: 'selected', orgIds: ['B'] },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(getCurrentDbAccessContext).mockReturnValue(undefined);
    roleWhereArgs = [];
    partnerWhereArgs = [];
  });

  it('partner-wide: only orgAccess=all partner users', async () => {
    mockGrantingRoles([{ roleId: 'r1' }]);
    mockPartnerMembers(rows);
    await expect(resolvePartnerUsersWithPermission('P', PERM)).resolves.toEqual(['u1']);
  });

  it('org-scoped: all + selected covering the org; never org members', async () => {
    mockGrantingRoles([{ roleId: 'r1' }]);
    mockPartnerMembers(rows);
    const out = await resolvePartnerUsersWithPermission('P', PERM, { orgId: 'A' });
    expect(out.sort()).toEqual(['u1', 'u2']);
    // roles query + partner_users query only: no organizations / organization_users lookups
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('returns [] and skips the partner query when no role grants the permission', async () => {
    mockGrantingRoles([]);
    await expect(resolvePartnerUsersWithPermission('P', PERM)).resolves.toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('escapes an org-scoped ambient context before reading', async () => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValue({ scope: 'organization' } as any);
    mockGrantingRoles([]);
    await resolvePartnerUsersWithPermission('P', PERM);
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('partner query pins partner, granting roles and active status', async () => {
    mockGrantingRoles([{ roleId: 'role-aaa' }, { roleId: 'role-bbb' }]);
    mockPartnerMembers([]);
    await resolvePartnerUsersWithPermission('partner-xyz', PERM);
    const { sql, params } = dialect.sqlToQuery(partnerWhereArgs[0] as never);
    // schema mock uses plain strings for columns, so they render as params
    expect(sql).toBe('($1 = $2 and $3 in ($4, $5) and $6 = $7)');
    expect(params).toEqual(['partner_id', 'partner-xyz', 'role_id', 'role-aaa', 'role-bbb', 'status', 'active']);
  });

  it('skips the escape when the ambient scope is already system', async () => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValue({ scope: 'system' } as any);
    mockGrantingRoles([]);
    await resolvePartnerUsersWithPermission('P', PERM);
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it('wildcard-aware role query', async () => {
    mockGrantingRoles([]);
    await resolvePartnerUsersWithPermission('P', PERM);
    expect(renderedWhere(0)).toContain('connected_apps');
    expect(renderedWhere(0)).toContain('*');
  });
});
