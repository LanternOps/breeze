/**
 * Refresh-Token Family Mint Helper (Task 7 follow-up)
 *
 * Centralises the family-creation dance so every authenticated token-mint
 * path uses one source of truth. Without this helper, /login, /mfa/verify,
 * /register-partner, /accept-invite, and /sso/callback all had to repeat
 * the same 4-step sequence — and missing it on any path (most importantly
 * /mfa/verify) silently disabled reuse-detection for that cohort of users.
 *
 * Sequence (single-source-of-truth, OAuth 2.1 / RFC 9700 §4.13.2):
 *   1. Generate a fresh familyId UUID.
 *   2. INSERT into refresh_token_families under system scope (audit row).
 *   3. Caller mints the token pair with `{ refreshFam: familyId }`.
 *   4. Caller calls bindRefreshJtiToFamily(refreshJti, familyId) so the
 *      jti → family mapping is hot in Redis for the next /refresh.
 *
 * Steps 1+2 live here; 3+4 stay in the route handler so each path can apply
 * its own surrounding logic (db wrapping, audit trail, etc).
 */
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  refreshTokenFamilies,
  type RefreshTokenFamily,
} from '../db/schema/refreshTokenFamilies';
import { rememberJtiFamily } from './tokenRevocation';
import type { AuthLifecycleTransaction } from './authLifecycle';

const REFRESH_TOKEN_FAMILY_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Mints a fresh refresh-token family for a user and persists the audit row
 * to refresh_token_families under system scope (matches the existing /login
 * pattern — RLS Shape 6, system-scope OR branch).
 *
 * Returns the new familyId, which the caller must pass to createTokenPair
 * via `{ refreshFam: familyId }` and then to bindRefreshJtiToFamily once the
 * pair is minted.
 *
 * If the insert fails this throws — callers should let the error propagate
 * (no token has been minted yet, so failing the request is the right
 * outcome; the alternative is a token without a family, which is exactly
 * the bug this helper exists to prevent).
 */
export async function mintRefreshTokenFamily(
  userId: string,
  options: { tx?: AuthLifecycleTransaction } = {},
): Promise<string> {
  const familyId = randomUUID();
  const absoluteExpiresAt = new Date(Date.now() + REFRESH_TOKEN_FAMILY_ABSOLUTE_LIFETIME_MS);
  if (options.tx) {
    await options.tx.insert(refreshTokenFamilies).values({
      familyId,
      userId,
      absoluteExpiresAt,
    });
    return familyId;
  }
  await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () => {
      await dbModule.db.insert(refreshTokenFamilies).values({
        familyId,
        userId,
        absoluteExpiresAt,
      });
    })
  );
  return familyId;
}

/**
 * Loads an existing family from PostgreSQL and accepts it only while it is
 * owned by the expected user, durably unrevoked, and inside its fixed absolute
 * lifetime. The caller receives no distinction between missing and inactive
 * families, avoiding an ownership/status oracle.
 */
export async function getActiveRefreshTokenFamily(
  familyId: string,
  userId: string,
  options: { tx?: AuthLifecycleTransaction } = {},
): Promise<RefreshTokenFamily | null> {
  const query = (database: Pick<AuthLifecycleTransaction, 'select'>) =>
    database
        .select()
        .from(refreshTokenFamilies)
        .where(and(
          eq(refreshTokenFamilies.familyId, familyId),
          eq(refreshTokenFamilies.userId, userId)
        ))
        .limit(1);
  const rows = options.tx
    ? await query(options.tx)
    : await dbModule.runOutsideDbContext(() =>
      dbModule.withSystemDbAccessContext(() => query(dbModule.db))
    );
  const family = rows[0];
  const absoluteExpiresAtMs = family?.absoluteExpiresAt instanceof Date
    ? family.absoluteExpiresAt.getTime()
    : Number.NaN;
  if (
    !family
    || family.userId !== userId
    || family.revokedAt !== null
    || !Number.isFinite(absoluteExpiresAtMs)
    || absoluteExpiresAtMs <= Date.now()
  ) {
    return null;
  }
  return family;
}

/**
 * Best-effort bind of the newly-minted refresh jti to its family in Redis.
 * Mirrors the /login post-mint dance. Failure here is non-fatal: the family
 * id is also encoded in the JWT `fam` claim, so the family-revocation check
 * still works from the verified payload.
 */
export async function bindRefreshJtiToFamily(jti: string, familyId: string): Promise<void> {
  await rememberJtiFamily(jti, familyId);
}
