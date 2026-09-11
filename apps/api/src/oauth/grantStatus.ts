import { and, eq, gt, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthAuthorizationCodes, oauthGrants, oauthRefreshTokens } from '../db/schema';

/**
 * Durable Grant activity is the authority for every OAuth mint and use path.
 * Redis remains the eager revocation signal for already-issued access tokens,
 * but it is deliberately not the source of truth: its marker expires.
 *
 * This is the ONE definition of "this Grant is still live". Every caller —
 * adapter lookups, scope resolution, the bearer-admission join — composes this
 * condition rather than re-spelling the predicate, so a future change to what
 * "active" means cannot land on some paths and miss others.
 */
export function activeGrantCondition(grantId: string, now: Date): SQL {
  return and(
    eq(oauthGrants.id, grantId),
    isNull(oauthGrants.revokedAt),
    gte(oauthGrants.expiresAt, now),
  ) as SQL;
}

export async function isOAuthGrantActiveInCurrentDbContext(
  grantId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(activeGrantCondition(grantId, now));
  return !!row;
}

export function isOAuthGrantDurablyActive(grantId: string, now = new Date()): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => isOAuthGrantActiveInCurrentDbContext(grantId, now)),
  );
}

export interface DurableGrantRevocationOptions {
  grantIds: string[];
  /** Written to `oauth_grants.revoked_reason`. */
  reason: string | null;
  /** Written to `oauth_grants.revoked_by_user_id` when the caller knows the actor. */
  revokedByUserId?: string | null;
  /**
   * Also revoke every unrevoked refresh token whose payload `grantId` matches.
   * Callers that already hold the exact refresh-token ids they mean to revoke
   * (scoped disconnects) leave this off and revoke those rows themselves.
   */
  cascadeRefreshTokens?: boolean;
  now?: Date;
}

/**
 * The single durable "this Grant is dead" write, shared by every revocation
 * path: connected-app disconnect, tenant lifecycle, oidc-provider's own
 * `revokeGrant` (authorization-code replay) and refresh-token reuse detection.
 *
 * Order is load-bearing and mirrors the marker-then-stamp discipline in
 * `revocationService.ts`: live capabilities (authorization codes, sibling
 * refresh tokens) die BEFORE `revoked_at` is stamped. A stamped-but-unswept
 * Grant would read as revoked in the DB while its in-flight artifacts still
 * minted successors.
 *
 * Runs in the caller's DB context — every caller already holds a system
 * context (and usually a transaction), so the whole sweep is atomic with
 * whatever else that caller is doing.
 */
export async function revokeGrantsDurablyInCurrentDbContext(
  opts: DurableGrantRevocationOptions,
): Promise<void> {
  const { grantIds } = opts;
  if (grantIds.length === 0) return;
  const now = opts.now ?? new Date();

  // A pre-revocation authorization code is itself a live capability. Mark it
  // consumed with the provider's canonical payload shape so a later exchange
  // follows the normal invalid_grant path instead of minting a fresh family
  // once the eager Redis marker has expired.
  await db
    .update(oauthAuthorizationCodes)
    .set({
      consumedAt: now,
      payload: sql`jsonb_set(${oauthAuthorizationCodes.payload}, '{consumed}', ${Math.floor(now.getTime() / 1000)}::text::jsonb, true)`,
    })
    .where(and(
      inArray(sql<string>`${oauthAuthorizationCodes.payload}->>'grantId'`, grantIds),
      isNull(oauthAuthorizationCodes.consumedAt),
      gt(oauthAuthorizationCodes.expiresAt, now),
    ));

  if (opts.cascadeRefreshTokens) {
    await db
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(and(
        inArray(sql<string>`${oauthRefreshTokens.payload}->>'grantId'`, grantIds),
        isNull(oauthRefreshTokens.revokedAt),
      ));
  }

  // `revoked_at IS NULL` keeps the FIRST revocation's timestamp and reason:
  // a later sweep must not overwrite the forensic record of why a Grant died.
  const stamp: { revokedAt: Date; revokedReason: string | null; revokedByUserId?: string | null } = {
    revokedAt: now,
    revokedReason: opts.reason,
  };
  if (opts.revokedByUserId !== undefined) {
    stamp.revokedByUserId = opts.revokedByUserId;
  }
  await db
    .update(oauthGrants)
    .set(stamp)
    .where(and(
      inArray(oauthGrants.id, grantIds),
      isNull(oauthGrants.revokedAt),
    ));
}
