import { eq, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { revokeAllUserTokens } from './tokenRevocation';
import { clearPermissionCache } from './permissions';
import { revokeAllUserOauthArtifacts } from '../oauth/grantRevocation';

export type Tx = Parameters<Parameters<typeof dbModule.db.transaction>[0]>[0];

interface EpochRow {
  authEpoch: number;
  mfaEpoch: number;
  emailEpoch: number;
  passwordResetEpoch: number;
}

/**
 * Advance the requested epoch counters for a user INSIDE the caller's
 * transaction and return the post-mutation values. Because the increment and
 * the RETURNING happen in one statement, the value the caller mints into a new
 * token is exactly the committed one — no read-after-write race. Callers pass
 * the SAME `tx` that carries their business mutation so a rollback undoes the
 * epoch bump too (invariant: atomic or nothing).
 */
export async function advanceUserEpochs(
  tx: Tx,
  userId: string,
  fields: { auth?: boolean; mfa?: boolean; email?: boolean; passwordReset?: boolean },
): Promise<EpochRow> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (fields.auth) set.authEpoch = sql`${users.authEpoch} + 1`;
  if (fields.mfa) set.mfaEpoch = sql`${users.mfaEpoch} + 1`;
  if (fields.email) set.emailEpoch = sql`${users.emailEpoch} + 1`;
  if (fields.passwordReset) set.passwordResetEpoch = sql`${users.passwordResetEpoch} + 1`;

  const [row] = await tx
    .update(users)
    .set(set)
    .where(eq(users.id, userId))
    .returning({
      authEpoch: users.authEpoch,
      mfaEpoch: users.mfaEpoch,
      emailEpoch: users.emailEpoch,
      passwordResetEpoch: users.passwordResetEpoch,
    });
  if (!row) throw new Error(`advanceUserEpochs: user ${userId} not found`);
  return row;
}

function truncateReason(reason: string): string {
  return reason.length > 64 ? reason.slice(0, 64) : reason;
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
export async function runPostCommitCleanup(userId: string): Promise<PostCommitCleanupResult> {
  const result: PostCommitCleanupResult = { redisOk: true, permissionCacheOk: true, oauthOk: true };

  try {
    await revokeAllUserTokens(userId);
  } catch (err) {
    result.redisOk = false;
    console.error('[auth-lifecycle] Redis token cutoff failed (durable revocation already committed)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await clearPermissionCache(userId);
  } catch (err) {
    result.permissionCacheOk = false;
    console.error('[auth-lifecycle] permission-cache clear failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    result.oauthResult = await revokeAllUserOauthArtifacts(userId);
  } catch (err) {
    result.oauthOk = false;
    console.error('[auth-lifecycle] OAuth grant revocation failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
