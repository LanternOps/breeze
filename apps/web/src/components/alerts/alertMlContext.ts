export type MetricAnomalyAlertContext = {
  source: 'metric_anomaly';
  anomalyId: string | null;
  metricName: string | null;
  metricType: string | null;
  anomalyType: string | null;
  observedValue: number | null;
  baselineValue: number | null;
  confidence: number | null;
  score: number | null;
  modelVersion: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function normalizeMetricAnomalyContext(value: unknown): MetricAnomalyAlertContext | null {
  const context = asRecord(value);
  if (context.source !== 'metric_anomaly') return null;

  return {
    source: 'metric_anomaly',
    anomalyId: stringOrNull(context.anomalyId),
    metricName: stringOrNull(context.metricName),
    metricType: stringOrNull(context.metricType),
    anomalyType: stringOrNull(context.anomalyType),
    observedValue: numberOrNull(context.observedValue),
    baselineValue: numberOrNull(context.baselineValue),
    confidence: numberOrNull(context.confidence),
    score: numberOrNull(context.score),
    modelVersion: stringOrNull(context.modelVersion),
  };
}

export function formatAnomalyType(value: string | null): string {
  return value ? value.replace(/_/g, ' ') : 'anomaly';
}

export function formatAnomalyValue(value: number | null): string {
  if (value === null) return 'n/a';
  return formatNumber(value, Number.isInteger(value) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatAnomalyConfidence(value: number | null): string {
  if (value === null) return 'n/a';
  return formatPercent(value, { maximumFractionDigits: 0 });
}
import { formatNumber, formatPercent } from '@/lib/i18n/format';
