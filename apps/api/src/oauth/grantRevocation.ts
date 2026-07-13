import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthGrants, oauthRefreshTokens } from '../db/schema';
import { revokeGrant, revokeJti } from './revocationCache';
import { ACCESS_TOKEN_TTL_SECONDS } from './provider';
import { ERROR_IDS, logOauthError } from './log';

export interface UserOauthRevocationResult {
  grantsRevoked: number;
  refreshTokensRevoked: number;
  jtisRevoked: number;
}

async function revokeOauthArtifactsByColumn(
  target: 'user' | 'partner' | 'org',
  value: string,
  logContextKey: 'userId' | 'partnerId' | 'orgId',
): Promise<UserOauthRevocationResult> {
  const refreshColumn = target === 'user'
    ? oauthRefreshTokens.userId
    : target === 'partner'
      ? oauthRefreshTokens.partnerId
      : oauthRefreshTokens.orgId;
  const grantColumn = target === 'user'
    ? oauthGrants.accountId
    : target === 'partner'
      ? oauthGrants.partnerId
      : oauthGrants.orgId;

  const tokens = await db
    .select({
      id: oauthRefreshTokens.id,
      expiresAt: oauthRefreshTokens.expiresAt,
    })
    .from(oauthRefreshTokens)
    .where(and(eq(refreshColumn, value), isNull(oauthRefreshTokens.revokedAt)));

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

    // Key the jti marker on the token ROW id, never on payload.jti — Task 3
    // removes jti from the refresh payload, so payload is no longer a reliable
    // discovery source. The row id (its digest) is the authoritative token id.
    const ttl = Math.ceil((new Date(token.expiresAt).getTime() - Date.now()) / 1000);
    try {
      await revokeJti(token.id, Math.max(ttl, 1));
      jtisRevoked += 1;
    } catch (err) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
        message: 'tenant-lifecycle jti revocation cache write failed',
        err,
        context: { tokenId: token.id, [logContextKey]: value },
      });
      throw err;
    }
  }

  // Grant discovery is authoritative from oauth_grants — never from refresh
  // payload grantIds. This is what makes code-only grants (no refresh row)
  // still get a revocation marker. Already-revoked grants are skipped so a
  // repeat call is a no-op (matches revocationService.ts).
  const grants = await db
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(and(eq(grantColumn, value), isNull(oauthGrants.revokedAt)));

  for (const grant of grants) {
    if (seenGrants.has(grant.id)) continue;
    seenGrants.add(grant.id);
    try {
      await revokeGrant(grant.id, ACCESS_TOKEN_TTL_SECONDS);
    } catch (err) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
        message: 'tenant-lifecycle grant revocation cache write failed',
        err,
        context: { grantId: grant.id, [logContextKey]: value },
      });
      throw err;
    }
  }

  // Stamp revoked_at AFTER every marker write succeeded (fail closed, same
  // ordering as revocationService.ts): a stamped-but-unmarked grant would look
  // revoked in the DB while its in-flight access JWTs kept working.
  if (seenGrants.size > 0) {
    await db
      .update(oauthGrants)
      .set({ revokedAt: now, revokedReason: `tenant-lifecycle:${target}` })
      .where(inArray(oauthGrants.id, [...seenGrants]));
  }

  return {
    grantsRevoked: seenGrants.size,
    refreshTokensRevoked,
    jtisRevoked,
  };
}

function inExplicitSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Revoke ALL OAuth artifacts belonging to a user. Used when a user is
 * suspended/disabled so every active access JWT, refresh token, and Grant is
 * killed immediately rather than surviving until natural expiry.
 *
 * Mechanics (grants-driven discovery):
 *   1. Stamp `revokedAt` on every non-revoked refresh token row for the user.
 *   2. For each refresh token, write a jti marker keyed on the token ROW id
 *      (not payload.jti — Task 3 removes it) so bearer middleware rejects any
 *      in-flight access JWT.
 *   3. Write a grant-level marker for every Grant row discovered from the
 *      authoritative oauth_grants table, so code-only grants (auth-code access
 *      tokens with no refresh row) are also rejected. Once every marker is
 *      written, stamp `revoked_at` on those grant rows so revocation survives
 *      marker expiry / Redis loss (durability parity with revocationService).
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
  return inExplicitSystemContext(() => revokeOauthArtifactsByColumn('user', userId, 'userId'));
}

export async function revokeAllPartnerOauthArtifacts(partnerId: string): Promise<UserOauthRevocationResult> {
  return inExplicitSystemContext(() => revokeOauthArtifactsByColumn('partner', partnerId, 'partnerId'));
}

export async function revokeAllOrgOauthArtifacts(orgId: string): Promise<UserOauthRevocationResult> {
  return inExplicitSystemContext(() => revokeOauthArtifactsByColumn('org', orgId, 'orgId'));
}
