/**
 * May this caller read or write an organization's audit-retention policy?
 * Shared by `/organizations/:id/audit-retention` and the `get_audit_retention`
 * AI tool (full-control W18, #6789), so the tool never asks for less than the
 * route.
 *
 * Org-scoped callers may only reach their OWN org (issue #5423): the token's
 * bound orgId must match the id, and the accessible-org allowlist must agree.
 * Partner callers are bounded by the allowlist alone; system scope is
 * unbounded. The identity check runs before the org lookup so a cross-tenant
 * probe never touches the table. A foreign org and a missing (or deleted) one
 * are the same `false`.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import type { AuthContext } from '../middleware/auth';

export async function canAccessOrgAuditRetention(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'canAccessOrg'>,
  orgId: string,
): Promise<boolean> {
  if (auth.scope === 'organization' && auth.orgId !== orgId) return false;
  if (auth.scope !== 'system' && !auth.canAccessOrg(orgId)) return false;
  const orgRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return Boolean(orgRows[0]);
}
