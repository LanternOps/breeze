import { eq } from 'drizzle-orm';
import { getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users, userPasskeys } from '../db/schema';
import type { Tx } from './authLifecycle';
import { invalidateMfaAssuranceAfterFactorChange, type FactorChangeResult } from './mfaAssurance';
import { getRedis } from './redis';
import { captureException } from './sentry';

/**
 * RMM-QA-166 — the ONE place that removes every second factor from an account.
 *
 * `resetAllFactors(tx, userId)` is the in-transaction "mutate half": it clears
 * the `users` factor columns (TOTP secret, enabled flag, method, recovery
 * codes, phone) and hard-DELETEs every `user_passkeys` row (D1: rows are
 * deleted, never soft-disabled — `credential_id` is UNIQUE, so a disabled row
 * would block re-registering the same authenticator). It returns the prior
 * factor inventory for the caller's audit row.
 *
 * It NEVER advances epochs or revokes refresh families (D3). Two call shapes
 * are admitted, and both must run under a SYSTEM DB access context:
 *
 *   1. Admin/composite: `resetAllFactorsAndInvalidate(userId, reason)` — wraps
 *      this as the `mutate` of `invalidateMfaAssuranceAfterFactorChange`
 *      (mfa_epoch bump + family revoke precede the factor write inside one
 *      transaction; post-commit cleanup, remote-session teardown and the
 *      pending-artifact Redis sweep follow).
 *   2. Membership removal (`services/userNeutralization.ts`): the caller has
 *      ALREADY run `advanceUserEpochs(tx, id, { auth: true, mfa: true })` and
 *      `revokeAllRefreshFamilies(tx, id, …)` in the same transaction, then
 *      calls `neutralizeUserIfOrphaned`, which calls this last — global lock
 *      order user → families → factor rows holds at every site.
 *
 * Why the context guard (D4): `user_passkeys` RLS is
 * `user_id = breeze_current_user_id() OR breeze_current_scope() = 'system'`
 * (FORCE). Under an admin's ambient tenant context the DELETE matches ZERO
 * rows and reports success — the silent-zero-row trap. A row-count check
 * cannot catch it either: the pre-read is filtered to zero by the same policy,
 * so 0 == 0 passes. The only guard that cannot be fooled is an explicit
 * assertion on the active context's scope, thrown loudly.
 */
export class MfaFactorResetContextError extends Error {
  constructor(scope: string | undefined) {
    super(
      `resetAllFactors requires a system DB access context (active scope: ${scope ?? 'none'}); ` +
        'an ambient tenant context would delete zero user_passkeys rows under RLS',
    );
    this.name = 'MfaFactorResetContextError';
  }
}

export interface MfaFactorInventory {
  wasEnabled: boolean;
  previousMethod: 'totp' | 'sms' | 'passkey' | null;
  hadTotp: boolean;
  hadSms: boolean;
  hadRecoveryCodes: boolean;
  hadPhone: boolean;
  /** Deleted passkey rows, capped at MAX_AUDITED_PASSKEYS for the audit payload. */
  passkeys: Array<{ id: string; credentialId: string; name: string | null }>;
  /** Full count of deleted passkey rows (uncapped). */
  passkeysDeleted: number;
}

export interface AdminFactorResetResult extends FactorChangeResult {
  inventory: MfaFactorInventory;
  /** false when the post-commit Redis sweep could not run — recorded in audit, never thrown. */
  pendingSweepOk: boolean;
}

export const MAX_AUDITED_PASSKEYS = 100;

export async function resetAllFactors(tx: Tx, userId: string): Promise<MfaFactorInventory> {
  const ctx = getCurrentDbAccessContext();
  if (ctx?.scope !== 'system') {
    throw new MfaFactorResetContextError(ctx?.scope);
  }

  const [before] = await tx
    .select({
      mfaEnabled: users.mfaEnabled,
      mfaMethod: users.mfaMethod,
      mfaSecret: users.mfaSecret,
      mfaRecoveryCodes: users.mfaRecoveryCodes,
      phoneNumber: users.phoneNumber,
      phoneVerified: users.phoneVerified,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!before) {
    throw new Error(`resetAllFactors: no users row for ${userId}`);
  }

  // Lock order: the users row first (this UPDATE), then factor rows.
  const cleared = await tx
    .update(users)
    .set({
      mfaSecret: null,
      mfaEnabled: false,
      mfaMethod: null,
      mfaRecoveryCodes: null,
      phoneNumber: null,
      phoneVerified: false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (cleared.length !== 1) {
    throw new Error(`resetAllFactors: users UPDATE matched ${cleared.length} rows for ${userId}`);
  }

  // Every row — including already-disabled ones — so all credential ids are freed.
  const deleted = await tx
    .delete(userPasskeys)
    .where(eq(userPasskeys.userId, userId))
    .returning({ id: userPasskeys.id, credentialId: userPasskeys.credentialId, name: userPasskeys.name });

  return {
    wasEnabled: before.mfaEnabled === true,
    previousMethod: before.mfaMethod ?? null,
    hadTotp: before.mfaSecret != null,
    hadSms: before.mfaMethod === 'sms',
    hadRecoveryCodes: before.mfaRecoveryCodes != null,
    hadPhone: before.phoneNumber != null || before.phoneVerified === true,
    passkeys: deleted.slice(0, MAX_AUDITED_PASSKEYS).map((row) => ({ id: row.id, credentialId: row.credentialId, name: row.name ?? null })),
    passkeysDeleted: deleted.length,
  };
}

/**
 * Admin-path composite (cross-user by definition, so the system-context
 * escalation lives here; authorization — requirePermission, requireMfa,
 * getScopedUser — stays in the route BEFORE this call). One transaction:
 * mfa_epoch bump → family revoke → resetAllFactors; then post-commit cleanup,
 * remote-session teardown, and the best-effort pending-artifact sweep.
 */
export async function resetAllFactorsAndInvalidate(userId: string, reason: string): Promise<AdminFactorResetResult> {
  let inventory: MfaFactorInventory | undefined;
  const result = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      invalidateMfaAssuranceAfterFactorChange(userId, reason, async (tx) => {
        inventory = await resetAllFactors(tx, userId);
      }),
    ),
  );
  if (!inventory) {
    throw new Error('resetAllFactorsAndInvalidate: factor write did not run');
  }
  const pendingSweepOk = await sweepPendingFactorArtifacts(userId);
  return { ...result, inventory, pendingSweepOk };
}

/**
 * Per-user Redis artifacts a reset must not leave behind (D8). Step-up grants
 * (`mfa:stepup:<grantId>`) and pending logins (`mfa:pending:<tempToken>`) are
 * keyed by opaque ids and are NOT swept — they are dead by construction after
 * the mfa_epoch bump (they bind the live epochs).
 */
export function pendingFactorArtifactKeys(userId: string): string[] {
  return [
    `mfa:setup:${userId}`,
    `passkey:challenge:registration:${userId}`,
    `passkey:challenge:authentication:${userId}`,
  ];
}

/** Best-effort, post-commit, never throws. Returns false when the sweep could not run. */
export async function sweepPendingFactorArtifacts(userId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    if (!redis) {
      console.warn('[mfa-factor-reset] pending-artifact sweep skipped: Redis unavailable', { userId });
      return false;
    }
    await redis.del(...pendingFactorArtifactKeys(userId));
    return true;
  } catch (err) {
    console.error('[mfa-factor-reset] pending-artifact sweep failed', { userId });
    captureException(err);
    return false;
  }
}
