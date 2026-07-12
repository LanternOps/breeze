/**
 * Full-route tenant invite coverage for cross-tenant and tombstone reuse.
 *
 * Unlike the service-level lifecycle cases, this mounts the real userRoutes,
 * authenticates with a real partner JWT, and executes route transactions and
 * forced-RLS database work through the breeze_app pool. Email is intentionally
 * left unconfigured in the integration environment; successful invites retain
 * the route's truthful partial-cleanup envelope while all durable assertions
 * are made against PostgreSQL.
 */
import './setup';

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  organizationUsers,
  partnerUsers,
  refreshTokenFamilies,
  userPasskeys,
  userSsoIdentities,
  users,
} from '../../db/schema';
import { userRoutes } from '../../routes/users';
import { createAccessToken } from '../../services/jwt';
import {
  createPartner,
  createUser,
  setupTestEnvironment,
} from './db-utils';
import { getTestDb } from './setup';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function buildApp() {
  const app = new Hono();
  app.route('/users', userRoutes);
  return app;
}

async function setupInviter() {
  const env = await setupTestEnvironment({
    scope: 'partner',
    rolePermissions: [{ resource: 'users', action: 'invite' }],
  });
  const token = await createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    ae: env.user.authEpoch,
    me: env.user.mfaEpoch,
    sid: `invite-integration:${env.user.id}`,
    mfa: true,
  });
  return { env, token, app: buildApp() };
}

async function invite(
  app: Hono,
  token: string,
  roleId: string,
  email: string,
  name = 'Invited User',
) {
  return app.request('/users/invite', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
    body: JSON.stringify({ email, name, roleId, orgAccess: 'none' }),
  });
}

async function insertFamily(userId: string, familyId: string) {
  await getTestDb().insert(refreshTokenFamilies).values({
    familyId,
    userId,
    absoluteExpiresAt: new Date(Date.now() + 86_400_000),
  });
}

async function expectGenericBlockedInvite(input: {
  response: Response;
  targetId: string;
  targetPartnerId: string;
  invitingPartnerId: string;
  expectedName: string;
  expectedStatus: 'active' | 'disabled';
  familyId: string;
  isPlatformAdmin?: boolean;
}) {
  expect(input.response.status).toBe(409);
  expect(await input.response.json()).toEqual({ error: 'Unable to invite user' });

  const [after] = await getTestDb().select({
    partnerId: users.partnerId,
    name: users.name,
    status: users.status,
    authEpoch: users.authEpoch,
    isPlatformAdmin: users.isPlatformAdmin,
  }).from(users).where(eq(users.id, input.targetId));
  expect(after).toEqual(expect.objectContaining({
    partnerId: input.targetPartnerId,
    name: input.expectedName,
    status: input.expectedStatus,
    authEpoch: 1,
    isPlatformAdmin: input.isPlatformAdmin ?? false,
  }));

  const invitingMemberships = await getTestDb().select({ id: partnerUsers.id })
    .from(partnerUsers)
    .where(and(
      eq(partnerUsers.partnerId, input.invitingPartnerId),
      eq(partnerUsers.userId, input.targetId),
    ));
  expect(invitingMemberships).toEqual([]);

  const [family] = await getTestDb().select({
    revokedAt: refreshTokenFamilies.revokedAt,
    revokedReason: refreshTokenFamilies.revokedReason,
  }).from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, input.familyId));
  expect(family).toEqual({ revokedAt: null, revokedReason: null });
}

describe('POST /users/invite — real route tombstone isolation', () => {
  it('returns a generic conflict with zero side effects for an active cross-partner user', async () => {
    const { env, token, app } = await setupInviter();
    const priorPartner = await createPartner();
    const target = await createUser({
      partnerId: priorPartner.id,
      email: `active-cross-partner-${Date.now()}@example.com`,
      name: 'Existing Active User',
      withMembership: true,
    });
    const familyId = '41000000-0000-4000-8000-000000000001';
    await insertFamily(target.id, familyId);

    const response = await invite(app, token, env.role.id, target.email, 'Leaked Replacement Name');

    await expectGenericBlockedInvite({
      response,
      targetId: target.id,
      targetPartnerId: priorPartner.id,
      invitingPartnerId: env.partner.id,
      expectedName: 'Existing Active User',
      expectedStatus: 'active',
      familyId,
    });
  });

  it('returns a generic conflict with zero side effects for a removed user retaining a passkey', async () => {
    const { env, token, app } = await setupInviter();
    const priorPartner = await createPartner();
    const target = await createUser({
      partnerId: priorPartner.id,
      email: `retained-passkey-${Date.now()}@example.com`,
      name: 'Retained Passkey User',
    });
    await getTestDb().update(users).set({
      status: 'disabled',
      passwordHash: null,
      disabledReason: 'removed',
    }).where(eq(users.id, target.id));
    await getTestDb().insert(userPasskeys).values({
      userId: target.id,
      credentialId: `credential-${target.id}`,
      publicKey: 'integration-public-key',
      deviceType: 'singleDevice',
      name: 'Retained passkey',
    });
    const familyId = '41000000-0000-4000-8000-000000000002';
    await insertFamily(target.id, familyId);

    const response = await invite(app, token, env.role.id, target.email, 'Leaked Replacement Name');

    await expectGenericBlockedInvite({
      response,
      targetId: target.id,
      targetPartnerId: priorPartner.id,
      invitingPartnerId: env.partner.id,
      expectedName: 'Retained Passkey User',
      expectedStatus: 'disabled',
      familyId,
    });
    const retainedPasskeys = await getTestDb().select({ id: userPasskeys.id })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, target.id));
    expect(retainedPasskeys).toHaveLength(1);
  });

  it('returns a generic conflict with zero side effects for a removed platform-admin tombstone', async () => {
    const { env, token, app } = await setupInviter();
    const priorPartner = await createPartner();
    const target = await createUser({
      partnerId: priorPartner.id,
      email: `platform-admin-tombstone-${Date.now()}@example.com`,
      name: 'Platform Owner',
    });
    await getTestDb().update(users).set({
      status: 'disabled',
      passwordHash: null,
      disabledReason: 'removed',
      isPlatformAdmin: true,
    }).where(eq(users.id, target.id));
    const familyId = '41000000-0000-4000-8000-000000000003';
    await insertFamily(target.id, familyId);

    const response = await invite(app, token, env.role.id, target.email, 'Leaked Replacement Name');

    await expectGenericBlockedInvite({
      response,
      targetId: target.id,
      targetPartnerId: priorPartner.id,
      invitingPartnerId: env.partner.id,
      expectedName: 'Platform Owner',
      expectedStatus: 'disabled',
      familyId,
      isPlatformAdmin: true,
    });
  });

  it('re-homes a genuine removed orphan through the route without granting platform authority', async () => {
    const { env, token, app } = await setupInviter();
    const priorPartner = await createPartner();
    const target = await createUser({
      partnerId: priorPartner.id,
      email: `genuine-orphan-${Date.now()}@example.com`,
      name: 'Removed User',
    });
    await getTestDb().update(users).set({
      status: 'disabled',
      passwordHash: null,
      disabledReason: 'removed',
    }).where(eq(users.id, target.id));
    const familyId = '41000000-0000-4000-8000-000000000004';
    await insertFamily(target.id, familyId);

    const response = await invite(app, token, env.role.id, target.email, 'Re-homed User');

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(expect.objectContaining({
      id: target.id,
      email: target.email,
      name: 'Re-homed User',
      status: 'invited',
      roleId: env.role.id,
    }));

    const [after] = await getTestDb().select({
      partnerId: users.partnerId,
      orgId: users.orgId,
      name: users.name,
      status: users.status,
      authEpoch: users.authEpoch,
      isPlatformAdmin: users.isPlatformAdmin,
    }).from(users).where(eq(users.id, target.id));
    expect(after).toEqual({
      partnerId: env.partner.id,
      orgId: null,
      name: 'Re-homed User',
      status: 'invited',
      authEpoch: 2,
      isPlatformAdmin: false,
    });

    const memberships = await getTestDb().select({
      partnerId: partnerUsers.partnerId,
      roleId: partnerUsers.roleId,
      orgAccess: partnerUsers.orgAccess,
    }).from(partnerUsers).where(eq(partnerUsers.userId, target.id));
    expect(memberships).toEqual([{
      partnerId: env.partner.id,
      roleId: env.role.id,
      orgAccess: 'none',
    }]);
    expect(await getTestDb().select({ id: organizationUsers.id })
      .from(organizationUsers).where(eq(organizationUsers.userId, target.id))).toEqual([]);
    expect(await getTestDb().select({ id: userPasskeys.id })
      .from(userPasskeys).where(eq(userPasskeys.userId, target.id))).toEqual([]);
    expect(await getTestDb().select({ id: userSsoIdentities.id })
      .from(userSsoIdentities).where(eq(userSsoIdentities.userId, target.id))).toEqual([]);

    const [family] = await getTestDb().select({
      revokedAt: refreshTokenFamilies.revokedAt,
      revokedReason: refreshTokenFamilies.revokedReason,
    }).from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, familyId));
    if (!family) throw new Error('re-invited family was not found');
    expect(family.revokedAt).not.toBeNull();
    expect(family.revokedReason).toBe('user-reinvited');
  });
});
