import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = { processName: string; consecutiveFailures?: number };

// `agentDelivered: true` — the process watch runs on the agent itself (not
// the server sweep), same reasoning as service.ts.
export const processKind: MonitorKindSpec<C> = {
  kind: 'process',
  conditionSchema: monitorConditionSchemas.process,
  overridableKeys: ['consecutiveFailures'],
  defaultSeverity: 'high',
  agentDelivered: true,
  titleTemplate: 'Process {{processName}} stopped on {{deviceName}}',
  messageTemplate: 'Process {{processName}} is not running on {{deviceName}}',
  toAlertCondition: (c) => ({
    type: 'process_stopped',
    processName: c.processName,
    ...(c.consecutiveFailures ? { consecutiveFailures: c.consecutiveFailures } : {}),
  }),
};
