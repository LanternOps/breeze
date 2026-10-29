import { ERROR_CODES } from '@breeze/shared';
import { and, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceGroupMemberships, deviceGroups, organizations } from '../db/schema';

/** Partner-owned definitions have no owning organization. */
export function isPartnerOwnedGroup(g: { orgId: string | null }): boolean {
  return g.orgId === null;
}

/**
 * Owner predicate for un-aliased membership/group joins. The scalar subquery
 * keeps this independent of any organizations join in the surrounding query.
 */
export function groupOwnerMatchesMembershipOrg(): SQL {
  return sql`(${deviceGroups.orgId} = ${deviceGroupMemberships.orgId}
    OR (${deviceGroups.orgId} IS NULL AND ${deviceGroups.partnerId} =
      (SELECT ${organizations.partnerId} FROM ${organizations}
       WHERE ${organizations.id} = ${deviceGroupMemberships.orgId})))`;
}

/**
 * Which of `ids` name a partner-owned group, ignoring unknown ids and repeats.
 *
 * Reads in SYSTEM scope on purpose. Organization-session JWTs carry no
 * partner id (`middleware/auth.ts`), so under the caller's RLS a partner group
 * is invisible to an org user and a request-scoped read would return [] — the
 * write would then store the id silently. The query returns only the ids the
 * caller already sent, filtered to `org_id IS NULL`; no row data leaves it.
 */
export async function findPartnerOwnedGroupIds(ids: readonly string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const read = async () => db.select({ id: deviceGroups.id })
    .from(deviceGroups)
    .where(and(inArray(deviceGroups.id, uniqueIds), isNull(deviceGroups.orgId)));
  // Already system-scoped (worker): read straight through rather than open a
  // second pooled connection. Otherwise leave the request context first.
  const rows = getCurrentDbAccessContext()?.scope === 'system'
    ? await read()
    : await runOutsideDbContext(() => withSystemDbAccessContext(read));
  return [...new Set(rows.map((row) => row.id))];
}

export function partnerGroupTargetRefusal(ids: string[]): {
  error: string; code: 'PARTNER_GROUP_TARGET_UNSUPPORTED'; groupIds: string[];
} {
  return {
    error: `Partner-wide device groups can only be targeted by partner configuration policies (${ids.join(', ')})`,
    code: ERROR_CODES.PARTNER_GROUP_TARGET_UNSUPPORTED,
    groupIds: ids,
  };
}

export const PARTNER_GROUP_READ_ONLY_BODY = {
  error: 'Partner-wide device groups are read-only here',
  code: ERROR_CODES.PARTNER_GROUP_READ_ONLY,
};
