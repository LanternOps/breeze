import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthClients, oauthClientPartnerGrants, oauthGrants, oauthRefreshTokens } from '../db/schema';
import { revokeGrant, revokeJti } from './revocationCache';
import { ERROR_IDS, logOauthError } from './log';

// Grant-marker TTL must outlive the longest access JWT minted under a grant.
// Kept in sync with `ACCESS_TOKEN_TTL_SECONDS` in oauth/provider.ts (1800s
// since #2363 — a shorter marker here would leave already-minted access JWTs
// alive after the marker expired). We define it locally (rather than
// importing provider) so this module stays off the
// provider → adapter → revocationService import chain — adapter deliberately
// avoids importing provider to prevent a require cycle. Exported so
// provider.test.ts can assert the constants never drift
// (GRANT_REVOCATION_TTL_SECONDS >= ACCESS_TOKEN_TTL_SECONDS).
export const GRANT_REVOCATION_TTL_SECONDS = 1800;

/**
 * Explicit revocation scope for a shared OAuth (DCR) client. A single
 * `client_id` is shared across every partner that installs the app, so
 * "revoke this client" is ambiguous without a scope:
 *
 *   - `global`  — registration-management DELETE of the client itself.
 *                 Revokes EVERY family and disables the client row.
 *   - `partner` — one partner disconnects the shared app for their tenant.
 *                 Revokes only that partner's families and removes only their
 *                 join row; other partners keep working.
 *   - `user`    — one user revokes one client (self-service / admin lifecycle).
 */
export type OAuthRevocationScope =
  | { kind: 'global' }
  | { kind: 'partner'; partnerId: string }
  | { kind: 'user'; userId: string; partnerId?: string };

export interface RevokeClientFamiliesResult {
  grants: number;
  refreshTokens: number;
}

/**
 * Central grant-family revocation.
 *
 * Grant discovery is authoritative from `oauth_grants` — refresh-token rows
 * are supplemental (they drive per-token jti markers only). This closes the
 * code-only-grant gap (MCP-OAUTH-07): an auth-code access token minted without
 * a refresh token still has an `oauth_grants` row, so it is discovered and
 * revoked here even though no refresh row exists.
 *
 * Ordering is FAIL CLOSED (design §3):
 *   1. resolve affected grants + active refresh rows;
 *   2. write grant-wide + token jti Redis markers — THROW on any failure so
 *      the caller can surface a 503 and NOT proceed (never hide/disable an app
 *      whose in-flight access JWTs we could not mark revoked);
 *   3. stamp `oauth_grants.revoked_at/by/reason` + refresh `revoked_at`;
 *   4. partner scope: delete only that partner's join row;
 *   5. global scope only: set `oauth_clients.disabled_at` LAST, after every
 *      family is revoked.
 *
 * Steps 3-5 all run inside the single transaction that
 * `withSystemDbAccessContext` already holds, so they are atomic together
 * without opening a nested transaction (nesting inside a held context would
 * pin a second pooled connection idle-in-transaction — #1105).
 *
 * Idempotent: a repeat call finds no active families (revoked_at filter), so
 * it writes no markers, mutates no grant/refresh rows, and the global-scope
 * client disable is guarded by `disabled_at IS NULL`.
 *
 * Runs in an explicit system DB context (callers may be inside a request).
 */
export async function revokeClientFamilies(
  clientId: string,
  scope: OAuthRevocationScope,
  opts: { revokedByUserId?: string; reason?: string } = {},
): Promise<RevokeClientFamiliesResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => revokeClientFamiliesInSystemContext(clientId, scope, opts)),
  );
}

function grantScopeCondition(clientId: string, scope: OAuthRevocationScope): SQL[] {
  const conds: SQL[] = [eq(oauthGrants.clientId, clientId), isNull(oauthGrants.revokedAt)];
  if (scope.kind === 'partner') {
    conds.push(eq(oauthGrants.partnerId, scope.partnerId));
  } else if (scope.kind === 'user') {
    conds.push(eq(oauthGrants.accountId, scope.userId));
    if (scope.partnerId) conds.push(eq(oauthGrants.partnerId, scope.partnerId));
  }
  return conds;
}

function refreshScopeCondition(clientId: string, scope: OAuthRevocationScope): SQL[] {
  const conds: SQL[] = [eq(oauthRefreshTokens.clientId, clientId), isNull(oauthRefreshTokens.revokedAt)];
  if (scope.kind === 'partner') {
    conds.push(eq(oauthRefreshTokens.partnerId, scope.partnerId));
  } else if (scope.kind === 'user') {
    conds.push(eq(oauthRefreshTokens.userId, scope.userId));
    if (scope.partnerId) conds.push(eq(oauthRefreshTokens.partnerId, scope.partnerId));
  }
  return conds;
}

async function revokeClientFamiliesInSystemContext(
  clientId: string,
  scope: OAuthRevocationScope,
  opts: { revokedByUserId?: string; reason?: string },
): Promise<RevokeClientFamiliesResult> {
  // 1. Authoritative discovery: grants first (source of truth), refresh rows
  //    supplemental (jti markers only).
  const grants = await db
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(and(...grantScopeCondition(clientId, scope)));

  const refreshRows = await db
    .select({ id: oauthRefreshTokens.id, expiresAt: oauthRefreshTokens.expiresAt })
    .from(oauthRefreshTokens)
    .where(and(...refreshScopeCondition(clientId, scope)));

  // 2. Redis markers BEFORE any DB mutation. A failure here throws so the
  //    caller returns 503 and does not proceed — the grant marker is the only
  //    signal that kills already-minted access JWTs before natural expiry.
  for (const grant of grants) {
    try {
      await revokeGrant(grant.id, GRANT_REVOCATION_TTL_SECONDS);
    } catch (err) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
        message: 'revocation-service grant marker write failed',
        err,
        context: { clientId, grantId: grant.id, scope: scope.kind },
      });
      throw err;
    }
  }

  for (const row of refreshRows) {
    // Key the jti marker on the token ROW id, never on payload.jti — Task 3
    // removes jti from the refresh payload but the row id (its digest) remains
    // the authoritative token identifier.
    const ttl = Math.max(Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / 1000), 1);
    try {
      await revokeJti(row.id, ttl);
    } catch (err) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
        message: 'revocation-service refresh-token marker write failed',
        err,
        context: { clientId, tokenId: row.id, scope: scope.kind },
      });
      throw err;
    }
  }

  // 3-5. DB mutations run inside the held system-context transaction, so they
  //      are atomic without a nested transaction.
  const now = new Date();
  const grantIds = grants.map((g) => g.id);
  const refreshIds = refreshRows.map((r) => r.id);

  if (grantIds.length > 0) {
    await db
      .update(oauthGrants)
      .set({
        revokedAt: now,
        revokedByUserId: opts.revokedByUserId ?? null,
        revokedReason: opts.reason ?? null,
      })
      .where(inArray(oauthGrants.id, grantIds));
  }

  if (refreshIds.length > 0) {
    await db
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(inArray(oauthRefreshTokens.id, refreshIds));
  }

  // 4. Partner disconnect removes only this partner's join row; the shared
  //    client and every other partner's grants are untouched.
  if (scope.kind === 'partner') {
    await db
      .delete(oauthClientPartnerGrants)
      .where(
        and(
          eq(oauthClientPartnerGrants.clientId, clientId),
          eq(oauthClientPartnerGrants.partnerId, scope.partnerId),
        ),
      );
  }

  // 5. Global registration-management deletion disables the shared client
  //    LAST, only after every family has been revoked. Guarded on
  //    `disabled_at IS NULL` so a repeat call is a true no-op.
  if (scope.kind === 'global') {
    await db
      .update(oauthClients)
      .set({ disabledAt: now })
      .where(and(eq(oauthClients.id, clientId), isNull(oauthClients.disabledAt)));
  }

  return { grants: grants.length, refreshTokens: refreshRows.length };
}
