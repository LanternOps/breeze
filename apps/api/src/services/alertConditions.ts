/**
 * Alert Condition Evaluator
 *
 * Parses and evaluates JSONB conditions from alert templates against device metrics.
 * Supports threshold conditions, offline detection, and compound AND/OR logic.
 */

import { db } from '../db';
import { deviceMetrics, devices, deviceEventLogs } from '../db/schema';
import { eq, and, gte, desc, like, sql } from 'drizzle-orm';

// Supported comparison operators
export type ComparisonOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

// Metric types that can be monitored (internal names match DB column names)
export type MetricName = 'cpuPercent' | 'ramPercent' | 'diskPercent' | 'processCount';

// Mapping from short metric names (used in UI) to DB column names
const METRIC_NAME_MAP: Record<string, MetricName> = {
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
function normalizeMetricName(metric: string): MetricName | null {
  return METRIC_NAME_MAP[metric] || null;
}

// Single threshold condition (also accepts type: 'metric' for backwards compatibility)
export interface ThresholdCondition {
  type: 'threshold' | 'metric';
  metric: MetricName | string; // Accepts both full and short names
  operator: ComparisonOperator;
  value: number;
  durationMinutes?: number; // Must exceed for this long
}

// Offline detection condition
export interface OfflineCondition {
  type: 'offline';
  durationMinutes?: number; // How long device must be offline
}

// Event log condition - triggers based on event log entries
export interface EventLogCondition {
  type: 'event_log';
  category: 'security' | 'hardware' | 'application' | 'system';
  level: 'warning' | 'error' | 'critical';
  sourcePattern?: string;      // regex match on source
  messagePattern?: string;     // regex match on message
  countThreshold: number;       // trigger if >= N events
  windowMinutes: number;        // within this time window
}

// Union of all condition types
export type AlertCondition = ThresholdCondition | OfflineCondition | EventLogCondition;

/**
 * Check if a condition is a threshold/metric type
 */
function isThresholdCondition(condition: AlertCondition): condition is ThresholdCondition {
  return condition.type === 'threshold' || condition.type === 'metric';
}

// Compound condition with AND/OR logic
export interface ConditionGroup {
  logic: 'and' | 'or';
  conditions: (AlertCondition | ConditionGroup)[];
}

// Root condition can be a single condition or a group
export type RootCondition = AlertCondition | ConditionGroup;

// Evaluation result with context
export interface EvaluationResult {
  triggered: boolean;
  conditionsMet: string[];
  conditionsNotMet: string[];
  context: {
    metric?: string;
    actualValue?: number;
    threshold?: number;
    operator?: string;
    durationMinutes?: number;
    deviceId: string;
    evaluatedAt: string;
  };
}

/**
 * Check if a value is a condition group (has logic property)
 */
function isConditionGroup(condition: RootCondition): condition is ConditionGroup {
  return 'logic' in condition && 'conditions' in condition;
}

/**
 * Compare a value against a threshold using the specified operator
 */
function compareValue(actual: number, operator: ComparisonOperator, threshold: number): boolean {
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
function getOperatorDisplay(operator: ComparisonOperator): string {
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
async function getRecentMetrics(
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
async function getLatestMetric(deviceId: string): Promise<typeof deviceMetrics.$inferSelect | null> {
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
async function getDevice(deviceId: string): Promise<typeof devices.$inferSelect | null> {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  return device || null;
}

/**
 * Evaluate a single threshold condition
 */
async function evaluateThresholdCondition(
  condition: ThresholdCondition,
  deviceId: string
): Promise<{ passed: boolean; description: string; actualValue?: number }> {
  const durationMinutes = condition.durationMinutes || 1;

  // Normalize metric name (handles both 'disk' and 'diskPercent' formats)
  const metricName = normalizeMetricName(condition.metric);
  if (!metricName) {
    return {
      passed: false,
      description: `Unknown metric: ${condition.metric}`
    };
  }

  // Get metrics within the duration window
  const metrics = await getRecentMetrics(deviceId, durationMinutes);

  if (metrics.length === 0) {
    return {
      passed: false,
      description: `No metrics available for ${condition.metric}`
    };
  }

  // Check if ALL metrics within the window exceed the threshold
  // This ensures the condition has persisted for the full duration
  const allExceed = metrics.every(m => {
    const value = m[metricName];
    if (value === null || value === undefined) return false;
    return compareValue(value, condition.operator, condition.value);
  });

  const latestValue = metrics[0]?.[metricName] ?? undefined;
  const operatorDisplay = getOperatorDisplay(condition.operator);

  return {
    passed: allExceed,
    description: `${condition.metric} ${operatorDisplay} ${condition.value} for ${durationMinutes}min`,
    actualValue: latestValue ?? undefined
  };
}

/**
 * Evaluate an offline condition
 */
async function evaluateOfflineCondition(
  condition: OfflineCondition,
  deviceId: string
): Promise<{ passed: boolean; description: string }> {
  const device = await getDevice(deviceId);

  if (!device) {
    return {
      passed: false,
      description: 'Device not found'
    };
  }

  const durationMinutes = condition.durationMinutes || 5;
  const offlineThreshold = new Date(Date.now() - durationMinutes * 60 * 1000);

  // Check if device is offline (status is offline or lastSeenAt is too old)
  const isOffline = device.status === 'offline' ||
    (device.lastSeenAt !== null && device.lastSeenAt < offlineThreshold);

  return {
    passed: isOffline,
    description: `Device offline for ${durationMinutes}min`
  };
}

/**
 * Evaluate an event log condition
 */
async function evaluateEventLogCondition(
  condition: EventLogCondition,
  deviceId: string
): Promise<{ passed: boolean; description: string; actualValue?: number }> {
  const windowStart = new Date(Date.now() - condition.windowMinutes * 60 * 1000);

  const conditions: ReturnType<typeof eq>[] = [
    eq(deviceEventLogs.deviceId, deviceId),
    eq(deviceEventLogs.category, condition.category),
    gte(deviceEventLogs.timestamp, windowStart),
  ];

  // Level filter: match specified level and above
  const levelOrder = ['info', 'warning', 'error', 'critical'];
  const minLevelIdx = levelOrder.indexOf(condition.level);
  if (minLevelIdx >= 0) {
    // Use SQL to match levels at or above the threshold
    const matchLevels = levelOrder.slice(minLevelIdx);
    conditions.push(
      sql`${deviceEventLogs.level} = ANY(ARRAY[${sql.raw(matchLevels.map(l => `'${l}'`).join(','))}]::event_log_level[])`
    );
  }

  // Source pattern filter
  if (condition.sourcePattern) {
    conditions.push(like(deviceEventLogs.source, `%${condition.sourcePattern}%`));
  }

  // Message pattern filter
  if (condition.messagePattern) {
    conditions.push(like(deviceEventLogs.message, `%${condition.messagePattern}%`));
  }

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(deviceEventLogs)
    .where(and(...conditions));

  const matchCount = Number(countResult[0]?.count ?? 0);
  const passed = matchCount >= condition.countThreshold;

  return {
    passed,
    description: `${condition.category}/${condition.level} events >= ${condition.countThreshold} in ${condition.windowMinutes}min (found ${matchCount})`,
    actualValue: matchCount,
  };
}

/**
 * Evaluate a single condition (threshold/metric, offline, or event_log)
 */
async function evaluateSingleCondition(
  condition: AlertCondition,
  deviceId: string
): Promise<{ passed: boolean; description: string; actualValue?: number }> {
  switch (condition.type) {
    case 'threshold':
    case 'metric': // Backwards compatibility with UI-generated conditions
      return evaluateThresholdCondition(condition as ThresholdCondition, deviceId);
    case 'offline':
      return evaluateOfflineCondition(condition, deviceId);
    case 'event_log':
      return evaluateEventLogCondition(condition as EventLogCondition, deviceId);
    default:
      return {
        passed: false,
        description: `Unknown condition type: ${(condition as { type: string }).type}`
      };
  }
}

/**
 * Recursively evaluate a condition or condition group
 */
async function evaluateConditionRecursive(
  condition: RootCondition,
  deviceId: string,
  results: { met: string[]; notMet: string[] }
): Promise<boolean> {
  if (isConditionGroup(condition)) {
    // Evaluate all conditions in the group
    const evaluations = await Promise.all(
      condition.conditions.map(c => evaluateConditionRecursive(c, deviceId, results))
    );

    if (condition.logic === 'and') {
      return evaluations.every(e => e);
    } else {
      return evaluations.some(e => e);
    }
  } else {
    // Evaluate single condition
    const result = await evaluateSingleCondition(condition, deviceId);

    if (result.passed) {
      results.met.push(result.description);
    } else {
      results.notMet.push(result.description);
    }

    return result.passed;
  }
}

/**
 * Main entry point: Evaluate conditions against a device
 *
 * @param conditions - JSONB conditions from alert template (can be object or array)
 * @param deviceId - Device to evaluate
 * @returns Evaluation result with triggered status and context
 */
export async function evaluateConditions(
  conditions: unknown,
  deviceId: string
): Promise<EvaluationResult> {
  const evaluatedAt = new Date().toISOString();

  // Handle null/undefined conditions
  if (!conditions) {
    return {
      triggered: false,
      conditionsMet: [],
      conditionsNotMet: ['No conditions defined'],
      context: {
        deviceId,
        evaluatedAt
      }
    };
  }

  // Normalize conditions to RootCondition format
  let rootCondition: RootCondition;

  if (Array.isArray(conditions)) {
    // Array of conditions treated as AND group
    rootCondition = {
      logic: 'and',
      conditions: conditions as AlertCondition[]
    };
  } else if (typeof conditions === 'object') {
    rootCondition = conditions as RootCondition;
  } else {
    return {
      triggered: false,
      conditionsMet: [],
      conditionsNotMet: ['Invalid conditions format'],
      context: {
        deviceId,
        evaluatedAt
      }
    };
  }

  const results = { met: [] as string[], notMet: [] as string[] };
  const triggered = await evaluateConditionRecursive(rootCondition, deviceId, results);

  // Get latest metric for context
  const latestMetric = await getLatestMetric(deviceId);

  // Build context based on the primary condition (first threshold condition found)
  const context: EvaluationResult['context'] = {
    deviceId,
    evaluatedAt
  };

  // Find first threshold condition to include in context
  const findFirstThreshold = (cond: RootCondition): ThresholdCondition | undefined => {
    if (isConditionGroup(cond)) {
      for (const c of cond.conditions) {
        const found = findFirstThreshold(c);
        if (found) return found;
      }
      return undefined;
    } else if (cond.type === 'threshold') {
      return cond;
    }
    return undefined;
  };

  const primaryThreshold = findFirstThreshold(rootCondition);
  if (primaryThreshold && latestMetric) {
    const normalizedMetric = normalizeMetricName(primaryThreshold.metric);
    context.metric = primaryThreshold.metric;
    context.actualValue = normalizedMetric ? latestMetric[normalizedMetric] ?? undefined : undefined;
    context.threshold = primaryThreshold.value;
    context.operator = getOperatorDisplay(primaryThreshold.operator);
    context.durationMinutes = primaryThreshold.durationMinutes;
  }

  return {
    triggered,
    conditionsMet: results.met,
    conditionsNotMet: results.notMet,
    context
  };
}

/**
 * Evaluate auto-resolve conditions (inverse of trigger conditions)
 * Used to automatically resolve alerts when conditions clear
 */
export async function evaluateAutoResolveConditions(
  conditions: unknown,
  deviceId: string
): Promise<{ shouldResolve: boolean; reason: string }> {
  // If no auto-resolve conditions specified, can't auto-resolve
  if (!conditions) {
    return { shouldResolve: false, reason: 'No auto-resolve conditions defined' };
  }

  const result = await evaluateConditions(conditions, deviceId);

  // For auto-resolve, the conditions should evaluate to TRUE (cleared state)
  if (result.triggered) {
    return {
      shouldResolve: true,
      reason: `Conditions cleared: ${result.conditionsMet.join(', ')}`
    };
  }

  return {
    shouldResolve: false,
    reason: `Conditions still active: ${result.conditionsNotMet.join(', ')}`
  };
}

/**
 * Validate condition structure
 * Returns list of errors if invalid
 */
export function validateConditions(conditions: unknown): string[] {
  const errors: string[] = [];

  if (!conditions) {
    return ['Conditions cannot be empty'];
  }

  const validateSingle = (cond: unknown, path: string): void => {
    if (!cond || typeof cond !== 'object') {
      errors.push(`${path}: Must be an object`);
      return;
    }

    const c = cond as Record<string, unknown>;

    if ('logic' in c) {
      // It's a condition group
      if (c.logic !== 'and' && c.logic !== 'or') {
        errors.push(`${path}.logic: Must be 'and' or 'or'`);
      }
      if (!Array.isArray(c.conditions)) {
        errors.push(`${path}.conditions: Must be an array`);
      } else {
        c.conditions.forEach((sub, i) => validateSingle(sub, `${path}.conditions[${i}]`));
      }
    } else if ('type' in c) {
      // It's a single condition
      if (c.type === 'threshold') {
        if (!['cpuPercent', 'ramPercent', 'diskPercent', 'processCount'].includes(c.metric as string)) {
          errors.push(`${path}.metric: Invalid metric name`);
        }
        if (!['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(c.operator as string)) {
          errors.push(`${path}.operator: Invalid operator`);
        }
        if (typeof c.value !== 'number') {
          errors.push(`${path}.value: Must be a number`);
        }
        if (c.durationMinutes !== undefined && typeof c.durationMinutes !== 'number') {
          errors.push(`${path}.durationMinutes: Must be a number`);
        }
      } else if (c.type === 'offline') {
        if (c.durationMinutes !== undefined && typeof c.durationMinutes !== 'number') {
          errors.push(`${path}.durationMinutes: Must be a number`);
        }
      } else if (c.type === 'event_log') {
        if (!['security', 'hardware', 'application', 'system'].includes(c.category as string)) {
          errors.push(`${path}.category: Invalid category`);
        }
        if (!['warning', 'error', 'critical'].includes(c.level as string)) {
          errors.push(`${path}.level: Invalid level`);
        }
        if (typeof c.countThreshold !== 'number' || c.countThreshold < 1) {
          errors.push(`${path}.countThreshold: Must be a positive number`);
        }
        if (typeof c.windowMinutes !== 'number' || c.windowMinutes < 1) {
          errors.push(`${path}.windowMinutes: Must be a positive number`);
        }
      } else {
        errors.push(`${path}.type: Unknown condition type '${c.type}'`);
      }
    } else {
      errors.push(`${path}: Missing 'type' or 'logic' property`);
    }
  };

  if (Array.isArray(conditions)) {
    conditions.forEach((c, i) => validateSingle(c, `conditions[${i}]`));
  } else {
    validateSingle(conditions, 'conditions');
  }

  return errors;
}

/**
 * Interpolate template strings with context values
 * Supports {{variable}} syntax
 */
export function interpolateTemplate(
  template: string,
  context: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = context[key];
    if (value === undefined || value === null) {
      return match; // Keep original if no value
    }
    return String(value);
  });
}
