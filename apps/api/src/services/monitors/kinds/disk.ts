import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = { operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; value: number; durationMinutes?: number };

// Same threshold shape as cpu/memory; only `metric` differs on the compiled side.
export const diskKind: MonitorKindSpec<C> = {
  kind: 'disk',
  conditionSchema: monitorConditionSchemas.disk,
  overridableKeys: ['operator', 'value', 'durationMinutes'],
  defaultSeverity: 'high',
  agentDelivered: false,
  titleTemplate: 'Low Disk Space on {{deviceName}}',
  messageTemplate: '{{ruleName}}: Disk {{actualValue}}% ({{operator}} {{threshold}}%)',
  toAlertCondition: (c) => ({
    type: 'threshold',
    metric: 'diskPercent',
    operator: c.operator,
    value: c.value,
    ...(c.durationMinutes ? { durationMinutes: c.durationMinutes } : {}),
  }),
};
