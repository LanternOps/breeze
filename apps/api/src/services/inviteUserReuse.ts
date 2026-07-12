import { eq } from 'drizzle-orm';
import {
  organizationUsers,
  partnerUsers,
  userPasskeys,
  userSsoIdentities,
  users,
} from '../db/schema';
import type { AuthLifecycleTransaction } from './authLifecycle';

export async function findExistingInviteUser(
  tx: AuthLifecycleTransaction,
  normalizedEmail: string,
  invitingPartnerId: string,
) {
  const [existingUser] = await tx
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (!existingUser) return { kind: 'none' as const, user: null };

  const isPasswordlessDisabledUser = existingUser.status === 'disabled' && existingUser.passwordHash === null;
  if (isPasswordlessDisabledUser) {
    if (existingUser.disabledReason !== 'removed') {
      return { kind: 'blocked' as const, user: null };
    }

    const [partnerMembership, organizationMembership, ssoIdentity, passkey] = await Promise.all([
      tx
        .select({ id: partnerUsers.id })
        .from(partnerUsers)
        .where(eq(partnerUsers.userId, existingUser.id))
        .limit(1),
      tx
        .select({ id: organizationUsers.id })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, existingUser.id))
        .limit(1),
      tx
        .select({ id: userSsoIdentities.id })
        .from(userSsoIdentities)
        .where(eq(userSsoIdentities.userId, existingUser.id))
        .limit(1),
      tx
        .select({ id: userPasskeys.id })
        .from(userPasskeys)
        .where(eq(userPasskeys.userId, existingUser.id))
        .limit(1),
    ]);

    if (partnerMembership[0] || organizationMembership[0] || ssoIdentity[0] || passkey[0]) {
      return { kind: 'blocked' as const, user: null };
    }

    return { kind: 'reusable' as const, user: existingUser };
  }

  if (existingUser.partnerId !== invitingPartnerId) {
    return { kind: 'blocked' as const, user: null };
  }
  return { kind: 'reusable' as const, user: existingUser };
}
