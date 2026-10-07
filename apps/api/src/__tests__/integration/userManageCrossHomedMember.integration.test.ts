/**
 * Org-admin member management for a member whose HOME org is elsewhere.
 *
 * A user's `users.org_id` names one home org, but they can hold memberships in
 * several orgs. Under an org-scoped RLS context the `users` SELECT policy only
 * exposes rows homed in the caller's org, so an org-B admin cannot read the
 * `users` row of a member homed in org A — yet that member is still org B's to
 * manage via the org-B `organization_users` row.
 *
 * Drives the real DELETE /users/:id and POST /users/:id/role routes as
 * breeze_app against real Postgres and proves:
 *   - an org-B admin can remove / re-role an org-B member homed in org A,
 *     touching only the org-B membership;
 *   - a role change advances the target's auth epoch and revokes their
 *     refresh families even though the admin cannot see the `users` row;
 *   - the rank and site-scope checks still refuse a lower-ranked or
 *     site-restricted admin for the same cross-homed member;
 *   - a user with no org-B membership stays 404 to the org-B admin.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

type AuthCtx = {
  scope: 'organization';
  orgId: string;
  userId: string;
};

let activeAuthContext: AuthCtx | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuthContext) return c.json({ error: 'Unauthorized' }, 401);
      const ctx = activeAuthContext;
      c.set('auth', {
        scope: ctx.scope,
        partnerId: null,
        orgId: ctx.orgId,
        accessibleOrgIds: [ctx.orgId],
        user: { id: ctx.userId, email: 'integration@test' },
      });
      return withDbAccessContext(
        {
          scope: ctx.scope,
          orgId: ctx.orgId,
          accessibleOrgIds: [ctx.orgId],
          accessiblePartnerIds: null,
          userId: ctx.userId,
        },
        () => next(),
      );
    },
    hasSatisfiedMfa: () => true,
    requireMfa: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
  };
});

import { users, organizationUsers, refreshTokenFamilies } from '../../db/schema';
import { userIsMfaProtected } from '../../routes/auth/helpers';
import {
  createPartner,
  createOrganization,
  createRole,
  createSite,
  createUser,
  assignUserToOrganization,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const ADMIN_PERMS = [
  { resource: 'users', action: 'read' },
  { resource: 'users', action: 'write' },
  { resource: 'users', action: 'delete' },
];

async function buildApp() {
  const { userRoutes } = await import('../../routes/users');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/users', userRoutes);
  return app;
}

async function readUser(id: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

async function membership(userId: string, orgId: string) {
  const [row] = await getTestDb()
    .select({ roleId: organizationUsers.roleId })
    .from(organizationUsers)
    .where(and(eq(organizationUsers.userId, userId), eq(organizationUsers.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Partner with org A (the target's home) and org B (the caller's org). The
 * target holds a membership in BOTH orgs; the caller is an org-B admin.
 */
async function seedCrossHomed(opts: { callerPerms?: typeof ADMIN_PERMS; targetPerms?: typeof ADMIN_PERMS } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });

  const callerRole = await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner.id, name: `caller-${suffix}` });
  await grantRolePermissions(callerRole.id, opts.callerPerms ?? ADMIN_PERMS);
  const targetRoleB = await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner.id, name: `target-b-${suffix}` });
  await grantRolePermissions(targetRoleB.id, opts.targetPerms ?? [{ resource: 'users', action: 'read' }]);
  const targetRoleA = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id, name: `target-a-${suffix}` });

  const caller = await createUser({ partnerId: partner.id, orgId: orgB.id, email: `caller-${suffix}@example.com`, status: 'active' });
  await assignUserToOrganization(caller.id, orgB.id, callerRole.id);

  const target = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `target-${suffix}@example.com`, status: 'active' });
  await assignUserToOrganization(target.id, orgA.id, targetRoleA.id);
  await assignUserToOrganization(target.id, orgB.id, targetRoleB.id);

  activeAuthContext = { scope: 'organization', orgId: orgB.id, userId: caller.id };
  return { partner, orgA, orgB, caller, callerRole, target, targetRoleA, targetRoleB };
}

beforeEach(() => {
  activeAuthContext = null;
});

afterEach(() => {
  activeAuthContext = null;
  vi.clearAllMocks();
});

describe('org admin manages a member homed in another org', () => {
  it('DELETE removes only the org-B membership of a member homed in org A', async () => {
    const { orgA, orgB, target, targetRoleA } = await seedCrossHomed();

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(await membership(target.id, orgB.id)).toBeNull();
    expect(await membership(target.id, orgA.id)).toEqual({ roleId: targetRoleA.id });
    expect((await readUser(target.id)).status).toBe('active');
  });

  it('POST /:id/role re-roles the org-B membership and cuts the target off from existing sessions', async () => {
    const { partner, orgA, orgB, target, targetRoleA } = await seedCrossHomed();
    const newRole = await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner.id, name: `new-${randomUUID().slice(0, 8)}` });
    const familyId = randomUUID();
    await getTestDb().insert(refreshTokenFamilies).values({
      familyId,
      userId: target.id,
      absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const before = await readUser(target.id);

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}/role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roleId: newRole.id }),
    });
    expect(res.status).toBe(200);

    expect(await membership(target.id, orgB.id)).toEqual({ roleId: newRole.id });
    expect(await membership(target.id, orgA.id)).toEqual({ roleId: targetRoleA.id });

    const after = await readUser(target.id);
    expect(after.authEpoch).toBeGreaterThan(before.authEpoch);
    const [family] = await getTestDb()
      .select({ revokedAt: refreshTokenFamilies.revokedAt })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId));
    expect(family?.revokedAt).not.toBeNull();
  });

  it('refuses a lower-ranked org-B admin for a cross-homed member holding a broader role', async () => {
    const { partner, orgA, orgB, target, targetRoleA, targetRoleB } = await seedCrossHomed({
      callerPerms: [{ resource: 'users', action: 'read' }],
      targetPerms: ADMIN_PERMS,
    });
    const newRole = await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner.id, name: `new-${randomUUID().slice(0, 8)}` });
    const app = await buildApp();

    const del = await app.request(`/users/${target.id}`, { method: 'DELETE' });
    expect(del.status).toBe(403);

    const role = await app.request(`/users/${target.id}/role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roleId: newRole.id }),
    });
    expect(role.status).toBe(403);

    expect(await membership(target.id, orgB.id)).toEqual({ roleId: targetRoleB.id });
    expect(await membership(target.id, orgA.id)).toEqual({ roleId: targetRoleA.id });
  });

  it('refuses a site-restricted org-B admin for an unrestricted cross-homed member', async () => {
    const { partner, orgB, caller, target, targetRoleB } = await seedCrossHomed();
    const site = await createSite({ orgId: orgB.id });
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [site.id] })
      .where(and(eq(organizationUsers.userId, caller.id), eq(organizationUsers.orgId, orgB.id)));
    const newRole = await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner.id, name: `new-${randomUUID().slice(0, 8)}` });
    const app = await buildApp();

    const del = await app.request(`/users/${target.id}`, { method: 'DELETE' });
    expect(del.status).toBe(403);

    const role = await app.request(`/users/${target.id}/role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roleId: newRole.id }),
    });
    expect(role.status).toBe(403);

    expect(await membership(target.id, orgB.id)).toEqual({ roleId: targetRoleB.id });
  });

  it('stays 404 for a user with no org-B membership', async () => {
    const { partner, orgA, orgB, targetRoleA } = await seedCrossHomed();
    const outsider = await createUser({
      partnerId: partner.id,
      orgId: orgA.id,
      email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
      status: 'active',
    });
    await assignUserToOrganization(outsider.id, orgA.id, targetRoleA.id);
    const newRole = await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner.id, name: `new-${randomUUID().slice(0, 8)}` });
    const app = await buildApp();

    const del = await app.request(`/users/${outsider.id}`, { method: 'DELETE' });
    expect(del.status).toBe(404);

    const role = await app.request(`/users/${outsider.id}/role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roleId: newRole.id }),
    });
    expect(role.status).toBe(404);

    expect(await membership(outsider.id, orgA.id)).toEqual({ roleId: targetRoleA.id });
    expect(await membership(outsider.id, orgB.id)).toBeNull();
  });

  it('POST /:id/mfa/reset resets a cross-homed org-B member', async () => {
    const { target } = await seedCrossHomed();
    await getTestDb().update(users).set({ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'enc:seeded' }).where(eq(users.id, target.id));
    const before = await readUser(target.id);

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}/mfa/reset`, { method: 'POST' });
    expect(res.status).toBe(200);

    expect(await userIsMfaProtected(target.id)).toBe(false);
    const after = await readUser(target.id);
    expect(after.mfaSecret).toBeNull();
    expect(after.mfaEpoch).toBeGreaterThan(before.mfaEpoch);
  });

  it('POST /:id/mfa/reset refuses a lower-ranked org-B admin for a cross-homed member', async () => {
    const { target } = await seedCrossHomed({
      callerPerms: [{ resource: 'users', action: 'read' }],
      targetPerms: ADMIN_PERMS,
    });
    await getTestDb().update(users).set({ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'enc:seeded' }).where(eq(users.id, target.id));

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}/mfa/reset`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await readUser(target.id)).mfaSecret).toBe('enc:seeded');
  });

  it('POST /:id/mfa/reset stays 404 for a user with no org-B membership', async () => {
    const { partner, orgA, targetRoleA } = await seedCrossHomed();
    const outsider = await createUser({
      partnerId: partner.id,
      orgId: orgA.id,
      email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
      status: 'active',
    });
    await assignUserToOrganization(outsider.id, orgA.id, targetRoleA.id);
    await getTestDb().update(users).set({ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'enc:seeded' }).where(eq(users.id, outsider.id));

    const app = await buildApp();
    const res = await app.request(`/users/${outsider.id}/mfa/reset`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await readUser(outsider.id)).mfaSecret).toBe('enc:seeded');
  });
});
