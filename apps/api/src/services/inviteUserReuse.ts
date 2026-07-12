import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
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
  const isReusableTombstone = existingUser.status === 'disabled' && existingUser.passwordHash === null;
  if (!isReusableTombstone && existingUser.partnerId !== invitingPartnerId) {
    return { kind: 'blocked' as const, user: null };
  }
  return { kind: 'reusable' as const, user: existingUser };
}
