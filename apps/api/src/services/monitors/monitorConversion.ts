import type { MonitorKind } from '@breeze/shared';
import { getMonitorKindSpec } from './kinds';

/**
 * Legacy alert rule → monitor definition (#5289).
 *
 * The inverse of `MonitorKindSpec.toAlertCondition`, used by
 * POST /alerts/rules/:id/convert-to-monitor. It is deliberately TOTAL and
 * conservative: a condition it cannot map exactly returns null, and the route
 * answers 409 RULE_NOT_CONVERTIBLE rather than inventing a monitor whose
 * evaluation would differ from the rule it replaced.
 *
 * Condition GROUPS ({ logic, conditions }) are never convertible: a monitor
 * carries exactly one root condition by design, so an and/or tree has no
 * faithful single-monitor representation.
 */

export interface ConvertedDefinition {
  kind: MonitorKind;
  condition: Record<string, unknown>;
}

const THRESHOLD_METRIC_KINDS: Record<string, MonitorKind> = {
  cpuPercent: 'cpu',
  ramPercent: 'memory',
  diskPercent: 'disk',
};

const DIRECT_KINDS: Record<string, MonitorKind> = {
  offline: 'offline',
  status: 'offline',
  event_log: 'event_log',
  patch_compliance: 'patch_compliance',
  service_stopped: 'service',
  process_stopped: 'process',
  cert_expiry: 'cert_expiry',
  bandwidth_high: 'bandwidth',
  disk_io_high: 'disk_io',
  network_errors: 'network_errors',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param conditions the template's stored `conditions` — a single root object,
 * or a one-element array (both shapes exist in the wild).
 */
export function convertAlertConditionToMonitor(conditions: unknown): ConvertedDefinition | null {
  let root = conditions;
  if (Array.isArray(root)) {
    if (root.length !== 1) return null;
    root = root[0];
  }
  if (!isRecord(root)) return null;
  if ('logic' in root || 'conditions' in root) return null;

  const type = typeof root.type === 'string' ? root.type : null;
  if (!type) return null;

  let kind: MonitorKind | undefined;
  const condition: Record<string, unknown> = {};

  if (type === 'threshold' || type === 'metric') {
    const metric = typeof root.metric === 'string' ? root.metric : '';
    kind = THRESHOLD_METRIC_KINDS[metric];
    // processCount has no monitor kind of its own in W02 — rules on it stay
    // legacy rather than convert into something that measures a different thing.
    if (!kind) return null;
    condition.operator = root.operator;
    condition.value = root.value;
    if (root.durationMinutes !== undefined) condition.durationMinutes = root.durationMinutes;
  } else if (type === 'process_cpu_high' || type === 'process_memory_high') {
    kind = 'process_resource';
    condition.resource = type === 'process_cpu_high' ? 'cpu' : 'memory';
    condition.processName = root.processName;
    condition.operator = root.operator;
    condition.value = root.value;
    if (root.durationMinutes !== undefined) condition.durationMinutes = root.durationMinutes;
  } else {
    kind = DIRECT_KINDS[type];
    if (!kind) return null;
    for (const [key, value] of Object.entries(root)) {
      if (key === 'type') continue;
      if (value === undefined || value === null) continue;
      condition[key] = value;
    }
  }

  // Final gate: the produced condition must satisfy the kind's own authoring
  // schema. Anything else would be persisted and then fail at compile time.
  const parsed = getMonitorKindSpec(kind).conditionSchema.safeParse(condition);
  if (!parsed.success) return null;
  return { kind, condition: parsed.data as Record<string, unknown> };
}
