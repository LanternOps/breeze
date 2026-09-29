import { monitorConditionSchemas } from '@breeze/shared';
import type { TimeSyncCondition } from '../../alertConditions/types';
import type { MonitorKindSpec } from './types';
type C = Omit<TimeSyncCondition, 'type'>;
export const timeSyncKind: MonitorKindSpec<C> = {
  kind: 'time_sync',
  conditionSchema: monitorConditionSchemas.time_sync,
  overridableKeys: ['consecutiveSnapshots'],
  defaultSeverity: 'medium',
  agentDelivered: false,
  alertCategory: 'system',
  titleTemplate: '{{findingLabel}} on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{findingDetail}}',
  toAlertCondition: (condition) => ({ type: 'time_sync', ...condition }),
};
