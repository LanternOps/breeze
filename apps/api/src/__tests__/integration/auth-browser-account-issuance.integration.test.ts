import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import './setup';
import { getTestDb, getTestRedis } from './setup';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
  assignUserToPartner,
  assignUserToOrganization,
} from './db-utils';
import {
  authBrowserTransitions,
  auditLogs,
  emailVerificationTokens,
  organizations,
  organizationUsers,
  partnerUsers,
  partners,
  refreshTokenFamilies,
  rolePermissions,
  roles,
  sites,
  users,
} from '../../db/schema';
import {
  AuthBindingRotationRequiredError,
  AuthIssuanceCapabilityError,
  beginAuthIssuance,
  finishAuthIssuance,
  resolveAuthBinding,
  type AuthBindingSource,
} from '../../services/authBrowserTransition';
import {
  revokeUserSessionFamily,
  withAuthLifecycleSystemTransaction,
} from '../../services/authLifecycle';
import { createRegisteredPartnerSession } from '../../routes/auth/register';
import { activateInvitedUserSession } from '../../routes/auth/invite';
import { activatePendingPartnerAndInvalidateSessions } from '../../services/partnerActivation';
import { issueUserSession } from '../../services/userSession';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';

const CURRENT_KEY = 'integration-account-issuance-browser-binding-key';

function freshBrowserBinding(): AuthBindingSource {
  try {
    resolveAuthBinding(undefined);
  } catch (error) {
    if (error instanceof AuthBindingRotationRequiredError) return error.replacement;
    throw error;
  }
  throw new Error('Missing binding did not produce a replacement');
}

async function beginLogoutAndRevokeLinkedFamily(transitionId: string) {
  return withAuthLifecycleSystemTransaction(async (tx) => {
    const [transition] = await tx
      .select({
        id: authBrowserTransitions.id,
        currentUserId: authBrowserTransitions.currentUserId,
        currentFamilyId: authBrowserTransitions.currentFamilyId,
      })
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, transitionId))
      .for('update')
      .limit(1);
    if (!transition) throw new Error('Missing browser transition');

    await tx
      .update(authBrowserTransitions)
      .set({
        state: 'logout_pending',
        generation: sql`${authBrowserTransitions.generation} + 1`,
        activeOperationId: null,
        activeOperationExpiresAt: null,
        logoutId: crypto.randomUUID(),
        completionNonceDigest: 'd'.repeat(64),
        logoutExpiresAt: sql`now() + interval '10 minutes'`,
        updatedAt: sql`now()`,
      })
      .where(eq(authBrowserTransitions.id, transition.id));

    if (transition.currentUserId && transition.currentFamilyId) {
      await revokeUserSessionFamily(
        tx,
        transition.currentUserId,
        transition.currentFamilyId,
        'terminal-logout',
      );
    }
    return transition;
  });
}

async function waitForBlockedTransitionQueries(minimum: number): Promise<void> {
  const db = getTestDb();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'breeze_app'
        AND wait_event_type = 'Lock'
        AND position('auth_browser_transitions' in lower(query)) > 0
    `) as unknown as Array<{ blocked_count: number }>;
    if (Number(rows[0]?.blocked_count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${minimum} blocked auth-browser transition queries`);
}

async function queueTransitionRacers<TFirst, TSecond>(
  transitionId: string,
  first: () => Promise<TFirst>,
  second: () => Promise<TSecond>,
): Promise<[Promise<TFirst>, Promise<TSecond>]> {
  const db = getTestDb();
  let firstPromise!: Promise<TFirst>;
  let secondPromise!: Promise<TSecond>;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id
      FROM auth_browser_transitions
      WHERE id = ${transitionId}::uuid
      FOR UPDATE
    `);
    firstPromise = first();
    void firstPromise.catch(() => undefined);
    await waitForBlockedTransitionQueries(1);
    secondPromise = second();
    void secondPromise.catch(() => undefined);
    await waitForBlockedTransitionQueries(2);
  });
  return [firstPromise, secondPromise];
}

beforeEach(async () => {
  delete process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY_ID = 'current';
  process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: CURRENT_KEY });

  // createPartner copies the global seeded Partner Admin permissions. The
  // integration database is intentionally empty after cleanup, so seed the
  // same role shape with no permissions for these transaction tests.
  await getTestDb().insert(roles).values({
    name: 'Partner Admin',
    scope: 'partner',
    isSystem: true,
    partnerId: null,
  });
});

describe('registration and invite issuance against terminal logout', () => {
  it('registration writes nothing when terminal logout owns the transition first', async () => {
    const db = getTestDb();
    const before = {
      partners: (await db.select().from(partners)).length,
      organizations: (await db.select().from(organizations)).length,
      sites: (await db.select().from(sites)).length,
      users: (await db.select().from(users)).length,
      roles: (await db.select().from(roles)).length,
      partnerUsers: (await db.select().from(partnerUsers)).length,
      organizationUsers: (await db.select().from(organizationUsers)).length,
      rolePermissions: (await db.select().from(rolePermissions)).length,
      families: (await db.select().from(refreshTokenFamilies)).length,
      verificationTokens: (await db.select().from(emailVerificationTokens)).length,
      audits: (await db.select().from(auditLogs)).length,
    };
    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);
    const [logout, issuance] = await queueTransitionRacers(
      capability.transitionId,
      () => beginLogoutAndRevokeLinkedFamily(capability.transitionId),
      () => finishAuthIssuance(capability, (tx) =>
        createRegisteredPartnerSession({
          tx,
          capability,
          companyName: 'Terminal First Registration',
          email: 'terminal-first-registration@example.com',
          name: 'Terminal First',
          passwordHash: 'new-password-hash',
          status: 'active',
        })),
    );
    await expect(logout).resolves.toBeTruthy();
    await expect(issuance).rejects.toBeInstanceOf(AuthIssuanceCapabilityError);

    expect(await db.select().from(partners)).toHaveLength(before.partners);
    expect(await db.select().from(organizations)).toHaveLength(before.organizations);
    expect(await db.select().from(sites)).toHaveLength(before.sites);
    expect(await db.select().from(users)).toHaveLength(before.users);
    expect(await db.select().from(roles)).toHaveLength(before.roles);
    expect(await db.select().from(partnerUsers)).toHaveLength(before.partnerUsers);
    expect(await db.select().from(organizationUsers)).toHaveLength(before.organizationUsers);
    expect(await db.select().from(rolePermissions)).toHaveLength(before.rolePermissions);
    expect(await db.select().from(refreshTokenFamilies)).toHaveLength(before.families);
    expect(await db.select().from(emailVerificationTokens)).toHaveLength(before.verificationTokens);
    expect(await db.select().from(auditLogs)).toHaveLength(before.audits);
  });

  it('terminal logout observes and revokes the family after registration commits first', async () => {
    const db = getTestDb();
    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);

    const [issuance, logout] = await queueTransitionRacers(
      capability.transitionId,
      () => finishAuthIssuance(capability, (tx) =>
        createRegisteredPartnerSession({
          tx,
          capability,
          companyName: 'Issuance First Registration',
          email: 'issuance-first-registration@example.com',
          name: 'Issuance First',
          passwordHash: 'new-password-hash',
          status: 'active',
        })),
      () => beginLogoutAndRevokeLinkedFamily(capability.transitionId),
    );
    const committed = await issuance;
    const linked = await logout;

    expect(linked).toMatchObject({
      currentUserId: committed.newUser.id,
      currentFamilyId: committed.tokens.familyId,
    });
    const [family] = await db
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, committed.tokens.familyId));
    expect(family?.revokedReason).toBe('terminal-logout');
  });

  it('invite state and Redis keys stay unchanged when terminal logout wins first', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const partner = await createPartner({ name: 'Invite Partner' });
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', partnerId: partner.id, orgId: org.id });
    const invited = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: 'terminal-first-invite@example.com',
      status: 'invited',
    });
    await assignUserToOrganization(invited.id, org.id, role.id);
    await redis.set('invite:test-terminal-first', invited.id);
    await redis.set(`invite-user:${invited.id}`, 'test-terminal-first');

    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);
    const [logout, issuance] = await queueTransitionRacers(
      capability.transitionId,
      () => beginLogoutAndRevokeLinkedFamily(capability.transitionId),
      () => finishAuthIssuance(capability, (tx) =>
        activateInvitedUserSession({
          tx,
          capability,
          userId: invited.id,
          passwordHash: 'replacement-password-hash',
        })),
    );
    await expect(logout).resolves.toBeTruthy();
    await expect(issuance).rejects.toBeInstanceOf(AuthIssuanceCapabilityError);

    const [unchanged] = await db.select().from(users).where(eq(users.id, invited.id));
    expect(unchanged).toMatchObject({
      status: 'invited',
      passwordHash: invited.passwordHash,
      authEpoch: invited.authEpoch,
      mfaEpoch: invited.mfaEpoch,
    });
    expect(await db.select().from(refreshTokenFamilies)).toHaveLength(0);
    expect(await redis.get('invite:test-terminal-first')).toBe(invited.id);
    expect(await redis.get(`invite-user:${invited.id}`)).toBe('test-terminal-first');
  });

  it('terminal logout observes and revokes the replacement family after invite acceptance commits first', async () => {
    const db = getTestDb();
    const partner = await createPartner({ name: 'Invite Partner' });
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', partnerId: partner.id, orgId: org.id });
    const invited = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: 'issuance-first-invite@example.com',
      status: 'invited',
    });
    await assignUserToOrganization(invited.id, org.id, role.id);

    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);
    const [issuance, logout] = await queueTransitionRacers(
      capability.transitionId,
      () => finishAuthIssuance(capability, (tx) =>
        activateInvitedUserSession({
          tx,
          capability,
          userId: invited.id,
          passwordHash: 'replacement-password-hash',
        })),
      () => beginLogoutAndRevokeLinkedFamily(capability.transitionId),
    );
    const committed = await issuance;
    const linked = await logout;

    expect(linked).toMatchObject({
      currentUserId: invited.id,
      currentFamilyId: committed.tokens.familyId,
    });
    const [accepted] = await db.select().from(users).where(eq(users.id, invited.id));
    expect(accepted).toMatchObject({ status: 'active', passwordHash: 'replacement-password-hash' });
    expect(accepted!.authEpoch).toBe(invited.authEpoch + 1);
    const [family] = await db
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, committed.tokens.familyId));
    expect(family?.revokedReason).toBe('terminal-logout');
  });

  it('activates a hosted partner with multiple users in one guarded invalidation sequence', async () => {
    const db = getTestDb();
    const partner = await createPartner({ name: 'Hosted Activation Partner' });
    await db.update(partners).set({ status: 'pending' }).where(eq(partners.id, partner.id));
    const org = await createOrganization({ partnerId: partner.id });
    const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
    const orgRole = await createRole({ scope: 'organization', partnerId: partner.id, orgId: org.id });
    const admin = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: 'hosted-activation-admin@example.com',
    });
    const member = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: 'hosted-activation-member@example.com',
    });
    await assignUserToPartner(admin.id, partner.id, partnerRole.id, 'all');
    await assignUserToOrganization(member.id, org.id, orgRole.id);
    const [adminOldFamily, memberOldFamily] = await withAuthLifecycleSystemTransaction(async (tx) => [
      await mintRefreshTokenFamily(admin.id, { tx }),
      await mintRefreshTokenFamily(member.id, { tx }),
    ]);

    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);
    const committed = await finishAuthIssuance(capability, async (tx) => {
      const activation = await activatePendingPartnerAndInvalidateSessions(
        tx,
        partner.id,
        new Date(),
      );
      const tokens = await issueUserSession({
        userId: admin.id,
        email: admin.email,
        roleId: partnerRole.id,
        orgId: null,
        partnerId: partner.id,
        scope: 'partner',
        mfa: false,
        amr: ['password'],
      }, { tx, capability });
      return { activation, tokens };
    });

    expect(committed.activation).toEqual({
      activated: true,
      userIds: [admin.id, member.id].sort(),
    });
    const [activatedPartner] = await db.select().from(partners).where(eq(partners.id, partner.id));
    expect(activatedPartner?.status).toBe('active');
    const activatedUsers = await db
      .select({ id: users.id, authEpoch: users.authEpoch })
      .from(users)
      .where(sql`${users.id} IN (${admin.id}::uuid, ${member.id}::uuid)`);
    expect(Object.fromEntries(activatedUsers.map((row) => [row.id, row.authEpoch]))).toEqual({
      [admin.id]: admin.authEpoch + 1,
      [member.id]: member.authEpoch + 1,
    });
    const familyRows = await db
      .select()
      .from(refreshTokenFamilies)
      .where(sql`${refreshTokenFamilies.familyId} IN (
        ${adminOldFamily}::uuid,
        ${memberOldFamily}::uuid,
        ${committed.tokens.familyId}::uuid
      )`);
    expect(familyRows.find((row) => row.familyId === adminOldFamily)?.revokedReason)
      .toBe('partner-activated');
    expect(familyRows.find((row) => row.familyId === memberOldFamily)?.revokedReason)
      .toBe('partner-activated');
    expect(familyRows.find((row) => row.familyId === committed.tokens.familyId)?.revokedAt)
      .toBeNull();
  });
});
