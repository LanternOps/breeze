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
import {
  applyRegistrationHookStatusTransition,
  activatePendingPartnerAndInvalidateSessions,
  restoreSuspendedPartnerInTransaction,
  suspendPartnerForAbuseInTransaction,
} from '../../services/partnerActivation';
import { issueUserSession } from '../../services/userSession';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import {
  consumeVerificationToken,
  generateVerificationToken,
} from '../../services/emailVerification';

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForBlockedActivationLock(
  tableName: 'users' | 'refresh_token_families',
  minimum = 1,
): Promise<void> {
  const db = getTestDb();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'breeze_app'
        AND wait_event_type = 'Lock'
        AND position(${tableName} in lower(query)) > 0
    `) as unknown as Array<{ blocked_count: number }>;
    if (Number(rows[0]?.blocked_count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${minimum} activation queries blocked on ${tableName}`);
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

  it('locks hosted activation users and families in UUID order against real opposing lockers', async () => {
    const db = getTestDb();
    const partner = await createPartner({ name: 'Hosted Lock Order Partner' });
    await db.update(partners).set({ status: 'pending' }).where(eq(partners.id, partner.id));
    const org = await createOrganization({ partnerId: partner.id });
    const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
    const orgRole = await createRole({ scope: 'organization', partnerId: partner.id, orgId: org.id });
    const createdUsers = [
      await createUser({
        partnerId: partner.id,
        orgId: org.id,
        email: 'hosted-lock-order-a@example.com',
      }),
      await createUser({
        partnerId: partner.id,
        orgId: org.id,
        email: 'hosted-lock-order-b@example.com',
      }),
    ];
    const [lowerUser, higherUser] = [...createdUsers].sort((left, right) =>
      left.id.localeCompare(right.id));
    if (!lowerUser || !higherUser) throw new Error('Failed to seed activation users');

    // Insert memberships in reverse UUID order. The old implementation used
    // discovery order and would attempt the higher user first; the real lock
    // barrier below catches that regression rather than trusting mock chains.
    await assignUserToPartner(higherUser.id, partner.id, partnerRole.id, 'all');
    await assignUserToOrganization(lowerUser.id, org.id, orgRole.id);
    const oldFamilies = await withAuthLifecycleSystemTransaction(async (tx) => [
      await mintRefreshTokenFamily(higherUser.id, { tx }),
      await mintRefreshTokenFamily(lowerUser.id, { tx }),
    ]);
    const [lowerFamily, higherFamily] = [...oldFamilies].sort();
    if (!lowerFamily || !higherFamily) throw new Error('Failed to seed activation families');

    const userLockHeld = deferred();
    const releaseUserLock = deferred();
    const familyLockHeld = deferred();
    const releaseFamilyLock = deferred();
    const userBlocker = db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM users WHERE id = ${lowerUser.id}::uuid FOR UPDATE
      `);
      userLockHeld.resolve();
      await releaseUserLock.promise;
    });
    const familyBlocker = db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT family_id
        FROM refresh_token_families
        WHERE family_id = ${lowerFamily}::uuid
        FOR UPDATE
      `);
      familyLockHeld.resolve();
      await releaseFamilyLock.promise;
    });
    await Promise.all([userLockHeld.promise, familyLockHeld.promise]);

    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);
    const activationPromise = finishAuthIssuance(capability, async (tx) => {
      const activation = await activatePendingPartnerAndInvalidateSessions(tx, partner.id);
      const tokens = await issueUserSession({
        userId: higherUser.id,
        email: higherUser.email,
        roleId: partnerRole.id,
        orgId: null,
        partnerId: partner.id,
        scope: 'partner',
        mfa: false,
        amr: ['password'],
      }, { tx, capability });
      return { activation, tokens };
    });
    void activationPromise.catch(() => undefined);

    try {
      await waitForBlockedActivationLock('users');
      // Blocking on the lower UUID must happen before the higher user is
      // locked, so an independent NOWAIT-style probe can still take it.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.execute(sql`
          SELECT id FROM users WHERE id = ${higherUser.id}::uuid FOR UPDATE
        `);
      });

      releaseUserLock.resolve();
      await userBlocker;
      await waitForBlockedActivationLock('refresh_token_families');
      // All user locks are now held, and the lower family blocks before the
      // higher family can be taken. This proves both lock-class and UUID order.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.execute(sql`
          SELECT family_id
          FROM refresh_token_families
          WHERE family_id = ${higherFamily}::uuid
          FOR UPDATE
        `);
      });

      releaseFamilyLock.resolve();
      await familyBlocker;
      const committed = await activationPromise;
      expect(committed.activation).toEqual({
        activated: true,
        userIds: [lowerUser.id, higherUser.id].sort(),
      });
    } finally {
      releaseUserLock.resolve();
      releaseFamilyLock.resolve();
      await Promise.allSettled([userBlocker, familyBlocker, activationPromise]);
    }
  });

  it('keeps email verification and guarded hosted activation in one cross-caller lock order', async () => {
    const db = getTestDb();
    const partner = await createPartner({ name: 'Verification Activation Race Partner' });
    await db.update(partners).set({
      status: 'pending',
      paymentMethodAttachedAt: new Date(),
    }).where(eq(partners.id, partner.id));
    const org = await createOrganization({ partnerId: partner.id });
    const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
    const createdUsers = [
      await createUser({
        partnerId: partner.id,
        orgId: org.id,
        email: 'verification-activation-a@example.com',
      }),
      await createUser({
        partnerId: partner.id,
        orgId: org.id,
        email: 'verification-activation-b@example.com',
      }),
    ];
    const [lowerUser, higherUser] = [...createdUsers].sort((left, right) =>
      left.id.localeCompare(right.id));
    if (!lowerUser || !higherUser) throw new Error('Failed to seed verification race users');
    await assignUserToPartner(lowerUser.id, partner.id, partnerRole.id, 'all');
    await assignUserToPartner(higherUser.id, partner.id, partnerRole.id, 'all');
    const rawVerificationToken = await generateVerificationToken({
      partnerId: partner.id,
      userId: higherUser.id,
      email: higherUser.email,
    });

    const lowerLockHeld = deferred();
    const releaseLowerLock = deferred();
    const lowerBlocker = db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM users WHERE id = ${lowerUser.id}::uuid FOR UPDATE
      `);
      lowerLockHeld.resolve();
      await releaseLowerLock.promise;
    });
    await lowerLockHeld.promise;

    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);
    const guardedActivation = finishAuthIssuance(capability, async (tx) => {
      const activation = await activatePendingPartnerAndInvalidateSessions(tx, partner.id);
      const tokens = await issueUserSession({
        userId: higherUser.id,
        email: higherUser.email,
        roleId: partnerRole.id,
        orgId: null,
        partnerId: partner.id,
        scope: 'partner',
        mfa: false,
        amr: ['password'],
      }, { tx, capability });
      return { activation, tokens };
    });
    void guardedActivation.catch(() => undefined);

    let verification!: Promise<Awaited<ReturnType<typeof consumeVerificationToken>>>;
    try {
      await waitForBlockedActivationLock('users', 1);
      verification = consumeVerificationToken(rawVerificationToken);
      void verification.catch(() => undefined);
      await waitForBlockedActivationLock('users', 2);

      // The verification path must reach the canonical lower-user lock before
      // writing its higher verification user. Under the old order this probe
      // times out, and releasing the lower row creates the exact higher/lower
      // deadlock with the guarded activation transaction.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.execute(sql`
          SELECT id FROM users WHERE id = ${higherUser.id}::uuid FOR UPDATE
        `);
      });

      releaseLowerLock.resolve();
      await lowerBlocker;
      const [guardedResult, verificationResult] = await Promise.all([
        guardedActivation,
        verification,
      ]);
      expect(guardedResult.activation.activated).toBe(true);
      expect(verificationResult).toMatchObject({
        ok: true,
        partnerId: partner.id,
        userId: higherUser.id,
      });
    } finally {
      releaseLowerLock.resolve();
      await Promise.allSettled([
        lowerBlocker,
        guardedActivation,
        ...(verification ? [verification] : []),
      ]);
    }
  });
});

describe('partner lifecycle writers share the browser-auth lock order', () => {
  async function expectPartnerRowStillLockable(partnerId: string) {
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
      await tx.execute(sql`
        SELECT id FROM partners WHERE id = ${partnerId}::uuid FOR UPDATE
      `);
    });
  }

  it('serializes activation against abuse suspension without a partner-to-user deadlock', async () => {
    const db = getTestDb();
    const partner = await createPartner({ name: 'Activation Suspension Lock Partner' });
    await db.update(partners).set({ status: 'pending' }).where(eq(partners.id, partner.id));
    const user = await createUser({
      partnerId: partner.id,
      email: 'activation-suspension-lock@example.com',
      withMembership: true,
    });
    await withAuthLifecycleSystemTransaction((tx) => mintRefreshTokenFamily(user.id, { tx }));

    const userLockHeld = deferred();
    const releaseUserLock = deferred();
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`);
      userLockHeld.resolve();
      await releaseUserLock.promise;
    });
    await userLockHeld.promise;

    const activation = withAuthLifecycleSystemTransaction((tx) =>
      activatePendingPartnerAndInvalidateSessions(tx, partner.id)
    );
    void activation.catch(() => undefined);
    let suspension!: Promise<Awaited<ReturnType<typeof suspendPartnerForAbuseInTransaction>>>;
    try {
      await waitForBlockedActivationLock('users', 1);
      suspension = withAuthLifecycleSystemTransaction((tx) =>
        suspendPartnerForAbuseInTransaction(tx, partner.id, crypto.randomUUID())
      );
      void suspension.catch(() => undefined);
      await waitForBlockedActivationLock('users', 2);

      // Neither contender may own the later partner row while waiting for the
      // first user. A partner-first suspension fails this probe and forms the
      // inverse edge needed for a real PostgreSQL deadlock after release.
      await expectPartnerRowStillLockable(partner.id);

      releaseUserLock.resolve();
      await blocker;
      await expect(Promise.all([activation, suspension])).resolves.toBeTruthy();
      const [after] = await db.select({ status: partners.status }).from(partners)
        .where(eq(partners.id, partner.id));
      expect(after?.status).toBe('suspended');
    } finally {
      releaseUserLock.resolve();
      await Promise.allSettled([blocker, activation, ...(suspension ? [suspension] : [])]);
    }
  });

  it('serializes activation against restore without a partner-to-user deadlock', async () => {
    const db = getTestDb();
    const partner = await createPartner({ name: 'Activation Restore Lock Partner' });
    await db.update(partners).set({
      status: 'suspended',
      emailVerifiedAt: new Date(),
      paymentMethodAttachedAt: new Date(),
    }).where(eq(partners.id, partner.id));
    const user = await createUser({
      partnerId: partner.id,
      email: 'activation-restore-lock@example.com',
      withMembership: true,
    });
    await db.update(users).set({
      status: 'disabled',
      disabledReason: 'partner_suspended',
    }).where(eq(users.id, user.id));
    await withAuthLifecycleSystemTransaction((tx) => mintRefreshTokenFamily(user.id, { tx }));

    const userLockHeld = deferred();
    const releaseUserLock = deferred();
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`);
      userLockHeld.resolve();
      await releaseUserLock.promise;
    });
    await userLockHeld.promise;

    const activation = withAuthLifecycleSystemTransaction((tx) =>
      activatePendingPartnerAndInvalidateSessions(tx, partner.id)
    );
    void activation.catch(() => undefined);
    let restore!: Promise<Awaited<ReturnType<typeof restoreSuspendedPartnerInTransaction>>>;
    try {
      await waitForBlockedActivationLock('users', 1);
      restore = withAuthLifecycleSystemTransaction((tx) =>
        restoreSuspendedPartnerInTransaction(tx, partner.id)
      );
      void restore.catch(() => undefined);
      await waitForBlockedActivationLock('users', 2);
      await expectPartnerRowStillLockable(partner.id);

      releaseUserLock.resolve();
      await blocker;
      const [activationResult, restoreResult] = await Promise.all([activation, restore]);
      expect(activationResult.activated).toBe(false);
      expect(restoreResult).toMatchObject({ notFound: false, status: 'active' });
      const [after] = await db.select({ status: partners.status }).from(partners)
        .where(eq(partners.id, partner.id));
      expect(after?.status).toBe('active');
    } finally {
      releaseUserLock.resolve();
      await Promise.allSettled([blocker, activation, ...(restore ? [restore] : [])]);
    }
  });

  it('keeps a committed abuse suspension authoritative over a delayed registration hook', async () => {
    const db = getTestDb();
    const partner = await createPartner({ name: 'Delayed Registration Hook Partner' });
    const user = await createUser({
      partnerId: partner.id,
      email: 'delayed-registration-hook@example.com',
      withMembership: true,
    });
    const familyId = await withAuthLifecycleSystemTransaction((tx) =>
      mintRefreshTokenFamily(user.id, { tx })
    );

    await withAuthLifecycleSystemTransaction((tx) =>
      suspendPartnerForAbuseInTransaction(tx, partner.id, crypto.randomUUID())
    );
    const staleHook = await withAuthLifecycleSystemTransaction((tx) =>
      applyRegistrationHookStatusTransition(tx, {
        partnerId: partner.id,
        expectedStatus: 'active',
        nextStatus: 'pending',
      })
    );

    expect(staleHook).toEqual({ applied: false });
    const [partnerAfter] = await db.select({ status: partners.status }).from(partners)
      .where(eq(partners.id, partner.id));
    const [userAfter] = await db.select({ status: users.status }).from(users)
      .where(eq(users.id, user.id));
    const [familyAfter] = await db.select({
      revokedReason: refreshTokenFamilies.revokedReason,
    }).from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, familyId));
    expect(partnerAfter?.status).toBe('suspended');
    expect(userAfter?.status).toBe('disabled');
    expect(familyAfter?.revokedReason).toBe('partner-suspended');
  });
});
