/**
 * Integration test — W18 PR A (#6789): the org admin and identity read tools honour the routers' gates and the
 * tenant axis against real Postgres as the unprivileged `breeze_app` role.
 *
 * Entry point: `executeTool`, the production dispatch. The TOOL_PERMISSIONS floor is `checkToolPermission`, which chat
 * (aiAgentSdk) and MCP (mcpServer) enter BEFORE dispatch, so its case calls that function directly. Proven:
 *   - list_users: a partner member with orgAccess 'selected' is refused (the userRoutes gate moved into the shared
 *     operation); CONTROL: the same partner's 'all' member lists, and only that partner's members;
 *   - list_roles: another partner's custom role is never listed, and reading it by id is not found; CONTROL: the
 *     caller's own custom role is listed and readable;
 *   - get_org_summary: another partner's org is the same not-found as a missing one; CONTROL: an own org reads;
 *   - list_portal_users: a real row with a password hash returns no hash bytes; get_user and list_roles users return
 *     no bytes of a real users.password_hash either;
 *   - get_account_readiness: the default set and explicit ids stay inside the caller's allowlist and partner;
 *   - per-section grants come from the real permission set; TOOL_PERMISSIONS refuses a caller without the base grant;
 *   - organization scope: get_audit_retention reaches only its own org, and the partner reads refuse it.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import { portalUsers, users } from '../../db/schema';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { checkToolPermission } from '../../services/aiGuardrails';
import { executeTool } from '../../services/aiTools';
import { clearPermissionCache } from '../../services/permissions';
import { assignUserToOrganization, assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { getTestDb } from './setup';

const HASH_SENTINEL = '$argon2id$v=19$m=65536,t=3,p=4$W18-PORTAL-HASH-SENTINEL';
const GRANTS = [
  { resource: 'users', action: 'read' },
  { resource: 'organizations', action: 'read' },
];

function partnerAuth(userId: string, partnerId: string, orgIds: string[], partnerOrgAccess: 'all' | 'selected'): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'fixture-operator@example.com', name: 'Fixture Operator', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    scope: 'partner', orgId: null, partnerId, partnerOrgAccess, accessibleOrgIds: orgIds,
    orgCondition: (column: Parameters<typeof inArray>[0]) => inArray(column, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id), canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: randomUUID() },
  } as unknown as AuthContext;
}

function orgAuth(userId: string, partnerId: string, orgId: string): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'fixture-org-admin@example.com', name: 'Fixture Org Admin', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    scope: 'organization', orgId, partnerId, accessibleOrgIds: [orgId],
    orgCondition: (column: Parameters<typeof eq>[0]) => eq(column, orgId),
    canAccessOrg: (id: string) => id === orgId, canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: randomUUID() },
  } as unknown as AuthContext;
}

function contextOf(auth: AuthContext) {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id,
  });
}

async function run(tool: string, input: Record<string, unknown>, auth: AuthContext) {
  const raw = await withDbAccessContext(contextOf(auth), () => executeTool(tool, input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

const floor = (tool: string, input: Record<string, unknown>, auth: AuthContext) =>
  withDbAccessContext(contextOf(auth), () => checkToolPermission(tool, input, auth));

async function seed() {
  const partner = await createPartner();
  const other = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const orgOther = await createOrganization({ partnerId: other.id });

  const role = await createRole({ scope: 'partner', partnerId: partner.id, name: `W18 custom ${randomUUID()}` });
  const otherRole = await createRole({ scope: 'partner', partnerId: other.id, name: `W18 foreign ${randomUUID()}` });
  await grantRolePermissions(role.id, GRANTS);
  await grantRolePermissions(otherRole.id, GRANTS);

  const full = await createUser({ partnerId: partner.id, email: `w18-full-${randomUUID()}@example.com` });
  const selected = await createUser({ partnerId: partner.id, email: `w18-selected-${randomUUID()}@example.com` });
  const foreign = await createUser({ partnerId: other.id, email: `w18-foreign-${randomUUID()}@example.com` });
  await assignUserToPartner(full.id, partner.id, role.id, 'all');
  await assignUserToPartner(selected.id, partner.id, role.id, 'selected');
  await assignUserToPartner(foreign.id, other.id, otherRole.id, 'all');

  // Holds the section grants the base role lacks: the CONTROL for the per-section checks.
  const wideRole = await createRole({ scope: 'partner', partnerId: partner.id, name: `W18 wide ${randomUUID()}` });
  await grantRolePermissions(wideRole.id, [...GRANTS, { resource: 'devices', action: 'read' }, { resource: 'audit', action: 'read' }]);
  const wide = await createUser({ partnerId: partner.id, email: `w18-wide-${randomUUID()}@example.com` });
  await assignUserToPartner(wide.id, partner.id, wideRole.id, 'all');
  // Lacks users:read, so TOOL_PERMISSIONS must refuse the identity reads.
  const orgsOnlyRole = await createRole({ scope: 'partner', partnerId: partner.id, name: `W18 orgs only ${randomUUID()}` });
  await grantRolePermissions(orgsOnlyRole.id, [{ resource: 'organizations', action: 'read' }]);
  const orgsOnly = await createUser({ partnerId: partner.id, email: `w18-orgs-only-${randomUUID()}@example.com` });
  await assignUserToPartner(orgsOnly.id, partner.id, orgsOnlyRole.id, 'all');
  // An organization-scoped admin of org A.
  const orgRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id, name: `W18 org ${randomUUID()}` });
  await grantRolePermissions(orgRole.id, [...GRANTS, { resource: 'audit', action: 'read' }]);
  const orgAdmin = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w18-org-${randomUUID()}@example.com` });
  await assignUserToOrganization(orgAdmin.id, orgA.id, orgRole.id);

  const [portalUser] = await getTestDb().insert(portalUsers).values({
    orgId: orgA.id, email: `w18-portal-${randomUUID()}@example.com`, name: 'Portal Person', passwordHash: HASH_SENTINEL,
    authMethod: 'password', status: 'active',
  }).returning({ id: portalUsers.id });

  return {
    partner, other, orgA, orgB, orgOther, role, otherRole, full, selected, foreign, portalUserId: portalUser!.id,
    auth: {
      full: partnerAuth(full.id, partner.id, [orgA.id, orgB.id], 'all'),
      selected: partnerAuth(selected.id, partner.id, [orgA.id], 'selected'),
      wide: partnerAuth(wide.id, partner.id, [orgA.id, orgB.id], 'all'),
      orgsOnly: partnerAuth(orgsOnly.id, partner.id, [orgA.id, orgB.id], 'all'),
      orgAdmin: orgAuth(orgAdmin.id, partner.id, orgA.id),
    },
  };
}

let f: Awaited<ReturnType<typeof seed>>;
beforeEach(async () => {
  clearPermissionCache();
  f = await seed();
});

describe('list_users / get_user: the full-partner-membership gate', () => {
  it("a 'selected' partner member is refused; CONTROL: the 'all' member lists only this partner's logins", async () => {
    const refused = await run('list_users', {}, f.auth.selected);
    expect(refused.body.code, refused.raw).toBe('FORBIDDEN');
    expect(refused.body.users).toBeUndefined();
    expect(refused.raw).not.toContain(f.full.email);

    const listed = await run('list_users', {}, f.auth.full);
    const ids = (listed.body.users as { id: string }[] | undefined)?.map((u) => u.id) ?? [];
    expect(ids, listed.raw).toEqual(expect.arrayContaining([f.full.id, f.selected.id]));
    expect(ids).not.toContain(f.foreign.id);
    expect(listed.raw).not.toContain('passwordHash');
  });

  it("get_user: another partner's login is not found; a 'selected' member is refused; CONTROL: own login reads", async () => {
    const foreign = await run('get_user', { userId: f.foreign.id }, f.auth.full);
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
    const refused = await run('get_user', { userId: f.full.id }, f.auth.selected);
    expect(refused.body.code, refused.raw).toBe('FORBIDDEN');
    const own = await run('get_user', { userId: f.selected.id }, f.auth.full);
    expect(own.body.id, own.raw).toBe(f.selected.id);
    expect(own.body.orgAccess).toBe('selected');
  });
});

describe('list_roles: the partner axis', () => {
  it("never lists another partner's custom role; CONTROL: the caller's own custom role is listed", async () => {
    const listed = await run('list_roles', { action: 'list' }, f.auth.full);
    const ids = (listed.body.roles as { id: string }[] | undefined)?.map((r) => r.id) ?? [];
    expect(ids, listed.raw).toContain(f.role.id);
    expect(ids).not.toContain(f.otherRole.id);
  });

  it("reading another partner's role by id is not found; CONTROL: own role reads with its member count", async () => {
    const foreign = await run('list_roles', { action: 'get', roleId: f.otherRole.id }, f.auth.full);
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
    const own = await run('list_roles', { action: 'get', roleId: f.role.id }, f.auth.full);
    expect(own.body.id, own.raw).toBe(f.role.id);
    expect(own.body.userCount).toBe(2);
  });

  it("a 'selected' partner member is refused before any role is read", async () => {
    const refused = await run('list_roles', { action: 'list' }, f.auth.selected);
    expect(refused.body.code, refused.raw).toBe('FORBIDDEN');
  });
});

describe('get_org_summary: the org axis', () => {
  it("another partner's org and a missing org are the same not-found; CONTROL: an own org reads", async () => {
    const foreign = await run('get_org_summary', { orgId: f.orgOther.id }, f.auth.full);
    const missing = await run('get_org_summary', { orgId: randomUUID() }, f.auth.full);
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
    expect(foreign.raw).toBe(missing.raw);
    const own = await run('get_org_summary', { orgId: f.orgA.id }, f.auth.full);
    expect(own.body.orgId, own.raw).toBe(f.orgA.id);
    expect(own.body.sites).toEqual({ count: 0 });
  });
});

describe('list_portal_users: no credential bytes', () => {
  it('a real row with a password hash returns no hash; CONTROL: the row is returned', async () => {
    const listed = await run('list_portal_users', { orgId: f.orgA.id }, f.auth.full);
    expect((listed.body.data as { id: string }[] | undefined)?.map((u) => u.id), listed.raw).toContain(f.portalUserId);
    expect(listed.raw).not.toContain('W18-PORTAL-HASH-SENTINEL');
    expect(listed.raw).not.toContain('argon2');
    expect(listed.body.data[0].effectiveStatus).toBe('active');

    const foreign = await run('list_portal_users', { orgId: f.orgOther.id }, f.auth.full);
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
  });
});

describe('credential bytes on the identity reads', () => {
  it('get_user and list_roles users return no bytes of a real users.password_hash; CONTROL: the row is returned', async () => {
    const [row] = await getTestDb().select({ hash: users.passwordHash }).from(users).where(eq(users.id, f.selected.id));
    expect(row?.hash, 'fixture must carry a real hash').toBeTruthy();

    const one = await run('get_user', { userId: f.selected.id }, f.auth.full);
    expect(one.body.id, one.raw).toBe(f.selected.id);
    expect(one.raw).not.toContain(row!.hash!);

    const members = await run('list_roles', { action: 'users', roleId: f.role.id }, f.auth.full);
    expect((members.body.users as { id: string }[]).map((u) => u.id), members.raw).toEqual(expect.arrayContaining([f.full.id, f.selected.id]));
    expect(members.raw).not.toContain(row!.hash!);

    const listed = await run('list_users', {}, f.auth.full);
    expect(listed.raw).not.toContain(row!.hash!);
  });
});

describe('list_roles: every action on the foreign axis', () => {
  it("another partner's role is not found for users and effective_permissions; CONTROL: own role reads", async () => {
    for (const action of ['users', 'effective_permissions']) {
      const foreign = await run('list_roles', { action, roleId: f.otherRole.id }, f.auth.full);
      expect(foreign.body.code, `${action}: ${foreign.raw}`).toBe('NOT_FOUND');
      expect(foreign.raw).not.toContain(f.foreign.email);
    }
    const own = await run('list_roles', { action: 'effective_permissions', roleId: f.role.id }, f.auth.full);
    expect(own.body.roleId, own.raw).toBe(f.role.id);
    expect((own.body.permissions as { resource: string }[]).map((p) => p.resource)).toContain('users');
  });

  it("a foreign org named in orgId is refused on all four actions; CONTROL: an own org lists", async () => {
    for (const input of [
      { action: 'list' },
      { action: 'get', roleId: f.role.id },
      { action: 'users', roleId: f.role.id },
      { action: 'effective_permissions', roleId: f.role.id },
    ]) {
      const refused = await run('list_roles', { ...input, orgId: f.orgOther.id }, f.auth.full);
      expect(refused.body.code, `${input.action}: ${refused.raw}`).toBe('NOT_FOUND');
    }
    const own = await run('list_roles', { action: 'list', orgId: f.orgA.id }, f.auth.full);
    expect((own.body.roles as { id: string }[]).map((r) => r.id), own.raw).toContain(f.role.id);
  });
});

describe('get_account_readiness: the allowlist and the partner', () => {
  it('the default set holds only the caller\'s reachable orgs; CONTROL: a full member sees both, never another partner\'s', async () => {
    const selected = await run('get_account_readiness', {}, f.auth.selected);
    expect((selected.body.orgs as { orgId: string }[]).map((o) => o.orgId), selected.raw).toEqual([f.orgA.id]);
    expect(selected.body.truncated).toBe(false);

    const full = await run('get_account_readiness', {}, f.auth.full);
    const ids = (full.body.orgs as { orgId: string }[]).map((o) => o.orgId);
    expect(ids, full.raw).toEqual(expect.arrayContaining([f.orgA.id, f.orgB.id]));
    expect(ids).not.toContain(f.orgOther.id);
  });

  it('explicit ids outside the allowlist or partner are named in notFound and return no data', async () => {
    const out = await run('get_account_readiness', { orgIds: [f.orgA.id, f.orgB.id, f.orgOther.id] }, f.auth.selected);
    expect((out.body.orgs as { orgId: string }[]).map((o) => o.orgId), out.raw).toEqual([f.orgA.id]);
    expect([...(out.body.notFound as string[])].sort()).toEqual([f.orgB.id, f.orgOther.id].sort());
  });
});

describe('per-section grants and the permission floor', () => {
  it('a caller without the section grants gets no section; CONTROL: a role holding them does', async () => {
    const narrow = await run('get_org_summary', { orgId: f.orgA.id }, f.auth.full);
    expect(narrow.body.orgId, narrow.raw).toBe(f.orgA.id);
    for (const key of ['devices', 'alerts', 'tickets', 'contracts', 'invoices', 'lastActivityAt']) {
      expect(Object.keys(narrow.body), key).not.toContain(key);
    }
    const wide = await run('get_org_summary', { orgId: f.orgA.id }, f.auth.wide);
    expect(wide.body.devices, wide.raw).toEqual({ total: 0, online: 0, offline: 0 });
    expect(Object.keys(wide.body)).toContain('lastActivityAt');
    expect(Object.keys(wide.body)).not.toContain('invoices');
  });

  it('checkToolPermission refuses the identity reads without users:read; CONTROL: the same caller passes on organizations:read, and a users:read holder passes', async () => {
    for (const [tool, input] of [['list_users', {}], ['get_user', { userId: f.full.id }], ['list_roles', { action: 'list' }]] as const) {
      expect(await floor(tool, input, f.auth.orgsOnly), tool).toBeTruthy();
      expect(await floor(tool, input, f.auth.full), `${tool} control`).toBeNull();
    }
    expect(await floor('get_org_summary', { orgId: f.orgA.id }, f.auth.orgsOnly)).toBeNull();
    expect(await floor('list_portal_users', { orgId: f.orgA.id }, f.auth.orgsOnly)).toBeNull();
    // audit:read is get_audit_retention's floor: the base role lacks it, the wide role holds it.
    expect(await floor('get_audit_retention', { orgId: f.orgA.id }, f.auth.full)).toBeTruthy();
    expect(await floor('get_audit_retention', { orgId: f.orgA.id }, f.auth.wide)).toBeNull();
  });
});

describe('organization scope', () => {
  it('get_audit_retention reaches only its own org; CONTROL: its own org reads', async () => {
    const own = await run('get_audit_retention', {}, f.auth.orgAdmin);
    expect(own.body.orgId, own.raw).toBe(f.orgA.id);
    expect(typeof own.body.retentionDays).toBe('number');
    const sibling = await run('get_audit_retention', { orgId: f.orgB.id }, f.auth.orgAdmin);
    expect(sibling.body.code, sibling.raw).toBe('NOT_FOUND');
  });

  it('the partner reads refuse it; list_users shows only its own org members', async () => {
    for (const [tool, input] of [
      ['get_org_summary', { orgId: f.orgA.id }],
      ['get_account_readiness', {}],
      ['list_portal_users', { orgId: f.orgA.id }],
    ] as const) {
      const refused = await run(tool, input, f.auth.orgAdmin);
      expect(refused.body.code, `${tool}: ${refused.raw}`).toBe('PARTNER_SCOPE_REQUIRED');
    }
    const listed = await run('list_users', {}, f.auth.orgAdmin);
    const ids = (listed.body.users as { id: string }[] | undefined)?.map((u) => u.id) ?? [];
    expect(ids, listed.raw).toContain(f.auth.orgAdmin.user.id);
    expect(ids).not.toContain(f.full.id);
  });
});
