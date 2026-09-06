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
  /**
   * The plaintext codes to hand back to the caller, paired one-for-one with
   * `recoveryCodeHashes` (which is what actually lands in the row). REQUIRED
   * and non-empty on this shape: a supplied set is the account's only valid
   * one from this commit on, so an empty or missing pair would be a silent
   * lockout. A factor REMOVAL (#4934 `/mfa/disable`) installs no codes and
   * must go through `completeMfaFactorRemoval`, which omits these fields by
   * TYPE rather than by convention — the #5008 review found that an optional
   * pair here let a rotation caller forget it and persist `[]` unnoticed.
   */
  recoveryCodes: readonly string[];
  recoveryCodeHashes: readonly string[];
  persistFactor: (tx: Tx, recoveryCodeHashes: readonly string[]) => Promise<T>;
}

export type CompleteInitialMfaEnrollmentInput<T> =
  Omit<ReplaceSessionOnMfaFactorWriteInput<T>, 'expectedMfaEnabled'>;

/**
 * Factor REMOVAL shape: the account is left holding no code set and there is
 * no one-time secret to reveal, so the pair is absent from the type entirely.
 * `expectedMfaEnabled` is fixed at `true` — removing a factor that is not there
 * is a precondition failure, not a no-op.
 */
export type CompleteMfaFactorRemovalInput<T> = Omit<
  ReplaceSessionOnMfaFactorWriteInput<T>,
  'expectedMfaEnabled' | 'recoveryCodes' | 'recoveryCodeHashes'
>;

/** Internal: the union both public entry points funnel into. */
type MfaFactorWriteCoreInput<T> =
  | (ReplaceSessionOnMfaFactorWriteInput<T> & { factorWrite: 'install' | 'rotate' })
  | (CompleteMfaFactorRemovalInput<T> & { expectedMfaEnabled: true; factorWrite: 'remove' });

export interface MfaFactorSessionReplacement<T> {
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
 * Three shapes call this, differing only in `expectedMfaEnabled` and whether a
 * code set accompanies the write: initial enrollment (factor must not exist yet,
 * codes required), rotation on a protected account (factor must still exist,
 * codes required), and factor REMOVAL (factor must still exist, no codes — a
 * self-disable that evicted its own caller bounced the user to
 * /login?reason=session-expired the moment they turned MFA off, #4934).
 *
 * Expensive recovery-code generation and hashing belong before this call; every
 * authority-bearing write happens inside finishAuthIssuance's supplied
 * transaction and plaintext codes are returned only after it commits.
 *
 * The replacement identity is the CALLER's — assurance is carried forward, never
 * elevated. Enrollment passes `mfa: true` because it just installed the factor;
 * a rotation or a removal passes whatever the caller's own token carried.
 */
export async function replaceSessionOnMfaFactorWrite<T>(
  input: ReplaceSessionOnMfaFactorWriteInput<T>,
): Promise<MfaFactorSessionReplacement<T>> {
  // Rotation shape (and, via completeInitialMfaEnrollment, install): the code
  // pair is mandatory. Checked at runtime too, since JS callers can still pass
  // `undefined` past the type.
  const codes = (input as { recoveryCodes?: readonly string[] }).recoveryCodes;
  const hashes = (input as { recoveryCodeHashes?: readonly string[] }).recoveryCodeHashes;
  if (codes === undefined || hashes === undefined || codes.length === 0 || codes.length !== hashes.length) {
    throw new Error(
      'A factor rotation must supply a non-empty, count-matched recovery-code pair; use completeMfaFactorRemoval to remove a factor',
    );
  }
  return replaceSessionOnMfaFactorWriteCore({ ...input, factorWrite: 'rotate' });
}

/**
 * Factor-removal specialization (#4934 `/mfa/disable`): the account must still
 * be protected when the bump lands, no code set is installed, and the caller's
 * own assurance is carried forward. The only sanctioned way to call the
 * primitive without recovery codes.
 */
export async function completeMfaFactorRemoval<T>(
  input: CompleteMfaFactorRemovalInput<T>,
): Promise<MfaFactorSessionReplacement<T>> {
  if ('recoveryCodes' in input || 'recoveryCodeHashes' in input) {
    throw new Error('A factor removal installs no recovery codes; use replaceSessionOnMfaFactorWrite to rotate them');
  }
  return replaceSessionOnMfaFactorWriteCore({ ...input, expectedMfaEnabled: true, factorWrite: 'remove' });
}

async function replaceSessionOnMfaFactorWriteCore<T>(
  input: MfaFactorWriteCoreInput<T>,
): Promise<MfaFactorSessionReplacement<T>> {
  if (input.identity.userId !== input.userId) {
    throw new Error('Factor-write identity does not match the target user');
  }
  const recoveryCodes = input.factorWrite === 'remove' ? [] : input.recoveryCodes;
  const recoveryCodeHashes = input.factorWrite === 'remove' ? [] : input.recoveryCodeHashes;
  if (
    !Number.isInteger(input.expectedAuthEpoch)
    || input.expectedAuthEpoch < 0
    || !Number.isInteger(input.expectedMfaEpoch)
    || input.expectedMfaEpoch < 0
    || recoveryCodes.length !== recoveryCodeHashes.length
    || (input.factorWrite !== 'remove' && recoveryCodes.length === 0)
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
    const value = await input.persistFactor(tx, recoveryCodeHashes);
    return { value, issued, mfaEpoch: epochs.mfaEpoch };
  });

  const [cleanup, remoteSessionsTerminated] = await Promise.all([
    runPostCommitCleanup(input.userId, { preserveTokensIssuedAtOrAfter: issuanceNotBefore }),
    terminateUserRemoteSessions(input.userId),
  ]);

  return {
    ...committed,
    recoveryCodes: [...recoveryCodes],
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
): Promise<MfaFactorSessionReplacement<T>> {
  if (input.identity.mfa !== true) {
    throw new Error('Replacement enrollment identity must be MFA-assured');
  }
  // Enrollment is the one factor write that must never omit its code set: the
  // codes it returns are the only escape hatch a user locked out of their own
  // factor has, and they exist exactly once. (An omitted pair is the
  // removal shape — `completeMfaFactorRemoval`, #4934 — never this one.)
  if (input.recoveryCodes === undefined || input.recoveryCodes.length === 0) {
    throw new Error('Initial MFA enrollment must install a recovery-code set');
  }
  return replaceSessionOnMfaFactorWriteCore({ ...input, expectedMfaEnabled: false, factorWrite: 'install' });
}
