/**
 * Write rules for notification_routing_rules that the route AND the
 * manage_delivery AI tool must agree on (spec §End state "Delivery": the
 * partner's "Everything else" row cannot be deleted; an org's override can be
 * removed to inherit. Default rows cannot be reordered; their channels may be
 * emptied to mean inbox only). One body, two callers.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { escalationPolicies, notificationRoutingRules } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../siteCeilingAccess';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import { partnerIdForOrg, type DbExecutor } from './railOwnership';

export const DEFAULT_ROW_NAME = 'Everything else';
/** Cosmetic: resolveDelivery orders is_default rows last regardless of priority. */
export const DEFAULT_ROW_PRIORITY = 1000000;

export type RoutingOwner = { orgId: string | null; partnerId: string | null };

export class DeliveryWriteError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = 'DeliveryWriteError';
  }
}

const DEFAULT_ROW_PATCHABLE = new Set(['channelIds', 'escalationPolicyId']);

export function assertDefaultRowPatch(updates: Record<string, unknown>): void {
  const offending = Object.keys(updates).filter((k) => updates[k] !== undefined && !DEFAULT_ROW_PATCHABLE.has(k));
  if (offending.length > 0) {
    throw new DeliveryWriteError(400, `Only channelIds and escalationPolicyId can change on the Everything else row (got ${offending.join(', ')})`);
  }
}

/**
 * An org-owned row may name the org's own policy or its partner's partner-wide
 * policy; a partner-wide row may name only a partner-wide policy of the same
 * partner (mirrors monitorAttachability for monitors).
 */
export async function escalationPolicyCompatible(
  policyId: string,
  owner: RoutingOwner,
  executor: DbExecutor = db
): Promise<boolean> {
  const [policy] = await executor
    .select({ id: escalationPolicies.id, orgId: escalationPolicies.orgId, partnerId: escalationPolicies.partnerId })
    .from(escalationPolicies)
    .where(eq(escalationPolicies.id, policyId))
    .limit(1);
  if (!policy) return false;
  if (owner.orgId !== null) {
    if (policy.orgId === owner.orgId) return true;
    if (policy.orgId !== null) return false;
    const orgPartnerId = await partnerIdForOrg(owner.orgId, executor);
    return orgPartnerId !== null && policy.partnerId === orgPartnerId;
  }
  return policy.orgId === null && policy.partnerId === owner.partnerId;
}

export async function upsertDefaultRow(
  owner: RoutingOwner,
  data: { channelIds: string[]; escalationPolicyId: string | null },
  auth: Pick<AuthContext, 'scope' | 'allowedSiteIds' | 'allowedDeviceIds'> & Partial<Pick<AuthContext, 'partnerId' | 'partnerOrgAccess' | 'canAccessOrg'>>,
  executor: DbExecutor = db
) {
  if (!canMutateOrgWideGovernance(auth)) {
    throw new DeliveryWriteError(403, SITE_CEILING_WRITE_DENIED_MESSAGE);
  }
  if (owner.orgId === null && !canManagePartnerWidePolicies(auth as Parameters<typeof canManagePartnerWidePolicies>[0])) {
    throw new DeliveryWriteError(403, PARTNER_WIDE_WRITE_DENIED_MESSAGE);
  }
  const axis = owner.orgId !== null
    ? and(eq(notificationRoutingRules.orgId, owner.orgId), eq(notificationRoutingRules.isDefault, true))
    : and(isNull(notificationRoutingRules.orgId), eq(notificationRoutingRules.partnerId, owner.partnerId!), eq(notificationRoutingRules.isDefault, true));
  const [existing] = await executor.select().from(notificationRoutingRules).where(axis).limit(1);
  const channelIds = [...new Set(data.channelIds)];
  if (existing) {
    const [row] = await executor
      .update(notificationRoutingRules)
      .set({ channelIds, escalationPolicyId: data.escalationPolicyId, updatedAt: new Date() })
      .where(eq(notificationRoutingRules.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await executor
    .insert(notificationRoutingRules)
    .values({
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      name: DEFAULT_ROW_NAME,
      priority: DEFAULT_ROW_PRIORITY,
      conditions: {},
      channelIds,
      enabled: true,
      escalationPolicyId: data.escalationPolicyId,
      isDefault: true,
    })
    .returning();
  return row!;
}
