import { hasSatisfiedMfa, type AuthContext } from '../middleware/auth';
import { isAutomationPrincipal } from '../middleware/principalKind';

/**
 * AI tool actions that require a session carrying the live MFA claim (#8340).
 *
 * This is the ONE list. The tool handlers enforce it through
 * {@link mfaGatedToolError}, and the MCP catalog (`tools/list` in
 * routes/mcpServer.ts) reads it through {@link mfaGatedActionsForTool} /
 * {@link isToolWhollyMfaGated} to advertise those actions as unavailable to a
 * caller that cannot clear the gate. Adding a gated action here gates the
 * handler AND updates the catalog. A second hand-maintained list would drift,
 * which is how `manage_policy_feature_link` came to advertise `update` as
 * available to API keys while the handler refused it.
 *
 * `'*'` gates every invocation of the tool, whatever its `action`.
 *
 * Config-policy mutations mirror `requireMfa()` on the HTTP routes
 * (routes/configurationPolicies/featureLinks.ts and siblings), so MCP and the
 * AI assistant are not a weaker path to a fleet-wide config change.
 */
export const MFA_GATED_TOOL_ACTIONS: Readonly<Record<string, '*' | readonly string[]>> = Object.freeze({
  apply_configuration_policy: '*',
  remove_configuration_policy_assignment: '*',
  manage_configuration_policy: '*',
  manage_policy_feature_link: Object.freeze(['add', 'update', 'remove']),
  // Full-control W11 (#6781, W11-D10): the writes whose REST twins carry requireMfa().
  // routes/accessReviews.ts POST / and PATCH /:id/items/:itemId.
  manage_access_reviews: Object.freeze(['create', 'decide_item']),
  // routes/policyManagement/actions.ts POST /:id/deactivate.
  manage_compliance_policies: '*',
  // routes/pam.ts rule, org-config and signer-group writes.
  // Full-control W12 (#6782, W12-D5): every W12 write's REST twin carries requireMfa().
  manage_software_catalog: Object.freeze([
    'create', 'update', 'archive', 'add_version', 'update_version', 'promote_version',
    'add_install_method', 'update_install_method', 'delete_install_method', 'import_package',
  ]),
  manage_software_deployments: Object.freeze(['create', 'cancel', 'retry']),
  manage_device_software: '*',
  bootstrap_homebrew: '*',
  manage_software_inventory: Object.freeze(['approve', 'deny', 'clear']),
  manage_fleet_findings: '*',
  manage_custom_fields: '*',
  // Full-control W13 (#6783, W13-D6): every PR A write's REST twin carries requireMfa().
  manage_device_function: Object.freeze(['set']),
  manage_device_links: Object.freeze(['create', 'update', 'dissolve']),
  manage_manual_assets: Object.freeze(['create', 'update', 'delete', 'link', 'unlink']),
  manage_device_warranty: Object.freeze(['refresh']),
  // Full-control W13 PR B (#6783): the system-tools router carries requireMfa() on every event-log route; tenant-variable
  // writes and support-session end carry it too (reads stay ungated, as every wave's reads).
  browse_device_event_log: '*',
  manage_tenant_variables: Object.freeze(['create', 'update', 'delete']),
  manage_support_sessions: Object.freeze(['end']),
  // Full-control W14 (#6784, W14-D3): every billing-profile / work-type / assignment write and both settings writes
  // carry requireMfa() at REST. Template and signed-agreement routes carry none, so those tools are not listed.
  manage_billing_profiles: Object.freeze([
    'create', 'update', 'archive', 'set_rows', 'clone', 'create_work_type', 'update_work_type',
    'set_org_profile', 'clear_org_profile',
  ]),
  manage_billing_settings: Object.freeze(['update_partner', 'update_org']),
  // Full-control W14 PR B (#6784): every interactive accounting write carries requireMfa() at REST. (POST
  // /contracts/:id/generate carries none, so generate_invoice is not listed; it is four-eyes.)
  manage_accounting_sync: Object.freeze(['link_mapping', 'unlink_mapping', 'sync_mapping', 'push', 'push_bulk']),
  manage_pam_rules: Object.freeze([
    'create_rule', 'update_rule', 'delete_rule', 'set_config',
    'create_signer_group', 'update_signer_group', 'delete_signer_group',
  ]),
});

export const MFA_REQUIRED_CODE = 'MFA_REQUIRED';

export const MFA_REQUIRED_TOOL_MESSAGE =
  'MFA required: this action needs a signed-in session that has completed multi-factor authentication. '
  + 'API keys and MCP connections cannot satisfy it. Run it from the Breeze web app (the AI assistant or the '
  + 'configuration policy pages) after signing in with MFA.';

/** True when `action` of `toolName` is in {@link MFA_GATED_TOOL_ACTIONS}. */
export function isMfaGatedToolAction(toolName: string, action: string | undefined): boolean {
  const gated = MFA_GATED_TOOL_ACTIONS[toolName];
  if (!gated) return false;
  if (gated === '*') return true;
  return typeof action === 'string' && gated.includes(action);
}

/**
 * Whether the MFA gate refuses this caller.
 *
 * `ai_agent` principals are exempt, deliberately. `requireMfa()` rejects them
 * (middleware/auth.ts) because HTTP is not an agent's channel at all, not
 * because an agent failed an MFA check. An agent never has, and never could
 * have, a session MFA claim, so deriving its authorization from one would
 * permanently disable the grantable `config_policies` agent capability
 * (agentToolCatalog.ts) rather than gate it. An approved agent run's
 * authorization is the UPSTREAM Tier-3 approval enforced in aiGuardrails.
 *
 * API-key and OAuth MCP callers carry `token: {}` (mcpServer.ts), so they are
 * refused while `ENABLE_2FA` is on and keep the product-wide `ENABLE_2FA=false`
 * behavior through `hasSatisfiedMfa`.
 */
export function mfaGateRefusesCaller(auth: Pick<AuthContext, 'principal' | 'token'>): boolean {
  if (isAutomationPrincipal(auth)) return false;
  return !hasSatisfiedMfa(auth);
}

/**
 * The handler-side gate: the coded refusal JSON when this caller may not run
 * `action` of `toolName`, else null. Pass `undefined` for a tool with no
 * `action` multiplexer.
 */
export function mfaGatedToolError(
  toolName: string,
  action: string | undefined,
  auth: Pick<AuthContext, 'principal' | 'token'>,
): string | null {
  if (!isMfaGatedToolAction(toolName, action)) return null;
  if (!mfaGateRefusesCaller(auth)) return null;
  return JSON.stringify({ error: MFA_REQUIRED_TOOL_MESSAGE, code: MFA_REQUIRED_CODE });
}

/**
 * Which of a tool's declared actions are MFA-gated. Empty for a tool with no
 * gated action, and for a tool without an `action` enum (those can only be
 * wholly gated; see {@link isToolWhollyMfaGated}).
 */
export function mfaGatedActionsForTool(toolName: string, actionEnum: readonly string[] | null): string[] {
  if (!actionEnum || !MFA_GATED_TOOL_ACTIONS[toolName]) return [];
  return actionEnum.filter((action) => isMfaGatedToolAction(toolName, action));
}

/** True when no invocation of the tool escapes the MFA gate. */
export function isToolWhollyMfaGated(toolName: string, actionEnum: readonly string[] | null): boolean {
  const gated = MFA_GATED_TOOL_ACTIONS[toolName];
  if (!gated) return false;
  if (gated === '*') return true;
  if (!actionEnum || actionEnum.length === 0) return false;
  return actionEnum.every((action) => gated.includes(action));
}
