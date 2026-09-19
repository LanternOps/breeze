import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = { operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; value: number; durationMinutes?: number };

// Same threshold shape as cpu; only `metric` differs on the compiled side.
export const memoryKind: MonitorKindSpec<C> = {
  kind: 'memory',
  conditionSchema: monitorConditionSchemas.memory,
  overridableKeys: ['operator', 'value', 'durationMinutes'],
  defaultSeverity: 'high',
  agentDelivered: false,
  titleTemplate: 'High Memory on {{deviceName}}',
  messageTemplate: '{{ruleName}}: RAM {{actualValue}}% ({{operator}} {{threshold}}%)',
  toAlertCondition: (c) => ({
    type: 'threshold',
    metric: 'ramPercent',
    operator: c.operator,
    value: c.value,
    ...(c.durationMinutes ? { durationMinutes: c.durationMinutes } : {}),
  }),
};
