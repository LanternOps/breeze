/**
 * Which Microsoft 365 enablement switch is off (#9319). Diagnostics only: the
 * boolean `is…EnabledForOrg` helpers remain the gates and are thin wrappers
 * over the same evaluation, so who may call is unchanged.
 */
export type M365Availability = 'enabled' | 'instance_disabled' | 'org_not_enabled';

export type M365DisabledReason = Exclude<M365Availability, 'enabled'>;

const TOOLS_DISABLED_MESSAGES: Record<M365DisabledReason, string> = {
  instance_disabled:
    'Microsoft 365 tools are turned off on this Breeze instance. A Breeze platform administrator can enable them.',
  org_not_enabled:
    'Microsoft 365 tools are not enabled for this organization yet. Ask your Breeze administrator to enable them.',
};

/** Operator/model-facing refusal text naming the switch that is off. */
export function m365ToolsDisabledMessage(reason: M365DisabledReason): string {
  return TOOLS_DISABLED_MESSAGES[reason];
}
