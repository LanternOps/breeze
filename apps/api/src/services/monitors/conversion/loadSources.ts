import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
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
import { monitorConversions, networkMonitors, partners } from '../../../db/schema';
import type { AuthContext } from '../../../middleware/auth';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import type { ConversionSourceTable, PendingConversionCounts } from './types';

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
  // Re-keying may leave the old settings row when the monitors link already
  // owns one. Both rows still contain legacy sources that must be swept.
  const settingsLinkIds = links.filter((l) => l.featureType === 'monitoring' || l.featureType === 'monitors').map((l) => l.id);
  const settings = settingsLinkIds.length
    ? await executor.select().from(configPolicyMonitoringSettings).where(inArray(configPolicyMonitoringSettings.featureLinkId, settingsLinkIds))
    : [];
  const watches = settings.length
    ? await executor.select().from(configPolicyMonitoringWatches).where(and(inArray(configPolicyMonitoringWatches.settingsId, settings.map((s) => s.id)), isNull(configPolicyMonitoringWatches.retiredAt))).orderBy(configPolicyMonitoringWatches.sortOrder)
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
      monitoringSettingsId: settings[0]?.id ?? null,
      monitors: monitorsLink ? { id: monitorsLink.id, inheritance: monitorsSettings?.success ? monitorsSettings.data.inheritance : 'cumulative', items: monitorsSettings?.success ? monitorsSettings.data.items : [] } : null,
    },
    inlineRules, watches, policyAutomations, standaloneAutomations, openAlertsBySource, parentUnconverted,
  };
}

export async function countPendingConversions(
  scope: { orgId: string | null; partnerId: string | null; includePartnerWide: boolean },
  executor: DbExecutor = db,
): Promise<PendingConversionCounts & { networkChecks: number; standaloneRules: number; pendingPolicies: Array<{ id: string; name: string }> }> {
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
  const selection = { policyId: configurationPolicies.id, policyName: configurationPolicies.name, count: sql<number>`count(*)::int` };
  const ruleCounts = await executor.select(selection).from(configPolicyAlertRules)
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyAlertRules.featureLinkId, configPolicyFeatureLinks.id))
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(policyCondition, isNull(configPolicyAlertRules.retiredAt)))
    .groupBy(configurationPolicies.id, configurationPolicies.name);
  const watchCounts = await executor.select(selection).from(configPolicyMonitoringWatches)
    .innerJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringWatches.settingsId, configPolicyMonitoringSettings.id))
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyFeatureLinks.id))
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(policyCondition, isNull(configPolicyMonitoringWatches.retiredAt)))
    .groupBy(configurationPolicies.id, configurationPolicies.name);
  const automationCounts = await executor.select(selection).from(configPolicyAutomations)
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyAutomations.featureLinkId, configPolicyFeatureLinks.id))
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(policyCondition, isNull(configPolicyAutomations.retiredAt),
      eq(configPolicyAutomations.triggerType, 'event'), eq(configPolicyAutomations.eventType, 'alert.triggered')))
    .groupBy(configurationPolicies.id, configurationPolicies.name);
  const [standalone] = await executor.select({ count: sql<number>`count(*)::int` }).from(alertRules)
    .where(and(ownership(alertRules), isNull(alertRules.managedByMonitorId), isNull(alertRules.retiredAt)));
  const networkOwner = scope.orgId
    ? eq(networkMonitors.orgId, scope.orgId)
    : scope.partnerId
      ? inArray(networkMonitors.orgId, sql`(select ${organizations.id} from ${organizations} where ${organizations.partnerId} = ${scope.partnerId})`)
      : sql`false`;
  const [network] = await executor.select({ count: sql<number>`count(*)::int` }).from(networkMonitors)
    .where(and(networkOwner, isNull(networkMonitors.managedByMonitorId), isNull(networkMonitors.retiredAt)));
  const counts = [...ruleCounts, ...watchCounts, ...automationCounts];
  // The list comes from the same rows as the count, so a surface that shows
  // both (banner + pending-policies list) can never disagree.
  const names = new Map(counts.map((row) => [row.policyId, row.policyName] as const));
  const pendingPolicies = [...names].map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    policies: names.size,
    pendingPolicies,
    rows: counts.reduce((sum, row) => sum + row.count, 0),
    standaloneRules: standalone?.count ?? 0,
    networkChecks: Number(network?.count ?? 0),
  };
}

/** Ledger-owned refusals, bounded by both caller ownership and the selected organization. */
export async function readRetirementReport(auth: AuthContext, requestedOrgId: string | null,
  executor: DbExecutor = db) {
  if (requestedOrgId && !auth.canAccessOrg(requestedOrgId)) throw new Error('Organization access denied');
  const owner = auth.scope === 'system' ? sql`true` : or(
    and(isNotNull(monitorConversions.orgId), auth.orgCondition(monitorConversions.orgId) ?? sql`false`),
    canManagePartnerWidePolicies(auth) && auth.partnerId
      ? and(isNull(monitorConversions.orgId), eq(monitorConversions.partnerId, auth.partnerId))
      : sql`false`,
  );
  const selectedOrg = requestedOrgId ? eq(monitorConversions.orgId, requestedOrgId) : sql`true`;
  const rows = await executor.execute<{
    source_table: ConversionSourceTable; source_id: string; name: string; reason: string;
    policy_id: string | null; policy_name: string | null; retired_at: Date;
  }>(sql`
    WITH sources AS (
      SELECT 'config_policy_alert_rules' AS source_table, id, name, retired_reason, retired_at
      FROM config_policy_alert_rules
      UNION ALL
      SELECT 'config_policy_monitoring_watches', id, COALESCE(display_name, name), retired_reason, retired_at
      FROM config_policy_monitoring_watches
      UNION ALL
      SELECT 'alert_templates', id, name, retired_reason, retired_at FROM alert_templates
      UNION ALL
      SELECT 'automations', id, name, retired_reason, retired_at FROM automations
      UNION ALL
      SELECT 'config_policy_automations', id, name, retired_reason, retired_at FROM config_policy_automations
    )
    SELECT sources.source_table, sources.id AS source_id, sources.name,
           sources.retired_reason AS reason, sources.retired_at,
           ${configurationPolicies.id} AS policy_id, ${configurationPolicies.name} AS policy_name
      FROM ${monitorConversions}
      JOIN sources ON sources.id = ${monitorConversions.sourceId}
        AND sources.source_table = ${monitorConversions.sourceTable}
      LEFT JOIN ${configurationPolicies} ON ${configurationPolicies.id} = ${monitorConversions.policyId}
     WHERE ${owner} AND ${selectedOrg} AND ${monitorConversions.revertedAt} IS NULL
       AND sources.retired_at IS NOT NULL AND sources.retired_reason LIKE 'unconvertible:%'
       AND sources.retired_reason <> 'unconvertible:alert_workflow_kept'
     ORDER BY sources.retired_at DESC, sources.id
     LIMIT 200
  `);
  const unconvertible = rows.map(row => ({ sourceTable: row.source_table, sourceId: row.source_id,
    name: row.name, reason: row.reason, policyId: row.policy_id, policyName: row.policy_name,
    retiredAt: new Date(row.retired_at).toISOString() }));
  // Partner-wide marker counts must not leak other orgs' data to a scoped viewer.
  // Org-specific reports still list all their refused sources through the ledger.
  let sweep: { sweptAt: string; converted: number; retired: number } | null = null;
  if (!requestedOrgId && auth.partnerId && canManagePartnerWidePolicies(auth)) {
    const [partner] = await executor.select({ settings: partners.settings }).from(partners)
      .where(eq(partners.id, auth.partnerId)).limit(1);
    const marker = (partner?.settings as { legacyAlertingRetirement?: {
      sweptAt: string; converted: number; retired: number;
    } } | null)?.legacyAlertingRetirement;
    if (marker?.sweptAt) sweep = { sweptAt: marker.sweptAt, converted: marker.converted, retired: marker.retired };
  }
  return { unconvertible, sweep };
}
