import { and, eq, gte, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthGrants } from '../db/schema';

/**
 * Durable Grant activity is the authority for every OAuth mint and use path.
 * Redis remains the eager revocation signal for already-issued access tokens,
 * but it is deliberately not the source of truth: its marker expires.
 */
export async function isOAuthGrantActiveInCurrentDbContext(
  grantId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(and(
      eq(oauthGrants.id, grantId),
      isNull(oauthGrants.revokedAt),
      gte(oauthGrants.expiresAt, now),
    ));
  return !!row;
}

export function isOAuthGrantDurablyActive(grantId: string, now = new Date()): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => isOAuthGrantActiveInCurrentDbContext(grantId, now)),
  );
}
