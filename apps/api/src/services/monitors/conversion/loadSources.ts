import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { monitorsInlineSettingsSchema, type MonitorAttachmentItem } from '@breeze/shared';
import { db } from '../../../db';
import { alerts, alertRules } from '../../../db/schema/alerts';
import { automations } from '../../../db/schema/automations';
import {
  configPolicyAlertRules, configPolicyAutomations, configPolicyFeatureLinks,
  configPolicyMonitoringSettings, configPolicyMonitoringWatches, configurationPolicies,
} from '../../../db/schema/configurationPolicies';
import { organizations } from '../../../db/schema/orgs';
import { normalizeAutomationTrigger } from '../../automationRuntime';
import type { PendingConversionCounts } from './types';

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface PolicySources {
  policy: { id: string; name: string; orgId: string | null; partnerId: string | null; parentPolicyId: string | null };
  links: { alertRule: string | null; monitoring: string | null; monitoringSettingsId: string | null; monitors: { id: string; inheritance: 'cumulative' | 'replace'; items: MonitorAttachmentItem[] } | null };
  inlineRules: Array<typeof configPolicyAlertRules.$inferSelect>;           // retired_at IS NULL
  watches: Array<typeof configPolicyMonitoringWatches.$inferSelect>;         // retired_at IS NULL
  policyAutomations: Array<typeof configPolicyAutomations.$inferSelect>;     // trigger_type = 'event' AND event_type = 'alert.triggered' AND retired_at IS NULL
  standaloneAutomations: Array<typeof automations.$inferSelect>;             // owner axis of the policy, event alert.triggered, filter.configPolicyAlertRuleId ∈ inlineRules ids, retired_at IS NULL
  openAlertsBySource: Map<string, number>;                                   // key = source id (inline rule id); watches/automations have no alert path → 0
  parentUnconverted: boolean;                                                // parentPolicyId has ≥1 unretired inline rule or watch
}

export const OPEN_ALERT_STATUSES = ['active', 'acknowledged', 'suppressed'] as const; // alertService.ts:202-206 dedupe set

export async function loadPolicySources(policyId: string, executor: DbExecutor = db): Promise<PolicySources | null> {
  const [policy] = await executor
    .select({ id: configurationPolicies.id, name: configurationPolicies.name, orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId, parentPolicyId: configurationPolicies.parentPolicyId })
    .from(configurationPolicies).where(eq(configurationPolicies.id, policyId)).limit(1);
  if (!policy) return null;

  const links = await executor.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, policyId));
  const link = (t: string) => links.find((l) => l.featureType === t) ?? null;
  const alertRuleLink = link('alert_rule'); const monitoringLink = link('monitoring'); const monitorsLink = link('monitors');

  const inlineRules = alertRuleLink
    ? await executor.select().from(configPolicyAlertRules).where(and(eq(configPolicyAlertRules.featureLinkId, alertRuleLink.id), isNull(configPolicyAlertRules.retiredAt))).orderBy(configPolicyAlertRules.sortOrder)
    : [];
  const [settings] = monitoringLink
    ? await executor.select().from(configPolicyMonitoringSettings).where(eq(configPolicyMonitoringSettings.featureLinkId, monitoringLink.id)).limit(1)
    : [];
  const watches = settings
    ? await executor.select().from(configPolicyMonitoringWatches).where(and(eq(configPolicyMonitoringWatches.settingsId, settings.id), isNull(configPolicyMonitoringWatches.retiredAt))).orderBy(configPolicyMonitoringWatches.sortOrder)
    : [];
  const automationLink = link('automation');
  const policyAutomations = automationLink
    ? (await executor.select().from(configPolicyAutomations).where(and(eq(configPolicyAutomations.featureLinkId, automationLink.id), isNull(configPolicyAutomations.retiredAt))))
        .filter((a) => a.triggerType === 'event' && a.eventType === 'alert.triggered')
    : [];

  const ruleIds = new Set(inlineRules.map((r) => r.id));
  const ownerCondition = policy.orgId ? eq(automations.orgId, policy.orgId) : and(isNull(automations.orgId), eq(automations.partnerId, policy.partnerId!));
  const candidates = ruleIds.size > 0
    ? await executor.select().from(automations).where(and(ownerCondition, isNull(automations.retiredAt), isNull(automations.managedByMonitorId)))
    : [];
  const standaloneAutomations = candidates.filter((a) => {
    try {
      const t = normalizeAutomationTrigger(a.trigger);
      if (t.type !== 'event' || t.eventType !== 'alert.triggered') return false;
      const ref = (t.filter as Record<string, unknown> | undefined)?.configPolicyAlertRuleId;
      return typeof ref === 'string' && ruleIds.has(ref);
    } catch { return false; }
  });

  const openAlertsBySource = new Map<string, number>();
  if (ruleIds.size > 0) {
    const counts = await executor
      .select({ sourceId: alerts.configPolicyId, count: sql<number>`count(*)::int` })
      .from(alerts)
      .where(and(inArray(alerts.configPolicyId, [...ruleIds]), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
      .groupBy(alerts.configPolicyId);
    for (const c of counts) if (c.sourceId) openAlertsBySource.set(c.sourceId, c.count);
  }

  let parentUnconverted = false;
  if (policy.parentPolicyId) {
    const [row] = await executor
      .select({ n: sql<number>`count(*)::int` })
      .from(configPolicyFeatureLinks)
      .leftJoin(configPolicyAlertRules, and(eq(configPolicyAlertRules.featureLinkId, configPolicyFeatureLinks.id), isNull(configPolicyAlertRules.retiredAt)))
      .leftJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyFeatureLinks.id))
      .leftJoin(configPolicyMonitoringWatches, and(eq(configPolicyMonitoringWatches.settingsId, configPolicyMonitoringSettings.id), isNull(configPolicyMonitoringWatches.retiredAt)))
      .where(and(eq(configPolicyFeatureLinks.configPolicyId, policy.parentPolicyId), or(sql`${configPolicyAlertRules.id} IS NOT NULL`, sql`${configPolicyMonitoringWatches.id} IS NOT NULL`)));
    parentUnconverted = (row?.n ?? 0) > 0;
  }

  const monitorsSettings = monitorsLink ? monitorsInlineSettingsSchema.safeParse(monitorsLink.inlineSettings ?? { items: [] }) : null;
  return {
    policy,
    links: {
      alertRule: alertRuleLink?.id ?? null,
      monitoring: monitoringLink?.id ?? null,
      monitoringSettingsId: settings?.id ?? null,
      monitors: monitorsLink ? { id: monitorsLink.id, inheritance: monitorsSettings?.success ? monitorsSettings.data.inheritance : 'cumulative', items: monitorsSettings?.success ? monitorsSettings.data.items : [] } : null,
    },
    inlineRules, watches, policyAutomations, standaloneAutomations, openAlertsBySource, parentUnconverted,
  };
}

export async function countPendingConversions(
  scope: { orgId: string | null; partnerId: string | null; includePartnerWide: boolean },
  executor: DbExecutor = db,
): Promise<PendingConversionCounts & { standaloneRules: number }> {
  const ownership = (table: typeof configurationPolicies | typeof alertRules) => {
    const orgCondition = scope.orgId
      ? eq(table.orgId, scope.orgId)
      : scope.partnerId
        ? inArray(table.orgId, sql`(select ${organizations.id} from ${organizations} where ${organizations.partnerId} = ${scope.partnerId})`)
        : sql`false`;
    return scope.includePartnerWide && scope.partnerId
      ? or(orgCondition, and(isNull(table.orgId), eq(table.partnerId, scope.partnerId)))
      : orgCondition;
  };
  const policyCondition = and(ownership(configurationPolicies), eq(configurationPolicies.status, 'active'));
  const selection = { policyId: configurationPolicies.id, count: sql<number>`count(*)::int` };
  const ruleCounts = await executor.select(selection).from(configPolicyAlertRules)
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyAlertRules.featureLinkId, configPolicyFeatureLinks.id))
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(policyCondition, isNull(configPolicyAlertRules.retiredAt)))
    .groupBy(configurationPolicies.id);
  const watchCounts = await executor.select(selection).from(configPolicyMonitoringWatches)
    .innerJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringWatches.settingsId, configPolicyMonitoringSettings.id))
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyFeatureLinks.id))
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(policyCondition, isNull(configPolicyMonitoringWatches.retiredAt)))
    .groupBy(configurationPolicies.id);
  const automationCounts = await executor.select(selection).from(configPolicyAutomations)
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyAutomations.featureLinkId, configPolicyFeatureLinks.id))
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(policyCondition, isNull(configPolicyAutomations.retiredAt),
      eq(configPolicyAutomations.triggerType, 'event'), eq(configPolicyAutomations.eventType, 'alert.triggered')))
    .groupBy(configurationPolicies.id);
  const [standalone] = await executor.select({ count: sql<number>`count(*)::int` }).from(alertRules)
    .where(and(ownership(alertRules), isNull(alertRules.managedByMonitorId), isNull(alertRules.retiredAt)));
  const counts = [...ruleCounts, ...watchCounts, ...automationCounts];
  return {
    policies: new Set(counts.map((row) => row.policyId)).size,
    rows: counts.reduce((sum, row) => sum + row.count, 0),
    standaloneRules: standalone?.count ?? 0,
  };
}
