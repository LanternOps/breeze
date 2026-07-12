import {
  db,
  runOutsideDbContext,
  withSystemDbAccessContext,
  type Database,
} from '../db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { users } from '../db/schema/users';

export type AuthLifecycleTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface SecurityStateAdvance {
  auth?: boolean;
  mfa?: boolean;
  email?: boolean;
  passwordReset?: boolean;
}

export function withAuthLifecycleSystemTransaction<T>(
  fn: (tx: AuthLifecycleTransaction) => Promise<T>,
): Promise<T> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => fn(db as unknown as AuthLifecycleTransaction))
  );
}

export async function advanceUserSecurityState(
  tx: AuthLifecycleTransaction,
  userId: string,
  advance: SecurityStateAdvance = { auth: true },
) {
  const updates: Record<string, unknown> = {};
  if (advance.auth) updates.authEpoch = sql`${users.authEpoch} + 1`;
  if (advance.mfa) updates.mfaEpoch = sql`${users.mfaEpoch} + 1`;
  if (advance.email) updates.emailEpoch = sql`${users.emailEpoch} + 1`;
  if (advance.passwordReset) {
    updates.passwordResetEpoch = sql`${users.passwordResetEpoch} + 1`;
  }

  if (Object.keys(updates).length === 0) {
    throw new Error(`No security state selected for user ${userId}`);
  }

  const [updated] = await tx
    .update(users)
    .set(updates)
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      authEpoch: users.authEpoch,
      mfaEpoch: users.mfaEpoch,
      emailEpoch: users.emailEpoch,
      passwordResetEpoch: users.passwordResetEpoch,
    });

  if (!updated) {
    throw new Error(`Failed to advance security state for user ${userId}`);
  }

  return updated;
}

export async function revokeAllUserSessionFamilies(
  tx: AuthLifecycleTransaction,
  userId: string,
  reason: string,
): Promise<number> {
  const revoked = await tx
    .update(refreshTokenFamilies)
    .set({
      revokedAt: sql`now()`,
      revokedReason: reason.slice(0, 64),
    })
    .where(and(
      eq(refreshTokenFamilies.userId, userId),
      isNull(refreshTokenFamilies.revokedAt),
    ))
    .returning({ familyId: refreshTokenFamilies.familyId });

  return revoked.length;
}

export async function revokeUserSessionFamily(
  tx: AuthLifecycleTransaction,
  userId: string,
  familyId: string,
  reason: string,
): Promise<number> {
  const revoked = await tx
    .update(refreshTokenFamilies)
    .set({
      revokedAt: sql`now()`,
      revokedReason: reason.slice(0, 64),
    })
    .where(and(
      eq(refreshTokenFamilies.familyId, familyId),
      eq(refreshTokenFamilies.userId, userId),
      isNull(refreshTokenFamilies.revokedAt),
    ))
    .returning({ familyId: refreshTokenFamilies.familyId });

  return revoked.length;
}

export type LogoutSessionFamilyRevocationOutcome =
  | { status: 'revoked' }
  | { status: 'already_revoked' }
  | { status: 'not_found' };

/**
 * Durably revoke one logout family and classify a zero-row conditional update
 * without creating an ownership oracle.
 *
 * The follow-up read stays inside the caller's transaction. PostgreSQL makes a
 * concurrent UPDATE wait and then re-evaluate its predicate, so a racer that
 * observes zero rows can re-read the now-committed `revoked_at` and return an
 * idempotent success. Missing and wrong-owner rows deliberately share one
 * result. An owned row that somehow remains active is an invariant failure,
 * never a successful logout.
 */
export async function revokeUserSessionFamilyForLogout(
  tx: AuthLifecycleTransaction,
  userId: string,
  familyId: string,
  reason: string,
): Promise<LogoutSessionFamilyRevocationOutcome> {
  const revokedCount = await revokeUserSessionFamily(tx, userId, familyId, reason);
  if (revokedCount > 0) {
    return { status: 'revoked' };
  }

  const [family] = await tx
    .select({ revokedAt: refreshTokenFamilies.revokedAt })
    .from(refreshTokenFamilies)
    .where(and(
      eq(refreshTokenFamilies.familyId, familyId),
      eq(refreshTokenFamilies.userId, userId),
    ))
    .limit(1);

  if (!family) {
    return { status: 'not_found' };
  }
  if (family.revokedAt !== null) {
    return { status: 'already_revoked' };
  }

  throw new Error(`Logout family ${familyId} remained active after conditional revocation`);
}
