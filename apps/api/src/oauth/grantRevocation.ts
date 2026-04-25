import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { oauthGrants, oauthRefreshTokens } from '../db/schema';
import { revokeGrant, revokeJti } from './revocationCache';
import { ACCESS_TOKEN_TTL_SECONDS } from './provider';
import { ERROR_IDS, logOauthError } from './log';

export interface UserOauthRevocationResult {
  grantsRevoked: number;
  refreshTokensRevoked: number;
  jtisRevoked: number;
}

/**
 * Revoke ALL OAuth artifacts belonging to a user. Used when a user is
 * suspended/disabled so every active access JWT, refresh token, and Grant is
 * killed immediately rather than surviving until natural expiry.
 *
 * Mechanics (mirrors the per-client path in `connectedApps.ts`):
 *   1. Stamp `revokedAt` on every non-revoked refresh token row for the user.
 *   2. For each refresh token, write the jti + grantId into the revocation
 *      cache so bearer middleware rejects any in-flight access JWT.
 *   3. Write a grant-level marker for every Grant row so sibling JWTs minted
 *      without a refresh token (direct authorize flows) are also rejected.
 *
 * We intentionally do NOT delete the oauth_grants / oauth_refresh_tokens rows:
 * keeping them simplifies audit trail and matches what `connectedApps.ts`
 * does (stamp `revokedAt`, not DELETE). The oidc-provider adapter will treat
 * revoked rows as expired.
 *
 * Any cache write failure bubbles up — callers must treat this as a hard
 * failure (suspension is only half-done otherwise).
 */
export async function revokeAllUserOauthArtifacts(userId: string): Promise<UserOauthRevocationResult> {
  // 1. Revoke refresh tokens + their jtis + grant markers from token payloads.
  const tokens = await db
    .select({
      id: oauthRefreshTokens.id,
      payload: oauthRefreshTokens.payload,
      expiresAt: oauthRefreshTokens.expiresAt,
    })
    .from(oauthRefreshTokens)
    .where(and(eq(oauthRefreshTokens.userId, userId), isNull(oauthRefreshTokens.revokedAt)));

  const now = new Date();
  const seenGrants = new Set<string>();
  let jtisRevoked = 0;
  let refreshTokensRevoked = 0;

  for (const token of tokens) {
    await db
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(eq(oauthRefreshTokens.id, token.id));
    refreshTokensRevoked += 1;

    const payload = token.payload as { jti?: string; grantId?: string } | null;
    const jti = payload?.jti;
    const grantId = payload?.grantId;

    if (jti) {
      const ttl = Math.ceil((new Date(token.expiresAt).getTime() - Date.now()) / 1000);
      try {
        await revokeJti(jti, Math.max(ttl, 1));
        jtisRevoked += 1;
      } catch (err) {
        logOauthError({
          errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
          message: 'user-suspension jti revocation cache write failed',
          err,
          context: { jti, userId },
        });
        throw err;
      }
    }

    if (grantId && !seenGrants.has(grantId)) {
      seenGrants.add(grantId);
      try {
        await revokeGrant(grantId, ACCESS_TOKEN_TTL_SECONDS);
      } catch (err) {
        logOauthError({
          errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
          message: 'user-suspension grant revocation cache write failed',
          err,
          context: { grantId, userId },
        });
        throw err;
      }
    }
  }

  // 2. Also cover Grants that have no active refresh token yet (e.g. just
  //    after /authorize before the first /token exchange, or after a grant
  //    whose only refresh token was already rotated-and-revoked). The cache
  //    marker is keyed by grant id, so double-writing the same marker is a
  //    cheap no-op.
  const grants = await db
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(eq(oauthGrants.accountId, userId));

  let grantsRevoked = 0;
  for (const grant of grants) {
    if (seenGrants.has(grant.id)) continue;
    seenGrants.add(grant.id);
    try {
      await revokeGrant(grant.id, ACCESS_TOKEN_TTL_SECONDS);
      grantsRevoked += 1;
    } catch (err) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
        message: 'user-suspension grant-only revocation cache write failed',
        err,
        context: { grantId: grant.id, userId },
      });
      throw err;
    }
  }

  return {
    grantsRevoked: seenGrants.size,
    refreshTokensRevoked,
    jtisRevoked,
  };
}
