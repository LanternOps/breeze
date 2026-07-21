import * as dbModule from '../db';
import {
  advanceUserEpochs,
  revokeAllRefreshFamilies,
  runPostCommitCleanup,
  type Tx,
  type PostCommitCleanupResult,
} from './authLifecycle';
import { terminateUserRemoteSessions } from './remoteSessionTeardown';

export interface FactorChangeResult {
  mfaEpoch: number;
  cleanup: PostCommitCleanupResult;
  remoteSessionsTerminated: number;
}

/**
 * Invalidate MFA assurance after a factor add/remove/replace/rotate (SR2-07,
 * SR2-19). No factor-mutating handler today bumps `mfa_epoch`, revokes
 * refresh families, or terminates remote sessions — a stolen/still-live
 * access or refresh token, or an open remote-desktop session, survives an
 * MFA factor change unaffected. This closes that gap as a single reusable
 * primitive every factor handler folds its own write into.
 *
 * Atomic durable effect (invariant 3): `mutate` (the caller's factor write)
 * + mfa_epoch advance + refresh-family revoke commit together in ONE
 * transaction or not at all — a throw inside `mutate` rolls back the whole
 * transaction (no epoch bump, no revoke).
 *
 * Post-commit cleanup and remote-session teardown are best-effort and run
 * AFTER the commit: they can never restore token validity, only extend the
 * blast radius of the already-durable revocation (Redis/permission-cache/
 * OAuth cutoff, then live remote-desktop/terminal teardown). Teardown failure
 * is surfaced to the caller as `remoteSessionsTerminated === TEARDOWN_FAILED`
 * (-1) rather than swallowed — a partial operational failure here means a
 * suspended/rogue-factor session could keep a live remote session, and the
 * caller (route audit) must be able to record that.
 *
 * Context: the SELF-SERVICE callers (mfa.ts setup/disable/enable/step-up,
 * change-password) run under the caller's ambient (user-scoped) request
 * context, writing the caller's OWN `users` + OWN `refresh_token_families`
 * rows, which Shape-6 / user-id-scoped RLS admits without a system-context
 * escape. Those callers must NOT wrap this in system context — the ambient
 * context is exactly what scopes the write to themselves.
 *
 * The ONE cross-user caller — the admin MFA-reset route (POST
 * /users/:id/mfa/reset in routes/users.ts) — is the exception: it writes a
 * DIFFERENT user's rows, and `refresh_token_families` RLS only admits
 * `user_id = self OR scope = 'system'`, so the admin's ambient context would
 * silently revoke ZERO families. That caller MUST wrap this in
 * `runOutsideDbContext(() => withSystemDbAccessContext(() => ...))`, and gates
 * the cross-tenant authorization itself (requirePermission + getScopedUser)
 * BEFORE calling in — RLS is defense-in-depth there, not the primary check.
 */
export async function invalidateMfaAssuranceAfterFactorChange(
  userId: string,
  reason: string,
  mutate?: (tx: Tx) => Promise<void>,
): Promise<FactorChangeResult> {
  const epochRow = await dbModule.db.transaction(async (tx: Tx) => {
    if (mutate) await mutate(tx);
    const row = await advanceUserEpochs(tx, userId, { mfa: true });
    await revokeAllRefreshFamilies(tx, userId, reason);
    return row;
  });

  const cleanup = await runPostCommitCleanup(userId);
  const remoteSessionsTerminated = await terminateUserRemoteSessions(userId);

  return { mfaEpoch: epochRow.mfaEpoch, cleanup, remoteSessionsTerminated };
}
