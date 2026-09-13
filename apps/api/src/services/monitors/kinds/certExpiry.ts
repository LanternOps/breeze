import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = { withinDays: number };

// Authoring and handler shapes are identical here — only the discriminant
// `type: 'cert_expiry'` needs adding.
export const certExpiryKind: MonitorKindSpec<C> = {
  kind: 'cert_expiry',
  conditionSchema: monitorConditionSchemas.cert_expiry,
  overridableKeys: ['withinDays'],
  defaultSeverity: 'medium',
  agentDelivered: false,
  titleTemplate: 'Certificate expiring on {{deviceName}}',
  messageTemplate: 'A certificate on {{deviceName}} expires within {{withinDays}} days',
  toAlertCondition: (c) => ({ type: 'cert_expiry', withinDays: c.withinDays }),
};
