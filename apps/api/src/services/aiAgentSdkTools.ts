import { AI_AGENT_RUN_STATUSES } from '@breeze/shared';
/**
 * AI Agent SDK Tool Definitions
 *
 * Defines all Breeze tools for use with the Claude Agent SDK's MCP server.
 * Each tool delegates to executeTool() from aiTools.ts, which validates input
 * via Zod schemas and calls the existing handler with org-scoped auth context.
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { AuthContext } from '../middleware/auth';
import { dbAccessContextFromAuth } from '../middleware/auth';
import { db, withDbAccessContext, runOutsideDbContext } from '../db';
import type { DbAccessContext } from '../db';
import { eq } from 'drizzle-orm';
import { executeTool, aiTools, getAllRegisteredToolNames, getToolAlwaysLoad, getToolSearchHint, type ExecuteToolOptions } from './aiTools';
import { WORKSPACE_MCP_SHAPES } from './workspace/workspaceTools';
import type { CaptureScope } from './artifacts/toolResultCapture';
import type { ToolExecutionContext } from './toolExecutionContext';
import type { AiToolTier, ActionPlanStep } from '@breeze/shared/types/ai';
import { compactToolResultForChat } from './aiToolOutput';
import { sanitizeThrownToolError } from './aiToolErrors';
import { buildToolHandoffResult, handoffIsError, type ToolHandoffStatus } from './aiToolHandoff';
import type { ActiveSession } from './streamingSessionManager';
import type { SdkTool } from './aiAgents/outcomeTools';
import { waitForPlanApproval } from './aiAgent';
import {
  aiActionPlans,
  peripheralDeviceClassEnum,
  peripheralPolicyActionEnum,
} from '../db/schema';
import { CONFIG_FEATURE_TYPES } from './configFeatureTypes';
import { CONTACT_ROLES } from './contacts/types';
import { ACTOR_TYPES, AI_AGENT_KINDS, INVOICE_STATUSES } from '@breeze/shared';
import { JOURNAL_VACUUM_MAX_BYTES, JOURNAL_VACUUM_MIN_BYTES, SYSTEM_CLEANUP_ACTION_IDS } from '@breeze/shared/validators';
import { getToolTimeout, withToolTimeout } from './toolTimeouts';
import { aiRunContextInputShape } from './scriptRunRequest';
import { deliveryToolShape } from './aiToolSchemas';
import { aiScriptAuthoringEnabled } from '../config/env';
import { keysetZodShape, pageZodShape } from './aiToolPagination';
import { captureMessage } from './sentry';
import {
  m365LookupUserHandler, m365RecentSigninsHandler, m365ListGroupMembershipsHandler,
  m365DisableUserHandler, m365ResetPasswordHandler,
} from './aiToolsM365';
import {
  googleLookupUserHandler, googleResetPasswordHandler, googleSuspendUserHandler,
  googleRestoreUserHandler, googleSignOutHandler, googleSetForwardingHandler,
  googleDisableForwardingHandler,
  googleSetVacationHandler, googleUpdateUserHandler, googleShareCalendarHandler,
  googleOffboardUserHandler, googleWipeMobileDeviceHandler,
  googleSecurityDriftHandler, googleEmailReportHandler,
  googleListUserGroupsHandler, googleAddToGroupHandler, googleRemoveFromGroupHandler,
  googleMoveOuHandler, googleRenameUserHandler,
  googleResetTwoSvHandler, googleAddMailDelegateHandler, googleRemoveMailDelegateHandler,
  googleListLicensesHandler, googleAssignLicenseHandler, googleRemoveLicenseHandler,
} from './aiToolsGoogle';
import {
  sealToolSecrets,
  isSecretBearingTool,
  SECRET_UNAVAILABLE_TEXT,
  type SecretToolResult,
} from './actionIntents/secretBearingTools';

/**
 * Shown when a secret-bearing tool call is refused BEFORE execution because
 * there is no action intent available to seal the resulting credential into.
 *
 * Deliberately distinct wording from SECRET_UNAVAILABLE_TEXT: that message
 * reports a reset that ALREADY HAPPENED with the credential subsequently
 * lost; this one reports that the action was NOT performed at all. Confusing
 * the two would tell an operator a reset succeeded when it didn't (or vice
 * versa) — never conflate them.
 */
const SECRET_ACTION_REFUSED_TEXT =
  'This action was not performed: no durable approval record was available to store the '
  + 'resulting credential securely. Retry once the approval workflow is available.';

/**
 * Callback invoked before tool execution to enforce guardrails, RBAC,
 * rate limits, and approval gates. Blocks execution until resolved.
 *
 * `intentId` (Task 6) is set only when the tool call has a durable action
 * intent row it can seal a secret into. Secret-bearing tools use its absence
 * to fail closed (see makeSessionAwareHandler) rather than mint a credential
 * with nowhere safe to store it.
 *
 * `context` (#3409 PR4c-1) is the same idea one step further: the inline chat
 * RELEASE path verifies an approved intent's pinned effect digest inside this
 * callback (aiAgentSdk.ts's createSessionPreToolUse), but the tool itself runs
 * later, from makeHandler below. This return value is the only channel between
 * the two, so the material the verification already resolved rides it across
 * and the handler executes from it instead of reading the same rows again.
 * Absent for every other caller, and the handler must behave identically then.
 */
export type PreToolUseCallback = (
  toolName: string,
  input: Record<string, unknown>,
  /**
   * The `mcp__<server>__<tool>` name this call was EXPOSED to the model as,
   * when it differs from the `executeTool` handler `toolName` above. Used for
   * one thing only: the session-allowlist check, which compares against the
   * names the caller put in `allowedTools` — i.e. exposed names, not handler
   * names. Everything downstream (tier, RBAC, rate limit, approval, audit)
   * stays on `toolName`, because that is where the capability actually lives.
   *
   * Pass the FULLY-QUALIFIED, non-empty `mcp__<server>__<tool>` string, not a
   * bare name. Omit it whenever the two identities coincide — as of writing
   * that is every tool this file's `breeze` server registers, and every
   * script-builder tool except `execute_script_on_device` -> `run_script`.
   * Only script builder's registrations are pinned against drift (see
   * `scriptBuilderTools.guard.test.ts`); a NEW tool registered here under a
   * name that differs from its handler must wire this argument, or the
   * session allowlist will refuse it the way it refused every Script Builder
   * test run with "Tool 'run_script' is not allowed for this session" (#4883).
   */
  mcpToolName?: string,
) => Promise<
  | { allowed: true; intentId?: string; context?: ToolExecutionContext }
  /**
   * Not run by THIS session. Two different things wear this shape:
   *
   *  - a real denial/failure (`handoff` absent) — published as `isError: true`
   *    with `{ error }`, as it always was; and
   *  - an approval HANDOFF (`handoff` set) — the human approved and the action
   *    is executing under the durable release worker, so this session declines
   *    to run it. Published as `isError: false` with `{ status, message }`.
   *
   * `error` carries the model-facing text in both cases; when `handoff` is set
   * it is a status message, not a failure, and it never reaches an `error`
   * field on the wire. See services/aiToolHandoff.ts (#5107).
   */
  | { allowed: false; error: string; handoff?: ToolHandoffStatus }
>;

/**
 * Callback invoked after each tool execution (success or failure).
 * Used by aiAgentSdk.ts to persist tool_result messages, execution records,
 * audit logs, and SSE events.
 */
export type PostToolUseCallback = (
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  durationMs: number,
  /** Present only for secret-bearing tools that sealed a credential. Carries
   *  the blob destined for action_intents.result, which must never appear in
   *  `output`. */
  sealed?: { intentId: string; sealedResult: Record<string, unknown> },
  /**
   * Set ONLY when the pre-tool-use gate itself reported an approval handoff
   * (#5107) — never inferred from `output`. The same value also appears as
   * `output.status`, but a tool controls its own output: without this trusted
   * channel, any tool could stamp its own audit row and repaint its own
   * failure as an approved, in-flight action.
   */
  handoff?: ToolHandoffStatus,
) => Promise<void>;

// ============================================
// Tool Tier Map (used by guardrails checks)
// ============================================

export const TOOL_TIERS = {
  list_time_entries: 1,
  get_running_timer: 1,
  get_timesheet: 1,
  // #6930. Base tier; the mutating actions are Tier 2 in aiGuardrails.
  manage_ticket_checklist: 1,

  query_devices: 1,
  search_documentation: 1,
  get_device_details: 1,
  get_device_hardware_health: 1,
  analyze_metrics: 1,
  get_active_users: 1,
  get_user_experience_metrics: 1,
  manage_alerts: 1, // Base tier; action-level escalation handled in guardrails
  manage_delivery: 1,
  get_dns_security: 1,
  get_huntress_status: 1,
  get_huntress_incidents: 1,
  manage_dns_policy: 2,
  get_s1_status: 1,
  get_s1_threats: 1,
  s1_isolate_device: 3,
  s1_threat_action: 3,
  sync_huntress_data: 2,
  execute_command: 3,
  run_script: 3,
  // AI script authoring: a proposal is inert until run_script consumes it.
  propose_script: 1,
  get_script_proposal: 1,
  // #3525 — the de-escalation that undoes run_script; same tier, same gate.
  cancel_script_execution: 3,
  // Script library (read-only) — used by the script-builder assistant to
  // reference existing scripts. Absent here, createSessionPreToolUse rejects
  // them as "Unknown tool" before execution (the script-builder could not
  // search/read the library). Keep in sync with TOOL_PERMISSIONS in aiGuardrails.
  list_scripts: 1,
  get_script_details: 1,
  list_script_templates: 1,
  get_script_execution_history: 1,
  get_script_execution: 1,
  manage_services: 3,
  security_scan: 3,
  get_security_posture: 1,
  get_cis_compliance: 1,
  get_cis_device_report: 1,
  apply_cis_remediation: 3,
  get_fleet_health: 1,
  // Fleet hygiene (Task 8) — read-only fleet-wide aggregation.
  get_fleet_findings: 1,
  analyze_fleet_metrics: 1,
  get_invite_funnel: 1,
  delete_tenant: 3,
  file_operations: 1, // Base tier; write/delete/mkdir/rename escalated to 3 in guardrails
  analyze_disk_usage: 1,
  disk_cleanup: 1, // Base tier; execute escalated to 3 in guardrails
  system_cleanup: 1, // Base tier; run escalated to 3 in guardrails
  query_audit_log: 1,
  query_change_log: 1,
  network_discovery: 3,
  // Screen-capture tools are Tier 3 (sensitive: may expose credentials,
  // customer data on display, etc.). See aiToolsRemote.ts.
  take_screenshot: 3,
  analyze_screen: 3,
  computer_control: 3,
  // Fleet orchestration tools
  manage_deployments: 1,     // Action-level escalation in guardrails
  manage_patches: 1,         // Action-level escalation in guardrails
  get_vulnerability_report: 1, // BE-16
  get_device_vulnerabilities: 1, // BE-16
  remediate_vulnerability: 3, // BE-16 (approval-gated)
  manage_groups: 1,          // Action-level escalation in guardrails
  manage_maintenance_windows: 1, // Action-level escalation in guardrails
  manage_automations: 1,     // Action-level escalation in guardrails
  manage_alert_rules: 1,     // Action-level escalation in guardrails
  manage_service_monitors: 1, // Action-level escalation in guardrails
  generate_report: 1,        // Action-level escalation in guardrails
  // Brain device context tools
  get_device_context: 1,
  set_device_context: 2,
  resolve_device_context: 2,
  // Boot performance & startup tools
  analyze_boot_performance: 1,
  manage_startup_items: 3,
  // Agent log tools
  search_agent_logs: 1,
  set_agent_log_level: 2,
  capture_agent_pprof: 2,
  // Event log tools
  search_logs: 1,
  get_log_trends: 1,
  detect_log_correlations: 2,
  // Execution plane (spec §5.7) — reads nothing the caller cannot already read;
  // it just refuses to throw the result away. Tier 1 like its source tools.
  export_dataset: 1,
  // A-W05 (D13a): reads only the caller's own already-captured artifacts.
  read_artifact: 1,
  // Execution plane W04 — sandbox workspace tools. Tier 1: they execute
  // nothing on the fleet. NOT read-only (see TIER1_NON_READONLY_TOOLS in
  // aiGuardrails.ts) — the allowlist is what gates them. A tool absent from
  // this map is invisible to chat AND to every run profile even when it is
  // registered in `aiTools`.
  workspace_stage: 1,
  workspace_run: 1,
  workspace_collect: 1,
  workspace_cancel: 1,
  // Configuration policy tools
  list_configuration_policies: 1,
  get_configuration_policy: 1,
  manage_configuration_policy: 1, // Action-level escalation in guardrails
  configuration_policy_compliance: 1,
  get_effective_configuration: 1,
  preview_configuration_change: 1,
  apply_configuration_policy: 2,
  remove_configuration_policy_assignment: 2,
  manage_policy_feature_link: 2,
  // Policy prerequisite tools (standalone policies linked via featurePolicyId)
  manage_update_rings: 1,          // Action-level escalation in guardrails
  manage_software_policies: 1,     // Action-level escalation in guardrails
  manage_peripheral_policies: 1,   // Action-level escalation in guardrails
  manage_backup_configs: 1,        // Action-level escalation in guardrails
  // Playbook tools
  list_playbooks: 1,
  execute_playbook: 3,
  get_playbook_history: 1,
  propose_action_plan: 1,
  // Monitoring tools
  query_monitors: 1,
  manage_monitors: 1,           // Action-level escalation in guardrails
  get_service_monitoring_status: 1,
  // W01 (spec §4.4) — read-only reachability for a discovered network asset,
  // with the source and age of the evidence. Wired here rather than added to
  // KNOWN_MISSING_TOOL_TIERS: without a tier, createSessionPreToolUse rejects
  // it as "Unknown tool" and the chat tells the user the capability does not
  // exist.
  list_network_assets: 1,
  get_network_asset: 1,
  get_network_asset_reachability: 1,
  // Monitor definition activity/escalation tools (#5290 W03). list_monitors /
  // get_monitor / manage_monitor_definitions remain in the frozen
  // KNOWN_MISSING_TOOL_TIERS baseline (aiAgentSdkTools.registryParity.contract.test.ts)
  // — these two are new and wired directly instead of widening that list.
  get_monitor_activity: 2,
  reset_monitor_escalation: 2,
  // Org lifecycle tools (issue #2366) — new-customer intake (org → site → quote)
  list_remediation_suggestions: 1,
  list_incidents: 1,
  list_ai_agents: 1,
  list_ai_agent_runs: 1,
  get_ai_agent_run: 1,
  list_sites: 1,
  get_site: 1,
  list_org_contacts: 1,
  list_organizations: 1,
  manage_organizations: 2,      // create_org/update_org/create_site escalate to 3 in guardrails
  // AI agent governance (P2-5, #4192). Base tier 3 — there is no lower-tier
  // action on this tool, and its single action is four_eyes in guardrails.
  manage_ai_agents: 3,
  // Billing / quoting / catalog / contracts (#3156). Same #2605 failure mode as
  // the vulnerability tools: registered in the aiTools execution registry (all
  // Tier 2 there) and reachable by external MCP clients, but never listed here
  // — so BREEZE_MCP_TOOL_NAMES omitted them and the chat answered "I have no
  // invoicing tool". Tier 2 mirrors the registry tier exactly; the nine reads
  // additionally sit in TIER2_READONLY_TOOLS (#3130) so they auto-execute with
  // an audit row instead of prompting per list call, while the two `manage_*`
  // mutators stay prompt-on-every-action (no TIER2_ACTIONS entry) and escalate
  // to Tier 3 for the financially-final actions via TIER3_ACTIONS.
  list_invoices: 2,
  get_invoice: 2,
  manage_invoices: 2,           // issue/void/record_payment/void_payment escalate to 3 in guardrails
  list_quotes: 2,
  get_quote: 2,
  list_contracts: 2,
  get_contract: 2,
  manage_contracts: 2,          // activate/pause/resume/cancel escalate to 3 in guardrails
  list_deliverable_templates: 2,
  list_deliverables: 2,
  manage_deliverables: 2,       // apply_template escalates to 3 in guardrails (W05)
  manage_key_dates: 2,
  list_org_documents: 2,
  manage_org_documents: 2,
  search_catalog: 2,
  get_catalog_item: 2,
  lookup_distributor_product: 2,
  // M365 helpdesk tools (Delegant-backed)
  m365_lookup_user: 1,
  m365_recent_signins: 1,
  m365_list_group_memberships: 1,
  m365_disable_user: 3,
  m365_reset_password: 3,
  // M365 typed Graph read-query tools (Task 9) — registered in the shared
  // `aiTools` map (see aiToolsM365.ts's registerM365Tools) and executed via
  // makeHandler/executeTool like list_organizations, not session-aware.
  m365_query_users: 1,
  m365_query_signins: 1,
  m365_query_intune_devices: 1,
  m365_query_groups: 1,
  m365_query_org: 1,
  m365_query_sites: 1,
  // Google Workspace helpdesk tools (DWD service-account-backed)
  google_lookup_user: 1,
  google_reset_password: 3,
  google_suspend_user: 3,
  google_restore_user: 3,
  google_signout: 3,
  google_set_forwarding: 3,
  google_disable_forwarding: 3,
  google_set_vacation: 3,
  google_update_user: 3,
  google_share_calendar: 3,
  google_offboard_user: 3,
  google_wipe_mobile_device: 3,
  google_security_drift: 1,
  google_email_report: 1,
  google_list_user_groups: 1,
  google_add_to_group: 3,
  google_remove_from_group: 3,
  google_move_ou: 3,
  google_rename_user: 3,
  google_reset_2sv: 3,
  google_add_mail_delegate: 3,
  google_remove_mail_delegate: 3,
  google_list_licenses: 1,
  google_assign_license: 3,
  google_remove_license: 3,
} as const satisfies Readonly<Record<string, AiToolTier>> as Readonly<Record<string, AiToolTier>>;

/**
 * Names the chat/Helper Agent SDK server ACTUALLY declares right now: the
 * names `buildBreezeSdkTools` returns under the current process env (so
 * env-gated tools — M365, Google Workspace, AI script authoring — drop out
 * when their flag is off), intersected with the registry (so a chat-only
 * SDK-bridge tool with no `aiTools`/tier-map entry, e.g.
 * `propose_action_plan`, stays out). Evaluated fresh on every call — this is
 * read once per `buildSystemPrompt` invocation, so it tracks env at session
 * time, not at module-load time. `getAuth` is a throwing no-op: only the
 * `tool()` declarations are built here, no handler ever runs. Lives here to
 * avoid a reverse import cycle from aiTools.ts and a CommonJS require in the
 * ESM source runtime.
 */
export function listChatSurfaceToolNames(): string[] {
  const registered = new Set(getAllRegisteredToolNames());
  const fakeAuth = (): AuthContext => {
    throw new Error('listChatSurfaceToolNames must not invoke tool handlers');
  };
  const declared = buildBreezeSdkTools(fakeAuth);
  const names = new Set(declared.map((t) => t.name).filter((name) => registered.has(name)));
  return [...names].sort();
}

// All tool names, prefixed for SDK MCP format
export const BREEZE_MCP_TOOL_NAMES = Object.keys(TOOL_TIERS).map(
  name => `mcp__breeze__${name}`
);

// ============================================
// Helper: Create tool handler that delegates to executeTool
// ============================================

// Exported so callers that schedule I/O INSIDE a postToolUse hook (e.g. the
// headless agent run loop's act-mode verification read, actVerify.ts) can
// size their own budget with headroom under this cap instead of picking an
// unrelated number — see the wave-4b review fix.
export const POST_TOOL_USE_TIMEOUT_MS = 10_000; // 10s for postToolUse DB writes

/**
 * Fire postToolUse with a timeout — if DB writes hang, don't block the conversation.
 * The postToolUse callback already emits SSE events synchronously before DB writes,
 * so even on timeout the UI receives the tool_result event.
 */
/**
 * Turns a `allowed: false` pre-tool-use decision into the SDK result shape,
 * and says whether it is a failure.
 *
 * The ONE place that decides `isError` for a blocked call. Three call sites
 * (registry handler, session-aware handler, extra-tool wrapper) previously
 * hard-coded `true` at each, which is how the approval handoff (#5107) reached
 * the phone as `MANAGE_SERVICES · FAILED` right after the user approved it: an
 * approved action executing under the durable worker is not an error. The
 * handoff payload carries `status` (machine-readable, what the clients switch
 * on) and never an `error` field, so nothing downstream can mistake it for a
 * failure by shape either.
 *
 * `isError` is derived from the handoff STATUS, not from "a handoff marker is
 * present" (#6022). The read-back added there rides this same channel, and
 * `approved_failed` — an action the worker ran and that did NOT take effect —
 * is a genuine failure. Treating the marker itself as "not an error" would
 * paint a guardrail refusal as "Approved · running", which is the bug.
 */
function preToolUseDenialResult(
  toolName: string,
  check: { error: string; handoff?: ToolHandoffStatus },
): { text: string; isError: boolean } {
  const payload = check.handoff
    ? buildToolHandoffResult(check.handoff, check.error)
    : { error: check.error };
  return {
    text: compactToolResultForChat(toolName, JSON.stringify(payload)),
    isError: check.handoff ? handoffIsError(check.handoff) : true,
  };
}

async function safePostToolUse(
  onPostToolUse: PostToolUseCallback | undefined,
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  isError: boolean,
  durationMs: number,
  sealed?: { intentId: string; sealedResult: Record<string, unknown> },
  handoff?: ToolHandoffStatus,
): Promise<void> {
  if (!onPostToolUse) return;
  try {
    await withToolTimeout(
      onPostToolUse(toolName, args, output, isError, durationMs, sealed, handoff),
      POST_TOOL_USE_TIMEOUT_MS,
      `postToolUse:${toolName}`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[AI-SDK] PostToolUse failed for ${toolName} (${durationMs}ms): ${reason}`);
  }
}

// The MCP CallToolResult shape that the SDK's `tool()` handler must return.
// Derived from `tool` itself so we don't take a direct dependency on
// @modelcontextprotocol/sdk's type entrypoint. As of claude-agent-sdk 0.3 the
// handler signature is strictly `(args, extra) => Promise<CallToolResult>`,
// so the per-handler return type below is now checked against this.
type SdkToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

/** Canonical descriptions for tools whose execution requires an active session. */
export const SESSION_TOOL_DESCRIPTIONS = {
  m365_lookup_user: 'Look up a Microsoft 365 user (profile, account status, assigned licenses) on the customer tenant selected for this session.',
  m365_recent_signins: "Read recent sign-in activity for a Microsoft 365 user on the customer tenant selected for this session. Useful for can't-log-in and lockout triage.",
  m365_list_group_memberships: 'List the groups in the customer tenant selected for this session.',
  m365_disable_user: 'Disable (block sign-in for) a Microsoft 365 user on the customer tenant selected for this session. Requires approval.',
  m365_reset_password: 'Reset the password for a Microsoft 365 user on the customer tenant selected for this session. Returns a temporary password the user must change at next sign-in. Requires approval.',
  google_lookup_user: "Look up a Google Workspace user (profile, suspended/admin status, 2-step enrollment, last login, OU, aliases) for this organization's connected Workspace domain.",
  google_reset_password: 'Reset a Google Workspace user\'s password (forces change at next sign-in). Returns a temporary password. Requires approval.',
  google_suspend_user: 'Suspend (block sign-in for) a Google Workspace user. Requires approval.',
  google_restore_user: 'Restore (un-suspend) a Google Workspace user. Requires approval.',
  google_signout: 'Sign a Google Workspace user out of all sessions (the supported substitute for "turn off login challenge", which has no API). Useful for lockout/offboarding. Requires approval.',
  google_list_user_groups: "List the Google Workspace groups a user belongs to (email, name, id) in this organization's connected domain.",
  google_add_to_group: 'Add a Google Workspace user to a group. role is one of MEMBER, MANAGER, OWNER (default MEMBER). Requires approval.',
  google_remove_from_group: 'Remove a Google Workspace user from a group. Requires approval.',
  google_move_ou: 'Move a Google Workspace user into a different organizational unit (orgUnitPath, e.g. "/Sales" or "/"). Requires approval.',
  google_rename_user: 'Rename a Google Workspace user by changing their primary email (the old address is retained as an alias). Requires approval.',
  google_list_licenses: 'List Google Workspace license assignments for a product (e.g. productId "Google-Apps") in this organization. Returns who holds which SKU.',
  google_assign_license: 'Assign a Google Workspace license (productId + skuId) to a user. Requires approval.',
  google_remove_license: 'Remove a Google Workspace license (productId + skuId) from a user. Requires approval.',
  google_reset_2sv: 'Turn off 2-step verification for a Google Workspace user so they can re-enroll (use when a user lost their second factor / is locked out). Requires approval.',
  google_add_mail_delegate: "Grant another user delegated access to a Google Workspace mailbox (read/send/manage). Requires approval.",
  google_remove_mail_delegate: 'Remove a delegate from a Google Workspace mailbox. Requires approval.',
  google_set_forwarding: 'Enable Gmail forwarding from one user to another, optionally keeping a copy in the original mailbox. Requires approval.',
  google_disable_forwarding: "Turn OFF Gmail auto-forwarding for a user's mailbox. Optionally also remove the forwarding address (pass removeAddress=true and the forwardTo address). Requires approval.",
  google_set_vacation: 'Set or clear a Google Workspace user\'s out-of-office / vacation responder. Requires approval.',
  google_update_user: 'Update a Google Workspace user\'s profile (given/family name, recovery email/phone) and/or add or remove an email alias. Requires approval.',
  google_share_calendar: "Share a Google Workspace user's calendar with another user. Inserts an ACL rule on the owner's calendar (default: their primary calendar). role is one of freeBusyReader, reader, writer, owner (default reader). Requires approval.",
  google_offboard_user: 'Offboard a Google Workspace user: optional out-of-office, forwarding (no copy kept), revoke OAuth tokens, remove all groups, selective mobile account wipe (corporate data only, never full device wipe), sign-out, suspend. Steps are independent and reported; best-effort. Requires approval.',
  google_wipe_mobile_device: 'STOLEN/LOST DEVICE ONLY: issue a FULL factory reset (admin_remote_wipe) to every mobile device enrolled to a user. This erases the ENTIRE device, not just corporate data. This is NOT for offboarding — offboard uses a selective account wipe. Requires approval.',
  google_security_drift: 'Read-only Google Workspace security posture for the connected domain: counts and lists of users with no 2-step verification, super-admins, suspended accounts, never-logged-in accounts, and accounts stale beyond staleDays (default 90). No changes are made.',
  google_email_report: "Run the Google Workspace security-drift report and email it to the connection's own admin address (recipient is fixed to the admin, not arbitrary). Use when asked to email a Workspace report. staleDays optional (default 90).",
  propose_action_plan: 'Propose a multi-step action plan for user approval. Use this when the approval mode requires it and you need to execute multiple operations. The user will review all steps before any are executed.',
} as const satisfies Readonly<Record<string, string>>;

/** Read the registry description; unknown names fail at server construction. */
function registryDescription(toolName: string): string {
  const description = aiTools.get(toolName)?.definition.description;
  if (!description) {
    throw new Error(`No aiTools registry description for tool "${toolName}"`);
  }
  return description;
}

function makeToolHandler(
  toolName: string,
  getAuth: () => AuthContext,
  getActiveSession: (() => ActiveSession | undefined) | undefined,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  const toolTimeout = getToolTimeout(toolName);

  return async (args: Record<string, unknown>) => {
    // CRITICAL: Escape any inherited AsyncLocalStorage DB context from the SDK's
    // MCP callback chain. Without this, dbContextStorage.getStore() may return a
    // stale/committed transaction from a prior withDbAccessContext call,
    // causing subsequent withDbAccessContext calls to skip creating a new transaction
    // and execute on the dead connection — which hangs until the PostgreSQL idle timeout.
    //
    // This wraps the ENTIRE handler (preToolUse, executeTool, postToolUse) so all
    // DB operations start with a clean context. Previously only executeTool was
    // wrapped, leaving preToolUse (approval DB writes) and postToolUse (tool_result
    // persistence) vulnerable to stale context hangs.
    return runOutsideDbContext(async (): Promise<SdkToolResult> => {
    const startTime = Date.now();

    // Material the preToolUse gate already verified against an approved
    // intent's pinned effect digest (#3409 PR4c-1). Declared out here because
    // the check happens in this block and the tool runs further down; stays
    // `undefined` for every caller that verified nothing, which is what keeps
    // the executeTool call three arguments wide.
    let verifiedContext: ToolExecutionContext | undefined;

    // Pre-execution check (guardrails, RBAC, rate limits, approval)
    if (onPreToolUse) {
      let check:
        | { allowed: true; intentId?: string; context?: ToolExecutionContext }
        | { allowed: false; error: string; handoff?: ToolHandoffStatus };
      try {
        check = await onPreToolUse(toolName, args);
      } catch (err) {
        // The guardrail path also touches the DB (approval records, rate limits),
        // so `reason` can be a raw driver message — sanitize before embedding it
        // in a string that is streamed to the chat (#2603).
        const reason = sanitizeThrownToolError(`${toolName}:preToolUse`, err);
        check = { allowed: false, error: `Guardrails check failed: ${reason}` };
      }
      // P2-5 (#4192): `intentId` is set by createSessionPreToolUse ONLY after
      // it won the approved -> executing CAS on a durable intent, i.e. this
      // invocation IS that intent's inline release — the same fact the durable
      // worker carries as `intent.id`. Carried on the context (not on args,
      // not on auth — see toolExecutionContext.ts) so a handler that may only
      // run as an approved release can name the approval it is executing.
      // Left entirely absent for an ordinary chat call, which keeps the
      // three-argument executeTool call below unchanged for every tool that
      // neither verified anything nor went through an intent.
      if (check.allowed) {
        verifiedContext = check.intentId
          ? { ...check.context, actionIntentId: check.intentId }
          : check.context;
      }
      if (!check.allowed) {
        const denial = preToolUseDenialResult(toolName, check);
        await safePostToolUse(onPostToolUse, toolName, args, denial.text, denial.isError, 0, undefined, check.handoff);
        return {
          content: [{ type: 'text' as const, text: denial.text }],
          isError: denial.isError,
        };
      }
    }
    try {
      const auth = getAuth();
      // Use the user's actual auth scope instead of system context so that
      // RLS policies and DB-level tenant isolation are enforced.
      //
      // Built via the canonical `dbAccessContextFromAuth` (#2822). The literal
      // this replaced omitted `accessiblePartnerIds`, `currentPartnerId` and
      // `userId`; `serializeAccessibleIds` maps an absent list to '' →
      // `ARRAY[]::uuid[]` for any non-system scope, so `breeze_has_partner_access`
      // was FALSE and `breeze_current_partner_id()` NULL for EVERY AI tool call —
      // including a partner-scope MSP admin's, who is entitled to the rows. And
      // because `makeHandler` deliberately calls `runOutsideDbContext` first,
      // there was no ambient context to fall back on: this literal was the only
      // context Postgres saw. Result was a silent partner-axis blackout (scripts,
      // alert templates, catalog, update rings, integrations all reported empty
      // with a 200) across the whole chat surface. Same builder the request path
      // and `jobs/intentReleaseWorker.ts` use, so the re-entered context is
      // identical to the one authMiddleware opened — not wider.
      const dbContext: DbAccessContext = dbAccessContextFromAuth(auth);
      // W01: attribute an oversized result to this session's org and session.
      // `session.orgId` is the canonical org — `auth.orgId` is null for a
      // partner-scope login — and `session.breezeSessionId` IS the
      // ai_sessions.id the artifact row's session_id FK points at.
      const captureSession = getActiveSession?.();
      const capture: CaptureScope | undefined = captureSession
        ? { orgId: captureSession.orgId, sessionId: captureSession.breezeSessionId }
        : undefined;
      // An absent member means no KEY at all, and an empty bag means no FOURTH
      // ARGUMENT at all — both are behaviour changes for an ordinary chat tool
      // call, and `aiAgentSdkTools.verifiedContext.test.ts` pins the arity.
      const execOptions: ExecuteToolOptions = {
        ...(verifiedContext ? { context: verifiedContext } : {}),
        ...(capture ? { capture } : {}),
      };
      const result = await withToolTimeout(
        withDbAccessContext(dbContext, () =>
          Object.keys(execOptions).length > 0
            ? executeTool(toolName, args, auth, execOptions)
            : executeTool(toolName, args, auth),
        ),
        toolTimeout,
        toolName,
      );
      const compactResult = compactToolResultForChat(toolName, result);

      // For screenshot/vision tools, return image content blocks for Claude Vision.
      // The SDK tool() handler expects MCP CallToolResult format — ImageContent uses
      // flat { type: 'image', data, mimeType }, NOT Anthropic's nested source format.
      if (toolName === 'take_screenshot' || toolName === 'analyze_screen' || toolName === 'computer_control') {
        try {
          const parsed = JSON.parse(result);
          if ((parsed.error || parsed.screenshotError) && !parsed.imageBase64) {
            // Error response with no image — fall through to normal text response
          } else if (parsed.imageBase64) {
            const imageBase64 = parsed.imageBase64;
            const durationMs = Date.now() - startTime;
            await safePostToolUse(onPostToolUse, toolName, args, JSON.stringify({ actionExecuted: parsed.actionExecuted, width: parsed.width, height: parsed.height, format: parsed.format, sizeBytes: parsed.sizeBytes, capturedAt: parsed.capturedAt }), false, durationMs);
            // MCP ImageContent format: { type: 'image', data: base64, mimeType: string }
            const contentBlocks: SdkToolResult['content'] = [
              {
                type: 'image',
                data: imageBase64,
                mimeType: `image/${parsed.format || 'jpeg'}`,
              },
            ];
            // For analyze_screen, include device context as text
            if (toolName === 'analyze_screen' && parsed.device) {
              contentBlocks.push({
                type: 'text',
                text: JSON.stringify({
                  analysisContext: parsed.analysisContext,
                  device: parsed.device,
                  capturedAt: parsed.capturedAt,
                  resolution: `${parsed.width}x${parsed.height}`,
                }),
              });
            }
            // For computer_control, include action metadata as text
            if (toolName === 'computer_control') {
              const meta: Record<string, unknown> = {
                actionExecuted: parsed.actionExecuted,
                capturedAt: parsed.capturedAt,
                resolution: `${parsed.width}x${parsed.height}`,
              };
              if (parsed.screenshotError) meta.screenshotError = parsed.screenshotError;
              contentBlocks.push({ type: 'text', text: JSON.stringify(meta) });
            }
            return { content: contentBlocks };
          }
        } catch (err) {
          console.error(`[AI-SDK] Failed to parse vision content blocks for ${toolName}:`, err);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Screenshot captured but response format was invalid. Please try again.' }) }],
            isError: true,
          };
        }
      }

      // Detect error responses returned as JSON strings by tool handlers
      let isToolError = false;
      try {
        const parsed = JSON.parse(compactResult);
        if (parsed && typeof parsed === 'object' && 'error' in parsed && !('success' in parsed) && !('data' in parsed) && !('configured' in parsed)) {
          isToolError = true;
        }
      } catch { /* not JSON, treat as success */ }

      const durationMs = Date.now() - startTime;
      await safePostToolUse(onPostToolUse, toolName, args, compactResult, isToolError, durationMs);
      return { content: [{ type: 'text' as const, text: compactResult }], ...(isToolError ? { isError: true } : {}) };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      // A thrown error here is an internal fault — its message is very often a
      // raw Drizzle/postgres.js string carrying the full query and column list.
      // sanitizeThrownToolError logs it server-side and returns a safe generic
      // string for the stream (#2603).
      const message = sanitizeThrownToolError(toolName, err, { durationMs });
      const safeError = compactToolResultForChat(toolName, JSON.stringify({ error: message }));
      await safePostToolUse(onPostToolUse, toolName, args, safeError, true, durationMs);
      return {
        content: [{ type: 'text' as const, text: safeError }],
        isError: true,
      };
    }
    }); // end runOutsideDbContext
  };
}

/**
 * Session-aware variant of makeHandler for tools whose handler signature is
 * `(args, auth, sessionId)` and which require an active streaming session
 * (e.g. Microsoft 365 helpdesk tools bound to a customer tenant).
 *
 * CRITICAL: this mirrors makeHandler EXACTLY — the full onPreToolUse enforcement
 * chain (TOOL_TIERS gate, guardrails, RBAC checkToolPermission, rate limits, and
 * tier-3 approval-card creation + waitForApproval blocking poll) runs before the
 * handler, and onPostToolUse runs after for ai_tool_executions persistence +
 * delegant_tool_call_id correlation. The ONLY difference from makeHandler is the
 * execute line: instead of executeTool(toolName, args, auth) it resolves the
 * active session and calls sessionHandler(args, auth, session.breezeSessionId).
 *
 * The no_active_session guard runs before any enforcement (nothing to enforce
 * if there is no session/tenant to act on).
 */
function makeSessionAwareHandler(
  toolName: string,
  getAuth: () => AuthContext,
  getActiveSession: (() => ActiveSession | undefined) | undefined,
  sessionHandler: (
    args: Record<string, unknown>,
    auth: AuthContext,
    sessionId: string,
  ) => Promise<string | SecretToolResult>,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  const toolTimeout = getToolTimeout(toolName);

  return async (args: Record<string, unknown>) => {
    // See makeHandler: escape any inherited AsyncLocalStorage DB context so all
    // DB ops (preToolUse approval writes, the tool call, postToolUse persistence)
    // start with a clean transaction context.
    return runOutsideDbContext(async (): Promise<SdkToolResult> => {
    const startTime = Date.now();

    // Resolve the active session up front. The no_active_session guard precedes
    // enforcement — there is no tenant/session to gate against if it's absent.
    const session = getActiveSession?.();
    if (!session) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no_active_session', message: 'No active session.' }) }],
        isError: true,
      };
    }

    // Pre-execution check (guardrails, RBAC, rate limits, approval). IDENTICAL to makeHandler.
    let intentId: string | undefined;
    if (onPreToolUse) {
      let check:
        | { allowed: true; intentId?: string }
        | { allowed: false; error: string; handoff?: ToolHandoffStatus };
      try {
        check = await onPreToolUse(toolName, args);
      } catch (err) {
        // The guardrail path also touches the DB (approval records, rate limits),
        // so `reason` can be a raw driver message — sanitize before embedding it
        // in a string that is streamed to the chat (#2603).
        const reason = sanitizeThrownToolError(`${toolName}:preToolUse`, err);
        check = { allowed: false, error: `Guardrails check failed: ${reason}` };
      }
      if (!check.allowed) {
        const denial = preToolUseDenialResult(toolName, check);
        await safePostToolUse(onPostToolUse, toolName, args, denial.text, denial.isError, 0, undefined, check.handoff);
        return {
          content: [{ type: 'text' as const, text: denial.text }],
          isError: denial.isError,
        };
      }
      intentId = check.intentId;
    }

    // Fail closed on confidentiality BEFORE the provider-side action executes,
    // not after. Without this, a secret-bearing tool with no intent to seal
    // into would still perform the (irreversible) provider-side reset and
    // only then discover there's nowhere safe to put the credential. Refusing
    // outright here means the reset genuinely never happens, so
    // SECRET_ACTION_REFUSED_TEXT (not performed) is accurate — as opposed to
    // SECRET_UNAVAILABLE_TEXT (performed, credential lost) used below for the
    // case where a carrier somehow reaches the post-execution split anyway.
    if (isSecretBearingTool(toolName) && !intentId) {
      console.error(
        `[AI-SDK] ${toolName} refused: no action intent available to seal a credential into (fail closed before execution)`,
      );
      const refusalText = compactToolResultForChat(
        toolName,
        JSON.stringify({ error: 'no_action_intent', message: SECRET_ACTION_REFUSED_TEXT }),
      );
      await safePostToolUse(onPostToolUse, toolName, args, refusalText, true, 0);
      return {
        content: [{ type: 'text' as const, text: refusalText }],
        isError: true,
      };
    }

    try {
      const auth = getAuth();
      // Use the user's actual auth scope so RLS / DB-level tenant isolation is
      // enforced. Canonical builder — see the note on the sibling literal in
      // `makeHandler` above for why the hand-rolled object was a partner-axis
      // blackout (#2822).
      const dbContext: DbAccessContext = dbAccessContextFromAuth(auth);
      // Bound to `handlerResult`, not `result`: the secret-carrier split below
      // declares its own `result: string` from `llmText`, so the raw handler
      // return must never share that name.
      const handlerResult = await withToolTimeout(
        withDbAccessContext(dbContext, () => sessionHandler(args, auth, session.breezeSessionId)),
        toolTimeout,
        toolName,
      );

      // Split a secret carrier BEFORE anything else sees it. Everything downstream —
      // compaction, the MCP/LLM response, the SSE stream, and DB persistence — may
      // only ever see llmText.
      let result: string;
      let sealed: { intentId: string; sealedResult: Record<string, unknown> } | undefined;

      if (typeof handlerResult === 'string') {
        result = handlerResult;
      } else if (handlerResult.kind === 'error') {
        result = handlerResult.llmText;
      } else if (!intentId) {
        // Unreachable in practice for any toolName registered in
        // isSecretBearingTool's registry: the pre-execution guard above
        // already refuses the call before sessionHandler ever runs. Kept as
        // defense-in-depth type-narrowing (so `sealed` below can require
        // `intentId: string` without a non-null assertion) for the case where
        // a handler returns a SecretToolResult carrier under a toolName the
        // registry doesn't recognize as secret-bearing. If reached, the
        // provider-side action already happened and cannot be undone, so
        // fail closed on confidentiality and drop the credential rather than
        // ever storing plaintext.
        console.error(
          `[AI-SDK] ${toolName} minted a credential with no action intent to seal it into — dropped (fail closed)`,
        );
        result = SECRET_UNAVAILABLE_TEXT;
      } else {
        const split = sealToolSecrets(handlerResult);
        result = split.llmText;
        sealed = { intentId, sealedResult: split.sealedResult };
      }

      const compactResult = compactToolResultForChat(toolName, result);

      // Detect error responses returned as JSON strings by tool handlers
      let isToolError = false;
      try {
        const parsed = JSON.parse(compactResult);
        if (parsed && typeof parsed === 'object' && 'error' in parsed && !('success' in parsed) && !('data' in parsed) && !('configured' in parsed)) {
          isToolError = true;
        }
      } catch { /* not JSON, treat as success */ }

      const durationMs = Date.now() - startTime;
      await safePostToolUse(onPostToolUse, toolName, args, compactResult, isToolError, durationMs, sealed);
      return { content: [{ type: 'text' as const, text: compactResult }], ...(isToolError ? { isError: true } : {}) };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      // A thrown error here is an internal fault — its message is very often a
      // raw Drizzle/postgres.js string carrying the full query and column list.
      // sanitizeThrownToolError logs it server-side and returns a safe generic
      // string for the stream (#2603).
      const message = sanitizeThrownToolError(toolName, err, { durationMs });
      const safeError = compactToolResultForChat(toolName, JSON.stringify({ error: message }));
      await safePostToolUse(onPostToolUse, toolName, args, safeError, true, durationMs);
      return {
        content: [{ type: 'text' as const, text: safeError }],
        isError: true,
      };
    }
    }); // end runOutsideDbContext
  };
}

// Exported for unit tests that lock in the enforcement ordering, and (for
// makeHandler) the preToolUse -> executeTool context hand-off (#3409 PR4c-1).
/**
 * Backwards-compatible four-argument shape of `makeToolHandler`, with NO active
 * session — W01 artifact capture is therefore inert for a handler built through
 * it. Every real declaration site shadows this with a local alias that closes
 * over its own `getActiveSession` (see createBreezeMcpServer and
 * scriptProposalToolDefinitions); this module-level binding exists only for
 * `__test__` consumers that predate the session parameter. Do NOT build a new
 * declaration site on it.
 */
const makeHandler = (
  toolName: string,
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) => makeToolHandler(toolName, getAuth, undefined, onPreToolUse, onPostToolUse);

export const __test__ = { makeSessionAwareHandler, makeHandler };

// ============================================
// SDK MCP Server Factory
// ============================================

/**
 * The Microsoft 365 helpdesk tool definitions, gated on EITHER backend being
 * usable: the direct app-only Graph path (M365_ENABLED + a per-org
 * m365_connections row) OR the Delegant broker (DELEGANT_BASE_URL). Returns []
 * (so the tools are NOT advertised to the model) only when neither is
 * configured — gating on DELEGANT_BASE_URL alone left the direct path dead in
 * production (M365_ENABLED instances with a saved connection but no broker).
 * Read from process.env at call time so it tracks runtime config (mirrors
 * googleToolDefinitions).
 */
/**
 * AI script authoring tools — EXPOSURE gate for BREEZE_AI_SCRIPT_AUTHORING_ENABLED.
 * Registration in aiTools and TOOL_TIERS stays unconditional so the
 * registry-parity contract holds statically; without a tool() entry the model
 * simply cannot call these. Same shape as m365ToolDefinitions below.
 */
export function scriptProposalToolDefinitions(
  getAuth: () => AuthContext,
  getActiveSession: (() => ActiveSession | undefined) | undefined,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  // Return type is inferred (like m365ToolDefinitions): the SDK's
  // SdkMcpToolDefinition generic is invariant in its shape, so an explicit
  // SdkTool[] annotation does not accept the concrete tool() results.
  if (!aiScriptAuthoringEnabled()) return [];
  // One alias so the tool() declarations below keep their four-argument shape
  // while the underlying handler also receives the session (W01 capture).
  const makeHandler = (
    toolName: string,
    auth: () => AuthContext,
    pre?: PreToolUseCallback,
    post?: PostToolUseCallback,
  ) => makeToolHandler(toolName, auth, getActiveSession, pre, post);
  const uuid = z.string().guid();
  return [
    tool(
      'propose_script',
      registryDescription('propose_script'),
      {
        language: z.enum(['powershell', 'bash', 'python', 'cmd']),
        content: z.string().min(1).max(65536),
        goal: z.string().min(1).max(2000),
        expectedEffect: z.string().min(1).max(2000),
        verification: z.record(z.string(), z.unknown()),
        rollbackNote: z.string().max(2000).optional(),
        deviceIds: z.array(uuid).min(1).max(10),
        runAs: z.enum(['system', 'user']).optional(),
        timeoutSeconds: z.number().int().min(1).max(3600).optional(),
        supersedesProposalId: uuid.optional(),
      },
      makeHandler('propose_script', getAuth, onPreToolUse, onPostToolUse),
    ),
    tool(
      'get_script_proposal',
      registryDescription('get_script_proposal'),
      { proposalId: uuid },
      makeHandler('get_script_proposal', getAuth, onPreToolUse, onPostToolUse),
    ),
  ];
}

export function m365ToolDefinitions(
  getAuth: () => AuthContext,
  getActiveSession: (() => ActiveSession | undefined) | undefined,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  const m365Flag = (process.env.M365_ENABLED ?? '').trim().toLowerCase();
  const m365Enabled = ['1', 'true', 'yes', 'on'].includes(m365Flag);
  const delegantConfigured = !!(process.env.DELEGANT_BASE_URL ?? '').trim();
  if (!m365Enabled && !delegantConfigured) return [];
  return [
    tool(
      'm365_lookup_user',
      SESSION_TOOL_DESCRIPTIONS.m365_lookup_user,
      { userIdentifier: z.string() },
      makeSessionAwareHandler('m365_lookup_user', getAuth, getActiveSession, m365LookupUserHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'm365_recent_signins',
      SESSION_TOOL_DESCRIPTIONS.m365_recent_signins,
      { userIdentifier: z.string() },
      makeSessionAwareHandler('m365_recent_signins', getAuth, getActiveSession, m365RecentSigninsHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'm365_list_group_memberships',
      SESSION_TOOL_DESCRIPTIONS.m365_list_group_memberships,
      {},
      makeSessionAwareHandler('m365_list_group_memberships', getAuth, getActiveSession, m365ListGroupMembershipsHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'm365_disable_user',
      SESSION_TOOL_DESCRIPTIONS.m365_disable_user,
      { userIdentifier: z.string(), reason: z.string() },
      makeSessionAwareHandler('m365_disable_user', getAuth, getActiveSession, m365DisableUserHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'm365_reset_password',
      SESSION_TOOL_DESCRIPTIONS.m365_reset_password,
      { userIdentifier: z.string(), reason: z.string() },
      makeSessionAwareHandler('m365_reset_password', getAuth, getActiveSession, m365ResetPasswordHandler, onPreToolUse, onPostToolUse)
    ),
  ];
}

/**
 * The Google Workspace helpdesk tool definitions, gated on
 * GOOGLE_WORKSPACE_ENABLED. Returns [] (tools NOT advertised to the model) when
 * the flag is off — without the flag + a per-org google_workspace_connections
 * row the tools can only no-op with `no_google_connection`. Read from
 * process.env at call time so it tracks runtime config (mirrors
 * m365ToolDefinitions).
 */
export function googleToolDefinitions(
  getAuth: () => AuthContext,
  getActiveSession: (() => ActiveSession | undefined) | undefined,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  const flag = (process.env.GOOGLE_WORKSPACE_ENABLED ?? '').trim().toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(flag)) return [];
  return [
    tool(
      'google_lookup_user',
      SESSION_TOOL_DESCRIPTIONS.google_lookup_user,
      { userEmail: z.string() },
      makeSessionAwareHandler('google_lookup_user', getAuth, getActiveSession, googleLookupUserHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_reset_password',
      SESSION_TOOL_DESCRIPTIONS.google_reset_password,
      { userEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_reset_password', getAuth, getActiveSession, googleResetPasswordHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_suspend_user',
      SESSION_TOOL_DESCRIPTIONS.google_suspend_user,
      { userEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_suspend_user', getAuth, getActiveSession, googleSuspendUserHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_restore_user',
      SESSION_TOOL_DESCRIPTIONS.google_restore_user,
      { userEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_restore_user', getAuth, getActiveSession, googleRestoreUserHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_signout',
      SESSION_TOOL_DESCRIPTIONS.google_signout,
      { userEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_signout', getAuth, getActiveSession, googleSignOutHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_list_user_groups',
      SESSION_TOOL_DESCRIPTIONS.google_list_user_groups,
      { userEmail: z.string() },
      makeSessionAwareHandler('google_list_user_groups', getAuth, getActiveSession, googleListUserGroupsHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_add_to_group',
      SESSION_TOOL_DESCRIPTIONS.google_add_to_group,
      { userEmail: z.string(), groupEmail: z.string(), role: z.enum(['MEMBER', 'MANAGER', 'OWNER']).optional(), reason: z.string() },
      makeSessionAwareHandler('google_add_to_group', getAuth, getActiveSession, googleAddToGroupHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_remove_from_group',
      SESSION_TOOL_DESCRIPTIONS.google_remove_from_group,
      { userEmail: z.string(), groupEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_remove_from_group', getAuth, getActiveSession, googleRemoveFromGroupHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_move_ou',
      SESSION_TOOL_DESCRIPTIONS.google_move_ou,
      { userEmail: z.string(), orgUnitPath: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_move_ou', getAuth, getActiveSession, googleMoveOuHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_rename_user',
      SESSION_TOOL_DESCRIPTIONS.google_rename_user,
      { userEmail: z.string(), newPrimaryEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_rename_user', getAuth, getActiveSession, googleRenameUserHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_list_licenses',
      SESSION_TOOL_DESCRIPTIONS.google_list_licenses,
      { productId: z.string() },
      makeSessionAwareHandler('google_list_licenses', getAuth, getActiveSession, googleListLicensesHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_assign_license',
      SESSION_TOOL_DESCRIPTIONS.google_assign_license,
      { userEmail: z.string(), productId: z.string(), skuId: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_assign_license', getAuth, getActiveSession, googleAssignLicenseHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_remove_license',
      SESSION_TOOL_DESCRIPTIONS.google_remove_license,
      { userEmail: z.string(), productId: z.string(), skuId: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_remove_license', getAuth, getActiveSession, googleRemoveLicenseHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_reset_2sv',
      SESSION_TOOL_DESCRIPTIONS.google_reset_2sv,
      { userEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_reset_2sv', getAuth, getActiveSession, googleResetTwoSvHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_add_mail_delegate',
      SESSION_TOOL_DESCRIPTIONS.google_add_mail_delegate,
      { userEmail: z.string(), delegateEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_add_mail_delegate', getAuth, getActiveSession, googleAddMailDelegateHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_remove_mail_delegate',
      SESSION_TOOL_DESCRIPTIONS.google_remove_mail_delegate,
      { userEmail: z.string(), delegateEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_remove_mail_delegate', getAuth, getActiveSession, googleRemoveMailDelegateHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_set_forwarding',
      SESSION_TOOL_DESCRIPTIONS.google_set_forwarding,
      { userEmail: z.string(), forwardTo: z.string(), keepCopy: z.boolean().optional(), reason: z.string() },
      makeSessionAwareHandler('google_set_forwarding', getAuth, getActiveSession, googleSetForwardingHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_disable_forwarding',
      SESSION_TOOL_DESCRIPTIONS.google_disable_forwarding,
      { userEmail: z.string(), forwardTo: z.string().optional(), removeAddress: z.boolean().optional(), reason: z.string() },
      makeSessionAwareHandler('google_disable_forwarding', getAuth, getActiveSession, googleDisableForwardingHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_set_vacation',
      SESSION_TOOL_DESCRIPTIONS.google_set_vacation,
      { userEmail: z.string(), enable: z.boolean().optional(), subject: z.string().optional(), message: z.string().optional(), reason: z.string() },
      makeSessionAwareHandler('google_set_vacation', getAuth, getActiveSession, googleSetVacationHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_update_user',
      SESSION_TOOL_DESCRIPTIONS.google_update_user,
      {
        userEmail: z.string(),
        givenName: z.string().optional(),
        familyName: z.string().optional(),
        recoveryEmail: z.string().optional(),
        recoveryPhone: z.string().optional(),
        addAlias: z.string().optional(),
        removeAlias: z.string().optional(),
        reason: z.string(),
      },
      makeSessionAwareHandler('google_update_user', getAuth, getActiveSession, googleUpdateUserHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_share_calendar',
      SESSION_TOOL_DESCRIPTIONS.google_share_calendar,
      {
        ownerEmail: z.string(),
        shareWithEmail: z.string(),
        calendarId: z.string().optional(),
        role: z.enum(['freeBusyReader', 'reader', 'writer', 'owner']).optional(),
        reason: z.string(),
      },
      makeSessionAwareHandler('google_share_calendar', getAuth, getActiveSession, googleShareCalendarHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_offboard_user',
      SESSION_TOOL_DESCRIPTIONS.google_offboard_user,
      {
        userEmail: z.string(),
        forwardTo: z.string().optional(),
        oooMessage: z.string().optional(),
        accountWipeMobile: z.boolean().optional(),
        removeFromGroups: z.boolean().optional(),
        revokeTokens: z.boolean().optional(),
        suspend: z.boolean().optional(),
        reason: z.string(),
      },
      makeSessionAwareHandler('google_offboard_user', getAuth, getActiveSession, googleOffboardUserHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_wipe_mobile_device',
      SESSION_TOOL_DESCRIPTIONS.google_wipe_mobile_device,
      { userEmail: z.string(), reason: z.string() },
      makeSessionAwareHandler('google_wipe_mobile_device', getAuth, getActiveSession, googleWipeMobileDeviceHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_security_drift',
      SESSION_TOOL_DESCRIPTIONS.google_security_drift,
      { staleDays: z.number().int().min(1).max(3650).optional() },
      makeSessionAwareHandler('google_security_drift', getAuth, getActiveSession, googleSecurityDriftHandler, onPreToolUse, onPostToolUse)
    ),
    tool(
      'google_email_report',
      SESSION_TOOL_DESCRIPTIONS.google_email_report,
      { staleDays: z.number().int().min(1).max(3650).optional() },
      makeSessionAwareHandler('google_email_report', getAuth, getActiveSession, googleEmailReportHandler, onPreToolUse, onPostToolUse)
    ),
  ];
}

/**
 * `extraTools` (e.g. the headless-run outcome tools built by
 * `buildOutcomeSdkTools` — `outcomeTools.ts`) arrive as bare
 * `SdkMcpToolDefinition`s with no hook wiring of their own — `outcomeTools.ts`
 * stays hook-free by design (it never touches the DB or the run's outcome
 * object). Without this wrapper the SDK would invoke an extra tool's
 * `handler` directly, so `onPreToolUse`/`onPostToolUse` — the run loop's
 * ONLY channel for denying a call or capturing `outcome.alertVerdict` —
 * would never fire for it (found in review: the verdict was silently never
 * captured outside the unit tests, since nothing called the hooks in a real
 * run). This gives an extra tool the SAME contract `makeHandler` gives every
 * registry tool, including the two protections that were originally missing
 * here (review round 2, Minor 1):
 *   - The ENTIRE handler (preToolUse, the original handler, postToolUse)
 *     runs inside `runOutsideDbContext`, exactly where `makeHandler` places
 *     it — escaping any stale/committed AsyncLocalStorage DB context
 *     inherited from the SDK's MCP callback chain (see `makeHandler`'s
 *     docstring for the hang this prevents) so pre/post hooks that touch the
 *     DB never inherit a dead connection.
 *   - The original handler runs under `withToolTimeout(…, getToolTimeout(name),
 *     name)` — the SAME timeout table `makeHandler` uses for registry tools
 *     (`toolTimeouts.ts`: 60s default, per-name overrides), computed once per
 *     wrap just like `makeHandler` computes it once per tool.
 * Otherwise the flow is unchanged: the preToolUse gate runs first (a denial
 * short-circuits with the SDK's own error-result shape, never reaching the
 * handler), then postToolUse fires with the result's first text block (or the
 * whole serialized result, if there is none) as `output` and `isError`
 * reflecting whether the call actually failed — a timeout included, since
 * `withToolTimeout`'s rejection lands in the same thrown-error catch block as
 * any other failure (`sanitizeThrownToolError` → `isError` result →
 * postToolUse).
 */
export function wrapExtraToolWithHooks(
  extraTool: SdkTool,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
): SdkTool {
  const { name, handler } = extraTool;
  const toolTimeout = getToolTimeout(name);
  return {
    ...extraTool,
    handler: async (args: Record<string, unknown>, extra: unknown): Promise<SdkToolResult> => {
      // See makeHandler: escape any inherited AsyncLocalStorage DB context so
      // preToolUse/handler/postToolUse all start with a clean context rather
      // than a stale/committed one from the SDK's MCP callback chain.
      return runOutsideDbContext(async (): Promise<SdkToolResult> => {
      const startTime = Date.now();
      if (onPreToolUse) {
        let check:
          | { allowed: true; context?: ToolExecutionContext }
          | { allowed: false; error: string; handoff?: ToolHandoffStatus };
        try {
          check = await onPreToolUse(name, args);
        } catch (err) {
          const reason = sanitizeThrownToolError(`${name}:preToolUse`, err);
          check = { allowed: false, error: `Guardrails check failed: ${reason}` };
        }
        if (!check.allowed) {
          const denial = preToolUseDenialResult(name, check);
          await safePostToolUse(onPostToolUse, name, args, denial.text, denial.isError, 0, undefined, check.handoff);
          return { content: [{ type: 'text' as const, text: denial.text }], isError: denial.isError };
        }
      }
      try {
        const result = await withToolTimeout(handler(args, extra), toolTimeout, name);
        const durationMs = Date.now() - startTime;
        await safePostToolUse(onPostToolUse, name, args, extraToolResultText(result), result.isError === true, durationMs);
        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const message = sanitizeThrownToolError(name, err, { durationMs });
        const safeError = compactToolResultForChat(name, JSON.stringify({ error: message }));
        await safePostToolUse(onPostToolUse, name, args, safeError, true, durationMs);
        return { content: [{ type: 'text' as const, text: safeError }], isError: true };
      }
      }); // end runOutsideDbContext
    },
  };
}

/** Best-effort text extraction from a `CallToolResult` for `onPostToolUse`'s
 *  `output` string — the first text content block, or the whole serialized
 *  result when there isn't one (e.g. an image-only result). */
function extraToolResultText(result: SdkToolResult): string {
  const blocks = (result as { content?: unknown[] }).content;
  if (Array.isArray(blocks)) {
    const first = blocks.find(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string',
    );
    if (first) return first.text;
  }
  return JSON.stringify(result);
}

/** Levenshtein edit distance — cheapest way to surface a likely-intended
 *  tool name for a typo without pulling in a fuzzy-match dependency. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

/** The `limit` registered tool names nearest (by edit distance) to `name` —
 *  used to make an unmatched `onlyTools` entry's likely typo self-evident. */
function nearestToolNames(name: string, candidates: readonly string[], limit = 3): string[] {
  return [...candidates]
    .map((candidate) => ({ candidate, distance: levenshteinDistance(name, candidate) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

/** Build the unfiltered SDK declarations before attaching registry metadata. */
export function buildBreezeSdkTools(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
  getActiveSession?: () => ActiveSession,
): SdkTool[] {
  // One alias so the tool() declarations below keep their four-argument shape
  // while the underlying handler also receives the session. W01 capture needs
  // the session's org (auth.orgId is null for a partner-scope login) and its
  // ai_sessions id. getActiveSession is undefined for the headless/agent
  // server, where the ai_agent principal already carries the run and org.
  const makeHandler = (
    toolName: string,
    auth: () => AuthContext,
    pre?: PreToolUseCallback,
    post?: PostToolUseCallback,
  ) => makeToolHandler(toolName, auth, getActiveSession, pre, post);

  const uuid = z.string().guid();

  const tools = [
    tool(
      'list_time_entries',
      registryDescription('list_time_entries'),
      {
        orgId: uuid.optional(),
        ticketId: uuid.optional(),
        userId: uuid.optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        running: z.boolean().optional(),
        billingStatus: z.enum(['not_billed', 'billed', 'no_charge', 'contract']).optional(),
        approved: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      makeHandler('list_time_entries', getAuth, onPreToolUse, onPostToolUse)
    ),
    tool(
      'get_running_timer',
      registryDescription('get_running_timer'),
      {},
      makeHandler('get_running_timer', getAuth, onPreToolUse, onPostToolUse)
    ),
    tool(
      'get_timesheet',
      registryDescription('get_timesheet'),
      { weekStart: z.string(), userId: uuid.optional() },
      makeHandler('get_timesheet', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'search_documentation',
      registryDescription('search_documentation'),
      {
        query: z.string().min(1).max(500),
        section: z.enum(['getting-started', 'deploy', 'agents', 'security', 'features', 'monitoring', 'reference']).optional(),
      },
      makeHandler('search_documentation', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'query_devices',
      registryDescription('query_devices'),
      {
        status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
        osType: z.enum(['windows', 'macos', 'linux']).optional(),
        siteId: z.string().guid().optional(),
        search: z.string().max(200).optional(),
        tags: z.array(z.string().max(100)).max(20).optional(),
        ...pageZodShape(25, 100),
      },
      makeHandler('query_devices', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_device_details',
      registryDescription('get_device_details'),
      { deviceId: uuid },
      makeHandler('get_device_details', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_device_hardware_health',
      registryDescription('get_device_hardware_health'),
      { deviceId: uuid, includeEvents: z.boolean().optional() },
      makeHandler('get_device_hardware_health', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'analyze_metrics',
      registryDescription('analyze_metrics'),
      {
        deviceId: uuid,
        metric: z.enum(['cpu', 'ram', 'disk', 'network', 'all']).optional(),
        hoursBack: z.number().int().min(1).max(168).optional(),
        aggregation: z.enum(['raw', 'hourly', 'daily']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      makeHandler('analyze_metrics', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_active_users',
      registryDescription('get_active_users'),
      {
        deviceId: uuid.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        maxSessionsPerDevice: z.number().int().min(1).max(50).optional(),
        idleThresholdMinutes: z.number().int().min(1).max(1440).optional(),
      },
      makeHandler('get_active_users', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_user_experience_metrics',
      registryDescription('get_user_experience_metrics'),
      {
        deviceId: uuid.optional(),
        username: z.string().max(255).optional(),
        daysBack: z.number().int().min(1).max(365).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      makeHandler('get_user_experience_metrics', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_delivery',
      registryDescription('manage_delivery'),
      deliveryToolShape,
      makeHandler('manage_delivery', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_alerts',
      registryDescription('manage_alerts'),
      {
        action: z.enum(['list', 'get', 'acknowledge', 'resolve']),
        alertId: uuid.optional(),
        status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        deviceId: uuid.optional(),
        ...keysetZodShape(15, 100),
        resolutionNote: z.string().max(1000).optional(),
      },
      makeHandler('manage_alerts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_dns_security',
      registryDescription('get_dns_security'),
      {
        timeRange: z.object({
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
        }),
        deviceId: uuid.optional(),
        integrationId: uuid.optional(),
        action: z.enum(['allowed', 'blocked', 'redirected']).optional(),
        category: z.string().max(100).optional(),
        topN: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('get_dns_security', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_huntress_status',
      registryDescription('get_huntress_status'),
      {
        orgId: uuid.optional(),
        integrationId: uuid.optional(),
      },
      makeHandler('get_huntress_status', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_huntress_incidents',
      registryDescription('get_huntress_incidents'),
      {
        orgId: uuid.optional(),
        integrationId: uuid.optional(),
        status: z.string().max(30).optional(),
        severity: z.string().max(20).optional(),
        deviceId: uuid.optional(),
        search: z.string().max(200).optional(),
        includeResolved: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
      makeHandler('get_huntress_incidents', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_dns_policy',
      registryDescription('manage_dns_policy'),
      {
        integrationId: uuid,
        action: z.enum(['add_block', 'remove_block', 'add_allow', 'remove_allow']),
        domains: z.array(z.string().min(1).max(500)).min(1).max(500),
        reason: z.string().max(2000).optional(),
      },
      makeHandler('manage_dns_policy', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_s1_status',
      registryDescription('get_s1_status'),
      {
        orgId: uuid.optional(),
      },
      makeHandler('get_s1_status', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_s1_threats',
      registryDescription('get_s1_threats'),
      {
        orgId: uuid.optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'unknown']).optional(),
        status: z.enum(['active', 'in_progress', 'quarantined', 'resolved']).optional(),
        deviceId: uuid.optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      makeHandler('get_s1_threats', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      's1_isolate_device',
      registryDescription('s1_isolate_device'),
      {
        orgId: uuid.optional(),
        deviceId: uuid.optional(),
        deviceIds: z.array(uuid).min(1).max(200).optional(),
        isolate: z.boolean().optional(),
      },
      makeHandler('s1_isolate_device', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      's1_threat_action',
      registryDescription('s1_threat_action'),
      {
        orgId: uuid.optional(),
        action: z.enum(['kill', 'quarantine', 'rollback']),
        threatIds: z.array(z.string().min(1).max(128)).min(1).max(200),
      },
      makeHandler('s1_threat_action', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'sync_huntress_data',
      registryDescription('sync_huntress_data'),
      {
        orgId: uuid.optional(),
        integrationId: uuid.optional(),
      },
      makeHandler('sync_huntress_data', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'execute_command',
      registryDescription('execute_command'),
      {
        deviceId: uuid,
        commandType: z.enum([
          'list_processes', 'kill_process',
          'list_services', 'start_service', 'stop_service', 'restart_service',
          'file_list', 'file_read',
          'event_logs_list', 'event_logs_query',
        ]),
        payload: z.record(z.string(), z.unknown()).optional(),
      },
      makeHandler('execute_command', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'run_script',
      registryDescription('run_script'),
      {
        // The tool() form takes a raw zod SHAPE, not a schema, so the XOR
        // refinement can only live in toolInputSchemas.run_script — which
        // validateToolInput enforces at dispatch. Deliberate asymmetry.
        scriptId: uuid.optional(),
        proposalId: uuid.optional(),
        deviceIds: z.array(uuid).min(1).max(10),
        parameters: z.record(z.string(), z.unknown()).optional(),
        // #4888 — mirrors toolInputSchemas.run_script; see scriptRunRequest.ts
        // for why the shape is shared rather than repeated.
        ...aiRunContextInputShape,
      },
      makeHandler('run_script', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'cancel_script_execution',
      registryDescription('cancel_script_execution'),
      {
        executionId: uuid,
        // Mirrors toolInputSchemas.cancel_script_execution; the 30s ceiling is
        // MAX_GRACE_SECONDS in services/scriptCancellation.
        graceSeconds: z.number().int().min(0).max(30).optional(),
      },
      makeHandler('cancel_script_execution', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_script_execution',
      registryDescription('get_script_execution'),
      {
        executionId: uuid,
        stdoutOffset: z.number().int().min(0).optional(),
        stdoutMaxChars: z.number().int().min(1).max(5000).optional(),
        stderrMaxChars: z.number().int().min(1).max(8000).optional(),
      },
      makeHandler('get_script_execution', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_services',
      registryDescription('manage_services'),
      {
        deviceId: uuid,
        action: z.enum(['list', 'start', 'stop', 'restart']),
        serviceName: z.string().max(255).optional(),
      },
      makeHandler('manage_services', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'security_scan',
      registryDescription('security_scan'),
      {
        deviceId: uuid,
        action: z.enum(['scan', 'status', 'quarantine', 'remove', 'restore', 'vulnerabilities']),
        threatId: z.string().max(255).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('security_scan', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_security_posture',
      registryDescription('get_security_posture'),
      {
        deviceId: uuid.optional(),
        orgId: uuid.optional(),
        minScore: z.number().int().min(0).max(100).optional(),
        maxScore: z.number().int().min(0).max(100).optional(),
        riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        includeRecommendations: z.boolean().optional(),
        ...pageZodShape(5, 500),
      },
      makeHandler('get_security_posture', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_cis_compliance',
      registryDescription('get_cis_compliance'),
      {
        orgId: uuid.optional(),
        baselineId: uuid.optional(),
        deviceId: uuid.optional(),
        osType: z.enum(['windows', 'macos', 'linux']).optional(),
        minScore: z.number().int().min(0).max(100).optional(),
        maxScore: z.number().int().min(0).max(100).optional(),
        includeSummary: z.boolean().optional(),
        ...pageZodShape(12, 500),
      },
      makeHandler('get_cis_compliance', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_cis_device_report',
      registryDescription('get_cis_device_report'),
      {
        deviceId: uuid,
        baselineId: uuid.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('get_cis_device_report', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'apply_cis_remediation',
      registryDescription('apply_cis_remediation'),
      {
        deviceId: uuid,
        baselineId: uuid.optional(),
        baselineResultId: uuid.optional(),
        checkIds: z.array(z.string().min(1).max(120)).min(1).max(100),
        action: z.enum(['apply', 'rollback']).optional(),
        reason: z.string().max(1000).optional(),
      },
      makeHandler('apply_cis_remediation', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_fleet_health',
      registryDescription('get_fleet_health'),
      {
        orgId: uuid.optional(),
        siteId: uuid.optional(),
        scoreRange: z.enum(['critical', 'poor', 'fair', 'good']).optional(),
        trendDirection: z.enum(['improving', 'stable', 'degrading']).optional(),
        issueType: z.enum(['crashes', 'hangs', 'hardware', 'services', 'uptime']).optional(),
        includeTopIssues: z.boolean().optional(),
        ...pageZodShape(15, 100),
      },
      makeHandler('get_fleet_health', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Zod shapes below mirror `toolInputSchemas.get_fleet_findings` /
    // `.analyze_fleet_metrics` (aiToolSchemas.ts) key-for-key — the gate
    // strips unknown keys silently, so a shape that drifts from the enforced
    // schema makes the model's argument vanish and the tool answer with
    // defaults.
    tool(
      'get_fleet_findings',
      registryDescription('get_fleet_findings'),
      {
        kind: z.enum(['metric_anomaly_pattern', 'log_correlation', 'reliability_offenders']).optional(),
        severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
        status: z.string().max(200).optional(),
        orgId: uuid.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeHandler('get_fleet_findings', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'analyze_fleet_metrics',
      registryDescription('analyze_fleet_metrics'),
      {
        metricName: z.enum(['cpu_percent', 'ram_percent', 'disk_percent']),
        windowHours: z.number().int().min(1).max(168).optional(),
        topN: z.number().int().min(1).max(50).optional(),
        orgId: uuid.optional(),
      },
      makeHandler('analyze_fleet_metrics', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_invite_funnel',
      registryDescription('get_invite_funnel'),
      {},
      makeHandler('get_invite_funnel', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'delete_tenant',
      registryDescription('delete_tenant'),
      {
        tenant_id: z.string().guid(),
        confirmation_phrase: z.string().min(1).max(500),
      },
      makeHandler('delete_tenant', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'file_operations',
      registryDescription('file_operations'),
      {
        deviceId: uuid,
        action: z.enum(['list', 'read', 'write', 'delete', 'mkdir', 'rename']),
        path: z.string().max(4096),
        content: z.string().max(1_000_000).optional(),
        newPath: z.string().max(4096).optional(),
      },
      makeHandler('file_operations', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'analyze_disk_usage',
      registryDescription('analyze_disk_usage'),
      {
        deviceId: uuid,
        refresh: z.boolean().optional(),
        path: z.string().max(4096).optional(),
        maxDepth: z.number().int().min(1).max(64).optional(),
        topFiles: z.number().int().min(1).max(500).optional(),
        topDirs: z.number().int().min(1).max(200).optional(),
        maxEntries: z.number().int().min(1_000).max(25_000_000).optional(),
        workers: z.number().int().min(1).max(32).optional(),
        timeoutSeconds: z.number().int().min(5).max(900).optional(),
        maxCandidates: z.number().int().min(1).max(200).optional(),
      },
      makeHandler('analyze_disk_usage', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'disk_cleanup',
      registryDescription('disk_cleanup'),
      {
        deviceId: uuid,
        action: z.enum(['preview', 'execute']),
        categories: z.array(z.string()).max(10).optional(),
        paths: z.array(z.string().max(4096)).min(1).max(200).optional(),
        maxCandidates: z.number().int().min(1).max(200).optional(),
        includeReasons: z.boolean().optional(),
      },
      makeHandler('disk_cleanup', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'system_cleanup',
      registryDescription('system_cleanup'),
      {
        deviceId: uuid,
        action: z.enum(['list', 'run', 'status']),
        actionIds: z
          .array(z.enum(SYSTEM_CLEANUP_ACTION_IDS))
          .min(1)
          .optional(),
        params: z
          .object({
            journalVacuumBytes: z.number().int().min(JOURNAL_VACUUM_MIN_BYTES).max(JOURNAL_VACUUM_MAX_BYTES).optional(),
          })
          .optional(),
        cleanupRunId: uuid.optional(),
        commandId: uuid.optional(),
      },
      makeHandler('system_cleanup', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'query_audit_log',
      registryDescription('query_audit_log'),
      {
        action: z.string().max(100).optional(),
        resourceType: z.string().max(100).optional(),
        resourceId: uuid.optional(),
        actorType: z.enum(ACTOR_TYPES).optional(),
        hoursBack: z.number().int().min(1).max(168).optional(),
        ...keysetZodShape(25, 100),
        includeDetails: z.boolean().optional(),
      },
      makeHandler('query_audit_log', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'query_change_log',
      registryDescription('query_change_log'),
      {
        deviceId: uuid.optional(),
        startTime: z.string().datetime({ offset: true }).optional(),
        endTime: z.string().datetime({ offset: true }).optional(),
        changeType: z.enum(['software', 'service', 'startup', 'network', 'scheduled_task', 'user_account', 'hardware', 'os_version']).optional(),
        changeAction: z.enum(['added', 'removed', 'modified', 'updated']).optional(),
        ...keysetZodShape(25, 500),
        includeValues: z.boolean().optional(),
      },
      makeHandler('query_change_log', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'network_discovery',
      registryDescription('network_discovery'),
      {
        deviceId: uuid,
        subnet: z.string().max(50).optional(),
        scanType: z.enum(['ping', 'arp', 'full']).optional(),
      },
      makeHandler('network_discovery', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'take_screenshot',
      registryDescription('take_screenshot'),
      {
        deviceId: uuid,
        monitor: z.number().int().min(0).max(10).optional(),
      },
      makeHandler('take_screenshot', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'analyze_screen',
      registryDescription('analyze_screen'),
      {
        deviceId: uuid,
        context: z.string().max(500).optional(),
        monitor: z.number().int().min(0).max(10).optional(),
      },
      makeHandler('analyze_screen', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'computer_control',
      registryDescription('computer_control'),
      {
        deviceId: uuid,
        action: z.enum(['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'mouse_move', 'scroll', 'key', 'type']),
        x: z.number().int().min(0).max(10000).optional(),
        y: z.number().int().min(0).max(10000).optional(),
        text: z.string().max(1000).optional(),
        key: z.string().max(50).regex(/^[a-zA-Z0-9_]+$/, 'Invalid key name').optional(),
        modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).max(4).optional(),
        scrollDelta: z.number().int().min(-100).max(100).optional(),
        monitor: z.number().int().min(0).max(10).optional(),
        captureAfter: z.boolean().optional(),
        captureDelayMs: z.number().int().min(0).max(3000).optional(),
      },
      makeHandler('computer_control', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Fleet orchestration tools

    tool(
      'manage_deployments',
      registryDescription('manage_deployments'),
      {
        action: z.enum(['list', 'get', 'device_status', 'create', 'start', 'pause', 'resume', 'cancel']),
        deploymentId: uuid.optional(),
        status: z.enum(['draft', 'pending', 'running', 'paused', 'completed', 'failed', 'cancelled']).optional(),
        name: z.string().max(200).optional(),
        type: z.string().max(50).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        targetType: z.string().max(20).optional(),
        targetConfig: z.record(z.string(), z.unknown()).optional(),
        rolloutConfig: z.record(z.string(), z.unknown()).optional(),
        schedule: z.record(z.string(), z.unknown()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_deployments', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_patches',
      registryDescription('manage_patches'),
      {
        action: z.enum(['list', 'compliance', 'scan', 'approve', 'decline', 'defer', 'bulk_approve', 'install', 'rollback', 'device_history']),
        patchId: uuid.optional(),
        patchName: z.string().min(1).max(300).optional(),
        patchIds: z.array(uuid).max(50).optional(),
        deviceIds: z.array(uuid).max(50).optional(),
        // #6665: also scopes `list` to one device (pre-existing gap — the
        // handler has read `input.deviceId` for `list` since #2112, but this
        // SDK-chat schema never declared the field, so the chat path silently
        // stripped it before device_history needed it too).
        deviceId: uuid.optional(),
        ringId: uuid.optional(),
        allRings: z.boolean().optional(),
        source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
        severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
        status: z.enum(['pending', 'approved', 'rejected', 'deferred']).optional(),
        resultStatus: z.enum(['pending', 'running', 'queued', 'completed', 'failed', 'skipped']).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        deferUntil: z.string().optional(),
        notes: z.string().max(1000).optional(),
        configPolicyId: uuid.optional(),
        autoApprove: z.boolean().optional(),
        autoApproveSeverities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).optional(),
        scheduleFrequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
        scheduleTime: z.string().optional(),
        rebootPolicy: z.enum(['if_required', 'always', 'never']).optional(),
        sources: z.array(z.enum(['os', 'third_party', 'custom'])).optional(),
        ...pageZodShape(25, 100),
      },
      makeHandler('manage_patches', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Vulnerability management (BE-16). These were registered in the aiTools
    // execution registry + TOOL_TIERS but NEVER given tool() definitions here,
    // so the in-product chat never saw them and routed every CVE question to
    // posture/patch tools (#2605). Descriptions are duplicated here (as for
    // every other tool in this file); aiToolsVulnerability.ts carries the copy
    // served to external MCP clients via getToolDefinitions(). Both are pinned
    // by tests so the CVE vocabulary cannot drift out of either surface.
    tool(
      'get_vulnerability_report',
      registryDescription('get_vulnerability_report'),
      {
        status: z.enum(['open', 'patched', 'mitigated', 'accepted', 'all']).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      },
      makeHandler('get_vulnerability_report', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_device_vulnerabilities',
      registryDescription('get_device_vulnerabilities'),
      {
        deviceId: uuid,
        status: z.enum(['open', 'patched', 'mitigated', 'accepted', 'all']).optional(),
        ...pageZodShape(45, 200),
      },
      makeHandler('get_device_vulnerabilities', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'remediate_vulnerability',
      registryDescription('remediate_vulnerability'),
      {
        deviceVulnerabilityIds: z.array(uuid).min(1).max(100),
      },
      makeHandler('remediate_vulnerability', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_groups',
      registryDescription('manage_groups'),
      {
        action: z.enum(['list', 'get', 'preview', 'membership_log', 'create', 'update', 'delete', 'add_devices', 'remove_devices']),
        groupId: uuid.optional(),
        name: z.string().max(255).optional(),
        type: z.enum(['static', 'dynamic']).optional(),
        siteId: uuid.optional(),
        filterConditions: z.record(z.string(), z.unknown()).optional(),
        deviceIds: z.array(uuid).max(100).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      makeHandler('manage_groups', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_maintenance_windows',
      registryDescription('manage_maintenance_windows'),
      {
        action: z.enum(['list', 'get', 'active_now', 'create', 'update', 'delete']),
        windowId: uuid.optional(),
        name: z.string().max(255).optional(),
        description: z.string().max(2000).optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        timezone: z.string().max(50).optional(),
        recurrence: z.enum(['once', 'daily', 'weekly', 'monthly', 'custom']).optional(),
        recurrenceRule: z.record(z.string(), z.unknown()).optional(),
        targetType: z.string().max(50).optional(),
        siteIds: z.array(uuid).optional(),
        groupIds: z.array(uuid).optional(),
        deviceIds: z.array(uuid).optional(),
        suppressAlerts: z.boolean().optional(),
        suppressPatching: z.boolean().optional(),
        suppressAutomations: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_maintenance_windows', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_automations',
      registryDescription('manage_automations'),
      {
        action: z.enum(['list', 'get', 'history', 'create', 'update', 'delete', 'enable', 'disable', 'run']),
        automationId: uuid.optional(),
        name: z.string().max(200).optional(),
        description: z.string().max(2000).optional(),
        trigger: z.record(z.string(), z.unknown()).optional(),
        conditions: z.record(z.string(), z.unknown()).optional(),
        actions: z.array(z.record(z.string(), z.unknown())).min(1).max(20).optional(),
        onFailure: z.enum(['stop', 'continue', 'notify']).optional(),
        enabled: z.boolean().optional(),
        triggerType: z.enum(['schedule', 'event', 'webhook', 'manual']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_automations', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_alert_rules',
      registryDescription('manage_alert_rules'),
      {
        action: z.enum(['list_templates', 'list_rules', 'get_rule', 'create_rule', 'update_rule', 'delete_rule', 'test_rule', 'list_channels', 'alert_summary']),
        ruleId: uuid.optional(),
        name: z.string().max(200).optional(),
        templateId: uuid.optional(),
        targetType: z.enum(['device', 'group', 'site', 'org', 'all']).optional(),
        targetId: uuid.optional(),
        overrideSettings: z.record(z.string(), z.unknown()).optional(),
        isActive: z.boolean().optional(),
        category: z.string().max(100).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_alert_rules', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_service_monitors',
      registryDescription('manage_service_monitors'),
      {
        action: z.enum(['list']),
        configPolicyId: uuid.optional(),
      },
      makeHandler('manage_service_monitors', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'generate_report',
      registryDescription('generate_report'),
      {
        action: z.enum(['list', 'generate', 'data', 'create', 'update', 'delete', 'history']),
        reportId: uuid.optional(),
        reportType: z.enum(['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary']).optional(),
        name: z.string().max(255).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional(),
        format: z.enum(['csv', 'pdf', 'excel']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('generate_report', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Brain device context tools

    tool(
      'get_device_context',
      registryDescription('get_device_context'),
      {
        deviceId: uuid,
        includeResolved: z.boolean().optional().default(false),
      },
      makeHandler('get_device_context', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'set_device_context',
      registryDescription('set_device_context'),
      {
        deviceId: uuid,
        contextType: z.enum(['issue', 'quirk', 'followup', 'preference']),
        summary: z.string().min(1).max(255),
        details: z.record(z.string(), z.unknown()).optional(),
        expiresInDays: z.number().int().positive().max(365).optional(),
      },
      makeHandler('set_device_context', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'resolve_device_context',
      registryDescription('resolve_device_context'),
      {
        contextId: uuid,
      },
      makeHandler('resolve_device_context', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Boot performance & startup tools

    tool(
      'analyze_boot_performance',
      registryDescription('analyze_boot_performance'),
      {
        deviceId: uuid,
        bootsBack: z.number().int().min(1).max(30).optional(),
        triggerCollection: z.boolean().optional(),
        includePaths: z.boolean().optional(),
      },
      makeHandler('analyze_boot_performance', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_startup_items',
      registryDescription('manage_startup_items'),
      {
        deviceId: uuid,
        itemName: z.string().min(1).max(255),
        itemId: z.string().max(512).optional(),
        itemType: z.string().max(64).optional(),
        itemPath: z.string().max(2048).optional(),
        action: z.enum(['disable', 'enable']),
        reason: z.string().max(500).optional(),
      },
      makeHandler('manage_startup_items', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Agent log tools

    tool(
      'search_agent_logs',
      registryDescription('search_agent_logs'),
      {
        deviceIds: z.array(uuid).max(50).optional(),
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        component: z.string().max(100).optional(),
        startTime: z.string().datetime({ offset: true }).optional(),
        endTime: z.string().datetime({ offset: true }).optional(),
        message: z.string().max(500).optional(),
        ...keysetZodShape(18, 500),
        includeFields: z.boolean().optional(),
      },
      makeHandler('search_agent_logs', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'set_agent_log_level',
      registryDescription('set_agent_log_level'),
      {
        deviceId: uuid,
        level: z.enum(['debug', 'info', 'warn', 'error']),
        durationMinutes: z.number().int().min(1).max(1440).optional(),
      },
      makeHandler('set_agent_log_level', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'capture_agent_pprof',
      registryDescription('capture_agent_pprof'),
      {
        deviceId: uuid,
        profile: z.enum(['heap', 'goroutine', 'all']).optional(),
      },
      makeHandler('capture_agent_pprof', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Event log tools

    tool(
      'search_logs',
      registryDescription('search_logs'),
      {
        query: z.string().max(500).optional(),
        timeRange: z.object({
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
        }).optional(),
        level: z.array(z.enum(['info', 'warning', 'error', 'critical'])).max(4).optional(),
        category: z.array(z.enum(['security', 'hardware', 'application', 'system'])).max(4).optional(),
        source: z.string().max(255).optional(),
        deviceIds: z.array(uuid).max(500).optional(),
        siteIds: z.array(uuid).max(500).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        cursor: z.string().max(1024).optional(),
        countMode: z.enum(['exact', 'estimated', 'none']).optional(),
        sortBy: z.enum(['timestamp', 'level', 'device']).optional(),
        sortOrder: z.enum(['asc', 'desc']).optional(),
        includeFullMessage: z.boolean().optional(),
      },
      makeHandler('search_logs', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'export_dataset',
      registryDescription('export_dataset'),
      {
        dataset: z.enum(['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields']),
        format: z.enum(['jsonl', 'csv']).optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
        deviceIds: z.array(z.string()).optional(),
        siteId: z.string().optional(),
        maxRows: z.number().optional(),
      },
      makeHandler('export_dataset', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'read_artifact',
      registryDescription('read_artifact'),
      {
        handle: z.string().guid().describe('Artifact handle (UUID) from artifact.handle'),
        offset: z.number().int().min(0).optional().describe('Byte offset to start from; pass nextOffset to continue (default 0)'),
        maxChars: z.number().int().min(1).max(6000).optional().describe('Max characters to return (default 4000, max 6000)'),
      },
      makeHandler('read_artifact', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'workspace_stage',
      registryDescription('workspace_stage'),
      WORKSPACE_MCP_SHAPES.workspace_stage,
      makeHandler('workspace_stage', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'workspace_run',
      registryDescription('workspace_run'),
      WORKSPACE_MCP_SHAPES.workspace_run,
      makeHandler('workspace_run', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'workspace_collect',
      registryDescription('workspace_collect'),
      WORKSPACE_MCP_SHAPES.workspace_collect,
      makeHandler('workspace_collect', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'workspace_cancel',
      registryDescription('workspace_cancel'),
      WORKSPACE_MCP_SHAPES.workspace_cancel,
      makeHandler('workspace_cancel', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_log_trends',
      registryDescription('get_log_trends'),
      {
        timeRange: z.object({
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
        }).optional(),
        groupBy: z.enum(['level', 'source', 'device', 'category']).optional(),
        minLevel: z.enum(['info', 'warning', 'error', 'critical']).optional(),
        source: z.string().max(255).optional(),
        deviceIds: z.array(uuid).max(500).optional(),
        siteIds: z.array(uuid).max(500).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        includeTimeline: z.boolean().optional(),
      },
      makeHandler('get_log_trends', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'detect_log_correlations',
      registryDescription('detect_log_correlations'),
      {
        orgId: uuid.optional(),
        pattern: z.string().min(1).max(1000),
        isRegex: z.boolean().optional(),
        timeWindow: z.number().int().min(30).max(86_400).optional(),
        minDevices: z.number().int().min(1).max(200).optional(),
        minOccurrences: z.number().int().min(1).max(50_000).optional(),
      },
      makeHandler('detect_log_correlations', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Configuration policy tools

    tool(
      'list_configuration_policies',
      registryDescription('list_configuration_policies'),
      {
        status: z.enum(['active', 'inactive', 'archived']).optional(),
        ...pageZodShape(20, 100),
      },
      makeHandler('list_configuration_policies', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_effective_configuration',
      registryDescription('get_effective_configuration'),
      {
        deviceId: uuid,
        featureType: z.enum(CONFIG_FEATURE_TYPES).optional(),
        includeSettings: z.boolean().optional(),
      },
      makeHandler('get_effective_configuration', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'preview_configuration_change',
      registryDescription('preview_configuration_change'),
      {
        deviceId: uuid,
        add: z.array(z.object({
          configPolicyId: uuid,
          level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
          targetId: uuid,
          priority: z.number().int().optional(),
        })).optional(),
        remove: z.array(uuid).optional(),
      },
      makeHandler('preview_configuration_change', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'apply_configuration_policy',
      registryDescription('apply_configuration_policy'),
      {
        configPolicyId: uuid,
        level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
        targetId: uuid,
        priority: z.number().int().min(0).max(1000).optional(),
      },
      makeHandler('apply_configuration_policy', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'remove_configuration_policy_assignment',
      registryDescription('remove_configuration_policy_assignment'),
      {
        assignmentId: uuid,
      },
      makeHandler('remove_configuration_policy_assignment', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_configuration_policy',
      registryDescription('get_configuration_policy'),
      {
        policyId: uuid,
      },
      makeHandler('get_configuration_policy', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_configuration_policy',
      registryDescription('manage_configuration_policy'),
      {
        action: z.enum(['create', 'update', 'activate', 'deactivate', 'delete']),
        policyId: uuid.optional(),
        name: z.string().max(255).optional(),
        description: z.string().max(2000).optional(),
        status: z.enum(['active', 'inactive', 'archived']).optional(),
        orgId: uuid.optional(),
      },
      makeHandler('manage_configuration_policy', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'configuration_policy_compliance',
      registryDescription('configuration_policy_compliance'),
      {
        action: z.enum(['summary', 'status']),
        policyId: uuid.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('configuration_policy_compliance', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_policy_feature_link',
      registryDescription('manage_policy_feature_link'),
      {
        action: z.enum(['add', 'update', 'remove', 'list', 'describe']),
        // Conditional requirements are enforced by toolInputSchemas at dispatch.
        configPolicyId: uuid.optional(),
        featureLinkId: uuid.optional(),
        featureType: z.enum(CONFIG_FEATURE_TYPES).optional(),
        featurePolicyId: uuid.optional().nullable(),
        inlineSettings: z.record(z.string(), z.unknown()).optional().nullable(),
      },
      makeHandler('manage_policy_feature_link', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Policy prerequisite tools — the standalone policies a feature link points
    // at via `featurePolicyId`. The system prompt's "create a configuration
    // policy" workflow routes through these, so they have to reach the model.

    tool(
      'manage_update_rings',
      registryDescription('manage_update_rings'),
      {
        action: z.enum(['list', 'get', 'create', 'update']),
        ringId: uuid.optional(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().max(2000).optional(),
        deferralDays: z.number().int().min(0).max(365).optional(),
        deadlineDays: z.number().int().min(0).max(365).optional(),
        gracePeriodHours: z.number().int().min(0).max(168).optional(),
        categories: z.array(z.string().max(100)).max(50).optional(),
        excludeCategories: z.array(z.string().max(100)).max(50).optional(),
        // `patch_policies.sources` is deprecated (#3150) — never advertised to
        // the model; the handler ignores it and `get` strips it from responses.
        autoApprove: z.record(z.string(), z.unknown()).optional(),
        enabled: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_update_rings', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_software_policies',
      registryDescription('manage_software_policies'),
      {
        action: z.enum(['list', 'get', 'create', 'update']),
        policyId: uuid.optional(),
        ownerScope: z.enum(['organization', 'partner']).optional(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        mode: z.enum(['allowlist', 'blocklist', 'audit']).optional(),
        rules: z.record(z.string(), z.unknown()).optional(),
        enforceMode: z.boolean().optional(),
        remediationOptions: z.record(z.string(), z.unknown()).optional(),
        isActive: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_software_policies', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_peripheral_policies',
      registryDescription('manage_peripheral_policies'),
      {
        action: z.enum(['list', 'get', 'create', 'update']),
        policyId: uuid.optional(),
        name: z.string().min(1).max(200).optional(),
        deviceClass: z.enum(peripheralDeviceClassEnum.enumValues).optional(),
        // Named `action_type` (not `action`) by the tool definition so it does
        // not collide with the action multiplexer above.
        action_type: z.enum(peripheralPolicyActionEnum.enumValues).optional(),
        exceptions: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
        isActive: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_peripheral_policies', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_backup_configs',
      registryDescription('manage_backup_configs'),
      {
        action: z.enum(['list', 'get', 'create', 'update']),
        configId: uuid.optional(),
        name: z.string().min(1).max(200).optional(),
        type: z.enum(['file', 'system_image', 'database', 'application']).optional(),
        provider: z.enum(['s3', 'azure_blob', 'google_cloud', 'backblaze', 'local']).optional(),
        providerConfig: z.record(z.string(), z.unknown()).optional(),
        schedule: z.record(z.string(), z.unknown()).optional(),
        retention: z.record(z.string(), z.unknown()).optional(),
        compression: z.boolean().optional(),
        encryption: z.boolean().optional(),
        isActive: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_backup_configs', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Playbook tools

    tool(
      'list_playbooks',
      registryDescription('list_playbooks'),
      {
        category: z.enum(['disk', 'service', 'memory', 'patch', 'security', 'all']).optional(),
        includeSteps: z.boolean().optional(),
        ...pageZodShape(25, 100),
      },
      makeHandler('list_playbooks', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'execute_playbook',
      registryDescription('execute_playbook'),
      {
        playbookId: uuid,
        deviceId: uuid,
        variables: z.record(z.string(), z.unknown()).optional(),
        context: z.record(z.string(), z.unknown()).optional(),
      },
      makeHandler('execute_playbook', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_playbook_history',
      registryDescription('get_playbook_history'),
      {
        deviceId: uuid.optional(),
        playbookId: uuid.optional(),
        status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'rolled_back', 'cancelled']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('get_playbook_history', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Monitoring tools

    tool(
      'query_monitors',
      registryDescription('query_monitors'),
      {
        status: z.enum(['online', 'offline', 'degraded', 'unknown']).optional(),
        monitorType: z.string().max(50).optional(),
        isActive: z.boolean().optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('query_monitors', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_network_assets',
      registryDescription('list_network_assets'),
      {
        orgId: z.string().guid().optional(),
        siteId: z.string().guid().optional(),
        approvalStatus: z.enum(['pending', 'approved', 'dismissed']).optional(),
        assetType: z.enum(['workstation', 'server', 'printer', 'router', 'switch', 'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown', 'website', 'service']).optional(),
        linkedDeviceId: z.string().guid().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      makeHandler('list_network_assets', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_network_asset',
      registryDescription('get_network_asset'),
      { assetId: z.string().guid() },
      makeHandler('get_network_asset', getAuth, onPreToolUse, onPostToolUse)
    ),

    // W01 (spec §4.4) — the only read that answers "is this printer/switch up"
    // with the SOURCE and AGE of the evidence. Declared here as well as in
    // TOOL_TIERS: a tier without a tool() declaration is allowlisted but
    // uncallable (#2605).
    tool(
      'get_network_asset_reachability',
      registryDescription('get_network_asset_reachability'),
      {
        asset_id: uuid,
      },
      makeHandler('get_network_asset_reachability', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_monitors',
      registryDescription('manage_monitors'),
      {
        action: z.enum(['get', 'create', 'update', 'delete']),
        monitorId: uuid.optional(),
        name: z.string().max(255).optional(),
        monitorType: z.enum(['icmp_ping', 'tcp_port', 'http_check', 'dns_check']).optional(),
        target: z.string().max(500).optional(),
        pollingInterval: z.number().int().min(10).max(86400).optional(),
        timeout: z.number().int().min(1).max(120).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        isActive: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_monitors', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Monitor definition episode activity / escalation reset (#5290 W03).
    tool(
      'get_monitor_activity',
      registryDescription('get_monitor_activity'),
      {
        monitorId: uuid,
        deviceId: uuid.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      makeHandler('get_monitor_activity', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'reset_monitor_escalation',
      registryDescription('reset_monitor_escalation'),
      {
        monitorId: uuid,
        deviceId: uuid,
      },
      makeHandler('reset_monitor_escalation', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_service_monitoring_status',
      registryDescription('get_service_monitoring_status'),
      {
        action: z.enum(['status', 'summary', 'results', 'known_services']),
        deviceId: uuid.optional(),
        watchType: z.enum(['service', 'process']).optional(),
        name: z.string().max(255).optional(),
        since: z.string().datetime({ offset: true }).optional(),
        until: z.string().datetime({ offset: true }).optional(),
        search: z.string().max(255).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      makeHandler('get_service_monitoring_status', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Org lifecycle tools (issue #2366) — new-customer intake (org → site → quote)

    tool(
      'list_remediation_suggestions',
      registryDescription('list_remediation_suggestions'),
      {
        orgId: z.string().guid().optional(),
        sourceType: z.enum(['alert', 'anomaly', 'correlation', 'rca']).optional(),
        sourceId: z.string().min(1).max(255).optional(),
        deviceId: z.string().guid().optional(),
        status: z.enum(['all', 'suggested', 'accepted', 'edited', 'rejected', 'executed', 'failed']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('list_remediation_suggestions', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_incidents',
      registryDescription('list_incidents'),
      {
        orgId: z.string().guid().optional(),
        status: z.enum(['detected', 'analyzing', 'contained', 'recovering', 'closed']).optional(),
        severity: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
        classification: z.string().max(40).optional(),
        assignedTo: z.string().guid().optional(),
        startDate: z.string().datetime({ offset: true }).optional(),
        endDate: z.string().datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      makeHandler('list_incidents', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_ai_agents', registryDescription('list_ai_agents'),
      { includeDisabled: z.boolean().optional(), ...pageZodShape(25, 100) },
      makeHandler('list_ai_agents', getAuth, onPreToolUse, onPostToolUse)
    ),
    tool(
      'list_ai_agent_runs', registryDescription('list_ai_agent_runs'),
      {
        agentId: z.string().guid().optional(), orgId: z.string().guid().optional(),
        status: z.enum(AI_AGENT_RUN_STATUSES).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeHandler('list_ai_agent_runs', getAuth, onPreToolUse, onPostToolUse)
    ),
    tool(
      'get_ai_agent_run', registryDescription('get_ai_agent_run'),
      { runId: z.string().guid() },
      makeHandler('get_ai_agent_run', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_sites',
      registryDescription('list_sites'),
      {
        orgId: z.string().guid().optional(),
        search: z.string().max(255).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      makeHandler('list_sites', getAuth, onPreToolUse, onPostToolUse)
    ),
    tool(
      'get_site',
      registryDescription('get_site'),
      { siteId: z.string().guid() },
      makeHandler('get_site', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_org_contacts',
      registryDescription('list_org_contacts'),
      {
        orgId: z.string().guid(),
        siteId: z.union([z.literal('none'), z.string().guid()]).optional(),
        role: z.string().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      makeHandler('list_org_contacts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_organizations',
      registryDescription('list_organizations'),
      {
        search: z.string().max(255).optional(),
        ...pageZodShape(25, 100),
      },
      makeHandler('list_organizations', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_organizations',
      registryDescription('manage_organizations'),
      {
        action: z.enum(['create_org', 'update_org', 'create_site', 'add_contact']),
        orgId: uuid.optional(),
        name: z.string().max(255).optional(),
        status: z.enum(['active', 'suspended', 'trial', 'churned']).optional(),
        address: z.record(z.string(), z.unknown()).optional(),
        email: z.string().email().max(255).optional(),
        siteId: uuid.optional(),
        phone: z.string().max(64).optional(),
        mobile: z.string().max(64).optional(),
        title: z.string().max(255).optional(),
        roles: z.array(z.enum(CONTACT_ROLES)).optional(),
        isPrimary: z.boolean().optional(),
      },
      makeHandler('manage_organizations', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_ai_agents',
      registryDescription('manage_ai_agents'),
      {
        action: z.enum(['authorize_supervised_key']),
        kind: z.enum(AI_AGENT_KINDS),
        opKey: z.string().min(3).max(120),
        // Required, and re-checked against the intent's own org at creation and
        // again at execution. It is here so the approval can PIN this org's
        // authorized-key list (services/actionIntents/effectDigest.ts), not so
        // a caller can choose a target.
        orgId: uuid,
      },
      makeHandler('manage_ai_agents', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Billing, quoting, catalog and contract tools (#3156). Identical failure
    // mode to the vulnerability tools above (#2605): all eleven were registered
    // in the aiTools execution registry (aiToolsBilling / aiToolsQuotes /
    // aiToolsCatalog / aiToolsContracts) and served to EXTERNAL MCP clients via
    // getToolDefinitions(), but had no tool() declaration here — so the
    // in-product chat never saw them and answered "I don't have an invoicing
    // tool". Worse, #3130 had already added the nine reads to
    // TIER2_READONLY_TOOLS, an allowlist that is only consulted on the chat
    // path (aiAgentSdk.ts), making it entirely inert.
    //
    // Descriptions are duplicated here, as for every other tool in this file;
    // the aiTools* modules keep the canonical copy served to external MCP.
    // Input shapes mirror toolInputSchemas (aiToolSchemas.ts) exactly — that is
    // the gate executeTool validates against, and a key the model is told to
    // send but Zod does not know is stripped silently.

    tool(
      'list_invoices',
      registryDescription('list_invoices'),
      {
        orgId: uuid.optional(),
        status: z.enum(INVOICE_STATUSES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('list_invoices', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_invoice',
      registryDescription('get_invoice'),
      {
        invoiceId: uuid,
      },
      makeHandler('get_invoice', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_invoices',
      registryDescription('manage_invoices'),
      {
        action: z.enum([
          'create_draft', 'add_manual_line', 'add_catalog_line', 'add_bundle_line', 'add_contract_line',
          'update_line', 'remove_line', 'update_header', 'delete_draft',
          'assemble_from_org', 'assemble_from_ticket',
          'issue', 'void', 'record_payment', 'void_payment', 'create_pay_link',
        ]),
        orgId: uuid.optional(),
        siteId: uuid.optional(),
        invoiceId: uuid.optional(),
        lineId: uuid.optional(),
        paymentId: uuid.optional(),
        catalogItemId: uuid.optional(),
        bundleId: uuid.optional(),
        contractId: uuid.optional(),
        contractLineId: uuid.optional(),
        ticketId: uuid.optional(),
        quantity: z.number().optional(),
        notes: z.string().optional(),
        termsAndConditions: z.string().optional(),
        reason: z.string().optional(),
        reissue: z.boolean().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        line: z.record(z.string(), z.unknown()).optional(),
        patch: z.record(z.string(), z.unknown()).optional(),
        payment: z.record(z.string(), z.unknown()).optional(),
      },
      makeHandler('manage_invoices', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_quotes',
      registryDescription('list_quotes'),
      {
        orgId: uuid.optional(),
        status: z.enum(['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted', 'superseded']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('list_quotes', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_quote',
      // Single source of truth: the registry definition (aiToolsQuotes.ts) carries
      // the pagination guidance, so the MCP description can't drift from it.
      registryDescription('get_quote'),
      {
        quoteId: uuid,
        // Large quotes exceed the MCP output cap — let the model page the content
        // blocks or fetch a metadata-only overview (#3485). Must mirror the
        // canonical get_quote schema in aiToolSchemas.ts.
        blocksOffset: z.number().int().min(0).optional(),
        blocksLimit: z.number().int().min(1).max(100).optional(),
        includeBlockContent: z.boolean().optional(),
      },
      makeHandler('get_quote', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_contracts',
      registryDescription('list_contracts'),
      {
        orgId: uuid.optional(),
        status: z.enum(['draft', 'active', 'paused', 'cancelled', 'expired']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('list_contracts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_contract',
      registryDescription('get_contract'),
      {
        contractId: uuid,
      },
      makeHandler('get_contract', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_org_documents',
      registryDescription('list_org_documents'),
      {
        orgId: uuid,
        category: z.enum(['baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other']).optional(),
        includeSuperseded: z.boolean().optional(),
      },
      makeHandler('list_org_documents', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_org_documents',
      registryDescription('manage_org_documents'),
      {
        action: z.enum(['update_metadata', 'set_portal_visibility', 'supersede']),
        orgId: uuid,
        documentId: uuid.optional(),
        supersedesDocumentId: uuid.optional(),
        portalVisible: z.boolean().optional(),
        patch: z.record(z.string(), z.unknown()).optional(),
      },
      makeHandler('manage_org_documents', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_contracts',
      registryDescription('manage_contracts'),
      {
        action: z.enum([
          'create_draft',
          'update',
          'delete_draft',
          'add_line',
          'remove_line',
          'update_line',
          'activate',
          'pause',
          'resume',
          'cancel',
        ]),
        contractId: uuid.optional(),
        lineId: uuid.optional(),
        input: z.record(z.string(), z.unknown()).optional(),
        line: z.record(z.string(), z.unknown()).optional(),
        patch: z.record(z.string(), z.unknown()).optional(),
      },
      makeHandler('manage_contracts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_deliverables',
      registryDescription('list_deliverables'),
      {
        orgId: uuid,
        contractId: uuid.optional(),
        includeInactive: z.boolean().optional(),
        occurrencesFor: uuid.optional(),
      },
      makeHandler('list_deliverables', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_deliverable_templates',
      registryDescription('list_deliverable_templates'),
      { orgId: uuid.optional() },
      makeHandler('list_deliverable_templates', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_deliverables',
      registryDescription('manage_deliverables'),
      {
        action: z.enum(['create', 'update', 'deactivate', 'deliver', 'waive', 'reopen', 'reschedule', 'link_evidence', 'apply_template']),
        orgId: uuid.optional(),
        deliverableId: uuid.optional(),
        occurrenceId: uuid.optional(),
        setId: uuid.optional(),
        contractId: uuid.optional(),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ownerUserId: uuid.optional(),
        input: z.record(z.string(), z.unknown()).optional(),
        patch: z.record(z.string(), z.unknown()).optional(),
        note: z.string().max(4000).optional(),
        reason: z.string().max(2000).optional(),
        dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        reportRunId: uuid.optional(),
      },
      makeHandler('manage_deliverables', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_key_dates',
      registryDescription('manage_key_dates'),
      {
        action: z.enum(['list', 'create', 'update', 'delete']),
        orgId: uuid,
        keyDateId: uuid.optional(),
        input: z.record(z.string(), z.unknown()).optional(),
        patch: z.record(z.string(), z.unknown()).optional(),
      },
      makeHandler('manage_key_dates', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'search_catalog',
      registryDescription('search_catalog'),
      {
        search: z.string().optional(),
        itemType: z.enum(['hardware', 'software', 'service']).optional(),
        isBundle: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('search_catalog', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_catalog_item',
      registryDescription('get_catalog_item'),
      {
        catalogItemId: uuid,
      },
      makeHandler('get_catalog_item', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'lookup_distributor_product',
      registryDescription('lookup_distributor_product'),
      {
        query: z.string().min(1).max(40),
      },
      makeHandler('lookup_distributor_product', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Microsoft 365 typed Graph read-query tools (Task 9) — registered as
    // standard AiTools in the shared aiTools map (aiToolsM365.ts's
    // registerM365Tools), so unlike the session-bound M365 helpdesk tools
    // below they're wired the same way as list_organizations: a plain
    // makeHandler() -> executeTool() delegation, no session/Delegant binding.
    // Only visible to the model when the organization's M365 Graph read
    // integration is configured — executeM365ReadAction (Task 8) refuses
    // otherwise, so no separate gating list is needed here.

    tool(
      'm365_query_users',
      registryDescription('m365_query_users'),
      {
        mode: z.enum(['list', 'get']),
        search: z.string().max(120).optional(),
        userIdOrUpn: z.string().min(1).max(320).optional(),
        accountEnabled: z.boolean().optional(),
        department: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        orgId: uuid.optional(),
      },
      makeHandler('m365_query_users', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'm365_query_signins',
      registryDescription('m365_query_signins'),
      {
        userPrincipalName: z.string().min(1).max(320).optional(),
        sinceHours: z.number().int().min(1).max(168).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        orgId: uuid.optional(),
      },
      makeHandler('m365_query_signins', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'm365_query_intune_devices',
      registryDescription('m365_query_intune_devices'),
      {
        mode: z.enum(['list', 'get']),
        // Named intuneDeviceId (not deviceId) — this is a foreign Microsoft
        // Graph/Intune managed-device id, unrelated to Breeze's own `devices`
        // table. See the matching comment in aiToolsM365.ts.
        intuneDeviceId: z.string().min(1).max(300).optional(),
        complianceState: z.enum(['compliant', 'noncompliant', 'inGracePeriod', 'unknown']).optional(),
        operatingSystem: z.enum(['Windows', 'macOS', 'iOS', 'Android', 'Linux']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        orgId: uuid.optional(),
      },
      makeHandler('m365_query_intune_devices', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'm365_query_groups',
      registryDescription('m365_query_groups'),
      {
        mode: z.enum(['list', 'get', 'members']),
        groupId: z.string().min(1).max(300).optional(),
        search: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        orgId: uuid.optional(),
      },
      makeHandler('m365_query_groups', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'm365_query_org',
      registryDescription('m365_query_org'),
      {
        include: z.enum(['profile', 'licenses']),
        orgId: uuid.optional(),
      },
      makeHandler('m365_query_org', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'm365_query_sites',
      registryDescription('m365_query_sites'),
      {
        mode: z.enum(['list', 'get']),
        search: z.string().max(120).optional(),
        siteId: z.string().min(1).max(300).optional(),
        orgId: uuid.optional(),
      },
      makeHandler('m365_query_sites', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Action Plan tool (for action_plan and hybrid_plan modes)
    tool(
      'propose_action_plan',
      SESSION_TOOL_DESCRIPTIONS.propose_action_plan,
      {
        title: z.string().min(1).max(255),
        steps: z.array(z.object({
          toolName: z.string(),
          input: z.record(z.string(), z.unknown()),
          reasoning: z.string().max(500),
        })).min(1).max(20),
      },
      async (args: { title: string; steps: Array<{ toolName: string; input: Record<string, unknown>; reasoning: string }> }) => {
        const session = getActiveSession?.();
        if (!session) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No active session' }) }], isError: true };
        }

        // Validate all step tool names exist
        for (const step of args.steps) {
          if (!TOOL_TIERS[step.toolName]) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool in plan: ${step.toolName}` }) }],
              isError: true,
            };
          }
        }

        // Build plan steps with indexes
        const planSteps: ActionPlanStep[] = args.steps.map((s) => ({
          toolName: s.toolName,
          input: s.input,
          reasoning: s.reasoning,
          status: 'pending' as const,
        }));

        // Canonical session org (always set) — `session.auth.orgId` is null for
        // partner-scope logins, which hard-failed every plan proposal for
        // exactly the population #3087 narrows tool execution for. Every other
        // DB write in this handler already keys off session.orgId (see
        // aiAgentSdk.ts's withDbAccessContext calls).
        const orgId = session.orgId;

        // Insert plan record
        let planId: string;
        try {
          const [row] = await withDbAccessContext(
            { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
            () =>
              db.insert(aiActionPlans).values({
                sessionId: session.breezeSessionId,
                orgId,
                status: 'pending',
                steps: planSteps,
              }).returning({ id: aiActionPlans.id })
          );
          if (!row) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to create action plan record' }) }], isError: true };
          }
          planId = row.id;
        } catch (err) {
          console.error('[AI-SDK] Failed to create action plan:', err);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to create action plan' }) }], isError: true };
        }

        // Set active plan ID on session before emitting event
        session.activePlanId = planId;

        // Emit plan_approval_required event
        session.eventBus.publish({
          type: 'plan_approval_required',
          planId,
          steps: planSteps,
        });

        // Block until user approves or rejects (10-min timeout)
        const approved = await waitForPlanApproval(planId, session);

        if (!approved) {
          session.activePlanId = null;
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              result: 'rejected',
              message: 'The action plan was rejected by the user. Ask them what changes they would like.',
            }) }],
          };
        }

        // Populate approved plan steps map on the session
        session.approvedPlanSteps.clear();
        session.currentPlanStepIndex = 0;
        for (let i = 0; i < planSteps.length; i++) {
          const step = planSteps[i]!;
          session.approvedPlanSteps.set(i, { toolName: step.toolName, input: step.input });
        }

        // Update DB status to executing
        try {
          await withDbAccessContext(
            { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
            () =>
              db.update(aiActionPlans)
                .set({ status: 'executing' })
                .where(eq(aiActionPlans.id, planId))
          );
        } catch (err) {
          console.error('[AI-SDK] Failed to update plan status to executing:', err);
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            result: 'approved',
            planId,
            stepCount: planSteps.length,
            message: 'Plan approved. Execute the steps in order now.',
          }) }],
        };
      }
    ),

    // Microsoft 365 helpdesk tools (session-aware; the customer tenant is bound
    // to the active AI session). Only advertised when the Delegant integration
    // is configured — see m365ToolDefinitions. Routed through
    // makeSessionAwareHandler so they get the SAME enforcement as every other
    // tool: onPreToolUse (TOOL_TIERS gate, guardrails, RBAC, rate limits, tier-3
    // approval) and onPostToolUse (ai_tool_executions persistence +
    // delegant_tool_call_id correlation).
    ...m365ToolDefinitions(getAuth, getActiveSession, onPreToolUse, onPostToolUse),
    // AI script authoring — behind BREEZE_AI_SCRIPT_AUTHORING_ENABLED (see the
    // factory for why registration stays unconditional but exposure does not).
    ...scriptProposalToolDefinitions(getAuth, getActiveSession, onPreToolUse, onPostToolUse),
    // Google Workspace helpdesk tools (gated on GOOGLE_WORKSPACE_ENABLED + a
    // per-org connection). Same enforcement path as every other tool.
    ...googleToolDefinitions(getAuth, getActiveSession, onPreToolUse, onPostToolUse),

    // Chat background launches are disabled pending delegated authorization design (#6086).

  ];

  return tools as SdkTool[];
}

/**
 * A-W02: the registry is the single source of truth for tool-search
 * metadata. Re-declare each tool through the SDK's public extras parameter
 * so it writes `_meta['anthropic/searchHint']` and
 * `_meta['anthropic/alwaysLoad']`. Every declaration must have a registry hint.
 */
export function attachRegistryMeta(def: SdkTool): SdkTool {
  const searchHint = getToolSearchHint(def.name);
  if (!searchHint) {
    throw new Error(`[attachRegistryMeta] no registry searchHint for tool "${def.name}"`);
  }
  return tool(def.name, def.description, def.inputSchema, def.handler, {
    annotations: def.annotations,
    searchHint,
    alwaysLoad: getToolAlwaysLoad(def.name),
  }) as SdkTool;
}

/**
 * Creates an SDK MCP server instance with all Breeze tools.
 * Auth context is fetched lazily via the getAuth thunk so all tool handlers
 * see the latest org-scoped access even when the session is reused.
 * Optional postToolUse callback fires after every tool execution for persistence/audit.
 *
 * `options.onlyTools` (F2 fix, P2-1 second live check): the SDK's
 * `allowedTools` (set by the caller on `query()`) only gates PERMISSION to
 * call a tool — it does not stop that tool's full JSON schema from being
 * sent to the model every turn. Registering the whole ~200-tool registry
 * unconditionally, as this function used to do, meant every turn of every
 * run (verdict runs included, despite being restricted to 4-5 tools by
 * `allowedTools`) paid the token cost of every tool definition — a single
 * verdict turn cost 9¢ (run `59fb933c-…`, `turn_count=1`). When
 * `onlyTools` is set, the registry `tools` array is filtered down to just
 * those bare names BEFORE `createSdkMcpServer` is called, so the SERVER
 * itself only advertises the pinned subset. `extraTools` are always
 * included regardless of `onlyTools` — they're never part of the registry
 * `tools` array (outcome tools in particular are deliberately absent from
 * `TOOL_TIERS`, see `outcomeTools.ts`), so there's nothing in `onlyTools` for
 * them to be filtered against. The name-collision guard below is unchanged:
 * it still runs against the full, unfiltered registry.
 *
 * `onlyTools` is populated only internally, from hardcoded profile
 * allowlists (see `aiAgents/runLoop.ts`'s `onlyTools` computation) — never
 * from request input — so a name in it that matches no registered tool is
 * always a programming error: a typo in the allowlist, or a tool renamed in
 * the registry without updating it. (#4447) Since every caller is internal,
 * that condition throws outside production (test/dev), so the bug is caught
 * before it ships; in production it degrades to the matched subset rather
 * than failing a live run, but logs via `console.error` and Sentry-captures
 * (event code `ai_agent_onlytools_unknown_name`) so it does not vanish the
 * way the old silent `.filter()` did. The Sentry capture is best-effort, not
 * guaranteed delivery: on a self-hosted install with no `SENTRY_DSN`,
 * `captureMessage` is a documented no-op (see `sentry.ts`) and the
 * `console.error` line is the only surviving signal — an operator has to be
 * watching API logs, not a Sentry inbox, to catch it there.
 */
export function createBreezeMcpServer(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
  getActiveSession?: () => ActiveSession,
  extraTools: SdkTool[] = [],
  options?: { onlyTools?: ReadonlySet<string> },
) {
  const tools = buildBreezeSdkTools(getAuth, onPreToolUse, onPostToolUse, getActiveSession);

  // extraTools (e.g. headless-run outcome tools like submit_alert_verdict) are
  // never in the TOOL_TIERS registry — that's what keeps them off the chat/MCP
  // surface (see outcomeTools.ts). A name collision here would mean an outcome
  // tool shadowing a real registered tool, which must never happen silently.
  // Checked against the ORIGINAL (unwrapped) names/array — wrapping never
  // changes `.name`.
  for (const extra of extraTools) {
    if (Object.prototype.hasOwnProperty.call(TOOL_TIERS, extra.name)) {
      throw new Error(`[createBreezeMcpServer] extra tool collides with registry: ${extra.name}`);
    }
  }
  // Every extra tool is wrapped so onPreToolUse/onPostToolUse fire for it —
  // see wrapExtraToolWithHooks's own docstring for why this is required, not
  // optional plumbing.
  const wrappedExtraTools = extraTools.map((extra) => wrapExtraToolWithHooks(extra, onPreToolUse, onPostToolUse));

  // F2 fix: filter the registry down to the pinned subset BEFORE
  // createSdkMcpServer, so those ~200 definitions never ride along on a
  // verdict run's turns. See this function's docstring for the full
  // rationale. Applied AFTER the collision guard above, which must still
  // see the full, unfiltered registry.
  const registeredTools = options?.onlyTools
    ? tools.filter((t) => options.onlyTools!.has(t.name))
    : tools;

  // #4447: a name in onlyTools that matches no registered tool used to be
  // dropped here with no signal at all. See this function's docstring for
  // why every caller being internal means this is always a bug, not a
  // runtime condition, and for the throw/log-and-capture split below.
  if (options?.onlyTools) {
    const matchedNames = new Set(registeredTools.map((t) => t.name));
    const unknownNames = [...options.onlyTools].filter((name) => !matchedNames.has(name));
    if (unknownNames.length > 0) {
      const allNames = tools.map((t) => t.name);
      const detail = unknownNames
        .map((name) => {
          const nearest = nearestToolNames(name, allNames);
          return `"${name}" (nearest: ${nearest.length > 0 ? nearest.join(', ') : 'no close match'})`;
        })
        .join('; ');
      const message = `[createBreezeMcpServer] onlyTools referenced unknown tool name(s): ${detail}`;
      if (process.env.NODE_ENV !== 'production') {
        throw new Error(message);
      }
      console.error(message);
      captureMessage('onlyTools referenced unknown tool name(s)', {
        eventCode: 'ai_agent_onlytools_unknown_name',
        level: 'error',
      });
    }
  }

  return createSdkMcpServer({
    name: 'breeze',
    version: '1.0.0',
    tools: [...registeredTools.map(attachRegistryMeta), ...wrappedExtraTools],
  });
}
