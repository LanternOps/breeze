import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  organizationUsers,
  organizations,
  partners,
  partnerUsers,
  refreshTokenFamilies,
  users,
} from '../db/schema';
import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import { lockMfaPolicyPartner } from './mfaPolicy';

export interface LockedPartnerLifecycleRows {
  orgIds: string[];
  userIds: string[];
  userRows: Array<{ id: string; isPlatformAdmin: boolean }>;
  partner: {
    id: string;
    status: string;
    emailVerifiedAt: Date | null;
    paymentMethodAttachedAt: Date | null;
  } | null;
}

/**
 * Acquire the shared partner lifecycle lock order.
 *
 * Browser-transition callers already own the transition row. Every competing
 * lifecycle writer then calls this primitive before touching route-specific
 * rows: transition (if any) -> users (UUID) -> active families (UUID) ->
 * partner. Holding all user locks closes the family-snapshot insertion race.
 */
export async function lockPartnerLifecycleRows(
  tx: AuthLifecycleTransaction,
  partnerId: string,
): Promise<LockedPartnerLifecycleRows> {
  const orgRows = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.partnerId, partnerId));
  const orgIds = [...new Set(orgRows.map((row) => row.id))].sort();
  const partnerMemberships = await tx
    .select({ userId: partnerUsers.userId })
    .from(partnerUsers)
    .where(eq(partnerUsers.partnerId, partnerId));
  const orgMemberships = orgIds.length === 0
    ? []
    : await tx
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .where(inArray(organizationUsers.orgId, orgIds));
  // Include direct ownership defensively. Legacy repairs can temporarily leave
  // a user without a membership row; lifecycle cutoff must still cover them.
  const directUsers = await tx
    .select({ id: users.id, isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(eq(users.partnerId, partnerId));
  const userIds = [...new Set([
    ...partnerMemberships.map((row) => row.userId),
    ...orgMemberships.map((row) => row.userId),
    ...directUsers.map((row) => row.id),
  ])].sort();

  let userRows: Array<{ id: string; isPlatformAdmin: boolean }> = [];
  if (userIds.length > 0) {
    userRows = await tx
      .select({ id: users.id, isPlatformAdmin: users.isPlatformAdmin })
      .from(users)
      .where(inArray(users.id, userIds))
      .orderBy(users.id)
      .for('update');
    if (userRows.length !== userIds.length) {
      throw new Error('Failed to lock every partner lifecycle user');
    }

    await tx
      .select({ familyId: refreshTokenFamilies.familyId })
      .from(refreshTokenFamilies)
      .where(and(
        inArray(refreshTokenFamilies.userId, userIds),
        isNull(refreshTokenFamilies.revokedAt),
      ))
      .orderBy(refreshTokenFamilies.familyId)
      .for('update');
  }

  const [partner] = await tx
    .select({
      id: partners.id,
      status: partners.status,
      emailVerifiedAt: partners.emailVerifiedAt,
      paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1)
    .for('update');

  return { orgIds, userIds, userRows, partner: partner ?? null };
}

/** MFA-policy partner writers share the factor-mutation prefix before entering
 * the general partner lifecycle order: advisory -> users -> families -> partner. */
export async function lockPartnerMfaLifecycleRows(
  tx: AuthLifecycleTransaction,
  partnerId: string,
): Promise<LockedPartnerLifecycleRows> {
  await lockMfaPolicyPartner(tx, partnerId);
  return lockPartnerLifecycleRows(tx, partnerId);
}

export async function invalidateLockedPartnerUsersInTransaction(
  tx: AuthLifecycleTransaction,
  locked: LockedPartnerLifecycleRows,
  reason: string,
  selectedUserIds: readonly string[] = locked.userIds,
): Promise<string[]> {
  const selected = [...new Set(selectedUserIds)].sort();
  const lockedIds = new Set(locked.userIds);
  if (selected.some((id) => !lockedIds.has(id))) {
    throw new Error('Cannot invalidate a partner user that was not locked');
  }
  for (const userId of selected) {
    await advanceUserSecurityState(tx, userId);
  }
  for (const userId of selected) {
    await revokeAllUserSessionFamilies(tx, userId, reason);
  }
  return selected;
}
