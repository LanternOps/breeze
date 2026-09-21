import { monitorConditionSchemas, type CompositeCondition } from '@breeze/shared';
import type { AlertCondition } from '../../alertConditions/types';
import type { MonitorKindSpec } from './types';
import { getMonitorKindSpec } from './index';

/**
 * "All / any of the following" (spec C8). Children are server-evaluated kinds
 * only (enforced by the shared schema), no nesting, 2..10 children. Each child
 * is re-parsed through its own kind schema (so child defaults apply) and
 * compiled by that kind's `toAlertCondition`, then wrapped in the group shape
 * `alertConditions/index.ts` `evaluateConditionRecursive` walks.
 *
 * `overridableKeys: []` is the honest contract: the sweep's override path
 * (`alertService.ts` getApplicableRules) replaces the ROOT node wholesale from
 * this spec, so there is no per-key override a policy attachment could apply.
 */
export const compositeKind: MonitorKindSpec<CompositeCondition> = {
  kind: 'composite',
  conditionSchema: monitorConditionSchemas.composite,
  overridableKeys: [],
  defaultSeverity: 'high',
  agentDelivered: false,
  titleTemplate: '{{ruleName}} on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{conditionsMet}}',
  toAlertCondition: (c, ctx) => ({
    logic: c.match === 'all' ? 'and' : 'or',
    conditions: c.children.map((child) => {
      const spec = getMonitorKindSpec(child.kind);
      const parsed = spec.conditionSchema.parse(child.condition);
      // A server-evaluated child always compiles to a leaf; the cast documents
      // the invariant the shared schema enforces (no composite children).
      return spec.toAlertCondition(parsed, ctx) as AlertCondition;
    }),
  }),
};
