import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  category: 'security' | 'hardware' | 'application' | 'system';
  level: 'warning' | 'error' | 'critical';
  sourcePattern?: string;
  messagePattern?: string;
  countThreshold: number;
  windowMinutes: number;
};

// Authoring and handler shapes are identical here — only the discriminant
// `type: 'event_log'` needs adding.
export const eventLogKind: MonitorKindSpec<C> = {
  kind: 'event_log',
  conditionSchema: monitorConditionSchemas.event_log,
  overridableKeys: ['countThreshold', 'windowMinutes', 'level'],
  defaultSeverity: 'medium',
  agentDelivered: false,
  titleTemplate: '{{ruleName}} on {{deviceName}}',
  messageTemplate: '{{count}} matching {{category}} events on {{deviceName}} within {{windowMinutes}} minutes',
  toAlertCondition: (c) => ({
    type: 'event_log',
    category: c.category,
    level: c.level,
    ...(c.sourcePattern ? { sourcePattern: c.sourcePattern } : {}),
    ...(c.messagePattern ? { messagePattern: c.messagePattern } : {}),
    countThreshold: c.countThreshold,
    windowMinutes: c.windowMinutes,
  }),
};
