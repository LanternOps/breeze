import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations } from '../../db/schema/orgs';
import { getUserPermissions, type UserPermissions } from '../permissions';

/**
 * A decider's live permissions for the org an approval row belongs to,
 * resolved in the partner that OWNS that org.
 *
 * Authority over an org comes from a membership of that org, or from a
 * membership of the partner that owns it. The signed-in session's partner is
 * not an input: one identity can belong to several partners, and a role held
 * in one of them grants nothing over another partner's orgs. With no
 * membership of either kind the result is `null`, which every caller treats as
 * a refusal. An org that no longer resolves is also `null`.
 *
 * System context, exited from the ambient request context first: the caller's
 * RLS context normally cannot see the owning partner's `partner_users` row,
 * and a bare `withSystemDbAccessContext` inside a request context is a
 * passthrough. The reads are keyed by the given user and org (server-loaded
 * ids, never client input), so nothing else becomes readable.
 */
export async function getDeciderPermissionsForOrg(
  userId: string,
  orgId: string,
): Promise<UserPermissions | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      if (!org) return null;
      return getUserPermissions(userId, {
        orgId,
        ...(org.partnerId ? { partnerId: org.partnerId } : {}),
      });
    }),
  );
}
