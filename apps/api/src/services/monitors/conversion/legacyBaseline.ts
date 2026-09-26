import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { devices, organizations, deviceGroupMemberships, configurationPolicies,
  configPolicyAssignments, configPolicyEffectiveFeatureLinks, configPolicyAlertRules,
  configPolicyMonitoringSettings, configPolicyMonitoringWatches } from '../../../db/schema';
import { policyOwnershipCondition } from '../../configPolicyOwnership';
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface LegacyBaseline {
  rules: Array<typeof configPolicyAlertRules.$inferSelect>;
  monitoring: { settingsId: string; checkIntervalSeconds: number;
    watches: Array<typeof configPolicyMonitoringWatches.$inferSelect> } | null;
}
const LEVEL: Record<string, number> = { device: 5, device_group: 4, site: 3, organization: 2, partner: 1 };
export async function resolveLegacyBaseline(deviceId: string, executor: DbExecutor): Promise<LegacyBaseline> {
  const [device] = await executor.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) return { rules: [], monitoring: null };
  const [org] = await executor.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, device.orgId)).limit(1);
  const groups = await executor.select({ groupId: deviceGroupMemberships.groupId }).from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const targets = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (org?.partnerId) targets.push(and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId)));
  if (groups.length) targets.push(and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groups.map((g) => g.groupId))));
  const filters = and(or(...targets),
    sql`(${configPolicyAssignments.roleFilter} IS NULL OR ${device.deviceRole} = ANY(${configPolicyAssignments.roleFilter}))`,
    sql`(${configPolicyAssignments.osFilter} IS NULL OR ${device.osType} = ANY(${configPolicyAssignments.osFilter}))`);
  const owner = policyOwnershipCondition({ orgId: device.orgId, partnerId: org?.partnerId ?? null });
  const rows = await executor.select({ rule: configPolicyAlertRules, assignmentId: configPolicyAssignments.id,
    level: configPolicyAssignments.level, priority: configPolicyAssignments.priority, createdAt: configPolicyAssignments.createdAt })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, and(eq(configPolicyAssignments.configPolicyId, configurationPolicies.id), eq(configurationPolicies.status, 'active'), owner))
    .innerJoin(configPolicyEffectiveFeatureLinks, and(eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id), eq(configPolicyEffectiveFeatureLinks.featureType, 'alert_rule')))
    .innerJoin(configPolicyAlertRules, and(eq(configPolicyAlertRules.featureLinkId, configPolicyEffectiveFeatureLinks.id), isNull(configPolicyAlertRules.retiredAt)))
    .where(filters).orderBy(configPolicyAssignments.level, configPolicyAssignments.priority, configPolicyAssignments.createdAt, asc(configPolicyAlertRules.sortOrder));
  rows.sort((a, b) => (LEVEL[b.level] ?? 0) - (LEVEL[a.level] ?? 0) || a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  const rules = rows.filter((r) => r.assignmentId === rows[0]?.assignmentId).map((r) => r.rule);
  const settings = await executor.select({ settingsId: configPolicyMonitoringSettings.id,
    checkIntervalSeconds: configPolicyMonitoringSettings.checkIntervalSeconds,
    level: configPolicyAssignments.level, priority: configPolicyAssignments.priority })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyEffectiveFeatureLinks, and(eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id), inArray(configPolicyEffectiveFeatureLinks.featureType, ['monitoring', 'monitors'])))
    .innerJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyEffectiveFeatureLinks.id))
    .where(and(eq(configurationPolicies.status, 'active'), owner, filters));
  // Actual watch runtime has no creation-time tie-breaker; preserve that order.
  settings.sort((a, b) => (LEVEL[b.level] ?? 0) - (LEVEL[a.level] ?? 0) || a.priority - b.priority);
  const winner = settings[0];
  if (!winner) return { rules, monitoring: null };
  const watches = await executor.select().from(configPolicyMonitoringWatches)
    .where(and(eq(configPolicyMonitoringWatches.settingsId, winner.settingsId), eq(configPolicyMonitoringWatches.enabled, true), isNull(configPolicyMonitoringWatches.retiredAt)))
    .orderBy(configPolicyMonitoringWatches.sortOrder);
  return { rules, monitoring: { settingsId: winner.settingsId, checkIntervalSeconds: winner.checkIntervalSeconds, watches } };
}
export async function resolveDeviceIdsForPolicy(policyId: string, executor: DbExecutor = db): Promise<string[]> {
  const rows = await executor.selectDistinct({ id: devices.id }).from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .innerJoin(configPolicyAssignments, or(
      and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, devices.id)),
      and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, devices.siteId)),
      and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, devices.orgId)),
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, organizations.partnerId)),
      and(eq(configPolicyAssignments.level, 'device_group'), sql`EXISTS (SELECT 1 FROM ${deviceGroupMemberships}
        WHERE ${deviceGroupMemberships.deviceId} = ${devices.id} AND ${deviceGroupMemberships.groupId} = ${configPolicyAssignments.targetId})`)))
    .innerJoin(configurationPolicies, eq(configurationPolicies.id, configPolicyAssignments.configPolicyId))
    .leftJoin(configPolicyEffectiveFeatureLinks, eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(eq(configurationPolicies.status, 'active'),
      or(eq(configurationPolicies.orgId, devices.orgId), and(isNull(configurationPolicies.orgId), eq(configurationPolicies.partnerId, organizations.partnerId))),
      or(eq(configurationPolicies.id, policyId), eq(configPolicyEffectiveFeatureLinks.sourcePolicyId, policyId)),
      sql`(${configPolicyAssignments.roleFilter} IS NULL OR ${devices.deviceRole} = ANY(${configPolicyAssignments.roleFilter}))`,
      sql`(${configPolicyAssignments.osFilter} IS NULL OR ${devices.osType}::text = ANY(${configPolicyAssignments.osFilter}))`))
    .orderBy(devices.id);
  return rows.map((r) => r.id);
}
