/**
 * Alert Condition Utilities
 *
 * Shared helper functions used across condition handlers.
 */

import { db } from '../../db';
import { deviceMetrics, devices } from '../../db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import type { ComparisonOperator, MetricName } from './types';

// Mapping from short metric names (used in UI) to DB column names
export const METRIC_NAME_MAP: Record<string, MetricName> = {
  'cpu': 'cpuPercent',
  'cpuPercent': 'cpuPercent',
  'ram': 'ramPercent',
  'ramPercent': 'ramPercent',
  'memory': 'ramPercent',
  'disk': 'diskPercent',
  'diskPercent': 'diskPercent',
  'processCount': 'processCount',
  'processes': 'processCount'
};

/**
 * Normalize metric name from various formats to DB column name
 */
export function normalizeMetricName(metric: string): MetricName | null {
  return METRIC_NAME_MAP[metric] || null;
}

/**
 * Compare a value against a threshold using the specified operator
 */
export function compareValue(actual: number, operator: ComparisonOperator, threshold: number): boolean {
  switch (operator) {
    case 'gt':
      return actual > threshold;
    case 'gte':
      return actual >= threshold;
    case 'lt':
      return actual < threshold;
    case 'lte':
      return actual <= threshold;
    case 'eq':
      return actual === threshold;
    case 'neq':
      return actual !== threshold;
    default:
      return false;
  }
}

/**
 * Get operator display string for context
 */
export function getOperatorDisplay(operator: ComparisonOperator): string {
  switch (operator) {
    case 'gt': return '>';
    case 'gte': return '>=';
    case 'lt': return '<';
    case 'lte': return '<=';
    case 'eq': return '=';
    case 'neq': return '!=';
    default: return operator;
  }
}

/**
 * Get recent metrics for a device within a time window
 */
export async function getRecentMetrics(
  deviceId: string,
  durationMinutes: number
): Promise<typeof deviceMetrics.$inferSelect[]> {
  const windowStart = new Date(Date.now() - durationMinutes * 60 * 1000);

  return db
    .select()
    .from(deviceMetrics)
    .where(
      and(
        eq(deviceMetrics.deviceId, deviceId),
        gte(deviceMetrics.timestamp, windowStart)
      )
    )
    .orderBy(desc(deviceMetrics.timestamp));
}

/**
 * Get the latest metric value for a device
 */
export async function getLatestMetric(deviceId: string): Promise<typeof deviceMetrics.$inferSelect | null> {
  const [latest] = await db
    .select()
    .from(deviceMetrics)
    .where(eq(deviceMetrics.deviceId, deviceId))
    .orderBy(desc(deviceMetrics.timestamp))
    .limit(1);

  return latest || null;
}

/**
 * Get device info for offline detection
 */
export async function getDevice(deviceId: string): Promise<typeof devices.$inferSelect | null> {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  return device || null;
}
