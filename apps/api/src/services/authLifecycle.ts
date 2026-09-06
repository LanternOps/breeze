import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { revokeAllUserTokens, type RevokeAllUserTokensOptions } from './tokenRevocation';
import { clearPermissionCache } from './permissions';
import { revokeAllUserOauthArtifacts } from '../oauth/grantRevocation';
import { captureException } from './sentry';

export type Tx = Parameters<Parameters<typeof dbModule.db.transaction>[0]>[0];

interface EpochRow {
  authEpoch: number;
  mfaEpoch: number;
  emailEpoch: number;
  passwordResetEpoch: number;
}

export class EpochAdvancePreconditionError extends Error {
  constructor() {
    super('User epoch precondition no longer matches');
    this.name = 'EpochAdvancePreconditionError';
  }
}

/**
 * Advance the requested epoch counters for a user INSIDE the caller's
 * transaction and return the post-mutation values. Because the increment and
 * the RETURNING happen in one statement, the value the caller mints into a new
 * token is exactly the committed one — no read-after-write race. Callers pass
 * the SAME `tx` that carries their business mutation so a rollback undoes the
 * epoch bump too (invariant: atomic or nothing).
 *
 * Which mutation advances which epoch, and what actually READS each one — keep
 * this table honest, an epoch nothing reads is a decoration, not a control
 * (#2428). The `2026-07-15-auth-epochs-and-family-expiry.sql` header claimed
 * all five classes from day one; MFA landed later (#2385) and email later still
 * (#2428), so treat this table — not that comment — as the current truth.
 *
 * | epoch                 | advanced by                                              | enforced by                                                        |
 * |-----------------------|----------------------------------------------------------|--------------------------------------------------------------------|
 * | `auth_epoch`          | status change, password change/reset, membership removal, | `aep` claim vs live row (middleware/auth.ts, /refresh)             |
 * |                       | abuse action, access review, email change                 |                                                                    |
 * | `mfa_epoch`           | any MFA factor add/remove/replace/rotate, via             | `mep` claim vs live row (middleware/auth.ts, /refresh)             |
 * |                       | `invalidateMfaAssuranceAfterFactorChange` (#2385)         |                                                                    |
 * | `email_epoch`         | committed email change (#2428)                            | `email_verification_tokens.email_epoch` vs live row at consume     |
 * | `password_reset_epoch`| forgot-password issue, password change/reset              | reset-token envelope vs live row (routes/auth/password.ts)         |
 *
 * `email_epoch` and `password_reset_epoch` are deliberately NOT JWT claims:
 * they gate purpose-specific artifacts (verification links, reset tokens), and
 * the session cutoff those changes need comes from `auth_epoch`, which every
 * caller advancing them also advances.
 */
export async function advanceUserEpochs(
  tx: Tx,
  userId: string,
  fields: { auth?: boolean; mfa?: boolean; email?: boolean; passwordReset?: boolean },
  expected?: { authEpoch?: number; mfaEpoch?: number; mfaEnabled?: boolean; status?: 'active' },
): Promise<EpochRow> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (fields.auth) set.authEpoch = sql`${users.authEpoch} + 1`;
  if (fields.mfa) set.mfaEpoch = sql`${users.mfaEpoch} + 1`;
  if (fields.email) set.emailEpoch = sql`${users.emailEpoch} + 1`;
  if (fields.passwordReset) set.passwordResetEpoch = sql`${users.passwordResetEpoch} + 1`;

  const conditions = [eq(users.id, userId)];
  if (expected?.authEpoch !== undefined) conditions.push(eq(users.authEpoch, expected.authEpoch));
  if (expected?.mfaEpoch !== undefined) conditions.push(eq(users.mfaEpoch, expected.mfaEpoch));
  if (expected?.mfaEnabled !== undefined) conditions.push(eq(users.mfaEnabled, expected.mfaEnabled));
  if (expected?.status !== undefined) conditions.push(eq(users.status, expected.status));

  const [row] = await tx
    .update(users)
    .set(set)
    .where(and(...conditions))
    .returning({
      authEpoch: users.authEpoch,
      mfaEpoch: users.mfaEpoch,
      emailEpoch: users.emailEpoch,
      passwordResetEpoch: users.passwordResetEpoch,
    });
  if (!row && expected) throw new EpochAdvancePreconditionError();
  if (!row) throw new Error(`advanceUserEpochs: user ${userId} not found`);
  return row;
}

function truncateReason(reason: string): string {
  return reason.length > 64 ? reason.slice(0, 64) : reason;
}

/**
 * Lock active refresh families in the global family_id order before a caller
 * performs a bulk revocation. The caller must already own the relevant user
 * row lock(s), preserving transition -> users -> families ordering.
 */
export async function lockActiveRefreshFamiliesForUsers(
  tx: Tx,
  userIds: readonly string[],
): Promise<void> {
  const sortedUserIds = [...new Set(userIds)].sort();
  if (sortedUserIds.length === 0) return;

  await tx
    .select({ familyId: refreshTokenFamilies.familyId })
    .from(refreshTokenFamilies)
    .where(and(
      inArray(refreshTokenFamilies.userId, sortedUserIds),
      isNull(refreshTokenFamilies.revokedAt),
    ))
    .orderBy(refreshTokenFamilies.familyId)
    .for('update');
}

/** Durably revoke every active refresh family for a user inside `tx`. */
export async function revokeAllRefreshFamilies(tx: Tx, userId: string, reason: string): Promise<void> {
  const r = truncateReason(reason);
  await tx
    .update(refreshTokenFamilies)
    .set({
      revokedAt: sql`COALESCE(revoked_at, now())`,
      revokedReason: sql`COALESCE(revoked_reason, ${r})`,
    })
    .where(eq(refreshTokenFamilies.userId, userId));
}

/** Durably revoke one family (logout) inside `tx`. */
export async function revokeRefreshFamilyById(tx: Tx, familyId: string, reason: string): Promise<void> {
  const r = truncateReason(reason);
  await tx
    .update(refreshTokenFamilies)
    .set({
      revokedAt: sql`COALESCE(revoked_at, now())`,
      revokedReason: sql`COALESCE(revoked_reason, ${r})`,
    })
    .where(eq(refreshTokenFamilies.familyId, familyId));
}

export interface PostCommitCleanupResult {
  redisOk: boolean;
  permissionCacheOk: boolean;
  oauthOk: boolean;
  oauthResult?: Awaited<ReturnType<typeof revokeAllUserOauthArtifacts>>;
}

/**
 * Hot-path cleanup that runs AFTER the durable commit. Each step is best-effort
 * and independent: a failure is logged (observable/retryable) but never undoes
 * the committed revocation and never short-circuits the others. Redis cutoff +
 * permission-cache clear + MCP OAuth grant sweep (the EdDSA bearer path never
 * sees user-JWT epochs, so grants must be revoked out-of-band).
 * Never throws — returns a per-step outcome so callers that must surface a
 * partial failure (users.ts suspension returns 503 today when the OAuth sweep
 * fails) can keep doing so with the durable revocation already committed.
 *
 * Logging is structured and bounded to the userId + error message/name —
 * never the raw token/JTI/reason payloads that triggered the mutation.
 */
export async function runPostCommitCleanup(
  userId: string,
  options?: RevokeAllUserTokensOptions,
): Promise<PostCommitCleanupResult> {
  const result: PostCommitCleanupResult = { redisOk: true, permissionCacheOk: true, oauthOk: true };

  try {
    await revokeAllUserTokens(userId, options);
  } catch (err) {
    result.redisOk = false;
    console.error('[auth-lifecycle] Redis token cutoff failed (durable revocation already committed)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    await clearPermissionCache(userId);
  } catch (err) {
    result.permissionCacheOk = false;
    console.error('[auth-lifecycle] permission-cache clear failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    result.oauthResult = await revokeAllUserOauthArtifacts(userId);
  } catch (err) {
    result.oauthOk = false;
    console.error('[auth-lifecycle] OAuth grant revocation failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  return result;
}
