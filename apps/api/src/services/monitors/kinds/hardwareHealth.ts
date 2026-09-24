import { monitorConditionSchemas } from '@breeze/shared';
import type { HardwareHealthCondition } from '../../alertConditions/types';
import type { MonitorKindSpec } from './types';

type C = Omit<HardwareHealthCondition, 'type'>;

export const hardwareHealthKind: MonitorKindSpec<C> = {
  kind: 'hardware_health',
  conditionSchema: monitorConditionSchemas.hardware_health,
  overridableKeys: ['minHealth', 'includePredictiveFailure', 'consecutiveSnapshots'],
  defaultSeverity: 'high',
  agentDelivered: false,
  alertCategory: 'hardware',
  titleTemplate: '{{componentLabel}} {{stateLabel}} on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{componentLabel}} is {{stateLabel}} ({{stateDetail}})',
  toAlertCondition: condition => ({ type: 'hardware_health', ...condition }),
};
