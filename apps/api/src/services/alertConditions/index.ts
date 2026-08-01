/**
 * Alert Condition Evaluator
 *
 * Modular handler registry for evaluating JSONB conditions from alert templates
 * against device metrics and monitoring data. Supports threshold conditions,
 * offline detection, event log conditions, service/process stopped conditions,
 * process resource conditions, bandwidth, disk I/O, network errors,
 * patch compliance, cert expiry, and compound AND/OR logic.
 */

import { conditionRegistry } from './registry';
import { getLatestMetric, normalizeMetricName, getOperatorDisplay } from './utils';

// Register all built-in handlers
import { thresholdHandler } from './handlers/threshold';
import { offlineHandler } from './handlers/offline';
import { eventLogHandler } from './handlers/eventLog';
import { serviceHandler } from './handlers/service';
import { processHandler } from './handlers/process';
import { processCpuHighHandler, processMemoryHighHandler } from './handlers/processResource';
import { bandwidthHighHandler } from './handlers/bandwidthHigh';
import { diskIoHighHandler } from './handlers/diskIoHigh';
import { networkErrorsHandler } from './handlers/networkErrors';
import { patchComplianceHandler } from './handlers/patchCompliance';
import { certExpiryHandler } from './handlers/certExpiry';

conditionRegistry.register(thresholdHandler);
conditionRegistry.register(offlineHandler);
conditionRegistry.register(eventLogHandler);
conditionRegistry.register(serviceHandler);
conditionRegistry.register(processHandler);
conditionRegistry.register(processCpuHighHandler);
conditionRegistry.register(processMemoryHighHandler);
conditionRegistry.register(bandwidthHighHandler);
conditionRegistry.register(diskIoHighHandler);
conditionRegistry.register(networkErrorsHandler);
conditionRegistry.register(patchComplianceHandler);
conditionRegistry.register(certExpiryHandler);

// Re-export types for backward compatibility
export type {
  ComparisonOperator,
  MetricName,
  ThresholdCondition,
  OfflineCondition,
  EventLogCondition,
  ServiceCondition,
  ProcessCondition,
  ProcessResourceCondition,
  BandwidthHighCondition,
  DiskIoHighCondition,
  NetworkErrorsCondition,
  PatchComplianceCondition,
  CertExpiryCondition,
  AlertCondition,
  ConditionGroup,
  RootCondition,
  EvaluationResult,
  ConditionResult
} from './types';

// Re-export utilities
export { conditionRegistry } from './registry';
export { compareValue, getOperatorDisplay, normalizeMetricName, METRIC_NAME_MAP } from './utils';

// Type imports for internal use
import type {
  AlertCondition,
  ConditionGroup,
  RootCondition,
  EvaluationResult,
  ThresholdCondition,
} from './types';

function isConditionGroup(condition: RootCondition): condition is ConditionGroup {
  return 'logic' in condition && 'conditions' in condition;
}

async function evaluateConditionRecursive(
  condition: RootCondition,
  deviceId: string,
  results: { met: string[]; notMet: string[]; primaryActualValue?: number }
): Promise<boolean> {
  if (isConditionGroup(condition)) {
    const evaluations = await Promise.all(
      condition.conditions.map(c => evaluateConditionRecursive(c, deviceId, results))
    );

    if (condition.logic === 'and') {
      return evaluations.every(e => e);
    } else {
      return evaluations.some(e => e);
    }
  } else {
    // Evaluate via registry
    const result = await conditionRegistry.evaluate(
      condition as { type: string },
      deviceId
    );

    if (result.passed) {
      results.met.push(result.description);
    } else {
      results.notMet.push(result.description);
    }

    // Capture the value the threshold/metric handler actually evaluated (the
    // window average) so context.actualValue reflects what drove the decision
    // rather than the latest raw sample — which can be sub-threshold once the
    // window is averaged (#1980).
    const condType = (condition as { type?: string }).type;
    if (
      (condType === 'threshold' || condType === 'metric') &&
      results.primaryActualValue === undefined &&
      typeof result.actualValue === 'number'
    ) {
      results.primaryActualValue = result.actualValue;
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

  if (!conditions) {
    return {
      triggered: false,
      conditionsMet: [],
      conditionsNotMet: ['No conditions defined'],
      context: { deviceId, evaluatedAt }
    };
  }

  let rootCondition: RootCondition;

  if (Array.isArray(conditions)) {
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
      context: { deviceId, evaluatedAt }
    };
  }

  const results = { met: [] as string[], notMet: [] as string[] } as {
    met: string[];
    notMet: string[];
    primaryActualValue?: number;
  };
  const triggered = await evaluateConditionRecursive(rootCondition, deviceId, results);

  // Get latest metric for context
  const latestMetric = await getLatestMetric(deviceId);

  const context: EvaluationResult['context'] = { deviceId, evaluatedAt };

  // Find first threshold condition to include in context
  const findFirstThreshold = (cond: RootCondition): ThresholdCondition | undefined => {
    if (isConditionGroup(cond)) {
      for (const c of cond.conditions) {
        const found = findFirstThreshold(c);
        if (found) return found;
      }
      return undefined;
    } else if (cond.type === 'threshold' || cond.type === 'metric') {
      return cond as ThresholdCondition;
    }
    return undefined;
  };

  const primaryThreshold = findFirstThreshold(rootCondition);
  if (primaryThreshold) {
    const normalizedMetric = normalizeMetricName(primaryThreshold.metric);
    const latestValue = normalizedMetric ? latestMetric?.[normalizedMetric] ?? undefined : undefined;
    context.metric = primaryThreshold.metric;
    // Prefer the averaged value the handler evaluated; fall back to the latest
    // raw sample only when no handler value was captured (e.g. window empty).
    context.actualValue = results.primaryActualValue ?? latestValue;
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
 * Evaluate explicit auto-resolve conditions. Returns shouldResolve: true when the specified conditions are met.
 */
export async function evaluateAutoResolveConditions(
  conditions: unknown,
  deviceId: string
): Promise<{ shouldResolve: boolean; reason: string }> {
  if (!conditions) {
    return { shouldResolve: false, reason: 'No auto-resolve conditions defined' };
  }

  const result = await evaluateConditions(conditions, deviceId);

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
      if (c.logic !== 'and' && c.logic !== 'or') {
        errors.push(`${path}.logic: Must be 'and' or 'or'`);
      }
      if (!Array.isArray(c.conditions)) {
        errors.push(`${path}.conditions: Must be an array`);
      } else {
        c.conditions.forEach((sub, i) => validateSingle(sub, `${path}.conditions[${i}]`));
      }
    } else if ('type' in c) {
      const handlerErrors = conditionRegistry.validate(
        c as { type: string } & Record<string, unknown>,
        path
      );
      errors.push(...handlerErrors);
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

// Deepest nesting a conditions tree is walked to. Groups nest via
// `{logic, conditions[]}`; anything past this is malformed or hostile and is
// not worth recursing into.
const MAX_CONDITION_DEPTH = 10;

// Ceiling on how many nodes the walk will visit, so an oversized or hostile
// payload can't turn this boundary check into a CPU sink. `/alerts/rules`
// validates `conditions` as `z.any()` with no size cap of its own.
const MAX_CONDITION_NODES = 5000;

/**
 * Condition types that were once writable but have no evaluator behind them.
 *
 * **A denylist, deliberately — NOT "every type absent from `conditionRegistry`".**
 * The registry is not the complete set of live condition types: `dns_threat`
 * (seeded built-in template, `db/seed.ts`) is evaluated by an event-bus
 * subscriber in `services/dnsThreatAlerts.ts` that never consults the registry,
 * and the alert-template editor writes `type: 'event'` triggers. Rejecting
 * "unregistered" types would 400 those working features — e.g. the documented
 * way to narrow a DNS-threat rule is editing its `override_settings.conditions
 * .categories`, which is a plain `PUT /alerts/rules`.
 *
 * So the failure mode is chosen on purpose: this misses a hypothetical future
 * dead type rather than breaking a live one. Add an entry here when a type is
 * retired, alongside a cleanup migration for rows that already carry it.
 */
export const RETIRED_CONDITION_TYPES: ReadonlySet<string> = new Set([
  // #2948 — offered by both alert-rule editors, never had a handler.
  // `conditionRegistry.evaluate` answered "Unknown condition type: custom" with
  // passed=false, and a root-level array is evaluated as an implicit AND
  // (`evaluateConditions` wraps it in `{logic:'and'}`), so a rule carrying one
  // could never fire. Inside an explicit `or` group it would not be fatal, but
  // the write boundary rejects it there too: a type with no evaluator is a bug
  // in the payload either way.
  'custom',
]);

/**
 * Collect every retired condition type appearing anywhere in a conditions
 * payload.
 *
 * The walk is deliberately structure-agnostic — it descends into every nested
 * object and array rather than only `{logic, conditions[]}` groups. The write
 * paths this guards accept several different envelopes for the same data: a
 * bare array (`POST /alerts/rules`), a `{logic, conditions[]}` group, and the
 * alert-template editor's `{triggers: [...], thresholdDefaults, ...}` object
 * (`z.record` on those routes, never an array). A structure-aware walk silently
 * missed the last of those. Over-walking is safe *because* this is a denylist:
 * the worst case is finding a retired type somewhere unexpected, which is still
 * a type nobody can evaluate.
 *
 * Returns the offending type names, deduped. Empty means the payload is clean.
 */
export function findRetiredConditionTypes(conditions: unknown): string[] {
  const retired = new Set<string>();
  let visited = 0;

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_CONDITION_DEPTH || ++visited > MAX_CONDITION_NODES) return;
    if (node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }

    const record = node as Record<string, unknown>;
    if (typeof record.type === 'string' && RETIRED_CONDITION_TYPES.has(record.type)) {
      retired.add(record.type);
    }
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') walk(value, depth + 1);
    }
  };

  walk(conditions, 0);
  return [...retired];
}

/**
 * Boundary check for the alert-rule / alert-template write paths. Returns a
 * user-facing error message when the payload carries a retired condition type,
 * or null when it is safe to store.
 *
 * Note the depth/node caps above mean a pathologically nested payload can slip
 * a retired type past this check. That degrades to the pre-#2948 behaviour —
 * the evaluator (`evaluateConditionRecursive`, which has no depth limit) still
 * fails it closed — rather than to a false rejection.
 */
export function retiredConditionTypeError(conditions: unknown): string | null {
  if (conditions === undefined || conditions === null) return null;

  const retired = findRetiredConditionTypes(conditions);
  if (retired.length === 0) return null;

  return `Retired alert condition type(s): ${retired.join(', ')}. `
    + 'These never had an evaluator behind them, so a rule containing one can never fire. '
    + 'Remove or replace the condition.';
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
      return match;
    }
    return String(value);
  });
}
