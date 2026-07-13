import {
  runOutsideDbContext,
  withSystemDbAccessTransaction,
  type Database,
} from '../db';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { users } from '../db/schema/users';

export type AuthLifecycleTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface SecurityStateAdvance {
  auth?: boolean;
  mfa?: boolean;
  email?: boolean;
  passwordReset?: boolean;
}

export type TerminalLockedUser = {
  id: string;
  status: string;
  authEpoch: number;
  mfaEpoch: number;
};

export type TerminalLockedFamily = {
  familyId: string;
  userId: string;
  revokedAt: Date | null;
  absoluteExpiresAt: Date;
  currentRefreshJtiDigest: string | null;
};

export type TerminalLogoutAuthorityLocks = {
  users: Map<string, TerminalLockedUser>;
  families: Map<string, TerminalLockedFamily>;
  databaseNow: Date;
};

export function withAuthLifecycleSystemTransaction<T>(
  fn: (tx: AuthLifecycleTransaction) => Promise<T>,
): Promise<T> {
  return runOutsideDbContext(() =>
    withSystemDbAccessTransaction(fn)
  );
}

/**
 * Acquire every user lock before every family lock for terminal preparation.
 * All families owned by candidate users are included so later user-wide
 * revocation never discovers a lower-sorting family after a higher one is
 * already held. Explicit family IDs additionally cover a signed wrong-owner
 * candidate and the transition-linked just-issued family.
 */
export async function lockTerminalLogoutAuthority(
  tx: AuthLifecycleTransaction,
  input: { userIds: readonly string[]; familyIds: readonly string[] },
): Promise<TerminalLogoutAuthorityLocks> {
  const userIds = [...new Set(input.userIds.filter(Boolean))].sort();
  const familyIds = [...new Set(input.familyIds.filter(Boolean))].sort();
  if (userIds.length === 0) {
    throw new Error('Terminal logout requires at least one candidate user');
  }

  const lockedUsers = await tx
    .select({
      id: users.id,
      status: users.status,
      authEpoch: users.authEpoch,
      mfaEpoch: users.mfaEpoch,
      databaseNow: sql<Date>`clock_timestamp()`,
    })
    .from(users)
    .where(inArray(users.id, userIds))
    .orderBy(asc(users.id))
    .for('update');

  const familyPredicate = familyIds.length === 0
    ? inArray(refreshTokenFamilies.userId, userIds)
    : or(
      inArray(refreshTokenFamilies.userId, userIds),
      inArray(refreshTokenFamilies.familyId, familyIds),
    );
  const lockedFamilies = await tx
    .select({
      familyId: refreshTokenFamilies.familyId,
      userId: refreshTokenFamilies.userId,
      revokedAt: refreshTokenFamilies.revokedAt,
      absoluteExpiresAt: refreshTokenFamilies.absoluteExpiresAt,
      currentRefreshJtiDigest: refreshTokenFamilies.currentRefreshJtiDigest,
    })
    .from(refreshTokenFamilies)
    .where(familyPredicate)
    .orderBy(asc(refreshTokenFamilies.familyId))
    .for('update');

  const databaseNowValue = lockedUsers[0]?.databaseNow;
  const databaseNow = databaseNowValue instanceof Date
    ? databaseNowValue
    : new Date(databaseNowValue ?? Number.NaN);
  if (!Number.isFinite(databaseNow.getTime())) {
    throw new Error('Terminal logout could not read authoritative database time');
  }

  return {
    users: new Map(lockedUsers.map(({ databaseNow: _databaseNow, ...user }) => [user.id, user])),
    families: new Map(lockedFamilies.map((family) => [family.familyId, family])),
    databaseNow,
  };
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

/**
 * Advance the factor-configuration epoch and durably revoke every refresh
 * family. Callers own the surrounding transaction so the factor/policy write
 * and both invalidation effects commit or roll back together.
 */
export async function invalidateUserMfaAssurance(
  tx: AuthLifecycleTransaction,
  userId: string,
  reason: string,
) {
  const securityState = await advanceUserSecurityState(tx, userId, { mfa: true });
  const revokedFamilyCount = await revokeAllUserSessionFamilies(tx, userId, reason);
  return { securityState, revokedFamilyCount };
}

/** Set-based epoch/family invalidation after callers have locked users stably. */
export async function invalidateUsersMfaAssurance(
  tx: AuthLifecycleTransaction,
  userIds: readonly string[],
  reason: string,
): Promise<{ advancedUserCount: number; revokedFamilyCount: number }> {
  const uniqueUserIds = [...new Set(userIds)].sort();
  if (uniqueUserIds.length === 0) {
    return { advancedUserCount: 0, revokedFamilyCount: 0 };
  }
  const advanced = await tx
    .update(users)
    .set({ mfaEpoch: sql`${users.mfaEpoch} + 1` })
    .where(inArray(users.id, uniqueUserIds))
    .returning({ id: users.id });
  if (advanced.length !== uniqueUserIds.length) {
    throw new Error('Failed to advance MFA assurance for every affected user');
  }
  const revoked = await tx
    .update(refreshTokenFamilies)
    .set({
      revokedAt: sql`now()`,
      revokedReason: reason.slice(0, 64),
    })
    .where(and(
      inArray(refreshTokenFamilies.userId, uniqueUserIds),
      isNull(refreshTokenFamilies.revokedAt),
    ))
    .returning({ familyId: refreshTokenFamilies.familyId });
  return {
    advancedUserCount: advanced.length,
    revokedFamilyCount: revoked.length,
  };
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
