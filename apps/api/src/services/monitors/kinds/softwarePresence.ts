import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  name: string;
  vendor?: string;
  presence: 'installed' | 'not_installed' | 'version_below';
  version?: string;
};

// Authoring and handler shapes are identical here — only the discriminant
// `type: 'software_presence'` needs adding. `version` is the only overridable
// key: `name`/`vendor`/`presence` define what the monitor watches, not a
// per-device tuning knob.
export const softwarePresenceKind: MonitorKindSpec<C> = {
  kind: 'software_presence',
  conditionSchema: monitorConditionSchemas.software_presence,
  overridableKeys: ['version'],
  defaultSeverity: 'medium',
  agentDelivered: false,
  titleTemplate: '{{name}} on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{name}} on {{deviceName}}',
  toAlertCondition: (c) => ({
    type: 'software_presence',
    name: c.name,
    presence: c.presence,
    ...(c.vendor ? { vendor: c.vendor } : {}),
    ...(c.version ? { version: c.version } : {}),
  }),
};
