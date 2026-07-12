import './setup';

import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import {
  organizationUsers,
  partners,
  refreshTokenFamilies,
  users,
} from '../../db/schema';
import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
  withAuthLifecycleSystemTransaction,
  type AuthLifecycleTransaction,
} from '../../services/authLifecycle';
import { neutralizeUserIfOrphaned } from '../../services/userMembershipLifecycle';
import { invalidatePartnerUsersInTransaction } from '../../services/tenantLifecycle';
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
    await insertFamily(target.id, familyId);

    const actorCount = await runOutsideDbContext(() => withDbAccessContext({
      scope: 'organization',
      orgId: org.id,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [],
      userId: actor.id,
      currentPartnerId: partner.id,
    }, () => revokeAllUserSessionFamilies(
      db as unknown as AuthLifecycleTransaction,
      target.id,
      'actor-attempt',
    )));
    expect(actorCount).toBe(0);

    const systemCount = await withAuthLifecycleSystemTransaction((tx) =>
      revokeAllUserSessionFamilies(tx, target.id, 'system-revoke')
    );
    expect(systemCount).toBe(1);
    const [family] = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId));
    expect(family?.revokedReason).toBe('system-revoke');
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
});
