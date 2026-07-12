import { eq } from 'drizzle-orm';
import { organizationUsers, partnerUsers, users } from '../db/schema';
import type { AuthLifecycleTransaction } from './authLifecycle';

export async function neutralizeUserIfOrphaned(
  tx: AuthLifecycleTransaction,
  userId: string,
): Promise<boolean> {
  const [partnerLink] = await tx
    .select({ id: partnerUsers.id })
    .from(partnerUsers)
    .where(eq(partnerUsers.userId, userId))
    .limit(1);
  if (partnerLink) return false;

  const [orgLink] = await tx
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(eq(organizationUsers.userId, userId))
    .limit(1);
  if (orgLink) return false;

  const neutralized = await tx
    .update(users)
    .set({
      status: 'disabled',
      disabledReason: 'removed',
      passwordHash: null,
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      mfaRecoveryCodes: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (neutralized.length === 0) {
    throw new Error(`Failed to neutralize orphaned user ${userId}`);
  }
  return true;
}
