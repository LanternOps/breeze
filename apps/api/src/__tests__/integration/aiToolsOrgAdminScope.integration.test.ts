/**
 * Integration test — W18 PR A (#6789): the org admin and identity read tools honour the routers' gates and the
 * tenant axis against real Postgres as the unprivileged `breeze_app` role.
 *
 * Entry point: `executeTool`, so the production dispatch runs (TOOL_PERMISSIONS floor included). Proven:
 *   - list_users: a partner member with orgAccess 'selected' is refused (the userRoutes gate moved into the shared
 *     operation); CONTROL: the same partner's 'all' member lists, and only that partner's members;
 *   - list_roles: another partner's custom role is never listed, and reading it by id is not found; CONTROL: the
 *     caller's own custom role is listed and readable;
 *   - get_org_summary: another partner's org is the same not-found as a missing one; CONTROL: an own org reads;
 *   - list_portal_users: a real row with a password hash returns no hash bytes.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { executeTool } from '../../services/aiTools';
import { clearPermissionCache } from '../../services/permissions';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
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

async function run(tool: string, input: Record<string, unknown>, auth: AuthContext) {
  const context = buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id,
  });
  const raw = await withDbAccessContext(context, () => executeTool(tool, input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

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

  const [portalUser] = await getTestDb().insert(portalUsers).values({
    orgId: orgA.id, email: `w18-portal-${randomUUID()}@example.com`, name: 'Portal Person', passwordHash: HASH_SENTINEL,
    authMethod: 'password', status: 'active',
  }).returning({ id: portalUsers.id });

  return {
    partner, other, orgA, orgB, orgOther, role, otherRole, full, selected, foreign, portalUserId: portalUser!.id,
    auth: {
      full: partnerAuth(full.id, partner.id, [orgA.id, orgB.id], 'all'),
      selected: partnerAuth(selected.id, partner.id, [orgA.id], 'selected'),
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
