import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  direction: 'read' | 'write' | 'total';
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  value: number;
  durationMinutes?: number;
};

// Authoring `value` is MB/s; the handler converts to Bps internally (see
// DiskIoHighCondition in alertConditions/types.ts) — passed through untouched.
export const diskIoKind: MonitorKindSpec<C> = {
  kind: 'disk_io',
  conditionSchema: monitorConditionSchemas.disk_io,
  overridableKeys: ['operator', 'value', 'durationMinutes'],
  defaultSeverity: 'medium',
  agentDelivered: false,
  titleTemplate: 'High Disk I/O on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{direction}} disk I/O {{actualValue}} MB/s ({{operator}} {{threshold}} MB/s)',
  toAlertCondition: (c) => ({
    type: 'disk_io_high',
    direction: c.direction,
    operator: c.operator,
    value: c.value,
    ...(c.durationMinutes ? { durationMinutes: c.durationMinutes } : {}),
  }),
};
