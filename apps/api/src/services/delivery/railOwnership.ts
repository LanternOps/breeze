/**
 * Delivery rails are dual-owned (#2130): a channel / routing rule / escalation
 * policy is org-owned (org_id set) OR partner-wide (org_id NULL, partner_id
 * set). Every delivery lookup must match the alert org's own rows OR
 * partner-wide rows owned by that org's partner — a plain eq(orgId, X)
 * silently never matches partner-wide rows (the #1724 trap). Moved out of
 * notificationDispatcher.ts in W05b so resolveDelivery and the dispatcher
 * share one definition.
 */
import { and, eq, isNull, or, type Column, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { organizations } from '../../db/schema';

export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function partnerIdForOrg(orgId: string, executor: DbExecutor = db): Promise<string | null> {
  const [org] = await executor
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org?.partnerId ?? null;
}

export function railOwnershipCondition(
  orgCol: Column,
  partnerCol: Column,
  orgId: string,
  orgPartnerId: string | null
): SQL {
  if (!orgPartnerId) {
    return eq(orgCol, orgId);
  }
  return or(
    eq(orgCol, orgId),
    and(isNull(orgCol), eq(partnerCol, orgPartnerId))
  ) as SQL;
}
