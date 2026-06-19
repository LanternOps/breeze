import { and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '../db';
import { alertCorrelations, alerts } from '../db/schema';

const GROUP_METADATA_VERSION = 'alert-correlation-groups-v1';

type AlertForGrouping = Pick<
  typeof alerts.$inferSelect,
  'id' | 'orgId' | 'deviceId' | 'ruleId' | 'status' | 'severity' | 'title' | 'triggeredAt' | 'createdAt'
>;

type CorrelationForGrouping = Pick<
  typeof alertCorrelations.$inferSelect,
  'parentAlertId' | 'childAlertId' | 'correlationType' | 'confidence' | 'createdAt'
>;

export interface PersistAlertCorrelationGroupsResult {
  scanned: number;
  groupsWritten: number;
  membersWritten: number;
}

interface Component {
  root: AlertForGrouping;
  alerts: AlertForGrouping[];
  correlations: CorrelationForGrouping[];
}

function sortByTriggeredAt(alertRows: AlertForGrouping[]): AlertForGrouping[] {
  return [...alertRows].sort((a, b) => {
    const diff = a.triggeredAt.getTime() - b.triggeredAt.getTime();
    return diff === 0 ? a.id.localeCompare(b.id) : diff;
  });
}

function buildComponents(alertRows: AlertForGrouping[], correlations: CorrelationForGrouping[]): Component[] {
  const alertById = new Map(alertRows.map((alert) => [alert.id, alert]));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
    return parent.get(id)!;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  for (const link of correlations) {
    if (alertById.has(link.parentAlertId) && alertById.has(link.childAlertId)) {
      union(link.parentAlertId, link.childAlertId);
    }
  }

  const componentAlertIds = new Map<string, string[]>();
  for (const link of correlations) {
    const root = find(link.parentAlertId);
    const ids = componentAlertIds.get(root) ?? [];
    if (!ids.includes(link.parentAlertId)) ids.push(link.parentAlertId);
    if (!ids.includes(link.childAlertId)) ids.push(link.childAlertId);
    componentAlertIds.set(root, ids);
  }

  const components: Component[] = [];
  for (const ids of componentAlertIds.values()) {
    if (ids.length < 2) continue;
    const componentAlerts = sortByTriggeredAt(
      ids.map((id) => alertById.get(id)).filter((alert): alert is AlertForGrouping => Boolean(alert))
    );
    if (componentAlerts.length < 2) continue;
    const idSet = new Set(componentAlerts.map((alert) => alert.id));
    components.push({
      root: componentAlerts[0]!,
      alerts: componentAlerts,
      correlations: correlations.filter(
        (link) => idSet.has(link.parentAlertId) && idSet.has(link.childAlertId)
      ),
    });
  }

  return components;
}

function averageConfidence(correlations: CorrelationForGrouping[]): number {
  if (correlations.length === 0) return 0;
  const avg = correlations.reduce((sum, link) => sum + Number(link.confidence ?? 0), 0) / correlations.length;
  return Math.max(0, Math.min(1, Math.round(avg * 100) / 100));
}

function confidenceForAlert(alertId: string, component: Component): number {
  if (alertId === component.root.id) return 1;
  const confidences = component.correlations
    .filter((link) => link.parentAlertId === alertId || link.childAlertId === alertId)
    .map((link) => Number(link.confidence ?? 0));
  return confidences.length > 0 ? Math.max(...confidences) : 0;
}

async function upsertGroup(orgId: string, component: Component): Promise<string> {
  const memberCount = component.alerts.length;
  const score = averageConfidence(component.correlations);
  // Floor (never round up) so the customer-facing noise-reduction claim never overstates
  // the actual suppression (e.g. 3 members => 66%, not 67%). Guard against a 0-member divide.
  const noiseReductionPercent = memberCount > 0
    ? Math.floor(((memberCount - 1) / memberCount) * 100)
    : 0;
  const firstSeenAt = component.alerts[0]!.triggeredAt;
  const lastSeenAt = component.alerts[memberCount - 1]!.triggeredAt;
  const correlationTypes = [...new Set(component.correlations.map((link) => link.correlationType))];
  const groupKey = `root:${component.root.id}`;

  const rows = (await db.execute(sql`
    INSERT INTO alert_correlation_groups (
      org_id,
      group_key,
      root_alert_id,
      status,
      score,
      noise_reduction_percent,
      member_count,
      first_seen_at,
      last_seen_at,
      metadata
    )
    VALUES (
      ${orgId},
      ${groupKey},
      ${component.root.id},
      'open',
      ${score.toFixed(2)},
      ${noiseReductionPercent},
      ${memberCount},
      ${firstSeenAt},
      ${lastSeenAt},
      jsonb_build_object(
        'version', ${GROUP_METADATA_VERSION},
        'correlationTypes', ${JSON.stringify(correlationTypes)}
      )
    )
    ON CONFLICT (org_id, group_key)
    DO UPDATE SET
      root_alert_id = EXCLUDED.root_alert_id,
      score = EXCLUDED.score,
      noise_reduction_percent = EXCLUDED.noise_reduction_percent,
      member_count = EXCLUDED.member_count,
      first_seen_at = EXCLUDED.first_seen_at,
      last_seen_at = EXCLUDED.last_seen_at,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  const groupId = rows[0]?.id;
  if (!groupId) {
    throw new Error('Failed to upsert alert correlation group');
  }
  return groupId;
}

async function upsertMembers(orgId: string, groupId: string, component: Component): Promise<number> {
  let written = 0;
  for (const alert of component.alerts) {
    const role = alert.id === component.root.id ? 'root' : 'related';
    const confidence = confidenceForAlert(alert.id, component);
    await db.execute(sql`
      INSERT INTO alert_correlation_members (
        org_id,
        group_id,
        alert_id,
        role,
        confidence,
        evidence
      )
      VALUES (
        ${orgId},
        ${groupId},
        ${alert.id},
        ${role},
        ${confidence.toFixed(2)},
        jsonb_build_object('version', ${GROUP_METADATA_VERSION})
      )
      ON CONFLICT (group_id, alert_id)
      DO UPDATE SET
        role = EXCLUDED.role,
        confidence = EXCLUDED.confidence,
        evidence = EXCLUDED.evidence,
        updated_at = now()
    `);
    written += 1;
  }
  return written;
}

export async function persistAlertCorrelationGroupsForAlerts(options: {
  orgId: string;
  alertIds: string[];
}): Promise<PersistAlertCorrelationGroupsResult> {
  const alertIds = [...new Set(options.alertIds)].filter(Boolean);
  if (alertIds.length < 2) {
    return { scanned: alertIds.length, groupsWritten: 0, membersWritten: 0 };
  }

  const alertRows = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.orgId, options.orgId), inArray(alerts.id, alertIds)));

  if (alertRows.length < 2) {
    return { scanned: alertRows.length, groupsWritten: 0, membersWritten: 0 };
  }

  const scopedAlertIds = alertRows.map((alert) => alert.id);
  const correlations = await db
    .select()
    .from(alertCorrelations)
    .where(
      and(
        inArray(alertCorrelations.parentAlertId, scopedAlertIds),
        inArray(alertCorrelations.childAlertId, scopedAlertIds)
      )
    );

  const components = buildComponents(alertRows, correlations);
  let membersWritten = 0;
  for (const component of components) {
    const groupId = await upsertGroup(options.orgId, component);
    membersWritten += await upsertMembers(options.orgId, groupId, component);
  }

  return {
    scanned: alertRows.length,
    groupsWritten: components.length,
    membersWritten,
  };
}
