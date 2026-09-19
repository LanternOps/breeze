import { monitorConditionSchemas, PATCH_ALERT_CATEGORY } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = { operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; value: number };

// Authoring and handler shapes are identical here — only the discriminant
// `type: 'patch_compliance'` needs adding.
export const patchComplianceKind: MonitorKindSpec<C> = {
  kind: 'patch_compliance',
  conditionSchema: monitorConditionSchemas.patch_compliance,
  overridableKeys: ['operator', 'value'],
  defaultSeverity: 'medium',
  agentDelivered: false,
  titleTemplate: 'Patch Compliance on {{deviceName}}',
  messageTemplate: '{{ruleName}}: patch compliance {{actualValue}}% ({{operator}} {{threshold}}%)',
  toAlertCondition: (c) => ({ type: 'patch_compliance', operator: c.operator, value: c.value }),
  // Stamped on the compiled alert template so the AI patch agent's failure
  // classifier can recognise a patch-compliance alert without pattern-matching
  // on kind/condition shape.
  alertCategory: PATCH_ALERT_CATEGORY,
};
