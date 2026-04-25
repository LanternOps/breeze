import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/**
 * Resolve the OIDC account for a given `sub`.
 *
 * Security (M-B4, audit 2026-04-24): only return active users. If a user is
 * suspended/disabled or still in the 'invited' state, returning their row
 * would let oidc-provider mint id_tokens / fulfil consent for an account
 * that is no longer authorized. With `status='active'` in the WHERE clause,
 * findAccount returns undefined for any non-active user → oidc-provider
 * treats the account as not-found and the flow halts cleanly.
 *
 * TODO(security): a suspended user with an existing access token continues
 * to work until natural token expiry (~10 minutes). Cross-cutting
 * suspension-driven token revocation is tracked separately — when a user
 * status flips to 'disabled', every grant_id under that user should be
 * pushed to the grant-revocation cache. Out of scope for this PR (would
 * touch user-management routes that aren't in the security-fixes branch).
 */
export async function findAccount(_ctx: any, sub: string): Promise<any> {
  const row = await asSystem(async () => {
    const [r] = await db.select({
      id: users.id,
      email: users.email,
      name: users.name,
    })
      .from(users)
      .where(and(eq(users.id, sub), eq(users.status, 'active')))
      .limit(1);
    return r ?? null;
  });

  if (!row) return undefined;
  return {
    accountId: row.id,
    async claims(_use: string, _scope: string) {
      // Tenant claims (partner_id/org_id) come from the Grant in extraTokenClaims (provider.ts).
      return {
        sub: row.id,
        email: row.email,
        name: row.name,
      };
    },
  };
}
