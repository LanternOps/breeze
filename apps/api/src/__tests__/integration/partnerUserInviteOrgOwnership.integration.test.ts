/**
 * POST /users/invite (partner scope, orgAccess:'selected') must validate at
 * WRITE time that every supplied orgId is an organization of the caller's
 * partner. The ids are persisted verbatim into partner_users.org_ids and
 * become the invitee's organization allowlist; downstream resolution
 * re-scopes by partner, but a foreign id must never be stored (defense in
 * depth + data integrity). POST /users/resend-invite applies the same
 * rank + site-scope check to the pending invite as other member management
 * (role ceiling, and site reach for a site-restricted caller). Real driver,
 * unprivileged breeze_app role — the only substituted boundary is outbound
 * mail.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { organizationUsers, partnerUsers, users } from '../../db/schema';
import { userRoutes } from '../../routes/users';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
  setupTestEnvironment,
} from './db-utils';
import { getTestDb, getTestRedis } from './setup';

const mail = vi.hoisted(() => ({ sendInvite: vi.fn(async () => undefined) }));
vi.mock('../../services/email', () => ({ getEmailService: () => mail }));

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function fixture() {
  const env = await setupTestEnvironment({
    scope: 'partner',
    userOptions: { mfaEnabled: true },
    rolePermissions: [{ resource: 'users', action: 'invite' }],
  });
  const mine = env.organization;
  const sibling = await createOrganization({ partnerId: env.partner.id });
  const otherPartner = await createPartner();
  const theirs = await createOrganization({ partnerId: otherPartner.id });
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null,
    partnerId: env.partner.id, scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/users', userRoutes);
  const invite = async (email: string, orgIds: string[]) => app.request('/users/invite', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: 'Synthetic invitee', roleId: env.role.id, orgAccess: 'selected', orgIds }),
  });
  const inviteeRows = async (email: string) => {
    const userRows = await getTestDb().select({ id: users.id }).from(users).where(eq(users.email, email));
    const links = userRows.length
      ? await getTestDb().select({ orgIds: partnerUsers.orgIds, partnerId: partnerUsers.partnerId })
          .from(partnerUsers).where(eq(partnerUsers.userId, userRows[0]!.id))
      : [];
    return { userRows, links };
  };
  return { env, mine, sibling, theirs, invite, inviteeRows, app, token };
}

beforeEach(() => { mail.sendInvite.mockReset(); mail.sendInvite.mockResolvedValue(undefined); });

describe('POST /users/invite — selected org list is bounded to the caller partner', () => {
  runDb('rejects an org of another partner with 403 and writes nothing (no user row, no link, no mail)', async () => {
    const fx = await fixture();
    const email = `foreign-${randomUUID()}@example.test`;

    const res = await fx.invite(email, [fx.mine.id, fx.theirs.id]);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/organization/i);
    const { userRows, links } = await fx.inviteeRows(email);
    expect(userRows).toEqual([]);
    expect(links).toEqual([]);
    expect(mail.sendInvite).not.toHaveBeenCalled();
  });

  runDb('rejects an org id that does not exist with the same 403 (no existence oracle)', async () => {
    const fx = await fixture();
    const email = `ghost-${randomUUID()}@example.test`;

    const res = await fx.invite(email, [randomUUID()]);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/organization/i);
    expect((await fx.inviteeRows(email)).userRows).toEqual([]);
  });

  runDb('accepts in-partner orgs and persists exactly that (deduplicated) list', async () => {
    const fx = await fixture();
    const email = `owned-${randomUUID()}@example.test`;

    const res = await fx.invite(email, [fx.mine.id, fx.sibling.id, fx.mine.id]);

    expect(res.status).toBe(201);
    const { links } = await fx.inviteeRows(email);
    expect(links).toHaveLength(1);
    expect(links[0]!.partnerId).toBe(fx.env.partner.id);
    expect([...(links[0]!.orgIds ?? [])].sort()).toEqual([fx.mine.id, fx.sibling.id].sort());
    expect(mail.sendInvite).toHaveBeenCalledOnce();
  });
});

describe('POST /users/resend-invite — applies the same role check as creating an invite', () => {
  async function resendFixture() {
    const fx = await fixture();
    const pendingInvite = async (rolePerms: Array<{ resource: string; action: string }>) => {
      const role = await createRole({ scope: 'partner', partnerId: fx.env.partner.id });
      await grantRolePermissions(role.id, rolePerms);
      const invitee = await createUser({
        partnerId: fx.env.partner.id,
        email: `pending-${randomUUID()}@example.test`,
        status: 'invited',
      });
      await assignUserToPartner(invitee.id, fx.env.partner.id, role.id, 'none');
      return invitee;
    };
    const resend = (userId: string) => fx.app.request('/users/resend-invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fx.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    return { ...fx, pendingInvite, resend };
  }

  runDb('refuses a pending invite whose role the caller may not assign: 403, no token, no mail', async () => {
    const fx = await resendFixture();
    const invitee = await fx.pendingInvite([
      { resource: 'users', action: 'invite' },
      { resource: 'users', action: 'delete' },
    ]);

    const res = await fx.resend(invitee.id);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/not held by caller: users:delete/);
    expect(mail.sendInvite).not.toHaveBeenCalled();
    expect(await getTestRedis().get(`invite-user:${invitee.id}`)).toBeNull();
  });

  runDb('resends a pending invite whose role the caller may assign', async () => {
    const fx = await resendFixture();
    const invitee = await fx.pendingInvite([{ resource: 'users', action: 'invite' }]);

    const res = await fx.resend(invitee.id);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
    expect(mail.sendInvite).toHaveBeenCalledOnce();
    expect(await getTestRedis().get(`invite-user:${invitee.id}`)).toBeTruthy();
  });
});

describe('POST /users/resend-invite — a site-restricted caller is held to its own sites', () => {
  async function orgFixture() {
    const env = await setupTestEnvironment({
      scope: 'organization',
      userOptions: { mfaEnabled: true },
      rolePermissions: [{ resource: 'users', action: 'invite' }],
    });
    const otherSite = await createSite({ orgId: env.organization.id });
    const setSites = (userId: string, siteIds: string[]) => getTestDb()
      .update(organizationUsers)
      .set({ siteIds })
      .where(and(eq(organizationUsers.orgId, env.organization.id), eq(organizationUsers.userId, userId)));
    await setSites(env.user.id, [env.site.id]);
    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id,
      partnerId: env.partner.id, scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const app = new Hono();
    app.route('/users', userRoutes);
    const pendingInvite = async (siteIds: string[]) => {
      const invitee = await createUser({
        partnerId: env.partner.id,
        orgId: env.organization.id,
        email: `pending-${randomUUID()}@example.test`,
        status: 'invited',
      });
      await assignUserToOrganization(invitee.id, env.organization.id, env.role.id);
      await setSites(invitee.id, siteIds);
      return invitee;
    };
    const resend = (userId: string) => app.request('/users/resend-invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    return { env, otherSite, pendingInvite, resend };
  }

  runDb('refuses an invite for a user outside the caller sites: 403, no token, no mail', async () => {
    const fx = await orgFixture();
    const invitee = await fx.pendingInvite([fx.otherSite.id]);

    const res = await fx.resend(invitee.id);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/site access/);
    expect(mail.sendInvite).not.toHaveBeenCalled();
    expect(await getTestRedis().get(`invite-user:${invitee.id}`)).toBeNull();
  });

  runDb('resends an invite for a user within the caller sites', async () => {
    const fx = await orgFixture();
    const invitee = await fx.pendingInvite([fx.env.site.id]);

    const res = await fx.resend(invitee.id);

    expect(res.status).toBe(200);
    expect(mail.sendInvite).toHaveBeenCalledOnce();
    expect(await getTestRedis().get(`invite-user:${invitee.id}`)).toBeTruthy();
  });
});
