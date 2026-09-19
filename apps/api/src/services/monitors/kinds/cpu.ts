import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = { operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; value: number; durationMinutes?: number };

// Authoring shape is a plain percent threshold; the handler shape adds `type`
// and `metric` (alertConditions has one generic threshold handler keyed by
// metric name, not a per-metric handler).
export const cpuKind: MonitorKindSpec<C> = {
  kind: 'cpu',
  conditionSchema: monitorConditionSchemas.cpu,
  overridableKeys: ['operator', 'value', 'durationMinutes'],
  defaultSeverity: 'high',
  agentDelivered: false,
  titleTemplate: 'High CPU on {{deviceName}}',
  messageTemplate: '{{ruleName}}: CPU {{actualValue}}% ({{operator}} {{threshold}}%)',
  toAlertCondition: (c) => ({
    type: 'threshold',
    metric: 'cpuPercent',
    operator: c.operator,
    value: c.value,
    ...(c.durationMinutes ? { durationMinutes: c.durationMinutes } : {}),
  }),
};
