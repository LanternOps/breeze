import { sql, type SQL } from 'drizzle-orm';
import type { Freshness, HealthCoverage, HealthStatus, TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { alertSiteScopeCondition } from '../../routes/alerts/helpers';
import { siteAccessCheck } from '../../middleware/auth';
import { hasPermission } from '../permissions';
import type { TopologyRequestContext } from './access';

/**
 * Attributed overlays built from monitoring that already exists.
 *
 * M1 never creates a monitor, a schedule or an alert rule to light up the map.
 * It reuses a monitor only through an explicit canonical binding row in
 * `topology_monitor_bindings`, and only when the monitor still agrees with that
 * binding on organization, site, destination family, protocol, configured
 * context and origin-selection policy. There is deliberately no address lookup:
 * "something else is pinging this IP" is not evidence about this node.
 *
 * Restricted alerts and monitor details are removed before anything is counted,
 * so a reader never learns a count that includes rows they may not read.
 */

export type TopologyOverlaySubject = { kind: 'node' | 'relationship'; id: string };

export type TopologyMonitorOverlayProvenance = {
  monitorId: string | null;
  monitorName: string | null;
  monitorType: string | null;
  destination: string | null;
  /** Reserved for the diagnostic run that supplied the measurement (Task 18). */
  runId: string | null;
  resultId: string | null;
  originDeviceId: string | null;
  originNodeId: string | null;
  observedAt: string | null;
};

export type TopologyMonitorOverlay = {
  subject: TopologyOverlaySubject;
  bindingId: string;
  contextKey: string;
  family: string;
  metricRole: string;
  status: HealthStatus;
  coverage: HealthCoverage;
  freshness: Freshness;
  reasons: string[];
  /** Null means the reader may not count alerts, which is not the same as zero. */
  activeAlertCount: number | null;
  provenance: TopologyMonitorOverlayProvenance;
  /** When a fresh result lapses to stale without new evidence; null unless fresh. */
  freshUntil: string | null;
};

export type MonitorBindingRow = {
  bindingId: string;
  nodeId: string | null;
  relationshipId: string | null;
  contextKey: string;
  family: string;
  metricRole: string;
  originDeviceId: string | null;
  originNodeId: string | null;
  originSiteId: string | null;
  monitorId: string;
  monitorName: string;
  monitorType: string;
  monitorTarget: string;
  monitorActive: boolean;
  pollingInterval: number;
  resultId: string | null;
  resultStatus: string | null;
  resultDeviceId: string | null;
  resultAt: string | Date | null;
};

export type OverlayReadOptions = { now?: Date; executor?: Pick<typeof db, 'execute'> };

/** Bounded so one projection can never fan a read out beyond the visible graph. */
export const OVERLAY_SUBJECT_LIMIT = 3_000;

/**
 * The protocol each bound metric role is allowed to reuse. A monitor of any
 * other type measures a different thing about the same address and is not
 * interchangeable with it.
 */
const METRIC_ROLE_MONITOR_TYPES: Record<string, string[]> = {
  connectivity: ['icmp_ping'],
  reachability: ['icmp_ping'],
  port_reachability: ['tcp_port'],
  service_response: ['http_check'],
  name_resolution: ['dns_check'],
};

const RESULT_STATUS_HEALTH: Record<string, HealthStatus> = {
  online: 'healthy',
  degraded: 'degraded',
  offline: 'failed_check',
  unknown: 'unknown',
};

const REASON_MESSAGES: Record<string, string> = {
  monitoring_unavailable: 'Topology monitoring is not available for this entity.',
  no_monitor_binding: 'No monitor is bound to this entity.',
  no_monitor_result: 'The bound monitor has not produced a result yet.',
  stale_monitor_result: 'The most recent monitor result is older than this monitor\'s cadence.',
  monitor_disabled: 'The bound monitor is disabled, so its last result is historical.',
  protocol_mismatch: 'The bound monitor measures a different protocol than this overlay needs.',
  metric_role_unrecognized: 'This binding requests a metric this milestone cannot reuse.',
  family_mismatch: 'The bound monitor targets a different address family.',
  family_unverified: 'The bound monitor targets a name, so its address family is not verified.',
  origin_not_visible: 'The measuring device is outside the sites you may read.',
  monitor_detail_restricted: 'You may not read the monitor that supplies this overlay.',
  alert_counts_restricted: 'You may not read alerts, so alert counts are withheld.',
  mixed_context_results: 'Measurements from different contexts disagree; the failure may be specific to one location.',
  interface_unmeasured: 'No current port measurement exists for this interface.',
  interface_measurement_stale: 'The latest port measurement is older than its expected cadence.',
  interface_measurement_stopped: 'Port measurement was stopped, so earlier readings are historical.',
  interface_generation_retired: 'The interface generation changed; nothing current is claimed about the old one.',
  interface_link_down: 'The port reports its link down.',
  interface_admin_disabled: 'The port is administratively disabled (an expected state, not a fault).',
  interface_admin_status_unknown: 'The port\'s administrative state is unknown, so no fault is inferred.',
  interface_dormant: 'The port reports a dormant state.',
  interface_testing: 'The port is in a testing state.',
  interface_not_present: 'The port reports a missing component.',
  interface_oper_status_unknown: 'The port reports an unknown operational state.',
  interface_rates_unavailable: 'No continuous measurement window is available yet for rates.',
  interface_error_rates_unavailable: 'The port does not report error or discard counters.',
  interface_errors_elevated: 'The port is receiving or sending errors above the threshold.',
  interface_discards_elevated: 'The port is discarding packets above the threshold.',
  interface_rate_exceeds_capacity: 'A measured rate exceeds the reported port speed.',
  policy_disabled: 'The recurring monitoring policy for this entity is not armed.',
  policy_result_pending: 'The recurring monitoring policy is armed but has not produced a result yet.',
  policy_result_stale: 'The latest scheduled policy result is older than its cadence allows.',
  policy_run_not_completed: 'The latest scheduled policy run did not complete in time, so it is not evidence.',
};

export function overlayReasonMessage(code: string): string {
  return REASON_MESSAGES[code] ?? 'No further detail is available for this overlay.';
}

function uuidArray(values: string[]): SQL {
  if (!values.length) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}::uuid`), sql`, `)}]::uuid[]`;
}

/**
 * Every eligibility condition that can be expressed in SQL. The monitor's own
 * org and site must equal the binding's; `site_id IS NOT NULL` is stated
 * explicitly so an assetless legacy monitor stays ineligible even if a future
 * join weakens the equality.
 */
export function monitorBindingFilter(scope: TopologyScope, nodeIds: string[], relationshipIds: string[]): SQL {
  return sql`b.org_id = ${scope.orgId}::uuid AND b.site_id = ${scope.siteId}::uuid
    AND b.monitor_id IS NOT NULL
    AND (b.node_id = ANY(${uuidArray(nodeIds)}) OR b.relationship_id = ANY(${uuidArray(relationshipIds)}))`;
}

function bindingQuery(scope: TopologyScope, nodeIds: string[], relationshipIds: string[]): SQL {
  return sql`SELECT b.id AS "bindingId", b.node_id AS "nodeId", b.relationship_id AS "relationshipId",
      b.context_key AS "contextKey", b.family, b.metric_role AS "metricRole",
      (b.origin_policy->>'deviceId') AS "originDeviceId", ob.node_id AS "originNodeId", od.site_id AS "originSiteId",
      m.id AS "monitorId", m.name AS "monitorName", m.monitor_type::text AS "monitorType", m.target AS "monitorTarget",
      m.is_active AS "monitorActive", m.polling_interval AS "pollingInterval",
      r.id AS "resultId", r.status::text AS "resultStatus", r.device_id AS "resultDeviceId", r."timestamp" AS "resultAt"
    FROM topology_monitor_bindings b
    JOIN network_monitors m ON m.id = b.monitor_id
      AND m.org_id = b.org_id AND m.site_id = b.site_id AND m.site_id IS NOT NULL
    LEFT JOIN devices od ON od.id::text = b.origin_policy->>'deviceId' AND od.org_id = b.org_id
    LEFT JOIN topology_node_bindings ob ON ob.device_id = od.id AND ob.org_id = b.org_id AND ob.site_id = b.site_id
    LEFT JOIN LATERAL (
      SELECT nr.id, nr.status, nr.device_id, nr."timestamp" FROM network_monitor_results nr
      WHERE nr.monitor_id = m.id AND nr.org_id = b.org_id
        AND (b.origin_policy->>'deviceId' IS NULL OR nr.device_id::text = b.origin_policy->>'deviceId')
      ORDER BY nr."timestamp" DESC LIMIT 1
    ) r ON true
    WHERE ${monitorBindingFilter(scope, nodeIds, relationshipIds)}
    ORDER BY b.id LIMIT ${OVERLAY_SUBJECT_LIMIT}`;
}

/**
 * Count only the alerts this reader may see. The site predicate is the same one
 * the alerts routes compile, so a topology overlay can never widen alert
 * visibility past the alerts API.
 *
 * A network monitor's alerts are linked through `context` (see
 * `jobs/monitorWorker.ts`); `alerts.monitor_id` belongs to the separate
 * monitor-definition compiler and is a different identity space.
 */
function alertCountQuery(scope: TopologyScope, monitorIds: string[], allowedSiteIds: string[] | undefined): SQL {
  const siteScope = alertSiteScopeCondition(allowedSiteIds);
  const ids = sql`ARRAY[${sql.join(monitorIds.map((id) => sql`${id}`), sql`, `)}]::text[]`;
  return sql`SELECT alerts.context->>'monitorId' AS "monitorId", count(*)::text AS count
    FROM alerts JOIN devices ON devices.id = alerts.device_id
    WHERE alerts.org_id = ${scope.orgId}::uuid AND alerts.status = 'active'
      AND alerts.context->>'source' = 'network_monitor'
      AND alerts.context->>'monitorId' = ANY(${ids})
      AND ${siteScope ?? sql`true`}
    GROUP BY alerts.context->>'monitorId'`;
}

function freshnessWindowMs(pollingIntervalSeconds: number): number {
  const interval = Number.isFinite(pollingIntervalSeconds) && pollingIntervalSeconds > 0 ? pollingIntervalSeconds : 60;
  return Math.max(interval * 3, 60) * 1_000;
}

function literalFamily(target: string): 'ipv4' | 'ipv6' | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) return 'ipv4';
  if (target.includes(':')) return 'ipv6';
  return null;
}

function timestamp(value: string | Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

type Evaluated = { overlay: TopologyMonitorOverlay; eligible: boolean; observedAt: number };

function evaluate(
  row: MonitorBindingRow,
  now: number,
  access: { canReadMonitors: boolean; canReadAlerts: boolean; siteVisible: (siteId: string | null) => boolean },
): Evaluated {
  const subject: TopologyOverlaySubject = row.nodeId
    ? { kind: 'node', id: row.nodeId }
    : { kind: 'relationship', id: row.relationshipId! };
  const reasons: string[] = [];
  const observedAt = timestamp(row.resultAt);

  const originVisible = row.originDeviceId ? access.siteVisible(row.originSiteId) : true;
  if (!originVisible) reasons.push('origin_not_visible');
  if (!access.canReadMonitors) reasons.push('monitor_detail_restricted');
  if (!access.canReadAlerts) reasons.push('alert_counts_restricted');

  const provenance: TopologyMonitorOverlayProvenance = {
    monitorId: row.monitorId,
    monitorName: access.canReadMonitors ? row.monitorName : null,
    monitorType: access.canReadMonitors ? row.monitorType : null,
    destination: access.canReadMonitors ? row.monitorTarget : null,
    runId: null,
    resultId: row.resultId,
    originDeviceId: originVisible ? row.originDeviceId : null,
    originNodeId: originVisible ? row.originNodeId : null,
    observedAt,
  };

  const ineligible = (code: string): Evaluated => ({
    overlay: {
      subject, bindingId: row.bindingId, contextKey: row.contextKey, family: row.family, metricRole: row.metricRole,
      status: 'unknown', coverage: 'unmonitored', freshness: 'unknown',
      reasons: [code, ...reasons],
      activeAlertCount: access.canReadAlerts ? 0 : null,
      provenance: { ...provenance, resultId: null, observedAt: null },
      freshUntil: null,
    },
    eligible: false,
    observedAt: 0,
  });

  const allowedTypes = METRIC_ROLE_MONITOR_TYPES[row.metricRole];
  if (!allowedTypes) return ineligible('metric_role_unrecognized');
  if (!allowedTypes.includes(row.monitorType)) return ineligible('protocol_mismatch');

  const targetFamily = literalFamily(row.monitorTarget);
  if (targetFamily && targetFamily !== row.family) return ineligible('family_mismatch');
  if (!targetFamily) reasons.push('family_unverified');

  if (!row.monitorActive) return ineligible('monitor_disabled');

  let status: HealthStatus = 'unknown';
  let coverage: HealthCoverage = 'unmonitored';
  let freshness: Freshness = 'unknown';
  let freshUntil: string | null = null;

  if (!row.resultId || !observedAt) {
    reasons.push('no_monitor_result');
  } else if (now - Date.parse(observedAt) > freshnessWindowMs(row.pollingInterval)) {
    reasons.push('stale_monitor_result');
    freshness = 'stale';
    coverage = 'partial';
  } else {
    freshness = 'fresh';
    coverage = 'monitored';
    freshUntil = new Date(Date.parse(observedAt) + freshnessWindowMs(row.pollingInterval)).toISOString();
    status = RESULT_STATUS_HEALTH[row.resultStatus ?? 'unknown'] ?? 'unknown';
    if (status === 'unknown') reasons.push('no_monitor_result');
  }

  return {
    overlay: {
      subject, bindingId: row.bindingId, contextKey: row.contextKey, family: row.family, metricRole: row.metricRole,
      status, coverage, freshness, reasons,
      activeAlertCount: access.canReadAlerts ? 0 : null,
      provenance,
      freshUntil,
    },
    eligible: true,
    observedAt: observedAt ? Date.parse(observedAt) : 0,
  };
}

/**
 * Read attributed monitor overlays for the given canonical subjects. Issues at
 * most two SELECTs and never writes, so a graph GET stays a read.
 */
export async function readTopologyMonitorOverlays(
  ctx: TopologyRequestContext,
  subjects: TopologyOverlaySubject[],
  options: OverlayReadOptions = {},
): Promise<TopologyMonitorOverlay[]> {
  const nodeIds = [...new Set(subjects.filter((s) => s.kind === 'node').map((s) => s.id))].slice(0, OVERLAY_SUBJECT_LIMIT);
  const relationshipIds = [...new Set(subjects.filter((s) => s.kind === 'relationship').map((s) => s.id))].slice(0, OVERLAY_SUBJECT_LIMIT);
  if (!nodeIds.length && !relationshipIds.length) return [];

  const executor = options.executor ?? db;
  const now = (options.now ?? new Date()).getTime();
  const allowedSiteIds = ctx.auth.allowedSiteIds;
  const access = {
    canReadMonitors: hasPermission(ctx.permissions, 'devices', 'read'),
    canReadAlerts: hasPermission(ctx.permissions, 'alerts', 'read'),
    siteVisible: (siteId: string | null) => siteAccessCheck(allowedSiteIds)(siteId),
  };

  const rows = await executor.execute<MonitorBindingRow>(bindingQuery(ctx.scope, nodeIds, relationshipIds));

  // One overlay per subject, context, family and metric role. Duplicate
  // compatible bindings resolve to the freshest measurement deterministically.
  const chosen = new Map<string, Evaluated>();
  for (const row of rows) {
    if (!row.nodeId && !row.relationshipId) continue;
    const evaluated = evaluate(row, now, access);
    const key = [evaluated.overlay.subject.kind, evaluated.overlay.subject.id,
      row.contextKey, row.family, row.metricRole].join(':');
    const current = chosen.get(key);
    if (!current
      || (evaluated.eligible && !current.eligible)
      || (evaluated.eligible === current.eligible
        && (evaluated.observedAt > current.observedAt
          || (evaluated.observedAt === current.observedAt && evaluated.overlay.bindingId < current.overlay.bindingId)))) {
      chosen.set(key, evaluated);
    }
  }

  const overlays = [...chosen.values()].map((entry) => entry.overlay);
  if (!overlays.length) return overlays;

  if (!access.canReadAlerts) return overlays;

  const monitorIds = [...new Set(overlays.map((overlay) => overlay.provenance.monitorId).filter((id): id is string => !!id))];
  if (!monitorIds.length) return overlays;

  const counts = await executor.execute<{ monitorId: string; count: string }>(
    alertCountQuery(ctx.scope, monitorIds, allowedSiteIds),
  );
  const byMonitor = new Map(counts.map((row) => [row.monitorId, Number(row.count)]));
  for (const overlay of overlays) {
    const count = overlay.provenance.monitorId ? byMonitor.get(overlay.provenance.monitorId) : undefined;
    overlay.activeAlertCount = Number.isSafeInteger(count) ? count! : 0;
  }
  return overlays;
}

/**
 * Project an overlay onto the graph's published health summary. The wire shape
 * is unchanged from M0 — the projection now fills it from real evidence instead
 * of always answering "not measured".
 */
export function overlayHealthSummary(scope: 'node' | 'relationship', overlay: TopologyMonitorOverlay | undefined) {
  return topologyHealthSummary(scope, overlay && {
    status: overlay.status, coverage: overlay.coverage, freshness: overlay.freshness, reasons: overlay.reasons,
    originNodeId: overlay.provenance.originNodeId, resultId: overlay.provenance.resultId,
  });
}

export type TopologyHealthSummaryInput = {
  status: HealthStatus; coverage: HealthCoverage; freshness: Freshness; reasons: string[];
  originNodeId: string | null; resultId: string | null;
};
/** The M0 wire shape for one subject's (aggregated) health; undefined = nothing measures it. */
export function topologyHealthSummary(scope: 'node' | 'relationship', input: TopologyHealthSummaryInput | undefined) {
  const codes = input?.reasons.length
    ? input.reasons
    : input ? [] : ['no_monitor_binding'];
  const status = input?.status ?? 'unknown';
  const freshness = input?.freshness ?? 'unknown';
  const reasons = (codes.length || (status !== 'unknown' && freshness !== 'unknown')
    ? codes
    : ['monitoring_unavailable']).map((code) => ({ code, message: overlayReasonMessage(code) }));

  return {
    status,
    coverage: input?.coverage ?? ('unmonitored' as HealthCoverage),
    scope,
    originNodeId: input?.originNodeId ?? null,
    resultId: input?.resultId ?? null,
    reasons,
    freshness,
  };
}

/**
 * Advance the site's health revision and nothing else. Structural graph and
 * layout revisions describe connectivity and arrangement; a health refresh must
 * never move them, or every open map would discard its projection and viewport.
 */
export async function advanceTopologyHealthRevision(
  executor: Pick<typeof db, 'execute'>,
  scope: TopologyScope,
): Promise<void> {
  await executor.execute(sql`UPDATE topology_site_state
    SET health_revision = health_revision + 1, updated_at = now()
    WHERE org_id = ${scope.orgId}::uuid AND site_id = ${scope.siteId}::uuid`);
}
