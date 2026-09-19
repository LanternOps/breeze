import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  resource: 'cpu' | 'memory';
  processName: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  value: number;
  durationMinutes?: number;
};

// One authoring kind maps to TWO handler types — alertConditions has separate
// process_cpu_high / process_memory_high handlers, so the handler `type` is
// picked at compile time from the authored `resource` field.
export const processResourceKind: MonitorKindSpec<C> = {
  kind: 'process_resource',
  conditionSchema: monitorConditionSchemas.process_resource,
  overridableKeys: ['operator', 'value', 'durationMinutes'],
  defaultSeverity: 'medium',
  agentDelivered: true,
  titleTemplate: '{{processName}} high {{resource}} on {{deviceName}}',
  messageTemplate: '{{processName}} {{resource}} {{actualValue}} ({{operator}} {{threshold}})',
  toAlertCondition: (c) => ({
    type: c.resource === 'cpu' ? 'process_cpu_high' : 'process_memory_high',
    processName: c.processName,
    operator: c.operator,
    value: c.value,
    ...(c.durationMinutes ? { durationMinutes: c.durationMinutes } : {}),
  }),
};
