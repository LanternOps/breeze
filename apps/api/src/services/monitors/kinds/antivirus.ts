import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  check: 'not_protected' | 'definitions_stale' | 'realtime_disabled' | 'threats_present';
  staleAfterDays?: number;
  minThreatCount?: number;
};

// Authoring and handler shapes are identical here — only the discriminant
// `type: 'antivirus'` needs adding.
export const antivirusKind: MonitorKindSpec<C> = {
  kind: 'antivirus',
  conditionSchema: monitorConditionSchemas.antivirus,
  overridableKeys: ['staleAfterDays', 'minThreatCount'],
  defaultSeverity: 'high',
  agentDelivered: false,
  titleTemplate: 'Antivirus Issue on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{actualValue}}',
  toAlertCondition: (c) => ({
    type: 'antivirus',
    check: c.check,
    ...(c.staleAfterDays != null ? { staleAfterDays: c.staleAfterDays } : {}),
    ...(c.minThreatCount != null ? { minThreatCount: c.minThreatCount } : {}),
  }),
};
