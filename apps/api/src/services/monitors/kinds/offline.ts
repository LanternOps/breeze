import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = { durationMinutes: number };

// Authoring schema defaults durationMinutes, so it's always present here —
// no conditional spread needed like the duration-optional kinds.
export const offlineKind: MonitorKindSpec<C> = {
  kind: 'offline',
  conditionSchema: monitorConditionSchemas.offline,
  overridableKeys: ['durationMinutes'],
  defaultSeverity: 'high',
  agentDelivered: false,
  titleTemplate: '{{deviceName}} is offline',
  messageTemplate: '{{deviceName}} has been offline for {{durationMinutes}} minutes',
  toAlertCondition: (c) => ({ type: 'offline', durationMinutes: c.durationMinutes }),
};
