import { createHash } from 'node:crypto';
import { inArray, lt, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../../db';
// Direct module (not the schema barrel) so route tests that replace the
// barrel still build the real revocation lookup.
import { portalSessionRevocations } from '../../db/schema/portalSessionRevocations';

/**
 * How long a signed-out portal token stays on record. A portal session slides
 * (24 h from its last use), and a cache entry can only have been extended by a
 * request admitted before logout committed, so seven lifetimes is far past the
 * last moment any cache — including one restored from an older snapshot — can
 * still hold the key.
 */
export const PORTAL_SESSION_REVOCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_BATCH = 200;

/** SHA-256 hex of a portal session token. The token itself is never stored. */
export function portalSessionTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * `true` when this session token was signed out. Meant to ride the portal
 * user lookup in portalAuthMiddleware as a column, so the check costs one
 * primary-key probe and no extra round trip.
 */
export function portalSessionRevokedSql(token: string): SQL<boolean> {
  const digest = portalSessionTokenDigest(token);
  return sql<boolean>`exists (
    select 1 from ${portalSessionRevocations}
    where ${portalSessionRevocations.tokenDigest} = ${digest}
  )`;
}

/**
 * Durably record that `token` was signed out. Commits in its own system
 * transaction — outside any request transaction — before the caller answers,
 * so a success response always means the token is refused from now on, even
 * if the cache delete that follows fails or Redis later loses it. Throws when
 * the record cannot be written; callers must not report a successful logout.
 */
export async function revokePortalSessionDurably(token: string, portalUserId: string): Promise<void> {
  const tokenDigest = portalSessionTokenDigest(token);
  const expiresAt = new Date(Date.now() + PORTAL_SESSION_REVOCATION_RETENTION_MS);
  await dbModule.runOutsideDbContext(() => dbModule.withSystemDbAccessContext(async () => {
    await dbModule.db
      .insert(portalSessionRevocations)
      .values({ tokenDigest, portalUserId, expiresAt })
      .onConflictDoNothing({ target: portalSessionRevocations.tokenDigest });
  }));

  // Housekeeping only, in its own transaction: a failure here must never
  // undo the record above or turn a completed logout into an error.
  try {
    await dbModule.runOutsideDbContext(() => dbModule.withSystemDbAccessContext(async () => {
      const expired = dbModule.db
        .select({ tokenDigest: portalSessionRevocations.tokenDigest })
        .from(portalSessionRevocations)
        .where(lt(portalSessionRevocations.expiresAt, sql`now()`))
        .limit(PURGE_BATCH);
      await dbModule.db
        .delete(portalSessionRevocations)
        .where(inArray(portalSessionRevocations.tokenDigest, expired));
    }));
  } catch (error) {
    console.warn('[portal] Failed to purge expired session revocation records:', error instanceof Error ? error.message : error);
  }
}
