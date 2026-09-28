import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { organizations } from '../../db/schema';
import { isUnassignedPoolOrgType } from './orgType';

/**
 * True when `orgId` is a holding org. Reads in the CALLER's DB context on
 * purpose: for a partner caller the holding org is invisible (RLS), and those
 * callers have already been refused by canAccessOrg/ensureOrgAccess before
 * this runs; for system scope (platform admins) it is visible and this is the
 * guard that refuses them.
 */
export async function isHoldingOrg(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ type: organizations.type })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return isUnassignedPoolOrgType(row?.type);
}
