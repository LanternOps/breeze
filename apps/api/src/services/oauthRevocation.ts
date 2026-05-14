import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthGrants, oauthRefreshTokens } from '../db/schema/oauth';
import { revokeGrant, revokeJti } from '../oauth/revocationCache';
import { ERROR_IDS, logOauthError } from '../oauth/log';
import { ACCESS_TOKEN_TTL_SECONDS } from '../oauth/provider';
import { captureException } from './sentry';

export interface RevokeUserOauthClientResult {
  grantsRevoked: number;
  refreshTokensRevoked: number;
  /**
   * Number of Redis revocation-cache writes that failed after the DB
   * transaction committed. >0 means the DB state is fully correct but
   * some active JWTs may survive until natural TTL (≤ ACCESS_TOKEN_TTL).
   * Callers that need to alert on this should propagate to the response
   * and audit details.
   */
  cacheFailures: number;
}

/**
 * Revoke every active grant + refresh token a user holds for a single
 * OAuth client. Used by:
 *   - lifecycle: self-revoke + admin org-block + admin per-user block
 *   - approvals: "this wasn't me" suspicious-report path
 *
 * Atomic DB phase (grants UPDATE + refresh-tokens SELECT/UPDATE) under
 * db.transaction. Redis cache writes are best-effort after commit; cache
 * failures are logged + Sentry'd and surfaced via `cacheFailures` rather
 * than throwing.
 */
export async function revokeUserOauthClient(
  userId: string,
  clientId: string,
  revokedByUserId: string,
  reason: string | null
): Promise<RevokeUserOauthClientResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const now = new Date();

      const { updatedGrants, tokens } = await db.transaction(async (tx) => {
        const updatedGrants = await tx
          .update(oauthGrants)
          .set({ revokedAt: now, revokedByUserId, revokedReason: reason })
          .where(
            and(
              eq(oauthGrants.accountId, userId),
              eq(oauthGrants.clientId, clientId),
              isNull(oauthGrants.revokedAt)
            )
          )
          .returning({ id: oauthGrants.id });

        const tokens = await tx
          .select({
            id: oauthRefreshTokens.id,
            payload: oauthRefreshTokens.payload,
            expiresAt: oauthRefreshTokens.expiresAt,
          })
          .from(oauthRefreshTokens)
          .where(
            and(
              eq(oauthRefreshTokens.userId, userId),
              eq(oauthRefreshTokens.clientId, clientId),
              isNull(oauthRefreshTokens.revokedAt)
            )
          );

        if (tokens.length > 0) {
          await tx
            .update(oauthRefreshTokens)
            .set({ revokedAt: now })
            .where(inArray(oauthRefreshTokens.id, tokens.map((t) => t.id)));
        }

        return { updatedGrants, tokens };
      });

      let cacheFailures = 0;
      const onCacheFailure = (
        err: unknown,
        message: string,
        context: Record<string, unknown>
      ): void => {
        cacheFailures++;
        logOauthError({
          errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
          message,
          err,
          context: { ...context, clientId, userId },
        });
        captureException(err);
      };

      const seenGrants = new Set<string>();
      for (const tok of tokens) {
        const payload = tok.payload as { jti?: string; grantId?: string } | null;
        if (payload?.jti) {
          const ttl = Math.ceil((new Date(tok.expiresAt).getTime() - Date.now()) / 1000);
          try {
            await revokeJti(payload.jti, Math.max(ttl, 1));
          } catch (err) {
            onCacheFailure(err, 'oauth jti revocation cache write failed', {
              jti: payload.jti,
            });
          }
        }
        if (payload?.grantId && !seenGrants.has(payload.grantId)) {
          seenGrants.add(payload.grantId);
          try {
            await revokeGrant(payload.grantId, ACCESS_TOKEN_TTL_SECONDS);
          } catch (err) {
            onCacheFailure(err, 'oauth grant revocation cache write failed', {
              grantId: payload.grantId,
            });
          }
        }
      }

      for (const grant of updatedGrants) {
        if (seenGrants.has(grant.id)) continue;
        seenGrants.add(grant.id);
        try {
          await revokeGrant(grant.id, ACCESS_TOKEN_TTL_SECONDS);
        } catch (err) {
          onCacheFailure(err, 'oauth grant-only revocation cache write failed', {
            grantId: grant.id,
          });
        }
      }

      return {
        grantsRevoked: updatedGrants.length,
        refreshTokensRevoked: tokens.length,
        cacheFailures,
      };
    })
  );
}
