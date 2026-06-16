/**
 * User delete / re-invite resurrection + login-hole proof (#1367).
 *
 * Drives the real DELETE /users/:id and POST /users/invite routes against the
 * real docker postgres as breeze_app, proving three things the unit tests
 * (Drizzle mocks) cannot:
 *
 *   1. Deleting a user's last membership NEUTRALIZES the orphaned `users` row
 *      (status='disabled', password_hash=NULL). This closes the security hole
 *      where a "deleted" user could still authenticate — login.ts bounces on
 *      a null password_hash / non-active status, so a tombstone can't log in.
 *
 *   2. Deleting ONE membership of a multi-membership user does NOT neutralize
 *      them. This is the correctness proof for running the orphan check under
 *      SYSTEM scope: an org-B admin's RLS view hides the user's org-A
 *      membership, so a request-scoped check would falsely report them
 *      orphaned and wrongly disable a still-active user.
 *
 *   3. Re-inviting the same email RESETS the tombstone to a clean invited
 *      state (status='invited', password_hash=NULL, new name) + a fresh
 *      membership — so the new invitee can set a password via the magic link
 *      instead of hitting "invite already accepted".
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

type AuthCtx = {
  scope: 'partner' | 'organization';
  partnerId: string | null;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  accessiblePartnerIds: string[] | null;
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
        partnerId: ctx.partnerId,
        orgId: ctx.orgId,
        accessibleOrgIds: ctx.accessibleOrgIds ?? [],
        user: { id: null, email: 'integration@test' },
      });
      return withDbAccessContext(
        {
          scope: ctx.scope,
          orgId: ctx.orgId,
          accessibleOrgIds: ctx.accessibleOrgIds,
          accessiblePartnerIds: ctx.accessiblePartnerIds,
          userId: null,
        },
        () => next(),
      );
    },
    hasSatisfiedMfa: () => true,
    requireMfa: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
  };
});

import { db, withSystemDbAccessContext } from '../../db';
import { users, partnerUsers, organizationUsers } from '../../db/schema';
import {
  createPartner,
  createOrganization,
  createRole,
  createUser,
  assignUserToPartner,
  assignUserToOrganization,
} from './db-utils';
import { getTestDb } from './setup';

async function buildApp() {
  const { userRoutes } = await import('../../routes/users');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/users', userRoutes);
  return app;
}

async function readUser(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

beforeEach(() => {
  activeAuthContext = null;
});

afterEach(() => {
  activeAuthContext = null;
  vi.clearAllMocks();
});

describe('user delete → neutralize orphan (#1367)', () => {
  it('neutralizes the orphaned users row when the last membership is deleted', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const target = await createUser({
      partnerId: partner.id,
      email: `orphan-${Date.now()}@example.com`,
      status: 'active',
    });
    await assignUserToPartner(target.id, partner.id, role.id);

    activeAuthContext = {
      scope: 'partner',
      partnerId: partner.id,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [partner.id],
    };

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    // The users row survives (FKs reference it) but is neutralized: disabled +
    // no password = cannot authenticate (the login hole is closed).
    const row = await readUser(target.id);
    expect(row.status).toBe('disabled');
    expect(row.passwordHash).toBeNull();
    expect(row.disabledReason).toBe('removed');

    // Membership is gone.
    const [link] = await getTestDb()
      .select({ id: partnerUsers.id })
      .from(partnerUsers)
      .where(eq(partnerUsers.userId, target.id))
      .limit(1);
    expect(link).toBeUndefined();
  });

  it('does NOT neutralize a multi-org user when only one membership is removed', async () => {
    // The correctness proof for the system-scoped orphan check: the deleting
    // admin (org B) cannot see the user's org-A membership under RLS, but the
    // user is still active there and must stay loginable.
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner.id });
    const target = await createUser({
      partnerId: partner.id,
      orgId: orgA.id,
      email: `multiorg-${Date.now()}@example.com`,
      status: 'active',
    });
    await assignUserToOrganization(target.id, orgA.id, role.id);
    await assignUserToOrganization(target.id, orgB.id, role.id);

    activeAuthContext = {
      scope: 'organization',
      partnerId: null,
      orgId: orgB.id,
      accessibleOrgIds: [orgB.id],
      accessiblePartnerIds: null,
    };

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    // Still active — org-A membership remains, so the row is NOT an orphan.
    const row = await readUser(target.id);
    expect(row.status).toBe('active');
    expect(row.passwordHash).not.toBeNull();

    // Only the org-B membership was removed; org-A survives.
    const remaining = await getTestDb()
      .select({ orgId: organizationUsers.orgId })
      .from(organizationUsers)
      .where(eq(organizationUsers.userId, target.id));
    expect(remaining.map((r) => r.orgId)).toEqual([orgA.id]);
  });
});

describe('user re-invite → resurrect tombstone (#1367)', () => {
  it('resets a neutralized tombstone to a clean invited state on re-invite', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const email = `revive-${Date.now()}@example.com`;

    // Seed a tombstone directly: the state a prior delete (or the backfill
    // migration) leaves behind — disabled, no password, no membership.
    const target = await createUser({
      partnerId: partner.id,
      email,
      name: 'Old Name',
      status: 'active',
    });
    await withSystemDbAccessContext(async () =>
      db
        .update(users)
        .set({ status: 'disabled', disabledReason: 'removed', passwordHash: null })
        .where(eq(users.id, target.id)),
    );

    activeAuthContext = {
      scope: 'partner',
      partnerId: partner.id,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [partner.id],
    };

    const app = await buildApp();
    const res = await app.request('/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: 'New Name', roleId: role.id, orgAccess: 'none' }),
    });
    expect(res.status).toBe(201);

    // Same row, resurrected cleanly so the magic-link set-password flow works
    // (accept-invite requires status='invited').
    const row = await readUser(target.id);
    expect(row.id).toBe(target.id);
    expect(row.status).toBe('invited');
    expect(row.passwordHash).toBeNull();
    expect(row.name).toBe('New Name');

    // A fresh membership was created.
    const [link] = await getTestDb()
      .select({ id: partnerUsers.id })
      .from(partnerUsers)
      .where(eq(partnerUsers.userId, target.id))
      .limit(1);
    expect(link).toBeDefined();
  });
});
