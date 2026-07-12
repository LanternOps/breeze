import './setup';

import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import {
  organizationUsers,
  organizations,
  partnerUsers,
  partners,
  refreshTokenFamilies,
  sessions,
  ssoProviders,
  userSsoIdentities,
  users,
} from '../../db/schema';
import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
  revokeUserSessionFamily,
  withAuthLifecycleSystemTransaction,
  type AuthLifecycleTransaction,
} from '../../services/authLifecycle';
import { neutralizeUserIfOrphaned } from '../../services/userMembershipLifecycle';
import { invalidatePartnerUsersInTransaction } from '../../services/tenantLifecycle';
import { findExistingInviteUser } from '../../services/inviteUserReuse';
import {
  authorizeOrganizationLifecycleWrite,
  organizationLifecycleWriteCondition,
  type OrganizationLifecycleActor,
} from '../../services/lifecycleAuthorization';
import { invalidateAllUserSessionsAsSystem } from '../../services/session';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
import { getTestDb } from './setup';

async function insertFamily(userId: string, familyId: string) {
  await getTestDb().insert(refreshTokenFamilies).values({
    familyId,
    userId,
    absoluteExpiresAt: new Date(Date.now() + 86_400_000),
  });
}

describe('transactional authentication lifecycle', () => {
  it('actor RLS cannot revoke another user family while true system scope can', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const actor = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: true });
    const target = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: true });
    const familyId = '10000000-0000-4000-8000-000000000001';
    const actorDeniedFamilyId = '10000000-0000-4000-8000-000000000006';
    await insertFamily(target.id, familyId);
    await insertFamily(target.id, actorDeniedFamilyId);

    let systemCount = 0;
    const actorCount = await runOutsideDbContext(() => withDbAccessContext({
      scope: 'organization',
      orgId: org.id,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [],
      userId: actor.id,
      currentPartnerId: partner.id,
    }, async () => {
      // Deliberately nest the system helper while the actor transaction is
      // active: this proves runOutsideDbContext escapes AsyncLocalStorage.
      systemCount = await withAuthLifecycleSystemTransaction((tx) =>
        revokeUserSessionFamily(tx, target.id, familyId, 'system-revoke')
      );
      return revokeUserSessionFamily(
        db as unknown as AuthLifecycleTransaction,
        target.id,
        actorDeniedFamilyId,
        'actor-attempt',
      );
    }));
    expect(actorCount).toBe(0);
    expect(systemCount).toBe(1);
    const [family] = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId));
    expect(family?.revokedReason).toBe('system-revoke');
    const [actorDeniedFamily] = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, actorDeniedFamilyId));
    expect(actorDeniedFamily?.revokedAt).toBeNull();
  });

  it('rolls back business mutation, epoch advance, and family revocation on a database error', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, withMembership: true });
    const familyId = '10000000-0000-4000-8000-000000000002';
    await insertFamily(user.id, familyId);

    await expect(withAuthLifecycleSystemTransaction(async (tx) => {
      await tx.update(users).set({ status: 'disabled' }).where(eq(users.id, user.id));
      await advanceUserSecurityState(tx, user.id);
      await revokeAllUserSessionFamilies(tx, user.id, 'must-roll-back');
      await tx.execute(sql`select 1 / 0`);
    })).rejects.toThrow();

    const [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    const [family] = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId));
    expect(row?.status).toBe('active');
    expect(row?.authEpoch).toBe(1);
    expect(family?.revokedAt).toBeNull();
  });

  it('DELETE RETURNING preserves a user with another org membership and neutralizes the last-membership tombstone', async () => {
    const partner = await createPartner();
    const reviewedOrg = await createOrganization({ partnerId: partner.id });
    const primaryOrg = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: primaryOrg.id });
    const reviewedRole = await createRole({ scope: 'organization', partnerId: partner.id, orgId: reviewedOrg.id });
    const primaryRole = await createRole({ scope: 'organization', partnerId: partner.id, orgId: primaryOrg.id });
    await assignUserToOrganization(user.id, reviewedOrg.id, reviewedRole.id);
    await assignUserToOrganization(user.id, primaryOrg.id, primaryRole.id);

    const firstNeutralized = await withAuthLifecycleSystemTransaction(async (tx) => {
      const deleted = await tx.delete(organizationUsers).where(and(
        eq(organizationUsers.orgId, reviewedOrg.id),
        eq(organizationUsers.userId, user.id),
      )).returning({ userId: organizationUsers.userId });
      expect(deleted).toEqual([{ userId: user.id }]);
      await advanceUserSecurityState(tx, user.id);
      await revokeAllUserSessionFamilies(tx, user.id, 'review-removal');
      return neutralizeUserIfOrphaned(tx, user.id);
    });
    expect(firstNeutralized).toBe(false);
    let [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(row?.status).toBe('active');

    const lastNeutralized = await withAuthLifecycleSystemTransaction(async (tx) => {
      await tx.delete(organizationUsers).where(and(
        eq(organizationUsers.orgId, primaryOrg.id),
        eq(organizationUsers.userId, user.id),
      ));
      await advanceUserSecurityState(tx, user.id);
      await revokeAllUserSessionFamilies(tx, user.id, 'last-membership-removed');
      return neutralizeUserIfOrphaned(tx, user.id);
    });
    expect(lastNeutralized).toBe(true);
    [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(row?.status).toBe('disabled');
    expect(row?.passwordHash).toBeNull();
    expect(row?.disabledReason).toBe('removed');
  });

  it('invalidates users atomically on partner suspension and reactivation', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, withMembership: true });
    const suspendedFamily = '10000000-0000-4000-8000-000000000003';
    await insertFamily(user.id, suspendedFamily);

    await withAuthLifecycleSystemTransaction(async (tx) => {
      await tx.update(partners).set({ status: 'suspended' }).where(eq(partners.id, partner.id));
      await invalidatePartnerUsersInTransaction(tx as any, partner.id, 'partner-status-changed');
    });
    const reactivatedFamily = '10000000-0000-4000-8000-000000000004';
    await insertFamily(user.id, reactivatedFamily);
    await withAuthLifecycleSystemTransaction(async (tx) => {
      await tx.update(partners).set({ status: 'active' }).where(eq(partners.id, partner.id));
      await invalidatePartnerUsersInTransaction(tx as any, partner.id, 'partner-status-changed');
    });

    const [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    const families = await getTestDb().select().from(refreshTokenFamilies).where(eq(refreshTokenFamilies.userId, user.id));
    expect(row?.authEpoch).toBe(3);
    expect(families).toHaveLength(2);
    expect(families.every((family) => family.revokedAt !== null)).toBe(true);
  });

  it('blocks cross-partner active-user invite reuse without lifecycle or membership side effects', async () => {
    const invitingPartner = await createPartner();
    const victimPartner = await createPartner();
    const victim = await createUser({ partnerId: victimPartner.id, withMembership: true });
    const familyId = '10000000-0000-4000-8000-000000000005';
    await insertFamily(victim.id, familyId);

    const decision = await withAuthLifecycleSystemTransaction((tx) =>
      findExistingInviteUser(tx, victim.email.toLowerCase(), invitingPartner.id)
    );

    expect(decision).toEqual({ kind: 'blocked', user: null });
    const [after] = await getTestDb().select().from(users).where(eq(users.id, victim.id));
    const links = await getTestDb().select().from(partnerUsers).where(and(
      eq(partnerUsers.partnerId, invitingPartner.id),
      eq(partnerUsers.userId, victim.id),
    ));
    const [family] = await getTestDb().select().from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, familyId));
    expect(after?.authEpoch).toBe(1);
    expect(links).toEqual([]);
    expect(family?.revokedAt).toBeNull();
  });

  it('reuses only a genuine removed orphan and blocks ambiguous disabled identities', async () => {
    const invitingPartner = await createPartner();
    const priorPartner = await createPartner();
    const manualSsoUser = await createUser({ partnerId: priorPartner.id });
    const lingeringMember = await createUser({ partnerId: priorPartner.id, withMembership: true });
    const retainedSsoUser = await createUser({ partnerId: priorPartner.id });
    const genuineOrphan = await createUser({ partnerId: priorPartner.id });
    const [provider] = await getTestDb().insert(ssoProviders).values({
      partnerId: priorPartner.id,
      name: 'Lifecycle integration IdP',
      type: 'oidc',
      status: 'active',
    }).returning();

    await getTestDb().update(users).set({
      status: 'disabled',
      passwordHash: null,
      disabledReason: null,
    }).where(eq(users.id, manualSsoUser.id));
    await getTestDb().insert(userSsoIdentities).values({
      userId: manualSsoUser.id,
      providerId: provider.id,
      externalId: 'manual-sso-subject',
      email: manualSsoUser.email,
    });

    await getTestDb().update(users).set({
      status: 'disabled',
      passwordHash: null,
      disabledReason: 'removed',
    }).where(eq(users.id, lingeringMember.id));

    await getTestDb().update(users).set({
      status: 'disabled',
      passwordHash: null,
      disabledReason: 'removed',
    }).where(eq(users.id, retainedSsoUser.id));
    await getTestDb().insert(userSsoIdentities).values({
      userId: retainedSsoUser.id,
      providerId: provider.id,
      externalId: 'retained-sso-subject',
      email: retainedSsoUser.email,
    });

    await getTestDb().update(users).set({
      status: 'disabled',
      passwordHash: null,
      disabledReason: 'removed',
    }).where(eq(users.id, genuineOrphan.id));

    const [manualDecision, membershipDecision, identityDecision] = await Promise.all([
      withAuthLifecycleSystemTransaction((tx) =>
        findExistingInviteUser(tx, manualSsoUser.email, invitingPartner.id)),
      withAuthLifecycleSystemTransaction((tx) =>
        findExistingInviteUser(tx, lingeringMember.email, invitingPartner.id)),
      withAuthLifecycleSystemTransaction((tx) =>
        findExistingInviteUser(tx, retainedSsoUser.email, invitingPartner.id)),
    ]);
    expect(manualDecision).toEqual({ kind: 'blocked', user: null });
    expect(membershipDecision).toEqual({ kind: 'blocked', user: null });
    expect(identityDecision).toEqual({ kind: 'blocked', user: null });

    const rehomed = await withAuthLifecycleSystemTransaction(async (tx) => {
      const decision = await findExistingInviteUser(tx, genuineOrphan.email, invitingPartner.id);
      if (decision.kind !== 'reusable' || !decision.user) return [];
      return tx.update(users).set({ partnerId: invitingPartner.id }).where(eq(users.id, decision.user.id)).returning({
        id: users.id,
        partnerId: users.partnerId,
      });
    });
    expect(rehomed).toEqual([{ id: genuineOrphan.id, partnerId: invitingPartner.id }]);

    const unchangedAmbiguousUsers = await getTestDb().select({ id: users.id, partnerId: users.partnerId })
      .from(users)
      .where(sql`${users.id} in (${manualSsoUser.id}, ${lingeringMember.id}, ${retainedSsoUser.id})`);
    expect(unchangedAmbiguousUsers).toHaveLength(3);
    expect(unchangedAmbiguousUsers.every((row) => row.partnerId === priorPartner.id)).toBe(true);
  });

  it('rechecks live organization, partner, and system actor authority inside the system transaction', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const orgActor = await createUser({ partnerId: partnerB.id, orgId: orgB.id });
    const orgRole = await createRole({ scope: 'organization', partnerId: partnerB.id, orgId: orgB.id });
    await assignUserToOrganization(orgActor.id, orgB.id, orgRole.id);
    const partnerActor = await createUser({ partnerId: partnerB.id, withMembership: true });
    const systemActor = await createUser({ partnerId: partnerA.id });
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, systemActor.id));

    const attemptWrite = (actor: OrganizationLifecycleActor, status: 'active' | 'suspended' | 'trial') =>
      withAuthLifecycleSystemTransaction(async (tx) => {
        const authorization = await authorizeOrganizationLifecycleWrite(tx, actor, orgB.id);
        if (!authorization.authorized) return [];
        return tx.update(organizations)
          .set({ status })
          .where(organizationLifecycleWriteCondition(orgB.id, authorization.targetPartnerId))
          .returning({ id: organizations.id, status: organizations.status });
      });

    const organizationActor: OrganizationLifecycleActor = {
      scope: 'organization',
      userId: orgActor.id,
      partnerId: partnerB.id,
      orgId: orgB.id,
    };
    const partnerActorContext: OrganizationLifecycleActor = {
      scope: 'partner',
      userId: partnerActor.id,
      partnerId: partnerB.id,
      orgId: null,
    };
    const systemActorContext: OrganizationLifecycleActor = {
      scope: 'system',
      userId: systemActor.id,
      partnerId: null,
      orgId: null,
    };

    await getTestDb().delete(organizationUsers).where(and(
      eq(organizationUsers.userId, orgActor.id),
      eq(organizationUsers.orgId, orgB.id),
    ));
    expect(await attemptWrite(organizationActor, 'suspended')).toEqual([]);
    await assignUserToOrganization(orgActor.id, orgB.id, orgRole.id);
    expect(await attemptWrite(organizationActor, 'suspended')).toEqual([{ id: orgB.id, status: 'suspended' }]);

    await getTestDb().update(partnerUsers).set({ orgAccess: 'none', orgIds: null }).where(and(
      eq(partnerUsers.userId, partnerActor.id),
      eq(partnerUsers.partnerId, partnerB.id),
    ));
    expect(await attemptWrite(partnerActorContext, 'active')).toEqual([]);
    await getTestDb().update(partnerUsers).set({ orgAccess: 'selected', orgIds: [orgB.id] }).where(and(
      eq(partnerUsers.userId, partnerActor.id),
      eq(partnerUsers.partnerId, partnerB.id),
    ));
    expect(await attemptWrite(partnerActorContext, 'active')).toEqual([{ id: orgB.id, status: 'active' }]);
    await getTestDb().update(partnerUsers).set({ orgAccess: 'all', orgIds: null }).where(and(
      eq(partnerUsers.userId, partnerActor.id),
      eq(partnerUsers.partnerId, partnerB.id),
    ));
    expect(await attemptWrite(partnerActorContext, 'trial')).toEqual([{ id: orgB.id, status: 'trial' }]);

    expect(await attemptWrite(systemActorContext, 'active')).toEqual([{ id: orgB.id, status: 'active' }]);
    expect(await attemptWrite({ ...systemActorContext, orgId: orgA.id }, 'suspended')).toEqual([]);
    await getTestDb().update(users).set({ isPlatformAdmin: false }).where(eq(users.id, systemActor.id));
    expect(await attemptWrite(systemActorContext, 'suspended')).toEqual([]);

    const [unchanged] = await getTestDb().select().from(organizations).where(eq(organizations.id, orgB.id));
    expect(unchanged?.status).toBe('active');
  });

  it('password-reset system cleanup deletes target sessions while actor scope cannot', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const actor = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: true });
    const target = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: true });
    await getTestDb().insert(sessions).values({
      userId: target.id,
      tokenHash: 'target-reset-session',
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const actorDeleted = await runOutsideDbContext(() => withDbAccessContext({
      scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id],
      accessiblePartnerIds: [], userId: actor.id, currentPartnerId: partner.id,
    }, () => db.delete(sessions).where(eq(sessions.userId, target.id)).returning({ id: sessions.id })));
    expect(actorDeleted).toEqual([]);

    const contextlessDeleted = await runOutsideDbContext(() =>
      db.delete(sessions).where(eq(sessions.userId, target.id)).returning({ id: sessions.id })
    );
    expect(contextlessDeleted).toEqual([]);

    await expect(invalidateAllUserSessionsAsSystem(target.id)).resolves.toBe(1);
    const remaining = await getTestDb().select().from(sessions).where(eq(sessions.userId, target.id));
    expect(remaining).toEqual([]);
  });
});
