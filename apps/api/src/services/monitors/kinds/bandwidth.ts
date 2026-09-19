import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  direction: 'in' | 'out' | 'total';
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  value: number;
  durationMinutes?: number;
};

// Authoring `value` is Mbps; the handler converts to bps internally (see
// BandwidthHighCondition in alertConditions/types.ts) — this kind just
// passes the authored value through untouched.
export const bandwidthKind: MonitorKindSpec<C> = {
  kind: 'bandwidth',
  conditionSchema: monitorConditionSchemas.bandwidth,
  overridableKeys: ['operator', 'value', 'durationMinutes'],
  defaultSeverity: 'medium',
  agentDelivered: false,
  titleTemplate: 'High Bandwidth on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{direction}} bandwidth {{actualValue}} Mbps ({{operator}} {{threshold}} Mbps)',
  toAlertCondition: (c) => ({
    type: 'bandwidth_high',
    direction: c.direction,
    operator: c.operator,
    value: c.value,
    ...(c.durationMinutes ? { durationMinutes: c.durationMinutes } : {}),
  }),
};
