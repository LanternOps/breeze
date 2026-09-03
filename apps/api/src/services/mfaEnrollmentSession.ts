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

export interface ReplaceSessionOnMfaFactorWriteInput<T> {
  userId: string;
  identity: UserSessionIdentity;
  capability: AuthIssuanceCapability;
  expectedAuthEpoch: number;
  expectedMfaEpoch: number;
  /**
   * The live `users.mfa_enabled` this write is predicated on, folded into the
   * same conditional UPDATE as the epoch bump so the precondition is checked
   * under the row lock rather than in a racy pre-read: `false` for initial
   * enrollment (the factor must not exist yet), `true` for a rotation on an
   * already-protected account (the factor must still exist).
   */
  expectedMfaEnabled: boolean;
  revokeReason: string;
  recoveryCodes: readonly string[];
  recoveryCodeHashes: readonly string[];
  persistFactor: (tx: Tx, recoveryCodeHashes: readonly string[]) => Promise<T>;
}

export type CompleteInitialMfaEnrollmentInput<T> =
  Omit<ReplaceSessionOnMfaFactorWriteInput<T>, 'expectedMfaEnabled'>;

export interface CompletedInitialMfaEnrollment<T> {
  value: T;
  recoveryCodes: string[];
  issued: AuthorizedUserSession;
  mfaEpoch: number;
  cleanup: MfaAssuranceCleanup;
}

/**
 * Atomically replaces the caller's session while an MFA factor is written.
 *
 * One transaction advances `mfa_epoch`, revokes every existing refresh family,
 * issues a REPLACEMENT session bound to the post-bump epochs, and runs the
 * caller's factor write. The epoch bump is what evicts every OTHER live session
 * (SR2-07/SR2-19); the replacement issuance is what keeps the actor who just
 * proved themselves from being evicted along with them — which matters most
 * when the response body carries a one-time secret the user has to read
 * (recovery codes, #4480): a caller signed out by its own request never sees it.
 *
 * Expensive recovery-code generation and hashing belong before this call; every
 * authority-bearing write happens inside finishAuthIssuance's supplied
 * transaction and plaintext codes are returned only after it commits.
 *
 * The replacement identity is the CALLER's — assurance is carried forward, never
 * elevated. Enrollment passes `mfa: true` because it just installed the factor;
 * a rotation passes whatever the caller's own token carried.
 */
export async function replaceSessionOnMfaFactorWrite<T>(
  input: ReplaceSessionOnMfaFactorWriteInput<T>,
): Promise<CompletedInitialMfaEnrollment<T>> {
  if (input.identity.userId !== input.userId) {
    throw new Error('Factor-write identity does not match the target user');
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

  // Captured BEFORE the replacement token is minted, so it is always <= that
  // token's `iat`. Post-commit cleanup uses it to clamp the Redis revocation
  // cutoff strictly below the token it just issued — otherwise a >1s commit
  // makes the fresh session revoke itself (#4480).
  const issuanceNotBefore = Math.floor(Date.now() / 1000);

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
          mfaEnabled: input.expectedMfaEnabled,
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
    runPostCommitCleanup(input.userId, { preserveTokensIssuedAtOrAfter: issuanceNotBefore }),
    terminateUserRemoteSessions(input.userId),
  ]);

  return {
    ...committed,
    recoveryCodes: [...input.recoveryCodes],
    cleanup: { ...cleanup, remoteSessionsTerminated },
  };
}

/**
 * Initial-enrollment specialization: the account must still be unprotected
 * (`mfa_enabled = false`) when the epoch bump lands, and the replacement
 * session must be MFA-assured — the factor this call installs is exactly what
 * assures it.
 */
export async function completeInitialMfaEnrollment<T>(
  input: CompleteInitialMfaEnrollmentInput<T>,
): Promise<CompletedInitialMfaEnrollment<T>> {
  if (input.identity.mfa !== true) {
    throw new Error('Replacement enrollment identity must be MFA-assured');
  }
  return replaceSessionOnMfaFactorWrite({ ...input, expectedMfaEnabled: false });
}
