import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  check: 'no_successful_backup' | 'consecutive_failures' | 'completed_with_errors';
  maxAgeHours?: number;
  failureCount?: number;
};

// Authoring and handler shapes are identical here — only the discriminant
// `type: 'backup_continuity'` needs adding.
export const backupContinuityKind: MonitorKindSpec<C> = {
  kind: 'backup_continuity',
  conditionSchema: monitorConditionSchemas.backup_continuity,
  overridableKeys: ['maxAgeHours', 'failureCount'],
  defaultSeverity: 'high',
  agentDelivered: false,
  titleTemplate: 'Backup Continuity on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{deviceName}} — {{description}}',
  toAlertCondition: (c) => ({
    type: 'backup_continuity',
    check: c.check,
    ...(c.maxAgeHours != null ? { maxAgeHours: c.maxAgeHours } : {}),
    ...(c.failureCount != null ? { failureCount: c.failureCount } : {}),
  }),
};
