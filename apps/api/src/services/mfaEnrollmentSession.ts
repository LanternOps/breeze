import {
  finishAuthIssuance,
  AuthIssuanceConflictError,
  type AuthIssuanceCapability,
} from './authBrowserTransition';
import {
  advanceUserEpochs,
  EpochAdvancePreconditionError,
  revokeAllRefreshFamilies,
  runPostCommitCleanup,
  type PostCommitCleanupResult,
  type Tx,
} from './authLifecycle';
import { terminateUserRemoteSessions } from './remoteSessionTeardown';
import {
  issueUserSession,
  type AuthorizedUserSession,
  type UserSessionIdentity,
} from './userSession';

export type MfaAssuranceCleanup = PostCommitCleanupResult & {
  remoteSessionsTerminated: number;
};

export interface CompleteInitialMfaEnrollmentInput<T> {
  userId: string;
  identity: UserSessionIdentity;
  capability: AuthIssuanceCapability;
  expectedAuthEpoch: number;
  expectedMfaEpoch: number;
  revokeReason: string;
  recoveryCodes: readonly string[];
  recoveryCodeHashes: readonly string[];
  persistFactor: (tx: Tx, recoveryCodeHashes: readonly string[]) => Promise<T>;
}

export interface CompletedInitialMfaEnrollment<T> {
  value: T;
  recoveryCodes: string[];
  issued: AuthorizedUserSession;
  mfaEpoch: number;
  cleanup: MfaAssuranceCleanup;
}

/**
 * Atomically replaces a pre-enrollment session with an MFA-assured session.
 * Expensive recovery-code generation and hashing belong before this call;
 * every authority-bearing write happens inside finishAuthIssuance's supplied
 * transaction and plaintext codes are returned only after it commits.
 */
export async function completeInitialMfaEnrollment<T>(
  input: CompleteInitialMfaEnrollmentInput<T>,
): Promise<CompletedInitialMfaEnrollment<T>> {
  if (input.identity.userId !== input.userId) {
    throw new Error('Enrollment identity does not match the target user');
  }
  if (input.identity.mfa !== true) {
    throw new Error('Replacement enrollment identity must be MFA-assured');
  }
  if (
    !Number.isInteger(input.expectedAuthEpoch)
    || input.expectedAuthEpoch < 0
    || !Number.isInteger(input.expectedMfaEpoch)
    || input.expectedMfaEpoch < 0
    || input.recoveryCodes.length === 0
    || input.recoveryCodes.length !== input.recoveryCodeHashes.length
  ) {
    throw new Error('Expected auth/MFA epochs and recovery-code counts must be valid');
  }

  const committed = await finishAuthIssuance(input.capability, async (tx) => {
    // Global order: transition (finishAuthIssuance), user, old families, new
    // family/session, factor-specific rows.
    let epochs;
    try {
      epochs = await advanceUserEpochs(
        tx,
        input.userId,
        { mfa: true },
        {
          authEpoch: input.expectedAuthEpoch,
          mfaEpoch: input.expectedMfaEpoch,
          mfaEnabled: false,
          status: 'active',
        },
      );
    } catch (error) {
      if (error instanceof EpochAdvancePreconditionError) {
        throw new AuthIssuanceConflictError();
      }
      throw error;
    }
    await revokeAllRefreshFamilies(tx, input.userId, input.revokeReason);
    const issued = await issueUserSession(input.identity, {
      tx,
      capability: input.capability,
      expectedEpochs: { authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch },
    });
    const value = await input.persistFactor(tx, input.recoveryCodeHashes);
    return { value, issued, mfaEpoch: epochs.mfaEpoch };
  });

  const [cleanup, remoteSessionsTerminated] = await Promise.all([
    runPostCommitCleanup(input.userId),
    terminateUserRemoteSessions(input.userId),
  ]);

  return {
    ...committed,
    recoveryCodes: [...input.recoveryCodes],
    cleanup: { ...cleanup, remoteSessionsTerminated },
  };
}
