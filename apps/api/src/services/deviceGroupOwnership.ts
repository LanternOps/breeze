import { ERROR_CODES } from '@breeze/shared';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
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

/** Find visible partner-owned ids, ignoring unknown ids and repeated inputs. */
export async function findPartnerOwnedGroupIds(ids: readonly string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const rows = await db.select({ id: deviceGroups.id, orgId: deviceGroups.orgId })
    .from(deviceGroups).where(inArray(deviceGroups.id, uniqueIds));
  return [...new Set(rows.filter(isPartnerOwnedGroup).map((row) => row.id))];
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
