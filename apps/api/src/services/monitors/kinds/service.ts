import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = { serviceName: string; consecutiveFailures?: number };

// `agentDelivered: true` — the Windows-service watch runs on the agent itself
// (not the server sweep), so callers must not treat this like the metric
// kinds until the agent-delivered watch path (W4) exists.
export const serviceKind: MonitorKindSpec<C> = {
  kind: 'service',
  conditionSchema: monitorConditionSchemas.service,
  overridableKeys: ['consecutiveFailures'],
  defaultSeverity: 'high',
  agentDelivered: true,
  titleTemplate: 'Service {{serviceName}} stopped on {{deviceName}}',
  messageTemplate: 'Service {{serviceName}} is not running on {{deviceName}}',
  toAlertCondition: (c) => ({
    type: 'service_stopped',
    serviceName: c.serviceName,
    ...(c.consecutiveFailures ? { consecutiveFailures: c.consecutiveFailures } : {}),
  }),
};
