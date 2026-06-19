import { and, eq, ne } from 'drizzle-orm';

import { db } from '../db';
import { alerts, metricAnomalies } from '../db/schema';
import { publishEvent } from './eventBus';
import { shouldProduceMlOutput } from './mlFeatureFlags';
import { resolveDeviceSiteId } from './deviceSiteResolver';

type MetricAnomalyRow = typeof metricAnomalies.$inferSelect;

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/**
 * Two detectors can emit the SAME logical incident under different metric_name
 * rows: the baseline detector emits anomaly_type='network_egress' for
 * metric_name='bandwidth_out_bps', while detectProcessSampleRunaways emits the
 * same 'network_egress' (and a 'process_runaway' CPU/RAM analog) for
 * metric_name='top_process_net_bps_sum'. The metric_anomalies ON CONFLICT key
 * includes metric_name, so those rows never collide at write time — one real
 * event becomes two promotable anomalies.
 *
 * We can't dedupe at the detection layer without losing the per-metric evidence,
 * so we collapse here at promotion: anomalies that share
 * (deviceId, anomalyType, bucketSeconds, windowStart) are the same incident and
 * must promote to a SINGLE alert. We pick the higher-severity / higher-confidence
 * row as the canonical one driving the alert, and link every sibling to that one
 * alert so a second promotion is a no-op reuse instead of a duplicate incident.
 */
function isHigherPriority(candidate: MetricAnomalyRow, current: MetricAnomalyRow): boolean {
  const candidateRank = SEVERITY_RANK[severityForAnomaly(candidate)] ?? -1;
  const currentRank = SEVERITY_RANK[severityForAnomaly(current)] ?? -1;
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  if (candidate.confidence !== current.confidence) return candidate.confidence > current.confidence;
  if (candidate.score !== current.score) return candidate.score > current.score;
  // Stable tiebreak so the canonical row is deterministic across re-promotions.
  return candidate.id < current.id;
}

export type MetricAnomalyPromotionResult =
  | {
      status: 'not_found';
    }
  | {
      status: 'disabled';
      anomaly: MetricAnomalyRow;
    }
  | {
      status: 'promoted';
      anomaly: MetricAnomalyRow;
      alertId: string;
      created: boolean;
    };

export type PromoteMetricAnomalyToAlertOptions = {
  orgId: string;
  deviceId: string;
  anomalyId: string;
  actorUserId?: string | null;
  requireCreateAlertsFlag?: boolean;
};

function titleForAnomaly(anomaly: MetricAnomalyRow): string {
  const label = anomaly.anomalyType.replace(/_/g, ' ');
  return `Metric anomaly promoted: ${label} on ${anomaly.metricName}`;
}

function severityForAnomaly(anomaly: MetricAnomalyRow): 'critical' | 'high' | 'medium' | 'low' | 'info' {
  if (anomaly.confidence >= 0.95 || anomaly.score >= 10) return 'critical';
  if (anomaly.anomalyType === 'network_egress' || anomaly.anomalyType === 'process_runaway') return 'high';
  if (anomaly.confidence >= 0.75 || anomaly.score >= 5) return 'medium';
  return 'low';
}

function messageForAnomaly(anomaly: MetricAnomalyRow): string {
  const observed = Number.isFinite(anomaly.observedValue) ? anomaly.observedValue.toFixed(2) : String(anomaly.observedValue);
  const baseline = anomaly.baselineValue == null
    ? 'no baseline'
    : Number.isFinite(anomaly.baselineValue)
      ? anomaly.baselineValue.toFixed(2)
      : String(anomaly.baselineValue);
  return [
    `${anomaly.metricName} ${anomaly.anomalyType.replace(/_/g, ' ')} was promoted from ML anomaly detection.`,
    `Observed ${observed}; baseline ${baseline}.`,
    `Confidence ${Math.round(anomaly.confidence * 100)}%, score ${Math.round(anomaly.score * 100) / 100}.`,
  ].join(' ');
}

function anomalyIdentityWhere(options: PromoteMetricAnomalyToAlertOptions) {
  return and(
    eq(metricAnomalies.id, options.anomalyId),
    eq(metricAnomalies.orgId, options.orgId),
    eq(metricAnomalies.deviceId, options.deviceId),
  );
}

/**
 * Find anomalies in the same incident group as `anomaly` — same device,
 * anomaly_type, bucket window — but a DIFFERENT metric_name (and a different
 * row). Used to collapse the double-emitted-anomaly case into a single alert.
 */
async function findDedupeSiblings(
  orgId: string,
  anomaly: MetricAnomalyRow,
): Promise<MetricAnomalyRow[]> {
  return db
    .select()
    .from(metricAnomalies)
    .where(
      and(
        eq(metricAnomalies.orgId, orgId),
        eq(metricAnomalies.deviceId, anomaly.deviceId),
        eq(metricAnomalies.anomalyType, anomaly.anomalyType),
        eq(metricAnomalies.bucketSeconds, anomaly.bucketSeconds),
        eq(metricAnomalies.windowStart, anomaly.windowStart),
        ne(metricAnomalies.id, anomaly.id),
      ),
    );
}

export async function promoteMetricAnomalyToAlert(
  options: PromoteMetricAnomalyToAlertOptions,
): Promise<MetricAnomalyPromotionResult> {
  const [anomaly] = await db
    .select()
    .from(metricAnomalies)
    .where(anomalyIdentityWhere(options))
    .limit(1);

  if (!anomaly) {
    return { status: 'not_found' };
  }

  if (anomaly.linkedAlertId) {
    if (anomaly.status === 'promoted') {
      return {
        status: 'promoted',
        anomaly,
        alertId: anomaly.linkedAlertId,
        created: false,
      };
    }

    const now = new Date();
    const [updated] = await db
      .update(metricAnomalies)
      .set({
        status: 'promoted',
        resolvedAt: null,
        updatedAt: now,
      })
      .where(anomalyIdentityWhere(options))
      .returning();

    return {
      status: 'promoted',
      anomaly: updated ?? { ...anomaly, status: 'promoted', resolvedAt: null, updatedAt: now },
      alertId: anomaly.linkedAlertId,
      created: false,
    };
  }

  // Collapse the double-emitted-anomaly case: if a sibling row (same device /
  // anomaly_type / window, different metric_name) already drove an alert, reuse
  // that alert instead of opening a second incident for the same event.
  const siblings = await findDedupeSiblings(anomaly.orgId, anomaly);
  const promotedSibling = siblings.find((s) => s.linkedAlertId);
  if (promotedSibling?.linkedAlertId) {
    const reusedAlertId = promotedSibling.linkedAlertId;
    const now = new Date();
    const [updated] = await db
      .update(metricAnomalies)
      .set({
        status: 'promoted',
        linkedAlertId: reusedAlertId,
        resolvedAt: null,
        updatedAt: now,
      })
      .where(anomalyIdentityWhere(options))
      .returning();

    return {
      status: 'promoted',
      anomaly: updated ?? { ...anomaly, status: 'promoted', linkedAlertId: reusedAlertId, resolvedAt: null, updatedAt: now },
      alertId: reusedAlertId,
      created: false,
    };
  }

  if (
    options.requireCreateAlertsFlag !== false
    && !(await shouldProduceMlOutput(anomaly.orgId, 'ml.anomalies.create_alerts'))
  ) {
    return { status: 'disabled', anomaly };
  }

  // Pick the highest-severity / highest-confidence row in the incident group to
  // drive the single alert, so the de-duped incident keeps the strongest signal.
  let canonical = anomaly;
  for (const sibling of siblings) {
    if (isHigherPriority(sibling, canonical)) {
      canonical = sibling;
    }
  }

  const severity = severityForAnomaly(canonical);
  const title = titleForAnomaly(canonical);
  const message = messageForAnomaly(canonical);
  const now = new Date();

  const [alert] = await db
    .insert(alerts)
    .values({
      ruleId: null,
      deviceId: canonical.deviceId,
      orgId: canonical.orgId,
      status: 'active',
      severity,
      title,
      message,
      context: {
        source: 'metric_anomaly',
        anomalyId: canonical.id,
        metricName: canonical.metricName,
        metricType: canonical.metricType,
        anomalyType: canonical.anomalyType,
        observedValue: canonical.observedValue,
        baselineValue: canonical.baselineValue,
        confidence: canonical.confidence,
        score: canonical.score,
        modelVersion: (canonical.baselineSummary as { modelVersion?: unknown } | null)?.modelVersion ?? null,
      },
      triggeredAt: now,
    })
    .returning({ id: alerts.id });

  if (!alert?.id) {
    throw new Error('Failed to create alert for metric anomaly');
  }

  const [updated] = await db
    .update(metricAnomalies)
    .set({
      status: 'promoted',
      linkedAlertId: alert.id,
      resolvedAt: null,
      updatedAt: now,
    })
    .where(anomalyIdentityWhere(options))
    .returning();

  // Link every sibling to the same alert so a later promotion of any of them is
  // a no-op reuse, not a duplicate incident.
  for (const sibling of siblings) {
    await db
      .update(metricAnomalies)
      .set({
        status: 'promoted',
        linkedAlertId: alert.id,
        resolvedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(metricAnomalies.id, sibling.id),
          eq(metricAnomalies.orgId, anomaly.orgId),
          eq(metricAnomalies.deviceId, anomaly.deviceId),
        ),
      );
  }

  const siteId = await resolveDeviceSiteId(anomaly.deviceId);
  await publishEvent(
    'alert.triggered',
    anomaly.orgId,
    {
      alertId: alert.id,
      ruleId: null,
      deviceId: anomaly.deviceId,
      severity,
      title,
      message,
      source: 'metric-anomaly',
      anomalyId: anomaly.id,
    },
    'metric-anomaly-promotion',
    {
      userId: options.actorUserId ?? undefined,
      siteId,
    },
  );

  return {
    status: 'promoted',
    anomaly: updated ?? {
      ...anomaly,
      status: 'promoted',
      linkedAlertId: alert.id,
      resolvedAt: null,
      updatedAt: now,
    },
    alertId: alert.id,
    created: true,
  };
}

export const __testOnly = {
  severityForAnomaly,
  titleForAnomaly,
  messageForAnomaly,
};
