import { ERROR_CODES } from '@breeze/shared';
import { and, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
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
 * Why not the caller's RLS: organization-session JWTs carry no partner id
 * (`middleware/auth.ts`), so the SELECT-only partner branch never matches and a
 * request-scoped read returns [] for an org user — the write would then store
 * the id silently.
 *
 * So the read runs in system scope, but is pinned to the CALLER's own
 * partner(s): the context's partner ids plus the partners of its orgs. A group
 * of another partner is filtered out exactly like an unknown id (same []), so
 * the helper is no cross-tenant existence oracle. Only the caller's own ids
 * come back; no row data leaves the query. A system-scope caller (worker) is
 * unconstrained; a call with no ambient context cannot be scoped and returns [].
 */
export async function findPartnerOwnedGroupIds(ids: readonly string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const ctx = getCurrentDbAccessContext();
  if (!ctx) return [];

  const base = and(inArray(deviceGroups.id, uniqueIds), isNull(deviceGroups.orgId));
  if (ctx.scope === 'system') {
    // Already system-scoped: read straight through (no second pooled connection).
    const rows = await db.select({ id: deviceGroups.id }).from(deviceGroups).where(base);
    return [...new Set(rows.map((row) => row.id))];
  }

  const partnerIds = [...new Set([
    ...(ctx.accessiblePartnerIds ?? []),
    ...(ctx.currentPartnerId ? [ctx.currentPartnerId] : []),
  ])];
  const orgIds = [...new Set([
    ...(ctx.accessibleOrgIds ?? []),
    ...(ctx.orgId ? [ctx.orgId] : []),
  ])];
  if (partnerIds.length === 0 && orgIds.length === 0) return [];

  const ownPartner = or(
    partnerIds.length > 0 ? inArray(deviceGroups.partnerId, partnerIds) : undefined,
    orgIds.length > 0
      ? inArray(
        deviceGroups.partnerId,
        db.select({ partnerId: organizations.partnerId }).from(organizations).where(inArray(organizations.id, orgIds)),
      )
      : undefined,
  );
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ id: deviceGroups.id }).from(deviceGroups).where(and(base, ownPartner))));
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
