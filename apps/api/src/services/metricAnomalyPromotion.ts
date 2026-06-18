import { and, eq } from 'drizzle-orm';

import { db } from '../db';
import { alerts, metricAnomalies } from '../db/schema';
import { publishEvent } from './eventBus';
import { shouldProduceMlOutput } from './mlFeatureFlags';
import { resolveDeviceSiteId } from './deviceSiteResolver';

type MetricAnomalyRow = typeof metricAnomalies.$inferSelect;

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

  if (
    options.requireCreateAlertsFlag !== false
    && !(await shouldProduceMlOutput(anomaly.orgId, 'ml.anomalies.create_alerts'))
  ) {
    return { status: 'disabled', anomaly };
  }

  const severity = severityForAnomaly(anomaly);
  const title = titleForAnomaly(anomaly);
  const message = messageForAnomaly(anomaly);
  const now = new Date();

  const [alert] = await db
    .insert(alerts)
    .values({
      ruleId: null,
      deviceId: anomaly.deviceId,
      orgId: anomaly.orgId,
      status: 'active',
      severity,
      title,
      message,
      context: {
        source: 'metric_anomaly',
        anomalyId: anomaly.id,
        metricName: anomaly.metricName,
        metricType: anomaly.metricType,
        anomalyType: anomaly.anomalyType,
        observedValue: anomaly.observedValue,
        baselineValue: anomaly.baselineValue,
        confidence: anomaly.confidence,
        score: anomaly.score,
        modelVersion: (anomaly.baselineSummary as { modelVersion?: unknown } | null)?.modelVersion ?? null,
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
