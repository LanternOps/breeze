import { and, eq, isNull } from 'drizzle-orm';
import { userPasskeys, users } from '../db/schema';
import type { AuthLifecycleTransaction } from './authLifecycle';
import { lockMfaPolicyPartner } from './mfaPolicy';

/**
 * Mandatory lock contract shared by assurance issuance and every Task 5
 * factor/effective-policy mutation:
 *
 *   partner MFA-policy advisory lock -> user row -> passkey/factor rows
 *
 * Mutations must acquire these locks in this exact order before changing a
 * factor or policy, advancing mfa_epoch, or revoking session families. Keeping
 * one exported primitive makes order drift (and the deadlocks/TOCTOU gaps it
 * creates) mechanically avoidable.
 */
export async function lockMfaAssuranceState(
  tx: AuthLifecycleTransaction,
  input: { partnerId: string | null; userId: string },
) {
  if (input.partnerId) {
    await lockMfaPolicyPartner(tx, input.partnerId);
  }
  const userRows = await tx
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .for('update')
    .limit(1);
  const passkeyRows = await tx
    .select({ id: userPasskeys.id })
    .from(userPasskeys)
    .where(and(
      eq(userPasskeys.userId, input.userId),
      isNull(userPasskeys.disabledAt),
    ))
    .for('update')
    .limit(100);
  return { user: userRows[0], activePasskeyCount: passkeyRows.length };
}
