import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import './setup';
import { getTestDb, getTestRedis } from './setup';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
  assignUserToOrganization,
} from './db-utils';
import {
  authBrowserTransitions,
  auditLogs,
  emailVerificationTokens,
  organizations,
  partners,
  refreshTokenFamilies,
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
      families: (await db.select().from(refreshTokenFamilies)).length,
      verificationTokens: (await db.select().from(emailVerificationTokens)).length,
      audits: (await db.select().from(auditLogs)).length,
    };
    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);
    await beginLogoutAndRevokeLinkedFamily(capability.transitionId);

    await expect(finishAuthIssuance(capability, (tx) =>
      createRegisteredPartnerSession({
        tx,
        capability,
        companyName: 'Terminal First Registration',
        email: 'terminal-first-registration@example.com',
        name: 'Terminal First',
        passwordHash: 'new-password-hash',
        status: 'active',
      }))).rejects.toBeInstanceOf(AuthIssuanceCapabilityError);

    expect(await db.select().from(partners)).toHaveLength(before.partners);
    expect(await db.select().from(organizations)).toHaveLength(before.organizations);
    expect(await db.select().from(sites)).toHaveLength(before.sites);
    expect(await db.select().from(users)).toHaveLength(before.users);
    expect(await db.select().from(refreshTokenFamilies)).toHaveLength(before.families);
    expect(await db.select().from(emailVerificationTokens)).toHaveLength(before.verificationTokens);
    expect(await db.select().from(auditLogs)).toHaveLength(before.audits);
  });

  it('terminal logout observes and revokes the family after registration commits first', async () => {
    const db = getTestDb();
    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);

    const committed = await finishAuthIssuance(capability, (tx) =>
      createRegisteredPartnerSession({
        tx,
        capability,
        companyName: 'Issuance First Registration',
        email: 'issuance-first-registration@example.com',
        name: 'Issuance First',
        passwordHash: 'new-password-hash',
        status: 'active',
      }));
    const linked = await beginLogoutAndRevokeLinkedFamily(capability.transitionId);

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
    await beginLogoutAndRevokeLinkedFamily(capability.transitionId);
    await expect(finishAuthIssuance(capability, (tx) =>
      activateInvitedUserSession({
        tx,
        capability,
        userId: invited.id,
        passwordHash: 'replacement-password-hash',
      }))).rejects.toBeInstanceOf(AuthIssuanceCapabilityError);

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
    const committed = await finishAuthIssuance(capability, (tx) =>
      activateInvitedUserSession({
        tx,
        capability,
        userId: invited.id,
        passwordHash: 'replacement-password-hash',
      }));
    const linked = await beginLogoutAndRevokeLinkedFamily(capability.transitionId);

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
});
