import { and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '../db';
import { sqlTimestamp } from '../db/sqlValues';
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
  /**
   * Ids of `alert_correlation_groups` rows that were newly INSERTed this pass
   * (not re-upserted). Consumed by jobs/alertCorrelation.ts to publish
   * `alert.correlation_group.created` exactly once per new group, after this
   * function returns — this service stays event-free by design.
   */
  createdGroupIds: string[];
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

async function upsertGroup(orgId: string, component: Component): Promise<{ id: string; created: boolean }> {
  const memberCount = component.alerts.length;
  const score = averageConfidence(component.correlations);
  // Floor (never round up) so the customer-facing noise-reduction claim never overstates
  // the actual suppression (e.g. 3 members => 66%, not 67%). Guard against a 0-member divide.
  const noiseReductionPercent = memberCount > 0
    ? Math.floor(((memberCount - 1) / memberCount) * 100)
    : 0;
  // `triggeredAt` is a live JS `Date`. It must be bound through `sqlTimestamp`
  // rather than interpolated bare into the template below (#3369) — a raw
  // `Date` in a `sql` template is wrapped with the noop encoder and reaches
  // postgres.js as a JS object, whose Bind step throws ERR_INVALID_ARG_TYPE and
  // fails the whole correlation-grouping pass. `first_seen_at`/`last_seen_at`
  // are naive `timestamp` columns, so the uncast ISO form is the correct
  // binding here — see the docblock on `sqlTimestamp`.
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
      ${sqlTimestamp(firstSeenAt)},
      ${sqlTimestamp(lastSeenAt)},
      -- jsonb_build_object is VARIADIC "any": a bare parameter used only as an
      -- argument to it (never as a direct INSERT column value) gives Postgres no
      -- column type to infer from, so it raises 42P18 "could not determine data
      -- type of parameter" on the extended query protocol postgres.js uses. The
      -- other params above bind straight to a typed INSERT column and don't need
      -- this — only args inside jsonb_build_object() do.
      jsonb_build_object(
        'version', ${GROUP_METADATA_VERSION}::text,
        'correlationTypes', ${JSON.stringify(correlationTypes)}::jsonb
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
    -- xmax = 0 on the RETURNING row identifies a freshly INSERTed tuple; Postgres
    -- sets xmax to the updating transaction's id on a row touched by
    -- ON CONFLICT DO UPDATE, so it is nonzero there. See PersistAlertCorrelationGroupsResult.
    RETURNING id, (xmax = 0) AS created
  `)) as unknown as Array<{ id: string; created: unknown }>;

  const row = rows[0];
  if (!row?.id) {
    throw new Error('Failed to upsert alert correlation group');
  }
  // Normalise defensively: postgres.js parses `bool` to a JS boolean, but guard
  // against a driver/config that instead hands back the raw 't'/'f' wire text.
  const created = row.created === true || row.created === 't';
  return { id: row.id, created };
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
        -- Same 42P18 hazard as upsertGroup's jsonb_build_object above — the
        -- version param is a bare arg to a VARIADIC "any" function, so it needs
        -- an explicit cast rather than the target-column inference INSERT
        -- normally gives every other param here.
        jsonb_build_object('version', ${GROUP_METADATA_VERSION}::text)
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
    return { scanned: alertIds.length, groupsWritten: 0, membersWritten: 0, createdGroupIds: [] };
  }

  const alertRows = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.orgId, options.orgId), inArray(alerts.id, alertIds)));

  if (alertRows.length < 2) {
    return { scanned: alertRows.length, groupsWritten: 0, membersWritten: 0, createdGroupIds: [] };
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
  const createdGroupIds: string[] = [];
  for (const component of components) {
    const { id: groupId, created } = await upsertGroup(options.orgId, component);
    if (created) {
      createdGroupIds.push(groupId);
    }
    membersWritten += await upsertMembers(options.orgId, groupId, component);
  }

  return {
    scanned: alertRows.length,
    groupsWritten: components.length,
    membersWritten,
    createdGroupIds,
  };
}
