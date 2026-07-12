import { and, eq, isNull } from 'drizzle-orm';
import {
  organizationUsers,
  organizations,
  partnerUsers,
} from '../db/schema';
import {
  invalidateAllUserSessions,
} from './session';
import {
  invalidateUserMfaAssurance,
  invalidateUsersMfaAssurance,
  withAuthLifecycleSystemTransaction,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import { lockMfaAssuranceState } from './mfaAssuranceLocks';
import { lockMfaPolicyPartner } from './mfaPolicy';
import { clearPermissionCache } from './permissions';
import { runPostCommitCleanup } from './postCommitCleanup';
import {
  TEARDOWN_FAILED,
  terminateUserRemoteSessions,
} from './remoteSessionTeardown';
import { revokeAllUserTokens } from './tokenRevocation';

export class MfaAssuranceMutationStaleError extends Error {
  constructor() {
    super('MFA assurance state changed; reauthentication is required');
    this.name = 'MfaAssuranceMutationStaleError';
  }
}

export interface LockedMfaMutationInput {
  userId: string;
  partnerId: string | null;
  authEpoch: number;
  mfaEpoch: number;
  reason: string;
}

/**
 * Mandatory transaction shell for one user's factor mutation. The callback is
 * invoked only after the shared partner -> user -> factor lock contract and
 * live epoch/status revalidation. Its write, the epoch advance, and durable
 * family revocation share the same PostgreSQL transaction.
 */
export async function runLockedMfaMutation<T>(
  input: LockedMfaMutationInput,
  mutate: (
    tx: AuthLifecycleTransaction,
    locked: Awaited<ReturnType<typeof lockMfaAssuranceState>>,
  ) => Promise<T>,
) {
  return withAuthLifecycleSystemTransaction(async (tx) => {
    const locked = await lockMfaAssuranceState(tx, {
      partnerId: input.partnerId,
      userId: input.userId,
    });
    if (!locked.user
      || locked.user.id !== input.userId
      || locked.user.status !== 'active'
      || locked.user.authEpoch !== input.authEpoch
      || locked.user.mfaEpoch !== input.mfaEpoch) {
      throw new MfaAssuranceMutationStaleError();
    }
    const result = await mutate(tx, locked);
    const invalidation = await invalidateUserMfaAssurance(
      tx,
      input.userId,
      input.reason,
    );
    return { result, ...invalidation };
  });
}

export interface MfaPolicyInvalidationInput {
  partnerId: string;
  orgId?: string;
  reason: string;
}

/**
 * Invalidate every current member affected by a partner or organization MFA
 * policy write. The partner advisory lock is acquired before membership
 * discovery; users are then locked in stable ID order through the exact shared
 * assurance lock helper before their epochs/families are changed.
 */
export async function invalidateMfaPolicyAssurance(
  tx: AuthLifecycleTransaction,
  input: MfaPolicyInvalidationInput,
): Promise<{ userIds: string[]; revokedFamilyCount: number }> {
  await lockMfaPolicyPartner(tx, input.partnerId);

  let memberRows: Array<{ userId: string }>;
  if (input.orgId) {
    memberRows = await tx
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .innerJoin(organizations, eq(organizations.id, organizationUsers.orgId))
      .where(and(
        eq(organizationUsers.orgId, input.orgId),
        eq(organizations.partnerId, input.partnerId),
        isNull(organizations.deletedAt),
      ));
  } else {
    const partnerMembers = await tx
      .select({ userId: partnerUsers.userId })
      .from(partnerUsers)
      .where(eq(partnerUsers.partnerId, input.partnerId));
    const organizationMembers = await tx
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .innerJoin(organizations, eq(organizations.id, organizationUsers.orgId))
      .where(and(
        eq(organizations.partnerId, input.partnerId),
        isNull(organizations.deletedAt),
      ));
    memberRows = [...partnerMembers, ...organizationMembers];
  }

  const userIds = [...new Set(memberRows.map((row) => row.userId))].sort();
  for (const userId of userIds) {
    const locked = await lockMfaAssuranceState(tx, {
      partnerId: input.partnerId,
      userId,
    });
    if (!locked.user || locked.user.id !== userId) {
      throw new Error(`MFA policy member ${userId} disappeared while locked`);
    }
  }
  const invalidation = await invalidateUsersMfaAssurance(tx, userIds, input.reason);
  return { userIds, revokedFamilyCount: invalidation.revokedFamilyCount };
}

/** Post-commit acceleration/teardown. Durable DB invalidation already won. */
export async function cleanupMfaAssuranceUsers(
  userIds: readonly string[],
  extraOperations: ReadonlyArray<{ name: string; run: () => Promise<unknown> }> = [],
) {
  const uniqueUserIds = [...new Set(userIds)].sort();
  const cleanup = await runPostCommitCleanup([...uniqueUserIds.flatMap((userId) => [
    { name: `sessions:${userId}`, run: () => invalidateAllUserSessions(userId) },
    { name: `user-tokens:${userId}`, run: () => revokeAllUserTokens(userId) },
    { name: `permission-cache:${userId}`, run: () => clearPermissionCache(userId) },
    {
      name: `remote-sessions:${userId}`,
      run: async () => {
        const result = await terminateUserRemoteSessions(userId);
        if (result === TEARDOWN_FAILED) {
          throw new Error(`Remote-session teardown failed for user ${userId}`);
        }
      },
    },
  ]), ...extraOperations]);
  for (const failure of cleanup.failures) {
    console.error('[mfa] post-commit assurance cleanup failed', failure.name, failure.error);
  }
  return cleanup;
}
