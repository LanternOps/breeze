import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { organizations, sites, monitorDefinitions, notificationChannels, escalationPolicies, notificationRoutingRules } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { siteAccessCheck } from '../../middleware/auth';
import { resolveDelivery, type ResolveDeliveryInput, type ResolvedDelivery } from './resolveDelivery';
import { partnerIdForOrg, railOwnershipCondition, type DbExecutor } from './railOwnership';
import { DeliveryWriteError } from './routingRuleWrites';

export interface DeliveryPreview extends ResolvedDelivery {
  display: string;
  description: {
    channels: Array<{ id: string; name: string; enabled: boolean }>;
    escalationPolicy: { id: string; name: string } | null;
    owner: 'organization' | 'partner' | null;
  };
}

export async function previewDelivery(input: ResolveDeliveryInput, auth: AuthContext): Promise<DeliveryPreview> {
  if (!auth.canAccessOrg(input.orgId) || (auth.scope === 'organization' && auth.orgId !== input.orgId)) {
    throw new DeliveryWriteError(403, 'Access to this organization denied');
  }
  if (auth.allowedSiteIds !== undefined && !siteAccessCheck(auth.allowedSiteIds)(input.siteId)) {
    throw new DeliveryWriteError(403, 'An authorized site is required');
  }
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, input.orgId)).limit(1);
  if (!org) throw new DeliveryWriteError(404, 'Organization not found');
  if (input.siteId) {
    const [site] = await db.select({ id: sites.id }).from(sites)
      .where(and(eq(sites.id, input.siteId), eq(sites.orgId, input.orgId))).limit(1);
    if (!site) throw new DeliveryWriteError(404, 'Site not found');
  }
  if (input.monitorId) {
    const [monitor] = await db.select({ id: monitorDefinitions.id }).from(monitorDefinitions)
      .where(and(eq(monitorDefinitions.id, input.monitorId),
        railOwnershipCondition(monitorDefinitions.orgId, monitorDefinitions.partnerId, input.orgId, org.partnerId))).limit(1);
    if (!monitor) throw new DeliveryWriteError(404, 'Monitor not found');
  }
  const resolved = await resolveDelivery(input);
  return describeDelivery(input, resolved);
}

export async function describeDelivery(
  input: ResolveDeliveryInput, resolved: ResolvedDelivery, executor: DbExecutor = db,
): Promise<DeliveryPreview> {
  const partnerId = await partnerIdForOrg(input.orgId, executor);
  const channels = resolved.channelIds.length ? await executor.select({
    id: notificationChannels.id, name: notificationChannels.name, enabled: notificationChannels.enabled,
  }).from(notificationChannels).where(and(
    inArray(notificationChannels.id, resolved.channelIds),
    railOwnershipCondition(notificationChannels.orgId, notificationChannels.partnerId, input.orgId, partnerId),
  )) : [];
  const [policy] = resolved.escalationPolicyId ? await executor.select({ id: escalationPolicies.id, name: escalationPolicies.name })
    .from(escalationPolicies).where(and(eq(escalationPolicies.id, resolved.escalationPolicyId),
      railOwnershipCondition(escalationPolicies.orgId, escalationPolicies.partnerId, input.orgId, partnerId))).limit(1) : [];
  const [rule] = resolved.routingRuleId ? await executor.select({ orgId: notificationRoutingRules.orgId })
    .from(notificationRoutingRules).where(and(eq(notificationRoutingRules.id, resolved.routingRuleId),
      railOwnershipCondition(notificationRoutingRules.orgId, notificationRoutingRules.partnerId, input.orgId, partnerId))).limit(1) : [];
  const owner = rule ? (rule.orgId === null ? 'partner' : 'organization') : null;
  const names = resolved.channelIds.map(id => {
    const channel = channels.find(c => c.id === id);
    return channel ? `${channel.name}${channel.enabled ? '' : ' (disabled)'}` : 'Unavailable channel';
  });
  const origin = resolved.source === 'routing_rule' || resolved.source === 'default_row'
    ? `${owner ?? 'unavailable'} ${resolved.source === 'default_row' ? 'default' : 'rule'} "${resolved.routingRuleName ?? ''}"`
    : { monitor_none: 'monitor: inbox only', monitor_channels: 'monitor override',
        legacy_override: 'legacy override', none: 'no delivery row' }[resolved.source];
  const severity = input.severity[0]!.toUpperCase() + input.severity.slice(1);
  return {
    ...resolved,
    display: `${severity} → ${names.join(', ') || 'Inbox only'} (${origin})${resolved.escalationPolicyId ? `, escalates via ${policy?.name ?? 'Unavailable policy'}` : ''}`,
    description: { channels, escalationPolicy: policy ?? null, owner },
  };
}
