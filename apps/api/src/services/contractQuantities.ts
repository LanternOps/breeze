import { and, eq, ne, count, countDistinct } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizationUsers, users } from '../db/schema';

/** Billable device count for an org, optionally narrowed to a site. Excludes decommissioned.
 *  Must be called inside a db access context (system for the worker, request otherwise). */
export async function countContractDevices(orgId: string, siteId: string | null): Promise<number> {
  const conds = [eq(devices.orgId, orgId), ne(devices.status, 'decommissioned' as never)];
  if (siteId) conds.push(eq(devices.siteId, siteId));
  const [row] = await db.select({ n: count() }).from(devices).where(and(...conds));
  return Number(row?.n ?? 0);
}

/** Active-seat count for an org: distinct active users mapped via organization_users. */
export async function countContractSeats(orgId: string): Promise<number> {
  const [row] = await db.select({ n: countDistinct(organizationUsers.userId) })
    .from(organizationUsers)
    .innerJoin(users, eq(users.id, organizationUsers.userId))
    .where(and(eq(organizationUsers.orgId, orgId), eq(users.status, 'active' as never)));
  return Number(row?.n ?? 0);
}
