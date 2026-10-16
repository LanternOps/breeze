import { monitorConditionSchemas } from '@breeze/shared';
import type { ContainerImageCurrencyCondition } from '../../alertConditions/types';
import type { MonitorKindSpec } from './types';

type C = Omit<ContainerImageCurrencyCondition, 'type'>;

/**
 * Workload inventory W06 (#8195, spec §10.2). Server-evaluated from the
 * upstream_* columns on device_workloads; nothing is delivered to the agent.
 * Category `system`, not `patching`: the patch-work AI classifier keys off
 * `patching`, and nothing in the patch pipeline can update a container image.
 */
export const containerImageCurrencyKind: MonitorKindSpec<C> = {
  kind: 'container_image_currency',
  conditionSchema: monitorConditionSchemas.container_image_currency,
  overridableKeys: ['minDaysBehind'],
  defaultSeverity: 'low',
  agentDelivered: false,
  alertCategory: 'system',
  titleTemplate: 'Container image {{imageRef}} is out of date on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{imageRef}} has been behind its registry tag for {{daysBehind}} days',
  toAlertCondition: (condition) => ({ type: 'container_image_currency', ...condition }),
};
