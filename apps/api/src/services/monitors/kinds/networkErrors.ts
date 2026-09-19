import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  interfaceName?: string;
  errorType: 'in' | 'out' | 'total';
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  value: number;
  windowMinutes?: number;
};

// Authoring and handler shapes are identical here — only the discriminant
// `type: 'network_errors'` needs adding.
export const networkErrorsKind: MonitorKindSpec<C> = {
  kind: 'network_errors',
  conditionSchema: monitorConditionSchemas.network_errors,
  overridableKeys: ['operator', 'value', 'windowMinutes'],
  defaultSeverity: 'medium',
  agentDelivered: false,
  titleTemplate: 'Network Errors on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{errorType}} errors {{actualValue}} ({{operator}} {{threshold}})',
  toAlertCondition: (c) => ({
    type: 'network_errors',
    ...(c.interfaceName ? { interfaceName: c.interfaceName } : {}),
    errorType: c.errorType,
    operator: c.operator,
    value: c.value,
    ...(c.windowMinutes ? { windowMinutes: c.windowMinutes } : {}),
  }),
};
