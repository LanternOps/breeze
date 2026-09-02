/**
 * AI Guardrails Service
 *
 * Tiered permission system for AI tool execution:
 * - Tier 1: Auto-execute (read-only tools)
 * - Tier 2: Auto-execute + audit (low-risk mutations)
 * - Tier 3: Requires user approval (destructive/mutating operations)
 * - Tier 4: Blocked (auth/user/role modifications, cross-org access)
 *
 * Also enforces RBAC permission checks and per-tool rate limiting.
 */

import type { AiApprovalScope } from '@breeze/shared/types/ai';
import type { AiAgentMode, AiAgentProtectedResources } from '@breeze/shared';
import { getToolTier } from './aiTools';
import { getUserPermissions, hasPermission } from './permissions';
import { rateLimiter } from './rate-limit';
import { getRedis } from './redis';
import { isSecretBearingTool } from './actionIntents/secretBearingTools';
import type { AuthContext } from '../middleware/auth';
import { envFlag } from '../config/env';
import { resolveActOperation } from './aiAgents/actManifest';
import { getCachedAiKillStateSnapshot } from './aiKillState';

type AiToolTier = 1 | 2 | 3 | 4;

// Tools that are always blocked (Tier 4)
export const BLOCKED_TOOLS: ReadonlySet<string> = new Set<string>([
  // No tools are explicitly blocked at the tool level —
  // cross-org access is enforced by orgCondition in each handler
]);

// Sub-operation discriminator key per tool. Most action-multiplexed tools
// carry their sub-operation in `action`; execute_command multiplexes on
// `commandType` (#3088) — that string selects the agent-side command handler,
// so it is a real dispatch discriminator, not a heuristic over command text.
// The TIER1/2/3_ACTIONS tables are indexed by the value found under this key.
// Exported for the tier-parity contract tests (aiGuardrailsTierParity.shared.ts).
export const TOOL_ACTION_INPUT_KEYS: Record<string, string> = {
  execute_command: 'commandType',
};

// Actions that are Tier 2 (auto-execute + audit):
//   manage_alerts: acknowledge/resolve/suppress are low-risk mutations
//   manage_services: list is a read downgraded from the tool's base Tier 3
// Exported for contract tests only (tier-table disjointness + the web
// tierConfig.ts parity guard, issue #2686). Not part of the runtime API —
// resolution always goes through checkGuardrails().
export const TIER2_ACTIONS: Record<string, string[]> = {
  manage_alerts: ['acknowledge', 'resolve', 'suppress'],
  manage_tickets: [
    'create',
    'comment',
    'assign',
    'update_status',
    'update_fields',
    'link_alert',
    'unlink_alert',
    'create_from_alert',
    'edit_comment',
    'delete_comment',
    // Time-tracking downgraded from Tier 3 (2026-07-20): starting/stopping a
    // timer or logging time is org-internal bookkeeping, consistent with
    // create/comment above. move_org stays Tier 3 (tenant-shape mutation).
    'log_time_entry',
    'start_timer',
    'stop_timer',
    // P2-4 (#4191) ticket triage: same family as update_fields — low-risk,
    // ticket-scoped mutations an autonomous triage run makes. link_device
    // only sets a currently-null device_id (never overwrites); draft only
    // writes an internal ticket_drafts row, never a customer-visible comment.
    'link_device',
    'draft'
  ],
  manage_services: ['list'],
  // SR5-01 partial relaxation (2026-07-20): directory LISTING is recon-only —
  // filenames leak far less than contents — so it auto-executes with audit.
  // file READ stays Tier 3 below: the agent runs as root/LocalSystem and an
  // unapproved read can exfiltrate any file's contents.
  file_operations: ['list'],
  // #3088 approval-fatigue fix (2026-08-04): read-only execute_command
  // commandTypes are non-mutating device reads and auto-execute with audit,
  // consistent with their sibling tools (manage_processes list is Tier 1,
  // manage_services list and file_operations list are Tier 2). This is an
  // explicit conservative allowlist keyed on commandType (the agent-side
  // handler discriminator — see TOOL_ACTION_INPUT_KEYS above); anything not
  // listed here, including an unknown or missing commandType, stays at the
  // tool's base Tier 3.
  //
  // Deliberately NOT downgraded, despite being nominally "read" operations:
  //   - file_read: arbitrary-file exfiltration off a root/LocalSystem agent
  //     (same SR5-01 rationale as file_operations read).
  //   - kill_process, start/stop/restart_service: mutating.
  //   - list_services: agent/internal/remote/tools/services_{windows,linux}.go
  //     populates ServiceInfo.Path from the service's full binary path/command
  //     line (config.BinaryPathName / ExecStart), only length-truncated, never
  //     credential-redacted. Legacy and third-party services routinely embed
  //     secrets there (e.g. `-p <password>`, DB connection strings) — same
  //     exfiltration class as file_read.
  //   - event_logs_query: logName is a free-form, caller-controlled string
  //     with no denylist excluding Security — combined with the raw, unredacted
  //     Message field (agent/internal/remote/tools/eventlogs_windows.go), a
  //     Security-log query can surface a mistyped password landing in a 4625
  //     failed-logon Account Name, or any credential/PII another app logged.
  // Both would let an AI actor pull that content into its context with zero
  // human review under auto_approve session mode.
  execute_command: [
    'event_logs_list',
    'file_list',
    'list_processes',
  ],
  // Fleet tools — Tier 2 actions (auto-execute + audit)
  manage_configuration_policy: ['activate', 'deactivate'],
  manage_deployments: ['pause', 'resume'],
  // scan downgraded from Tier 3 (2026-07-20): discovery, not mutation —
  // consistent with approve/decline/defer here. install/rollback stay Tier 3.
  manage_patches: ['approve', 'decline', 'defer', 'bulk_approve', 'scan'],
  manage_groups: ['add_devices', 'remove_devices'],
  // manage_maintenance_windows mutations disabled — managed via configuration policies
  manage_automations: ['enable', 'disable'],
  // manage_alert_rules mutations disabled — managed via configuration policies
  // manage_service_monitors mutations disabled — managed via configuration policies
  generate_report: ['create', 'update', 'delete', 'generate'],
  // Policy prerequisite tools — Tier 2 create/update actions.
  //
  // #3552 (2026-08-14): manage_update_rings, manage_software_policies and
  // manage_peripheral_policies were REMOVED from this list and escalated to
  // Tier 3 in TIER3_ACTIONS below — their create/update payloads ARM
  // unattended enforcement/remediation on the fleet. The two backup tools stay
  // here deliberately; see the note in TIER3_ACTIONS for the full rationale.
  manage_backup_configs: ['create', 'update'],
  manage_backup_profiles: ['create', 'update', 'delete'],
  // Notification channel & saved filter tools — Tier 2 actions
  manage_notification_channels: ['test', 'create', 'update', 'delete'],
  manage_saved_filters: ['create', 'delete'],
};

// #3130: Tier-2 entries that are strictly READ-ONLY. Tier 2 as a whole means
// "low-risk mutations + audit", so the per_step approval mode still prompts
// for it — but a verified read has nothing to confirm, and prompting per list
// call is exactly the approval-fatigue scenario #3088 measured (25 prompts in
// 35 minutes). Entries here keep Tier 2 — and its ai_tool_executions
// audit-ledger row; they are deliberately NOT demoted to Tier 1, which never
// writes one (recon reads stay in the audit trail, SR5-01 precedent) — but
// auto-execute under every session approval mode. A paused session still
// prompts (aiAgentSdk.ts gates on !isPaused).
//
// CONTRACT (enforced by aiGuardrails.readonly.contract.test.ts): every pair
// here must also be in TIER2_ACTIONS, and must be a pure read — no state
// change on the device, the org, or any external system. When in doubt an
// entry does not belong here; leaving a read out only costs one lightweight
// prompt.
export const TIER2_READONLY_ACTIONS: Record<string, string[]> = {
  execute_command: ['event_logs_list', 'file_list', 'list_processes'],
  file_operations: ['list'],
  manage_services: ['list'],
};

// #3130 companion for whole tools: base-Tier-2 tools whose EVERY operation is
// a read — single-purpose get/list/search tools with no action multiplexing
// and no TIER3_ACTIONS escalation (both enforced by the contract test). Same
// semantics as TIER2_READONLY_ACTIONS: keep the Tier-2 audit row, skip the
// per-step prompt.
export const TIER2_READONLY_TOOLS = new Set<string>([
  'get_catalog_item',
  'get_contract',
  'get_invoice',
  'get_quote',
  'list_contracts',
  'list_invoices',
  'list_quotes',
  'lookup_distributor_product',
  'search_catalog',
]);

// Actions that downgrade to Tier 1 (auto-execute, no approval) even if the tool's base tier is higher
// Exported for contract tests only — see the note on TIER2_ACTIONS.
export const TIER1_ACTIONS: Record<string, string[]> = {
  security_scan: ['vulnerabilities'],
  manage_tags: ['list'],
};

// Mutations that require approval (Tier 3) even if the tool is registered as Tier 1
// Exported for contract tests only — see the note on TIER2_ACTIONS.
export const TIER3_ACTIONS: Record<string, string[]> = {
  // SR5-01: filesystem READ is privileged. The endpoint agent runs as
  // root/LocalSystem and does not restrict reads to an approved root, so an
  // unapproved read can exfiltrate any file (/etc/shadow, SAM hive, SSH keys).
  // Require interactive approval (Tier 3) for read, same as the mutations.
  // `list` was deliberately downgraded to Tier 2 (2026-07-20) — recon-only.
  file_operations: ['read', 'write', 'delete', 'mkdir', 'rename'],
  manage_services: ['start', 'stop', 'restart'],
  security_scan: ['quarantine', 'remove', 'restore'],
  disk_cleanup: ['execute'],
  manage_startup_items: ['disable', 'enable'],
  manage_scheduled_tasks: ['run', 'disable', 'enable'],
  // Fleet tools — Tier 3 actions (require user approval)
  manage_configuration_policy: ['create', 'update', 'delete'],
  manage_deployments: ['create', 'start', 'cancel'],
  // setup_auto_approval added #3552: it arms unattended patch approval +
  // reboot policy, the same class as manage_update_rings.autoApprove below.
  // Its handler is hard-disabled today (aiToolsFleet.ts returns "managed
  // through configuration policies"), so the gate costs no live workflow —
  // it is here so re-enabling the handler cannot silently reopen the hole.
  manage_patches: ['install', 'rollback', 'setup_auto_approval'],
  manage_groups: ['create', 'update', 'delete'],
  manage_automations: ['run'],
  manage_processes: ['kill'],
  manage_policy_feature_link: ['remove'],
  registry_operations: ['set_value', 'create_key', 'delete_key'],
  // Policy prerequisite tools (#3552) — the standalone feature policies that
  // manage_configuration_policy links via featurePolicyId. These were Tier 2
  // (auto-execute + audit, no approval) while the configuration policy that
  // consumes them, and their singular-named siblings that write the SAME
  // tables, are Tier 3:
  //
  //   manage_software_policies   ~ manage_software_policy   (aiToolsCompliance.ts, base tier 3)
  //   manage_peripheral_policies ~ manage_peripheral_policy (aiToolsPeripherals.ts, base tier 3)
  //   manage_update_rings        ~ manage_patches:install   (Tier 3 above)
  //
  // The tier gap was the reachable one: the prereq tools are the ones listed
  // in aiAgentSdkTools' TOOL_TIERS, so they — not the Tier-3 singulars — are
  // what chat/MCP actually calls. Each create/update payload ARMS unattended
  // action on real endpoints with no human in the loop:
  //   - software policies: `enforceMode` + `remediationOptions.autoUninstall`
  //     turn a detect-only allowlist into fleet-wide auto-uninstall (the #3381
  //     mass-uninstall failure mode).
  //   - update rings: `autoApprove` + `deadlineDays` + `gracePeriodHours` arm
  //     unattended patch installs with FORCED reboots — the standing-rule form
  //     of manage_patches:install, which already requires approval.
  //   - peripheral policies: `action_type: block | read_only` cuts off USB /
  //     Bluetooth / Thunderbolt access across the target scope.
  //
  // `list`/`get` are deliberately NOT listed: the tools keep base tier 1, so
  // reads still auto-execute with no prompt. Only the mutations escalate.
  //
  // Deliberately NOT escalated (judgment calls, left at Tier 2, #3552):
  //   - manage_backup_configs / manage_backup_profiles. They change storage
  //     destinations, credentials, retention and selection sets — real, but
  //     PROTECTIVE scheduling rather than enforcement or remediation: no
  //     payload there causes an agent to uninstall, block, or reboot anything.
  //     Escalating them is defensible under a broader "any live linked policy
  //     change needs approval" rule; that is a separate product decision.
  manage_update_rings: ['create', 'update'],
  manage_software_policies: ['create', 'update'],
  manage_peripheral_policies: ['create', 'update'],
  // Backup & DR — Tier 3 actions (require user approval)
  manage_dr_plan: ['delete_group'],
  manage_hyperv_checkpoints: ['delete', 'apply'],
  // Monitoring tools — Tier 3 actions (require user approval)
  manage_monitors: ['create', 'update', 'delete'],
  // Ticketing — move_org is a tenant-shape mutation and requires approval.
  // log_time_entry/start_timer/stop_timer downgraded to Tier 2 (2026-07-20).
  manage_tickets: ['move_org'],
  manage_invoices: ['issue', 'void', 'record_payment', 'void_payment'],
  manage_contracts: ['activate', 'pause', 'resume', 'cancel'],
  manage_quotes: ['send'],
  // Org lifecycle (issue #2366) — tenant-shape mutations require approval.
  // add_contact (#3258) writes customer PII (a first-class contact record),
  // so it escalates too, even though it reshapes no tenant boundary.
  // update_org's approval SCOPE (not its tier) is input-aware — see
  // resolveApprovalScope's override hook below.
  manage_organizations: ['create_org', 'update_org', 'create_site', 'add_contact'],
  // s1_threat_action is registered at base Tier 3 (see TIER3_FOUR_EYES_TOOLS /
  // TIER3_SUPERVISED_TOOLS below for its whole-tool catch-all), but its
  // `action` enum (kill/quarantine/rollback) is a real dispatch discriminator
  // — same shape as manage_services/security_scan above — so it is split here
  // too: rollback (containment RELEASE) is four_eyes, kill/quarantine
  // (containment/mitigation) are supervised. See spec §3.2.
  s1_threat_action: ['kill', 'quarantine', 'rollback'],
};

// Spec 2026-08-05 §3: within tier 3, `four_eyes` requires a SECOND human
// (approvals:decide holder other than the requester); everything else is
// `supervised` — the requesting human approves their own AI action with a
// plain click, gated on their existing RBAC.
//
// THE FAIL-SAFE IS PER-TOOL, NOT PER-ACTION. resolveApprovalScope's final
// `return 'four_eyes'` is only reached by a tool that is in NEITHER whole-tool
// set — an unknown/extension tool. A tool that IS in TIER3_SUPERVISED_TOOLS
// short-circuits on the whole-tool lookup, so an action of that tool which is
// listed in no *_ACTIONS table falls through to `supervised` — the WEAKER
// scope, not the fail-safe. Tools in the supervised whole-tool set must
// therefore enumerate every action they accept; the contract test
// ("action-multiplexed tools in a whole-tool scope set enumerate every
// action") enforces that against the tools' real action enums, so a new enum
// member fails CI instead of silently self-approving.
//
// Three classification mechanisms, together covering the full tier-3 surface:
//   1. Per-action pairs drawn from TIER3_ACTIONS above (TIER3_*_ACTIONS).
//   2. Whole registered tools whose BASE tier is 3 (TIER3_*_TOOLS) — this
//      covers pure whole-tool surfaces (execute_command) AND the catch-all
//      for action-multiplexed base-Tier-3 tools whose action falls outside
//      every TIER1/2/3_ACTIONS table (e.g. security_scan 'scan'/'status',
//      which are not itself in TIER3_ACTIONS). A tool can legitimately
//      appear in both an *_ACTIONS table and the complementary whole-tool
//      set (manage_services, security_scan, s1_threat_action).
//   3. Input-aware overrides in resolveApprovalScope, for tool/action pairs
//      whose scope depends on ARGUMENT CONTENT, not just the tool/action
//      name — manage_organizations:update_org (status present vs a plain
//      rename) and s1_isolate_device (boolean `isolate`, not an `action`
//      string, so it can't even be an action-classified pair). These are
//      deliberately NOT listed in the static tables above; they are
//      exempted from the "classified in exactly one static table" contract
//      test via TIER3_INPUT_AWARE_ACTIONS / TIER3_INPUT_AWARE_TOOLS below
//      and instead get dedicated both-branches tests.
//
// See docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md §3.2
// for the full classification rationale.
export const TIER3_FOUR_EYES_ACTIONS: Record<string, string[]> = {
  // Financial / externally binding. `void` is not named in spec §3.2's
  // bullet list, but TOOL_PERMISSIONS maps it to the same `invoices:send`
  // RBAC action as issue/record_payment/void_payment — voiding an issued
  // invoice is the same externally-binding class, so it is classified
  // alongside them (see task report "concerns").
  manage_invoices: ['issue', 'void', 'record_payment', 'void_payment'],
  manage_contracts: ['activate', 'cancel'],
  manage_quotes: ['send'],
  // update_org is deliberately ABSENT here: its scope is input-aware (a
  // `status` change is four_eyes, a plain rename is supervised) and is
  // resolved by resolveApprovalScope's override hook, not this static table.
  // See TIER3_INPUT_AWARE_ACTIONS.
  manage_organizations: ['create_org'],
  manage_tickets: ['move_org'],
  // Destroys or rewinds state.
  manage_hyperv_checkpoints: ['delete', 'apply'],
  manage_patches: ['rollback'],
  // Containment RELEASE: threat rollback reverses a prior mitigation. kill/
  // quarantine are protective mitigation and stay supervised (same rationale
  // as s1_isolate_device isolate — urgent protective action must not wait).
  s1_threat_action: ['rollback'],
};

export const TIER3_FOUR_EYES_TOOLS = new Set<string>([
  // Restore / DR execution — "destroys or rewinds state": these overwrite or
  // replace live state from a prior snapshot.
  'restore_snapshot', 'restore_as_vm', 'instant_boot_vm',
  'restore_mssql_database', 'restore_hyperv_vm', 'restore_c2c_items',
  'execute_dr_plan',
  // Surveillance-grade / unattended access.
  'computer_control', 'create_remote_session',
  // Tenant destruction.
  'delete_tenant',
  // Identity / account control — M365 (helpdesk tools; dispatch outside the
  // headless registry via makeSessionAwareHandler, but still carry a real
  // tier via m365ToolTiers).
  'm365_disable_user', 'm365_reset_password',
  // Identity / account control — Google Workspace. Every mutating Google tool
  // acts on a human identity/mailbox/account, not a device, so the whole
  // mutating surface is classified four_eyes (categorical reading of spec
  // §3.2's "these act on human identities, not devices"; only a subset of
  // these — password/2SV reset, forwarding/delegates, offboarding/disable,
  // device wipe — is named explicitly in the design doc. See task report
  // "concerns" for the borderline members: restore_user, signout,
  // set_vacation, update_user, share_calendar, move_ou, rename_user,
  // add/remove_from_group, assign/remove_license).
  'google_reset_password', 'google_reset_2sv',
  'google_set_forwarding', 'google_disable_forwarding',
  'google_add_mail_delegate', 'google_remove_mail_delegate',
  'google_suspend_user', 'google_offboard_user', 'google_wipe_mobile_device',
  'google_restore_user', 'google_signout', 'google_set_vacation',
  'google_update_user', 'google_share_calendar', 'google_move_ou',
  'google_rename_user', 'google_add_to_group', 'google_remove_from_group',
  'google_assign_license', 'google_remove_license',
  // s1_threat_action whole-tool catch-all: every enum value is covered by
  // TIER3_FOUR_EYES_ACTIONS/TIER3_SUPERVISED_ACTIONS above, so this only
  // matters if the action is missing/unrecognized — fail-safe.
  's1_threat_action',
  // PAM elevation grant: rule auto-approve can grant elevated device access
  // with no further human review (see TOOL_PERMISSIONS comment on
  // request_elevation above). Not named in spec §3.2; classified four_eyes
  // out of caution — flagged in the task report "concerns".
  'request_elevation',
]);

export const TIER3_SUPERVISED_ACTIONS: Record<string, string[]> = {
  // complement of TIER3_FOUR_EYES_ACTIONS within TIER3_ACTIONS.
  file_operations: ['read', 'write', 'delete', 'mkdir', 'rename'],
  manage_services: ['start', 'stop', 'restart'],
  // `scan`/`status` are NOT in TIER3_ACTIONS — they need no tier escalation,
  // security_scan's BASE tier is already 3. They are listed here anyway
  // because security_scan is also in TIER3_SUPERVISED_TOOLS: without an
  // explicit entry they would reach `supervised` via the whole-tool
  // short-circuit rather than by a decision, which is exactly the fall-through
  // the enumeration contract test exists to forbid. (`vulnerabilities` is
  // classified in TIER1_ACTIONS and never reaches tier 3 at all.)
  security_scan: ['quarantine', 'remove', 'restore', 'scan', 'status'],
  disk_cleanup: ['execute'],
  manage_startup_items: ['disable', 'enable'],
  manage_scheduled_tasks: ['run', 'disable', 'enable'],
  manage_configuration_policy: ['create', 'update', 'delete'],
  manage_deployments: ['create', 'start', 'cancel'],
  manage_patches: ['install', 'setup_auto_approval'],
  manage_groups: ['create', 'update', 'delete'],
  manage_automations: ['run'],
  manage_processes: ['kill'],
  manage_policy_feature_link: ['remove'],
  registry_operations: ['set_value', 'create_key', 'delete_key'],
  // #3552 policy-prerequisite escalations. `supervised`, matching the
  // configuration policy they link into (manage_configuration_policy
  // create/update/delete above), the Tier-3 singular siblings in
  // TIER3_SUPERVISED_TOOLS below, and manage_patches:install. Spec §3.2
  // reserves four_eyes for externally-binding, identity, and
  // destroy/rewind actions; arming a policy is none of those, and
  // blast-radius-based escalation is explicitly deferred in the design doc.
  manage_update_rings: ['create', 'update'],
  manage_software_policies: ['create', 'update'],
  manage_peripheral_policies: ['create', 'update'],
  manage_dr_plan: ['delete_group'],
  manage_monitors: ['create', 'update', 'delete'],
  manage_contracts: ['pause', 'resume'],
  // create_site adds a location within an existing org, not a new tenant —
  // spec §3.2's tenant-shape bullet names only create_org/update_org.
  // add_contact (#3258) writes customer PII but is neither externally-binding
  // nor identity/destroy-class, so it stays supervised alongside create_site
  // rather than four_eyes — see spec §5.
  manage_organizations: ['create_site', 'add_contact'],
  s1_threat_action: ['kill', 'quarantine'],
};

export const TIER3_SUPERVISED_TOOLS = new Set<string>([
  // The customer's "regular work on a PC" (spec §3.2's explicit supervised list).
  'execute_command', 'run_script',
  // s1_isolate_device is deliberately ABSENT here: its boolean `isolate`
  // discriminator cannot be action-classified (spec §3.1), so its scope is
  // resolved by resolveApprovalScope's override hook instead of this static
  // set. See TIER3_INPUT_AWARE_TOOLS.
  // Whole-tool BACKSTOP complementing their _ACTIONS entries above — NOT the
  // effective classifier. Every action these three accept is enumerated in a
  // TIER1/TIER2/TIER3_*_ACTIONS table, enforced by the enumeration contract
  // test; membership here only matters for a missing/unrecognized action.
  // Reaching `supervised` here for a REAL action means someone added an enum
  // member without classifying it, and the contract test fails.
  'manage_services', 'security_scan',
  'manage_startup_items',
  'take_screenshot', 'analyze_screen',
  'apply_cis_remediation', 'manage_hyperv_vm', 'manage_peripheral_policy',
  'manage_software_policy', 'manage_browser_policy',
  'network_discovery', 'remediate_sensitive_data',
  'remediate_software_violation', 'remediate_vulnerability',
  'execute_playbook', 'execute_containment',
  // Backup triggers / agent maintenance — spec §3.2's explicit supervised list
  // ("backup triggers, ... agent upgrades").
  'trigger_backup', 'trigger_hyperv_backup', 'trigger_mssql_backup',
  'trigger_agent_upgrade', 'trigger_agent_restart',
]);

/**
 * Tier-3 (tool, action) pairs whose approval scope is resolved from INPUT
 * content by resolveApprovalScope's override hooks, not a static lookup in
 * TIER3_FOUR_EYES_ACTIONS / TIER3_SUPERVISED_ACTIONS. Exists purely so
 * aiGuardrails.approvalScope.contract.test.ts can exempt these pairs from the
 * "classified in exactly one static table" invariant — each one instead has
 * its own dedicated both-branches test.
 */
export const TIER3_INPUT_AWARE_ACTIONS: ReadonlySet<string> = new Set<string>([
  'manage_organizations:update_org',
]);

/**
 * Whole-tool counterpart of TIER3_INPUT_AWARE_ACTIONS — base-tier-3 tools
 * whose scope is resolved from input content rather than TIER3_FOUR_EYES_TOOLS
 * / TIER3_SUPERVISED_TOOLS membership (e.g. s1_isolate_device's boolean
 * `isolate`, which has no `action` string to key a per-action pair on).
 */
export const TIER3_INPUT_AWARE_TOOLS: ReadonlySet<string> = new Set<string>([
  's1_isolate_device',
]);

export function resolveApprovalScope(
  toolName: string,
  action: string | undefined,
  input: Record<string, unknown>,
): AiApprovalScope {
  // Input-aware overrides (spec §3.1) — scope depends on argument CONTENT,
  // not just the tool/action name, so these cannot live in the static
  // TIER3_*_ACTIONS / TIER3_*_TOOLS tables above. Checked first since neither
  // pair is (or should be) also listed in a static table.
  if (toolName === 'manage_organizations' && action === 'update_org') {
    // A status change (suspend/churn/reactivate) severs or restores agent
    // tenant access — externally binding, same class as the other
    // TIER3_FOUR_EYES_ACTIONS members — vs a plain name edit, which is inert.
    return 'status' in input ? 'four_eyes' : 'supervised';
  }
  if (toolName === 's1_isolate_device') {
    // isolate:false is containment RELEASE (reverses a prior mitigation —
    // same rationale as s1_threat_action's rollback); isolate:true or
    // missing is urgent protective containment, which must not wait on a
    // second approver.
    return input.isolate === false ? 'four_eyes' : 'supervised';
  }
  if (action && TIER3_FOUR_EYES_ACTIONS[toolName]?.includes(action)) return 'four_eyes';
  if (action && TIER3_SUPERVISED_ACTIONS[toolName]?.includes(action)) return 'supervised';
  if (TIER3_FOUR_EYES_TOOLS.has(toolName)) return 'four_eyes';
  // NOTE: this whole-tool line is reached by an action-multiplexed tool whose
  // action matched neither *_ACTIONS table — it yields the WEAKER scope, so it
  // is a backstop, not a fail-safe. The enumeration contract test keeps every
  // real action of these tools out of this line.
  if (TIER3_SUPERVISED_TOOLS.has(toolName)) return 'supervised';
  // Fail-safe for an unclassified TOOL — including extension tools, which are
  // per-tenant/dynamic and therefore excluded from getAllRegisteredToolNames()
  // by design, so they can never be enumerated into the static sets above.
  return 'four_eyes';
}

// RBAC permission map: tool → { resource, action } (or action-based overrides)
export const TOOL_PERMISSIONS: Record<string, { resource: string; action: string } | Record<string, { resource: string; action: string }>> = {
  query_devices: { resource: 'devices', action: 'read' },
  get_device_details: { resource: 'devices', action: 'read' },
  get_vulnerability_report: { resource: 'devices', action: 'read' },
  get_device_vulnerabilities: { resource: 'devices', action: 'read' },
  remediate_vulnerability: { resource: 'patches', action: 'execute' },
  analyze_metrics: { resource: 'devices', action: 'read' },
  get_s1_status: { resource: 'organizations', action: 'read' },
  get_s1_threats: { resource: 'devices', action: 'read' },
  s1_isolate_device: { resource: 'devices', action: 'execute' },
  s1_threat_action: { resource: 'devices', action: 'execute' },
  execute_command: { resource: 'devices', action: 'execute' },
  run_script: { resource: 'scripts', action: 'execute' },
  manage_alerts: {
    list: { resource: 'alerts', action: 'read' },
    get: { resource: 'alerts', action: 'read' },
    acknowledge: { resource: 'alerts', action: 'acknowledge' },
    resolve: { resource: 'alerts', action: 'write' },
    suppress: { resource: 'alerts', action: 'write' },
  },
  manage_tickets: {
    list: { resource: 'tickets', action: 'read' },
    get: { resource: 'tickets', action: 'read' },
    create: { resource: 'tickets', action: 'write' },
    comment: { resource: 'tickets', action: 'write' },
    assign: { resource: 'tickets', action: 'write' },
    update_status: { resource: 'tickets', action: 'write' },
    update_fields: { resource: 'tickets', action: 'write' },
    link_alert: { resource: 'tickets', action: 'write' },
    unlink_alert: { resource: 'tickets', action: 'write' },
    create_from_alert: { resource: 'tickets', action: 'write' },
    edit_comment: { resource: 'tickets', action: 'write' },
    delete_comment: { resource: 'tickets', action: 'write' },
    move_org: { resource: 'tickets', action: 'write' },
    log_time_entry: { resource: 'time_entries', action: 'write' },
    start_timer: { resource: 'time_entries', action: 'write' },
    stop_timer: { resource: 'time_entries', action: 'write' },
    // P2-4 (#4191): deliberately 'update', not 'write' — no seeded role
    // grants `tickets:update` (seed.ts only ever grants tickets:read/write/
    // manage), so this fails CLOSED for `checkToolPermission`'s interactive
    // path. link_device/draft are agent-only ticket-triage executors, never
    // reachable from a live chat/MCP session; the only path that can execute
    // them is the ai_agent-principal release path, which never consults RBAC
    // at all (`checkAgentGuardrails`'s doc comment). A future human-facing
    // caller of these two actions needs a real permission grant added first.
    link_device: { resource: 'tickets', action: 'update' },
    draft: { resource: 'tickets', action: 'update' },
  },
  list_invoices: { resource: 'invoices', action: 'read' },
  get_invoice: { resource: 'invoices', action: 'read' },
  manage_invoices: {
    create_draft: { resource: 'invoices', action: 'write' },
    add_manual_line: { resource: 'invoices', action: 'write' },
    add_catalog_line: { resource: 'invoices', action: 'write' },
    add_bundle_line: { resource: 'invoices', action: 'write' },
    add_contract_line: { resource: 'invoices', action: 'write' },
    update_line: { resource: 'invoices', action: 'write' },
    remove_line: { resource: 'invoices', action: 'write' },
    update_header: { resource: 'invoices', action: 'write' },
    delete_draft: { resource: 'invoices', action: 'write' },
    assemble_from_org: { resource: 'invoices', action: 'write' },
    assemble_from_ticket: { resource: 'invoices', action: 'write' },
    issue: { resource: 'invoices', action: 'send' },
    void: { resource: 'invoices', action: 'send' },
    record_payment: { resource: 'invoices', action: 'send' },
    void_payment: { resource: 'invoices', action: 'send' },
    create_pay_link: { resource: 'invoices', action: 'write' },
  },
  search_catalog: { resource: 'catalog', action: 'read' },
  get_catalog_item: { resource: 'catalog', action: 'read' },
  lookup_distributor_product: { resource: 'catalog', action: 'read' },
  manage_catalog: {
    create_item: { resource: 'catalog', action: 'write' },
    update_item: { resource: 'catalog', action: 'write' },
    archive_item: { resource: 'catalog', action: 'write' },
    set_org_price: { resource: 'catalog', action: 'write' },
    remove_org_price: { resource: 'catalog', action: 'write' },
    set_bundle_components: { resource: 'catalog', action: 'write' },
  },
  list_contracts: { resource: 'contracts', action: 'read' },
  get_contract: { resource: 'contracts', action: 'read' },
  manage_contracts: {
    create_draft: { resource: 'contracts', action: 'write' },
    update: { resource: 'contracts', action: 'write' },
    delete_draft: { resource: 'contracts', action: 'write' },
    add_line: { resource: 'contracts', action: 'write' },
    remove_line: { resource: 'contracts', action: 'write' },
    activate: { resource: 'contracts', action: 'manage' },
    pause: { resource: 'contracts', action: 'manage' },
    resume: { resource: 'contracts', action: 'manage' },
    cancel: { resource: 'contracts', action: 'manage' },
  },
  list_quotes: { resource: 'quotes', action: 'read' },
  get_quote: { resource: 'quotes', action: 'read' },
  manage_quotes: {
    create_draft: { resource: 'quotes', action: 'write' },
    update: { resource: 'quotes', action: 'write' },
    delete_draft: { resource: 'quotes', action: 'write' },
    add_block: { resource: 'quotes', action: 'write' },
    update_block: { resource: 'quotes', action: 'write' },
    delete_block: { resource: 'quotes', action: 'write' },
    reorder_blocks: { resource: 'quotes', action: 'write' },
    add_manual_line: { resource: 'quotes', action: 'write' },
    add_catalog_line: { resource: 'quotes', action: 'write' },
    update_line: { resource: 'quotes', action: 'write' },
    remove_line: { resource: 'quotes', action: 'write' },
    move_line: { resource: 'quotes', action: 'write' },
    reorder_lines: { resource: 'quotes', action: 'write' },
    send: { resource: 'quotes', action: 'send' },
    decline: { resource: 'quotes', action: 'write' },
    create_pay_link: { resource: 'quotes', action: 'write' },
  },
  list_organizations: { resource: 'organizations', action: 'read' },
  manage_organizations: {
    create_org: { resource: 'organizations', action: 'write' },
    update_org: { resource: 'organizations', action: 'write' },
    create_site: { resource: 'sites', action: 'write' },
    add_contact: { resource: 'organizations', action: 'write' },
  },
  manage_services: { resource: 'devices', action: 'execute' },
  manage_processes: {
    list: { resource: 'devices', action: 'read' },
    kill: { resource: 'devices', action: 'execute' },
  },
  security_scan: {
    scan: { resource: 'devices', action: 'execute' },
    status: { resource: 'devices', action: 'execute' },
    quarantine: { resource: 'devices', action: 'execute' },
    remove: { resource: 'devices', action: 'execute' },
    restore: { resource: 'devices', action: 'execute' },
    vulnerabilities: { resource: 'devices', action: 'read' },
  },
  analyze_disk_usage: { resource: 'devices', action: 'read' },
  disk_cleanup: {
    preview: { resource: 'devices', action: 'read' },
    execute: { resource: 'devices', action: 'execute' },
  },
  file_operations: {
    // SR5-01: read/list require devices.execute (not devices.read). Reading an
    // arbitrary file off a root/LocalSystem agent is a privileged operation.
    list: { resource: 'devices', action: 'execute' },
    read: { resource: 'devices', action: 'execute' },
    write: { resource: 'devices', action: 'execute' },
    delete: { resource: 'devices', action: 'execute' },
    mkdir: { resource: 'devices', action: 'execute' },
    rename: { resource: 'devices', action: 'execute' },
  },
  query_audit_log: { resource: 'audit', action: 'read' },
  query_change_log: { resource: 'devices', action: 'read' },
  network_discovery: { resource: 'devices', action: 'execute' },
  analyze_boot_performance: { resource: 'devices', action: 'read' },
  manage_startup_items: { resource: 'devices', action: 'execute' },
  manage_scheduled_tasks: {
    list: { resource: 'devices', action: 'read' },
    run: { resource: 'devices', action: 'execute' },
    disable: { resource: 'devices', action: 'execute' },
    enable: { resource: 'devices', action: 'execute' },
  },
  take_screenshot: { resource: 'devices', action: 'execute' },
  analyze_screen: { resource: 'devices', action: 'execute' },
  computer_control: { resource: 'devices', action: 'execute' },
  // Fleet tools — RBAC mappings
  manage_deployments: {
    list: { resource: 'deployments', action: 'read' },
    get: { resource: 'deployments', action: 'read' },
    device_status: { resource: 'deployments', action: 'read' },
    create: { resource: 'deployments', action: 'write' },
    start: { resource: 'deployments', action: 'write' },
    pause: { resource: 'deployments', action: 'write' },
    resume: { resource: 'deployments', action: 'write' },
    cancel: { resource: 'deployments', action: 'write' },
  },
  manage_patches: {
    list: { resource: 'patches', action: 'read' },
    compliance: { resource: 'patches', action: 'read' },
    scan: { resource: 'patches', action: 'execute' },
    approve: { resource: 'patches', action: 'approve' },
    decline: { resource: 'patches', action: 'approve' },
    defer: { resource: 'patches', action: 'approve' },
    bulk_approve: { resource: 'patches', action: 'approve' },
    install: { resource: 'patches', action: 'execute' },
    rollback: { resource: 'patches', action: 'execute' },
    setup_auto_approval: { resource: 'patches', action: 'approve' },
  },
  manage_groups: {
    list: { resource: 'groups', action: 'read' },
    get: { resource: 'groups', action: 'read' },
    preview: { resource: 'groups', action: 'read' },
    membership_log: { resource: 'groups', action: 'read' },
    create: { resource: 'groups', action: 'write' },
    update: { resource: 'groups', action: 'write' },
    delete: { resource: 'groups', action: 'write' },
    add_devices: { resource: 'groups', action: 'write' },
    remove_devices: { resource: 'groups', action: 'write' },
  },
  manage_maintenance_windows: {
    list: { resource: 'maintenance', action: 'read' },
    get: { resource: 'maintenance', action: 'read' },
    active_now: { resource: 'maintenance', action: 'read' },
    create: { resource: 'maintenance', action: 'write' },
    update: { resource: 'maintenance', action: 'write' },
    delete: { resource: 'maintenance', action: 'write' },
  },
  manage_automations: {
    list: { resource: 'automations', action: 'read' },
    get: { resource: 'automations', action: 'read' },
    history: { resource: 'automations', action: 'read' },
    create: { resource: 'automations', action: 'write' },
    update: { resource: 'automations', action: 'write' },
    delete: { resource: 'automations', action: 'write' },
    enable: { resource: 'automations', action: 'write' },
    disable: { resource: 'automations', action: 'write' },
    run: { resource: 'automations', action: 'execute' },
  },
  manage_alert_rules: {
    list_templates: { resource: 'alerts', action: 'read' },
    list_rules: { resource: 'alerts', action: 'read' },
    get_rule: { resource: 'alerts', action: 'read' },
    create_rule: { resource: 'alerts', action: 'write' },
    update_rule: { resource: 'alerts', action: 'write' },
    delete_rule: { resource: 'alerts', action: 'write' },
    test_rule: { resource: 'alerts', action: 'read' },
    list_channels: { resource: 'alerts', action: 'read' },
    alert_summary: { resource: 'alerts', action: 'read' },
  },
  manage_service_monitors: {
    list: { resource: 'monitoring', action: 'read' },
  },
  generate_report: {
    list: { resource: 'reports', action: 'read' },
    generate: { resource: 'reports', action: 'write' },
    data: { resource: 'reports', action: 'read' },
    create: { resource: 'reports', action: 'write' },
    update: { resource: 'reports', action: 'write' },
    delete: { resource: 'reports', action: 'write' },
    history: { resource: 'reports', action: 'read' },
    download: { resource: 'reports', action: 'read' },
  },
  // Analytics tools
  query_analytics: { resource: 'devices', action: 'read' },
  get_executive_summary: { resource: 'devices', action: 'read' },
  // Brain device context tools
  get_device_context: { resource: 'devices', action: 'read' },
  set_device_context: { resource: 'devices', action: 'write' },
  resolve_device_context: { resource: 'devices', action: 'write' },
  // Agent log tools
  search_agent_logs: { resource: 'devices', action: 'read' },
  set_agent_log_level: { resource: 'devices', action: 'execute' },
  capture_agent_pprof: { resource: 'devices', action: 'execute' },
  // Event log tools
  search_logs: { resource: 'devices', action: 'read' },
  get_log_trends: { resource: 'devices', action: 'read' },
  detect_log_correlations: { resource: 'devices', action: 'read' },
  // Configuration policy tools
  list_configuration_policies: { resource: 'policies', action: 'read' },
  get_configuration_policy: { resource: 'policies', action: 'read' },
  manage_configuration_policy: {
    create: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
    activate: { resource: 'policies', action: 'write' },
    deactivate: { resource: 'policies', action: 'write' },
    delete: { resource: 'policies', action: 'write' },
  },
  configuration_policy_compliance: {
    summary: { resource: 'policies', action: 'read' },
    status: { resource: 'policies', action: 'read' },
  },
  get_effective_configuration: { resource: 'devices', action: 'read' },
  preview_configuration_change: { resource: 'devices', action: 'read' },
  manage_policy_feature_link: {
    list: { resource: 'policies', action: 'read' },
    add: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
    remove: { resource: 'policies', action: 'write' },
  },
  manage_backup_profiles: {
    list: { resource: 'policies', action: 'read' },
    get: { resource: 'policies', action: 'read' },
    create: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
    delete: { resource: 'policies', action: 'write' },
  },
  apply_configuration_policy: { resource: 'policies', action: 'write' },
  remove_configuration_policy_assignment: { resource: 'policies', action: 'write' },
  // Playbook tools
  list_playbooks: { resource: 'devices', action: 'read' },
  execute_playbook: { resource: 'devices', action: 'execute' },
  get_playbook_history: { resource: 'devices', action: 'read' },
  // Security + reliability read tools
  get_security_posture: { resource: 'devices', action: 'read' },
  get_fleet_health: { resource: 'devices', action: 'read' },
  get_fleet_status: { resource: 'devices', action: 'read' },
  // Fleet hygiene findings (Task 8) — read-only, mirrors the
  // GET /fleet/findings route's requireFindingsRead (DEVICES_READ) gate.
  get_fleet_findings: { resource: 'devices', action: 'read' },
  analyze_fleet_metrics: { resource: 'devices', action: 'read' },
  // Tenant lifecycle (tier 3 destructive, typed-confirmation gated in handler).
  // Written as `organizations:write` so any partner admin with org write access
  // can call it; the handler additionally enforces tenant_id == auth.partnerId.
  delete_tenant: { resource: 'organizations', action: 'write' },
  // Tags, custom fields, and registry tools
  manage_tags: {
    list: { resource: 'devices', action: 'read' },
    add: { resource: 'devices', action: 'write' },
    remove: { resource: 'devices', action: 'write' },
  },
  query_custom_fields: { resource: 'devices', action: 'read' },
  registry_operations: {
    read_key: { resource: 'devices', action: 'read' },
    get_value: { resource: 'devices', action: 'read' },
    set_value: { resource: 'devices', action: 'execute' },
    create_key: { resource: 'devices', action: 'execute' },
    delete_key: { resource: 'devices', action: 'execute' },
  },
  // Documentation tools
  search_documentation: { resource: 'general', action: 'read' },
  // Script library tools
  search_script_library: { resource: 'scripts', action: 'read' },
  list_scripts: { resource: 'scripts', action: 'read' },
  get_script_details: { resource: 'scripts', action: 'read' },
  list_script_templates: { resource: 'scripts', action: 'read' },
  get_script_execution_history: { resource: 'scripts', action: 'read' },
  get_script_execution: { resource: 'scripts', action: 'read' },
  // Backup & DR tools
  query_backups: { resource: 'devices', action: 'read' },
  get_backup_status: { resource: 'devices', action: 'read' },
  browse_snapshots: { resource: 'devices', action: 'read' },
  trigger_backup: { resource: 'devices', action: 'execute' },
  restore_snapshot: { resource: 'devices', action: 'execute' },
  restore_as_vm: { resource: 'devices', action: 'execute' },
  instant_boot_vm: { resource: 'devices', action: 'execute' },
  get_vm_restore_estimate: { resource: 'devices', action: 'read' },
  query_mssql_instances: { resource: 'devices', action: 'read' },
  get_mssql_backup_status: { resource: 'devices', action: 'read' },
  trigger_mssql_backup: { resource: 'devices', action: 'execute' },
  restore_mssql_database: { resource: 'devices', action: 'execute' },
  verify_mssql_backup: { resource: 'devices', action: 'execute' },
  query_hyperv_vms: { resource: 'devices', action: 'read' },
  get_hyperv_vm_details: { resource: 'devices', action: 'read' },
  manage_hyperv_vm: { resource: 'devices', action: 'execute' },
  trigger_hyperv_backup: { resource: 'devices', action: 'execute' },
  restore_hyperv_vm: { resource: 'devices', action: 'execute' },
  manage_hyperv_checkpoints: { resource: 'devices', action: 'execute' },
  query_vaults: { resource: 'devices', action: 'read' },
  get_vault_status: { resource: 'devices', action: 'read' },
  trigger_vault_sync: { resource: 'devices', action: 'execute' },
  configure_vault: { resource: 'devices', action: 'write' },
  m365_query_users: { resource: 'organizations', action: 'read' },
  m365_query_signins: { resource: 'organizations', action: 'read' },
  m365_query_intune_devices: { resource: 'organizations', action: 'read' },
  m365_query_groups: { resource: 'organizations', action: 'read' },
  m365_query_org: { resource: 'organizations', action: 'read' },
  m365_query_sites: { resource: 'organizations', action: 'read' },
  query_c2c_connections: { resource: 'organizations', action: 'read' },
  query_c2c_jobs: { resource: 'organizations', action: 'read' },
  search_c2c_items: { resource: 'organizations', action: 'read' },
  trigger_c2c_sync: { resource: 'organizations', action: 'write' },
  restore_c2c_items: { resource: 'organizations', action: 'write' },
  query_backup_sla: { resource: 'organizations', action: 'read' },
  get_sla_breaches: { resource: 'organizations', action: 'read' },
  get_sla_compliance_report: { resource: 'organizations', action: 'read' },
  configure_backup_sla: { resource: 'organizations', action: 'write' },
  query_dr_plans: { resource: 'organizations', action: 'read' },
  get_dr_plan_details: { resource: 'organizations', action: 'read' },
  get_dr_execution_status: { resource: 'organizations', action: 'read' },
  execute_dr_plan: { resource: 'devices', action: 'execute' },
  manage_dr_plan: { resource: 'organizations', action: 'write' },
  // Monitoring tools — RBAC mappings
  query_monitors: { resource: 'devices', action: 'read' },
  manage_monitors: {
    get: { resource: 'devices', action: 'read' },
    create: { resource: 'devices', action: 'write' },
    update: { resource: 'devices', action: 'write' },
    delete: { resource: 'devices', action: 'write' },
  },
  get_service_monitoring_status: { resource: 'devices', action: 'read' },
  // Integration & webhook tools
  query_webhooks: { resource: 'devices', action: 'read' },
  query_psa_status: { resource: 'devices', action: 'read' },
  test_webhook: { resource: 'devices', action: 'write' },
  // Agent version & remote session tools
  query_agent_versions: { resource: 'devices', action: 'read' },
  trigger_agent_upgrade: { resource: 'devices', action: 'execute' },
  trigger_agent_restart: { resource: 'devices', action: 'execute' },
  list_remote_sessions: { resource: 'devices', action: 'read' },
  create_remote_session: { resource: 'devices', action: 'execute' },
  // Compliance policy tools
  query_compliance_policies: { resource: 'policies', action: 'read' },
  get_compliance_status: { resource: 'policies', action: 'read' },
  // Notification channel tools
  manage_notification_channels: {
    list: { resource: 'alerts', action: 'read' },
    test: { resource: 'alerts', action: 'write' },
    create: { resource: 'alerts', action: 'write' },
    update: { resource: 'alerts', action: 'write' },
    delete: { resource: 'alerts', action: 'write' },
  },
  // Saved filter tools
  manage_saved_filters: {
    list: { resource: 'devices', action: 'read' },
    get: { resource: 'devices', action: 'read' },
    create: { resource: 'devices', action: 'write' },
    delete: { resource: 'devices', action: 'write' },
  },
  // CIS hardening tools
  get_cis_compliance: { resource: 'devices', action: 'read' },
  get_cis_device_report: { resource: 'devices', action: 'read' },
  apply_cis_remediation: { resource: 'devices', action: 'execute' },
  get_huntress_status: { resource: 'devices', action: 'read' },
  get_huntress_incidents: { resource: 'devices', action: 'read' },
  sync_huntress_data: { resource: 'organizations', action: 'write' },
  // User risk scoring tools
  get_user_risk_scores: { resource: 'users', action: 'read' },
  get_user_risk_detail: { resource: 'users', action: 'read' },
  assign_security_training: { resource: 'users', action: 'write' },
  get_backup_health: { resource: 'devices', action: 'read' },
  run_backup_verification: { resource: 'devices', action: 'execute' },
  get_recovery_readiness: { resource: 'devices', action: 'read' },
  // M365 helpdesk tools (Delegant-backed)
  m365_lookup_user: { resource: 'm365', action: 'read' },
  m365_recent_signins: { resource: 'm365', action: 'read' },
  m365_list_group_memberships: { resource: 'm365', action: 'read' },
  m365_disable_user: { resource: 'm365', action: 'execute' },
  m365_reset_password: { resource: 'm365', action: 'execute' },
  // Google Workspace helpdesk tools (DWD service-account-backed)
  google_lookup_user: { resource: 'google', action: 'read' },
  google_reset_password: { resource: 'google', action: 'execute' },
  google_suspend_user: { resource: 'google', action: 'execute' },
  google_restore_user: { resource: 'google', action: 'execute' },
  google_signout: { resource: 'google', action: 'execute' },
  google_set_forwarding: { resource: 'google', action: 'execute' },
  google_disable_forwarding: { resource: 'google', action: 'execute' },
  google_set_vacation: { resource: 'google', action: 'execute' },
  google_update_user: { resource: 'google', action: 'execute' },
  google_share_calendar: { resource: 'google', action: 'execute' },
  google_offboard_user: { resource: 'google', action: 'execute' },
  google_wipe_mobile_device: { resource: 'google', action: 'execute' },
  google_security_drift: { resource: 'google', action: 'read' },
  google_email_report: { resource: 'google', action: 'read' },
  google_list_user_groups: { resource: 'google', action: 'read' },
  google_add_to_group: { resource: 'google', action: 'execute' },
  google_remove_from_group: { resource: 'google', action: 'execute' },
  google_move_ou: { resource: 'google', action: 'execute' },
  google_rename_user: { resource: 'google', action: 'execute' },
  google_reset_2sv: { resource: 'google', action: 'execute' },
  google_add_mail_delegate: { resource: 'google', action: 'execute' },
  google_remove_mail_delegate: { resource: 'google', action: 'execute' },
  google_list_licenses: { resource: 'google', action: 'read' },
  google_assign_license: { resource: 'google', action: 'execute' },
  google_remove_license: { resource: 'google', action: 'execute' },

  // Bootstrap authTools (MCP-OAUTH-11). These dispatch outside the main aiTools
  // registry (see mcpServer.ts dispatchBootstrapAuthTool) but MUST still carry a
  // product-RBAC mapping — enforced regardless of MCP_REQUIRE_EXECUTE_ADMIN. A
  // registry-parity test (aiGuardrails.bootstrapParity.test.ts) fails if a future
  // bootstrap tool omits an entry here. configure_defaults touches three product
  // surfaces (device groups, alert rules, notification channels), so its extra
  // permissions live in TOOL_EXTRA_PERMISSIONS below.
  send_deployment_invites: { resource: 'devices', action: 'write' },
  configure_defaults: { resource: 'organizations', action: 'write' },

  // Registration-debt payoff: RBAC entries for tools that were registered in
  // aiTools but had no TOOL_PERMISSIONS entry (legacyPermissionGaps in
  // aiToolsRegistryParity.test.ts). See that file's history for context.
  // Incidents (analogy: manage_dr_plan/sync_huntress_data org-write; get_dr_plan_details org-read)
  create_incident: { resource: 'organizations', action: 'write' },
  get_incident_timeline: { resource: 'organizations', action: 'read' },
  generate_incident_report: { resource: 'organizations', action: 'read' },
  // Device-execute (analogy: s1_isolate_device, execute_command; collect_evidence includes
  // screenshot => privileged extraction like take_screenshot)
  execute_containment: { resource: 'devices', action: 'execute' },
  collect_evidence: { resource: 'devices', action: 'execute' },

  // Policy-prereq family (analogy: manage_backup_profiles per-action map)
  manage_update_rings: {
    list: { resource: 'policies', action: 'read' },
    get: { resource: 'policies', action: 'read' },
    create: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
  },
  manage_backup_configs: {
    list: { resource: 'policies', action: 'read' },
    get: { resource: 'policies', action: 'read' },
    create: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
  },

  // Device reads (analogy: analyze_boot_performance, query_change_log)
  get_user_experience_metrics: { resource: 'devices', action: 'read' },
  get_ip_history: { resource: 'devices', action: 'read' },
  get_active_users: { resource: 'devices', action: 'read' },

  // Security visibility (analogy: get_security_posture devices:read; PAM entries mirror
  // routes/pam.ts requirePamRead/Execute)
  get_dns_security: { resource: 'devices', action: 'read' },
  manage_dns_policy: { resource: 'devices', action: 'write' },
  get_browser_security: { resource: 'devices', action: 'read' },
  manage_browser_policy: {
    list: { resource: 'devices', action: 'read' },
    create: { resource: 'devices', action: 'write' },
    update: { resource: 'devices', action: 'write' },
    apply: { resource: 'devices', action: 'execute' },   // queues real deviceCommands (parity: apply_cis_remediation)
  },
  get_sensitive_data_overview: { resource: 'devices', action: 'read' },
  remediate_sensitive_data: {
    encrypt: { resource: 'devices', action: 'execute' },
    quarantine: { resource: 'devices', action: 'execute' },
    secure_delete: { resource: 'devices', action: 'execute' },
    accept_risk: { resource: 'devices', action: 'write' },
    false_positive: { resource: 'devices', action: 'write' },
    mark_remediated: { resource: 'devices', action: 'write' },
  },
  request_elevation: { resource: 'devices', action: 'execute' },   // routes/pam.ts: respond gates on requirePamExecute; rule auto-approve makes this privilege-granting
  revoke_elevation: { resource: 'devices', action: 'execute' },    // routes/pam.ts revoke gates on requirePamExecute
  get_elevation_history: { resource: 'devices', action: 'read' },  // requirePamRead

  // Compliance / software / peripheral (analogy: query_compliance_policies policies:read;
  // manage_configuration_policy map)
  get_software_compliance: { resource: 'policies', action: 'read' },
  manage_software_policies: {
    list: { resource: 'policies', action: 'read' },
    get: { resource: 'policies', action: 'read' },
    create: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
  },
  manage_software_policy: {
    list: { resource: 'policies', action: 'read' },
    get: { resource: 'policies', action: 'read' },
    create: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
    delete: { resource: 'policies', action: 'write' },
  },
  remediate_software_violation: { resource: 'devices', action: 'execute' },  // analogy: apply_cis_remediation
  manage_peripheral_policies: {
    list: { resource: 'policies', action: 'read' },
    get: { resource: 'policies', action: 'read' },
    create: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
  },
  manage_peripheral_policy: {
    create: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
    disable: { resource: 'policies', action: 'write' },
    add_exception: { resource: 'policies', action: 'write' },
    remove_exception: { resource: 'policies', action: 'write' },
  },
  get_peripheral_activity: { resource: 'devices', action: 'read' },

  // Network (mirror backing REST routes: networkChanges.ts uses devices:read + alerts:acknowledge;
  // networkBaselines.ts uses devices:write)
  get_network_changes: { resource: 'devices', action: 'read' },
  acknowledge_network_device: { resource: 'alerts', action: 'acknowledge' },
  configure_network_baseline: { resource: 'devices', action: 'write' },
};

const TOOL_EXTRA_PERMISSIONS: Record<string, { resource: string; action: string }[]> = {
  // configure_defaults (MCP-OAUTH-11): primary organizations.write in
  // TOOL_PERMISSIONS, plus these — it also creates a default device group and a
  // baseline alert policy, so require devices.write AND alerts.write.
  configure_defaults: [
    { resource: 'devices', action: 'write' },
    { resource: 'alerts', action: 'write' },
  ],
  restore_snapshot: [{ resource: 'backup', action: 'read' }],
  restore_as_vm: [{ resource: 'backup', action: 'read' }],
  instant_boot_vm: [{ resource: 'backup', action: 'read' }],
  restore_mssql_database: [{ resource: 'backup', action: 'read' }],
  verify_mssql_backup: [{ resource: 'backup', action: 'read' }],
  restore_hyperv_vm: [{ resource: 'backup', action: 'read' }],
};

// Per-tool rate limits: { limit, windowSeconds }
const TOOL_RATE_LIMITS: Record<string, { limit: number; windowSeconds: number }> = {
  execute_command: { limit: 10, windowSeconds: 300 },
  run_script: { limit: 5, windowSeconds: 300 },
  security_scan: { limit: 3, windowSeconds: 600 },
  network_discovery: { limit: 2, windowSeconds: 600 },
  file_operations: { limit: 20, windowSeconds: 300 },
  manage_services: { limit: 10, windowSeconds: 300 },
  s1_isolate_device: { limit: 5, windowSeconds: 600 },
  s1_threat_action: { limit: 5, windowSeconds: 600 },
  analyze_disk_usage: { limit: 10, windowSeconds: 300 },
  disk_cleanup: { limit: 3, windowSeconds: 600 },
  manage_startup_items: { limit: 5, windowSeconds: 600 },
  manage_scheduled_tasks: { limit: 10, windowSeconds: 300 },
  take_screenshot: { limit: 10, windowSeconds: 300 },
  analyze_screen: { limit: 10, windowSeconds: 300 },
  computer_control: { limit: 20, windowSeconds: 300 },
  run_backup_verification: { limit: 10, windowSeconds: 300 },
  // Fleet tools — per-tool rate limits
  manage_deployments: { limit: 10, windowSeconds: 600 },
  manage_patches: { limit: 15, windowSeconds: 300 },
  manage_groups: { limit: 20, windowSeconds: 300 },
  manage_maintenance_windows: { limit: 15, windowSeconds: 300 },
  manage_automations: { limit: 10, windowSeconds: 600 },
  manage_alert_rules: { limit: 15, windowSeconds: 300 },
  manage_service_monitors: { limit: 15, windowSeconds: 300 },
  generate_report: { limit: 10, windowSeconds: 300 },
  // Brain device context tools
  set_device_context: { limit: 20, windowSeconds: 300 },
  resolve_device_context: { limit: 20, windowSeconds: 300 },
  // Event log tools
  search_logs: { limit: 30, windowSeconds: 300 },
  get_log_trends: { limit: 20, windowSeconds: 300 },
  detect_log_correlations: { limit: 10, windowSeconds: 300 },
  // Agent log tools
  set_agent_log_level: { limit: 5, windowSeconds: 600 },
  capture_agent_pprof: { limit: 3, windowSeconds: 600 },
  // Configuration policy tools
  get_configuration_policy: { limit: 30, windowSeconds: 300 },
  manage_configuration_policy: { limit: 20, windowSeconds: 300 },
  configuration_policy_compliance: { limit: 30, windowSeconds: 300 },
  apply_configuration_policy: { limit: 10, windowSeconds: 300 },
  remove_configuration_policy_assignment: { limit: 10, windowSeconds: 300 },
  // Playbook tools
  execute_playbook: { limit: 5, windowSeconds: 600 },
  manage_processes: { limit: 15, windowSeconds: 300 },
  // Tags and registry tools
  manage_tags: { limit: 20, windowSeconds: 300 },
  registry_operations: { limit: 15, windowSeconds: 300 },
  // Backup tools
  trigger_backup: { limit: 5, windowSeconds: 600 },
  restore_snapshot: { limit: 3, windowSeconds: 600 },
  restore_as_vm: { limit: 3, windowSeconds: 900 },
  instant_boot_vm: { limit: 3, windowSeconds: 900 },
  trigger_mssql_backup: { limit: 5, windowSeconds: 600 },
  restore_mssql_database: { limit: 3, windowSeconds: 900 },
  verify_mssql_backup: { limit: 5, windowSeconds: 600 },
  manage_hyperv_vm: { limit: 10, windowSeconds: 300 },
  trigger_hyperv_backup: { limit: 5, windowSeconds: 900 },
  restore_hyperv_vm: { limit: 3, windowSeconds: 900 },
  manage_hyperv_checkpoints: { limit: 5, windowSeconds: 600 },
  trigger_vault_sync: { limit: 10, windowSeconds: 600 },
  configure_vault: { limit: 10, windowSeconds: 300 },
  trigger_c2c_sync: { limit: 10, windowSeconds: 300 },
  restore_c2c_items: { limit: 5, windowSeconds: 600 },
  configure_backup_sla: { limit: 10, windowSeconds: 300 },
  execute_dr_plan: { limit: 3, windowSeconds: 900 },
  manage_dr_plan: { limit: 10, windowSeconds: 300 },
  // Monitoring tools
  query_monitors: { limit: 30, windowSeconds: 300 },
  manage_monitors: { limit: 10, windowSeconds: 300 },
  get_service_monitoring_status: { limit: 30, windowSeconds: 300 },
  // Integration & webhook tools
  test_webhook: { limit: 5, windowSeconds: 300 },
  // Agent version & remote session tools
  trigger_agent_upgrade: { limit: 5, windowSeconds: 600 },
  trigger_agent_restart: { limit: 5, windowSeconds: 600 },
  create_remote_session: { limit: 10, windowSeconds: 300 },
  // Notification channel & saved filter tools
  manage_notification_channels: { limit: 10, windowSeconds: 300 },
  manage_saved_filters: { limit: 15, windowSeconds: 300 },
  // CIS hardening tools
  get_cis_compliance: { limit: 30, windowSeconds: 300 },
  get_cis_device_report: { limit: 30, windowSeconds: 300 },
  apply_cis_remediation: { limit: 10, windowSeconds: 600 },
  // Huntress integration tools
  sync_huntress_data: { limit: 10, windowSeconds: 300 },
  // User risk tools
  assign_security_training: { limit: 10, windowSeconds: 300 },
  // Registration-debt payoff: rate limits for newly-permissioned tools.
  execute_containment: { limit: 5, windowSeconds: 600 },       // mirrors s1_isolate_device
  collect_evidence: { limit: 10, windowSeconds: 300 },          // mirrors take_screenshot-class dispatch
  remediate_software_violation: { limit: 10, windowSeconds: 600 }, // mirrors apply_cis_remediation
};

interface GuardrailCheckCommon {
  allowed: boolean;
  requiresApproval: boolean;
  /**
   * Set (true) only for Tier-2 resolutions on the #3130 read-only allowlists
   * (TIER2_READONLY_ACTIONS / TIER2_READONLY_TOOLS): eligible to auto-execute
   * — with the Tier-2 audit-ledger row — even under per_step approval mode.
   */
  readOnly?: boolean;
  reason?: string;
  description?: string;
}

/**
 * Discriminated on `tier` so "tier 3 ⇒ approvalScope is set" is a TYPE
 * invariant rather than prose. A new tier-3 return path that forgets the field
 * fails to compile; previously it silently produced an over-strict intent
 * (four_eyes deadline + digest pinning + a second approver) for an action that
 * was meant to be a plain supervised click — nothing errored, the feature just
 * quietly didn't work for that tool.
 *
 * `approvalScope?: undefined` on the non-3 arm keeps `check.approvalScope`
 * readable without narrowing (it widens to `AiApprovalScope | undefined`), so
 * existing consumers — including intentService.ts's `?? 'four_eyes'`
 * belt-and-braces default — are unaffected.
 */
export type GuardrailCheck =
  | (GuardrailCheckCommon & {
      tier: Exclude<AiToolTier, 3>;
      /** Never set off tier 3 — tier 4 is blocked outright, tiers 1-2 auto-execute. */
      approvalScope?: undefined;
    })
  | (GuardrailCheckCommon & {
      tier: 3;
      /**
       * REQUIRED on tier 3. `supervised` — the requester approves their own AI
       * action; `four_eyes` — a second `approvals:decide` holder must decide.
       * See docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md.
       */
      approvalScope: AiApprovalScope;
    });

/**
 * `'act'` (wave 4 Part B): a manifest-matched, rule-equivalent mutation under
 * a live `mode: 'act'` policy. Distinct from `'allow'` — `'act'` additionally
 * signals the run-loop pre-hook to revalidate (live policy + guardrail
 * re-run + device/asset pinning) and reserve a `maxActionsPerRun` slot before
 * dispatch (actRevalidation.ts, Task 3); `'allow'` never does either.
 */
export type GuardrailDisposition = 'allow' | 'propose' | 'deny' | 'act';

/**
 * checkAgentGuardrails' verdict. `allowed` stays false for 'propose' on
 * purpose: a consumer that only reads `allowed` (every pre-3b consumer)
 * fails CLOSED rather than executing a proposal.
 */
export type AgentGuardrailCheck = GuardrailCheck & { disposition: GuardrailDisposition };

/**
 * The sub-operation discriminator for a tool call, resolved EXACTLY the way
 * `checkGuardrails` and `checkAgentGuardrails` each used to do inline (two
 * byte-identical copies, now one). `TOOL_ACTION_INPUT_KEYS` overrides the
 * default `action` key for a multiplexer keyed on something else
 * (`execute_command`'s `commandType`, #3088). A non-string value at that key
 * resolves to `undefined`, not a coerced string — callers fall back to
 * whatever "no action" means for them (checkGuardrails: the tool's base
 * tier; checkAgentGuardrails: a hard deny on a multiplexed tool;
 * policyDecide.ts: no `tool:action` key, so a bare-tool registry lookup).
 *
 * Exported so `policyDecide.ts`'s canonical-key derivation reuses this
 * instead of a third inline copy (wave 5 Part B, #3827).
 */
export function resolveActionForTool(toolName: string, input: Record<string, unknown>): string | undefined {
  const actionKey = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
  const actionValue = input[actionKey];
  return typeof actionValue === 'string' ? actionValue : undefined;
}

/**
 * Check guardrails for a tool invocation.
 * Returns the effective tier and whether approval is needed.
 */
export function checkGuardrails(
  toolName: string,
  input: Record<string, unknown>
): GuardrailCheck {
  // Tier 4: Blocked
  if (BLOCKED_TOOLS.has(toolName)) {
    return {
      tier: 4,
      allowed: false,
      requiresApproval: false,
      reason: `Tool "${toolName}" is not available`
    };
  }

  const baseTier = getToolTier(toolName);
  if (baseTier === undefined) {
    return {
      tier: 4,
      allowed: false,
      requiresApproval: false,
      reason: `Unknown tool: ${toolName}`
    };
  }

  // Check for action-based tier escalation. Non-string values resolve to
  // undefined, which falls through to the base tier (fail-closed).
  const action = resolveActionForTool(toolName, input);

  // Tier 1 downgrade: read-only actions on otherwise-high-tier tools
  if (action && TIER1_ACTIONS[toolName]?.includes(action)) {
    return {
      tier: 1,
      allowed: true,
      requiresApproval: false,
      description: buildApprovalDescription(toolName, action, input)
    };
  }

  if (action && TIER3_ACTIONS[toolName]?.includes(action)) {
    return {
      tier: 3,
      allowed: true,
      requiresApproval: true,
      approvalScope: resolveApprovalScope(toolName, action, input),
      description: buildApprovalDescription(toolName, action, input)
    };
  }

  if (action && TIER2_ACTIONS[toolName]?.includes(action)) {
    return {
      tier: 2,
      allowed: true,
      requiresApproval: false,
      ...(TIER2_READONLY_ACTIONS[toolName]?.includes(action) ? { readOnly: true } : {}),
      description: buildApprovalDescription(toolName, action, input)
    };
  }

  // Use base tier from tool registration. Split by literal tier (rather than
  // `baseTier >= 3` with a conditional spread) so the tier-3 arm's REQUIRED
  // approvalScope is enforced by the compiler — see GuardrailCheck.
  if (baseTier === 3) {
    return {
      tier: 3,
      allowed: true,
      requiresApproval: true,
      approvalScope: resolveApprovalScope(toolName, action, input),
      description: buildApprovalDescription(toolName, action, input)
    };
  }

  if (baseTier === 4) {
    // Only tier 3 gets a scope — a base-Tier-4 tool has no approval path at
    // all, not a bigger approval scope.
    return {
      tier: 4,
      allowed: true,
      requiresApproval: true,
      description: buildApprovalDescription(toolName, action, input)
    };
  }

  return {
    tier: baseTier,
    allowed: true,
    requiresApproval: false,
    ...(baseTier === 2 && TIER2_READONLY_TOOLS.has(toolName) ? { readOnly: true } : {}),
    description: buildApprovalDescription(toolName, action, input)
  };
}

export interface AgentGuardrailPolicy {
  /**
   * Both carried, both enforced here. The resolver computes them, but returning
   * a snapshot makes enforcement advisory — the gate must be able to deny a
   * disabled or propose-only agent on its own.
   */
  enabled: boolean;
  mode: AiAgentMode;
  toolAllowlist: string[];
  protectedResources: AiAgentProtectedResources;
  /** Resolved from the run device, not from caller-controlled tool input. */
  deviceSiteId?: string | null;
  /**
   * The run's device id, resolved from the run row (never from tool input).
   * null = device-less run. A device-less run skips the site gate entirely
   * (buildAgentAuthContext only pins allowedSiteIds when a device exists), so
   * mutating tools are denied outright for it — there is no site scope to
   * bound the blast radius.
   */
  deviceId: string | null;
  /**
   * P2-4 (#4191): the intent's resolved TICKET target, populated by the
   * release path (`agentReleaseAuthority.ts`'s ticket mirror of its own
   * device-target resolution, `resolveIntentTargetTicket` in
   * `intentTargetScope.ts`) — never from tool input. Ticket-triage runs are
   * device-less by construction (one run walks the ticket queue, not a
   * device fleet), so without this a mutating `manage_tickets` call would
   * always trip the device-less-mutation deny below. Deliberately NOT a
   * general "any tool with a ticket" escape hatch: only `manage_tickets`
   * itself consults it (see the deny below) — no run-profile literal
   * anywhere in this file, keyed off tool name + scope alone.
   */
  scope?: { ticketId: string };
}

const SERVICE_INPUT_KEYS = ['serviceName', 'service', 'name'];
const PATH_INPUT_KEYS = [
  'path', 'filePath', 'source', 'destination', 'directory',
  // Swept from the real tool schemas — each of these carries a filesystem path
  // and every one of them was unprotected.
  'newPath', 'targetPath', 'selectedPaths', 'paths', 'filePaths',
  'itemPath', 'quarantineDir', 'scriptPath', 'dest',
];
const REGISTRY_INPUT_KEYS = ['key', 'registryKey', 'keyPath'];
const DEVICE_TAG_INPUT_KEYS = ['deviceTag', 'tag', 'tagName'];
const DEVICE_TAG_ARRAY_INPUT_KEYS = ['deviceTags', 'tags'];
const SITE_INPUT_KEYS = ['siteId', 'site_id', 'targetSiteId'];
const SITE_ARRAY_INPUT_KEYS = ['siteIds', 'site_ids'];

/** Tools whose real tier depends on an `action` argument. */
function isActionMultiplexedTool(toolName: string): boolean {
  return Boolean(
    TIER3_ACTIONS[toolName] ?? TIER2_ACTIONS[toolName] ?? TIER1_ACTIONS[toolName],
  );
}

function describeType(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

/**
 * Every string leaf of the input, at any depth, paired with the key it sat
 * under. A top-level key lookup missed nested parameter objects entirely —
 * `execute_command { commandType:'file_list', payload:{ path:'C:\\Windows\\...' } }`
 * dispatches the same agent command as `file_operations` but hid its path from
 * the protected-resource matcher, with no allowlist entry required.
 */
function collectStringLeaves(
  value: unknown,
  depth = 0,
  out: Array<{ key: string; value: string }> = [],
  key = '',
): Array<{ key: string; value: string }> {
  if (depth > 6 || out.length > 500) return out;
  if (typeof value === 'string') {
    out.push({ key, value });
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, depth + 1, out, key);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectStringLeaves(child, depth + 1, out, childKey);
    }
  }
  return out;
}

function leafValuesFor(input: Record<string, unknown>, keys: string[]): string[] {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  return collectStringLeaves(input)
    .filter((leaf) => wanted.has(leaf.key.toLowerCase()))
    .map((leaf) => leaf.value);
}

function inputStrings(input: Record<string, unknown>, keys: string[]): string[] {
  return keys.map((key) => input[key]).filter((value): value is string => typeof value === 'string');
}

function inputStringArrays(input: Record<string, unknown>, keys: string[]): string[] {
  return keys.flatMap((key) => {
    const value = input[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  });
}

function isWindowsStylePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') || value.includes('\\');
}

function normalizeHierarchy(value: string, separator: '\\' | '/', caseInsensitive: boolean): string {
  const separatorPattern = separator === '\\' ? /[\\/]+/g : /\/+/g;
  let normalized = value.trim().replace(separatorPattern, separator);
  while (normalized.length > 1 && normalized.endsWith(separator)) {
    normalized = normalized.slice(0, -1);
  }
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function normalizePath(value: string, separator: '\\' | '/', caseInsensitive: boolean): string {
  const normalized = normalizeHierarchy(value, separator, caseInsensitive);
  const segments: string[] = [];

  for (const segment of normalized.split(separator)) {
    if (segment === '.') continue;
    if (segment === '..' && segments.length > 0) {
      const previous = segments[segments.length - 1];
      if (previous !== undefined && previous !== '' && !previous.endsWith(':') && previous !== '..') {
        segments.pop();
        continue;
      }
    }
    segments.push(segment);
  }

  return segments.join(separator) || separator;
}

function isSameOrDescendant(candidate: string, root: string, separator: '\\' | '/'): boolean {
  return candidate === root || candidate.startsWith(root === separator ? root : `${root}${separator}`);
}

function pathIsProtected(candidate: string, protectedPath: string): boolean {
  const windowsStyle = isWindowsStylePath(candidate) || isWindowsStylePath(protectedPath);
  const separator = windowsStyle ? '\\' : '/';
  return isSameOrDescendant(
    normalizePath(candidate, separator, windowsStyle),
    normalizePath(protectedPath, separator, windowsStyle),
    separator,
  );
}

function registryKeyIsProtected(candidate: string, protectedKey: string): boolean {
  return isSameOrDescendant(
    normalizeHierarchy(candidate, '\\', true),
    normalizeHierarchy(protectedKey, '\\', true),
    '\\',
  );
}

function touchesProtected(
  input: Record<string, unknown>,
  protectedResources: AiAgentProtectedResources,
): string | null {
  for (const serviceName of leafValuesFor(input, SERVICE_INPUT_KEYS)) {
    if (protectedResources.services.some(
      (protectedService) => protectedService.toLowerCase() === serviceName.toLowerCase(),
    )) {
      return `service "${serviceName}" is protected`;
    }
  }

  for (const path of leafValuesFor(input, PATH_INPUT_KEYS)) {
    if (protectedResources.paths.some((protectedPath) => pathIsProtected(path, protectedPath))) {
      return `path "${path}" is protected`;
    }
  }

  for (const registryKey of leafValuesFor(input, REGISTRY_INPUT_KEYS)) {
    if (protectedResources.registryKeys.some(
      (protectedKey) => registryKeyIsProtected(registryKey, protectedKey),
    )) {
      return `registry key "${registryKey}" is protected`;
    }
  }

  const deviceTags = [
    ...leafValuesFor(input, DEVICE_TAG_INPUT_KEYS),
    ...leafValuesFor(input, DEVICE_TAG_ARRAY_INPUT_KEYS),
  ];
  for (const deviceTag of deviceTags) {
    // Case-insensitive, matching services/paths/registry. 'Production' vs
    // 'production' passed before.
    if (protectedResources.deviceTags.some(
      (protectedTag) => protectedTag.toLowerCase() === deviceTag.toLowerCase(),
    )) {
      return `device tag "${deviceTag}" is protected`;
    }
  }

  return null;
}

function isAgentGuardrailPolicy(
  policy: AgentGuardrailPolicy | null | undefined,
): policy is AgentGuardrailPolicy {
  if (!policy || !Array.isArray(policy.toolAllowlist)) return false;
  if (typeof policy.enabled !== 'boolean') return false;
  if (policy.deviceId !== null && typeof policy.deviceId !== 'string') return false;
  if (policy.mode !== 'off' && policy.mode !== 'shadow' && policy.mode !== 'act') return false;
  if (!policy.toolAllowlist.every((toolName) => typeof toolName === 'string')) return false;

  const resources = policy.protectedResources;
  if (!resources || typeof resources !== 'object') return false;
  return [resources.services, resources.paths, resources.registryKeys, resources.deviceTags]
    .every((values) => Array.isArray(values) && values.every((value) => typeof value === 'string'));
}

function siteScopeDenial(
  input: Record<string, unknown>,
  deviceSiteId: string | null | undefined,
): string | null {
  const selectedSiteIds: string[] = [];

  for (const key of SITE_INPUT_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== 'string') return `site selector "${key}" is invalid`;
    selectedSiteIds.push(value);
  }

  for (const key of SITE_ARRAY_INPUT_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (!Array.isArray(value) || !value.every((siteId) => typeof siteId === 'string')) {
      return `site selector "${key}" is invalid`;
    }
    selectedSiteIds.push(...value);
  }

  if (selectedSiteIds.length === 0) return null;
  if (!deviceSiteId) return 'run device site is unavailable';
  const outsideSite = selectedSiteIds.find((siteId) => siteId !== deviceSiteId);
  return outsideSite ? `site "${outsideSite}" is outside the run device site` : null;
}

/**
 * Structural guardrails for the ai_agent principal. This path intentionally
 * never consults user RBAC: an agent has no user role to authorize against.
 */
export function checkAgentGuardrails(
  toolName: string,
  input: Record<string, unknown>,
  policy: AgentGuardrailPolicy | null | undefined,
): AgentGuardrailCheck {
  const base = checkGuardrails(toolName, input);
  const deny = (reason: string): AgentGuardrailCheck =>
    ({ ...base, allowed: false, requiresApproval: false, disposition: 'deny', reason });

  // envFlag reads process.env at CALL time and shares its normalization with
  // config/env, so the two readers of this flag cannot disagree (a module-level
  // const also made the kill switch unstubbable, and therefore untestable).
  if (!envFlag('BREEZE_AI_AGENTS_ENABLED', false)) {
    return deny('Autonomous AI agents are disabled');
  }
  // Wave 5A Task 2 (#3827): DB-backed kill switch, ADDITIONAL to the env
  // flag above, not a replacement for it — the two need not agree, and
  // either alone denies. `getCachedAiKillStateSnapshot` is a pure sync read
  // of a module-level cache (see `aiKillState.ts`'s header for the ≤5s
  // staleness bound and why its default is not-killed); this function stays
  // synchronous, unable to await a fresh DB read on every dispatch, exactly
  // like the env-flag check above it.
  const killState = getCachedAiKillStateSnapshot();
  if (killState.killed) {
    return deny(`Autonomous AI agents are kill-switched (epoch ${killState.epoch})`);
  }
  if (!isAgentGuardrailPolicy(policy)) {
    return deny('AI agent run policy snapshot is missing or invalid');
  }
  if (!base.allowed || base.tier === 4 || BLOCKED_TOOLS.has(toolName)) {
    return deny(base.reason ?? `Tool "${toolName}" is not available to agents`);
  }
  if (isSecretBearingTool(toolName)) {
    return deny(`Tool "${toolName}" is secret-bearing and never available to agents`);
  }

  const siteDenial = siteScopeDenial(input, policy.deviceSiteId);
  if (siteDenial) return deny(`Denied: ${siteDenial}`);

  // An operator switching the agent off, or holding it at propose-only, must be
  // enforced HERE. The resolver computes enabled/mode but returning a snapshot
  // makes that advisory — every caller would have to remember to re-check it.
  if (policy.enabled === false) return deny('Agent is disabled');
  if (policy.mode === 'off') return deny('Agent mode is off');

  const actionKey = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
  const action = resolveActionForTool(toolName, input);

  // A non-string action (`action: ['write']`) makes checkGuardrails skip its
  // TIER3_ACTIONS escalation and fall back to the tool's REGISTERED BASE TIER —
  // which is 1 for most action-multiplexed tools. Falling back is a DOWNGRADE,
  // not a floor: it collapsed 15 mutating tools to Tier 1 and skipped the
  // allowlist entirely. An unresolvable action on a multiplexed tool denies.
  if (action === undefined && isActionMultiplexedTool(toolName)) {
    return deny(
      `Tool "${toolName}" requires a string "${actionKey}"; got ${describeType(input[actionKey])}`,
    );
  }

  const readOnly = base.tier === 1
    || (base.tier === 2 && (base.readOnly === true || TIER2_READONLY_TOOLS.has(toolName)));

  // A device-less run has no site scope (buildAgentAuthContext pins
  // allowedSiteIds only when a device exists), so a mutation from it would be
  // org-wide. Deny rather than propose: a human approving it could not see
  // what it is bounded to.
  //
  // P2-4 (#4191) exemption: a `manage_tickets` call carrying an explicit
  // ticket binding (`policy.scope.ticketId`, populated only by the release
  // path from the intent's own scope — see AgentGuardrailPolicy.scope's doc
  // comment) satisfies the same "the mutation is bounded to something a
  // human can see" requirement the device/site scope exists to prove, just
  // on the ticket axis instead of the device axis. Every other tool, and
  // every OTHER `manage_tickets` call with no ticket scope, still denies
  // exactly as before — this is not a blanket device-less carve-out.
  const ticketScoped = toolName === 'manage_tickets' && !!policy.scope?.ticketId;
  if (!readOnly && policy.deviceId === null && !ticketScoped) {
    return deny(`Tool "${toolName}" mutates and the run is not device-bound`);
  }

  const allowlisted = policy.toolAllowlist.includes(toolName)
    || (action !== undefined && policy.toolAllowlist.includes(`${toolName}:${action}`));
  if (!readOnly && !allowlisted) {
    return deny(`Tool "${toolName}"${action ? `:${action}` : ''} is not in the agent's allowlist`);
  }

  const protectedHit = touchesProtected(input, policy.protectedResources);
  if (protectedHit) return deny(`Denied: ${protectedHit}`);

  // Act mode (wave 4 Part B): a manifest-matched, rule-equivalent mutation
  // executes (through the normal tool path — the pre/post hooks in
  // runLoop.ts do the actual revalidate/reserve/verify work); everything
  // else that mutates records a proposal, exactly like shadow. This branch
  // sits AFTER the allowlist and protected checks (same placement rule as
  // shadow below), so both outcomes are only reachable for a call the agent
  // could legitimately make in the first place — every structural deny above
  // (kill switch, tier 4, secret-bearing, site scope, disabled/off, device-
  // less mutation, allowlist, protected resources) is untouched and sits
  // strictly upstream of this branch, never the reverse.
  if (policy.mode === 'act' && !readOnly) {
    const op = resolveActOperation(toolName, input);
    if (op) {
      return {
        ...base,
        allowed: true,
        requiresApproval: false,
        disposition: 'act',
        reason: `Rule-equivalent operation "${op.key}" — act mode executes with verification`,
      };
    }
    // Unmatched mutation under act: identical semantics to shadow — propose,
    // never auto-approve-and-execute. There is no "act mode but not manifest
    // -matched" execution path; the manifest IS the entire act-eligible surface.
    return {
      ...base,
      allowed: false,
      requiresApproval: false,
      disposition: 'propose',
      reason: `Tool "${toolName}" is not act-eligible; recorded as a proposal`,
    };
  }

  // Shadow proposes; it never mutates — and this branch now sits AFTER the
  // allowlist and protected checks so 'propose' is only reachable for a call
  // the agent could legitimately make. allowed:false is load-bearing (see
  // AgentGuardrailCheck).
  if (policy.mode === 'shadow' && !readOnly) {
    return {
      ...base,
      allowed: false,
      requiresApproval: false,
      disposition: 'propose',
      reason: `Tool "${toolName}" mutates; shadow mode records a proposal instead of executing`,
    };
  }

  return { ...base, disposition: 'allow' };
}

/**
 * Core role-resolution + permission-check primitive shared by checkToolPermission
 * (tools/call) and any other MCP dispatch path that needs to authorize a single
 * explicit `{ resource, action }` requirement — e.g. resources/read's
 * MCP_RESOURCE_PERMISSIONS map (MCP-OAUTH-03). Returns null if allowed, or a
 * denial reason string if not.
 *
 * Preserves the same fail-open short-circuits checkToolPermission has always
 * had: helper sessions carry a synthetic auth with no roleId, and tool/resource
 * access for those callers is governed elsewhere (the helper whitelist), not
 * user RBAC.
 */
export async function checkPermissionRequirement(
  auth: AuthContext,
  requirement: { resource: string; action: string }
): Promise<string | null> {
  return checkPermissionRequirements(auth, [requirement]);
}

/**
 * Batch variant: resolves the user's permissions ONCE and checks every
 * requirement against that single resolution, returning the first denial.
 * Use this when a caller has several requirements for the same auth context
 * (e.g. a tool's base permission plus TOOL_EXTRA_PERMISSIONS) — calling the
 * single-requirement form in a loop re-fetches getUserPermissions each time.
 */
export async function checkPermissionRequirements(
  auth: AuthContext,
  requirements: Array<{ resource: string; action: string }>
): Promise<string | null> {
  // Spec 2026-08-22 §3.2: an agent has no role; this helper's "no token ⇒
  // allowed" fallback would fail OPEN for it. Deny before anything else.
  if (auth.principal?.kind === 'ai_agent') {
    return 'AI agent principals are never granted user permissions';
  }
  if (requirements.length === 0) return null;
  if (!auth.token) {
    const described = requirements.map((r) => `${r.resource}.${r.action}`).join(', ');
    console.warn(
      `[aiGuardrails] checkPermissionRequirements called without auth.token for ${described}`
    );
    return null;
  }
  if (auth.token.roleId === null) return null;

  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
  });

  if (!userPerms) {
    return 'Insufficient permissions: no role assigned';
  }

  for (const requirement of requirements) {
    if (!hasPermission(userPerms, requirement.resource, requirement.action)) {
      return `Insufficient permissions: requires ${requirement.resource}.${requirement.action}`;
    }
  }

  return null;
}

type ToolPermissionRequirement = { resource: string; action: string };

type ToolPermissionResolution =
  | { ok: true; requirements: ToolPermissionRequirement[] }
  | { ok: false; denial: string };

function resolveToolPermissionRequirements(
  toolName: string,
  input: Record<string, unknown>,
): ToolPermissionResolution {
  const permDef = TOOL_PERMISSIONS[toolName];
  if (!permDef) {
    return { ok: false, denial: `No RBAC permission mapping for tool "${toolName}"` };
  }

  // Resolve the required permission (may be action-dependent)
  let required: ToolPermissionRequirement;
  const action = input.action as string | undefined;

  if ('resource' in permDef && 'action' in permDef) {
    required = permDef as ToolPermissionRequirement;
  } else if (action && (permDef as Record<string, ToolPermissionRequirement>)[action]) {
    required = (permDef as Record<string, ToolPermissionRequirement>)[action]!;
  } else if (action) {
    // Unknown action for a mapped tool — deny (fail-closed)
    // Include redirect hints for tools that have been replaced by policy-based management
    const redirectHints: Record<string, string> = {
      manage_service_monitors: 'To add, update, or remove monitoring watches, use manage_policy_feature_link with the existing policy\'s featureLinkId and action "update". First call get_configuration_policy to find the monitoring featureLinkId and current inlineSettings.watches array, then update it with the new watch appended.',
    };
    const hint = redirectHints[toolName];
    return {
      ok: false,
      denial: `Unknown action "${action}" for tool "${toolName}".${hint ? ` ${hint}` : ''}`,
    };
  } else {
    // Action-multiplexed tool invoked without an `action` arg — deny (fail-closed).
    // Each sub-operation has its own RBAC permission; without an action we can't
    // resolve which one applies, so allowing here would let any caller bypass
    // per-action checks. Zod schemas require `action` anyway; this is defense in depth.
    return {
      ok: false,
      denial: `Missing required "action" argument for tool "${toolName}"`,
    };
  }

  return {
    ok: true,
    requirements: [required, ...(TOOL_EXTRA_PERMISSIONS[toolName] ?? [])],
  };
}

/**
 * The RBAC requirements a HUMAN needs for this tool call. Used by wave-3b
 * approver eligibility (a human approving an agent proposal must hold what
 * they would need to do it themselves). Returns null when the tool has no
 * mapping — callers must treat null as "nobody is eligible", mirroring
 * checkToolPermission's deny.
 */
export function requiredPermissionsForTool(
  toolName: string,
  input: Record<string, unknown>,
): Array<{ resource: string; action: string }> | null {
  const resolution = resolveToolPermissionRequirements(toolName, input);
  return resolution.ok ? resolution.requirements : null;
}

/**
 * Check RBAC permissions for a tool invocation.
 * Returns null if allowed, or an error message if denied.
 */
export async function checkToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string | null> {
  // An agent has no user role, so the token-less fallback below would grant it
  // EVERY tool. This must stay the first statement: checkToolPermission
  // short-circuits before it delegates to checkPermissionRequirements, so the
  // deny there does not cover this path. (aiAgentSdk's tool loop, intent
  // release revalidation, approvals and the MCP server all enter here.)
  if (auth.principal?.kind === 'ai_agent') {
    return 'AI agent principals are never granted user permissions';
  }
  // Helper sessions use a synthetic auth with no roleId — tool access is
  // governed by the helper whitelist (helperToolFilter), not user RBAC.
  if (!auth.token) {
    console.warn(`[aiGuardrails] checkToolPermission called without auth.token for tool ${toolName}`);
    return null;
  }
  if (auth.token.roleId === null) return null;

  const resolution = resolveToolPermissionRequirements(toolName, input);
  if (!resolution.ok) return resolution.denial;

  // One getUserPermissions resolution covers the base requirement and every
  // extra permission; denials keep the same first-failure ordering as the
  // old per-requirement loop.
  return checkPermissionRequirements(auth, resolution.requirements);
}

/**
 * Check per-tool rate limits.
 * Returns null if allowed, or an error message if rate limited.
 */
export async function checkToolRateLimit(
  toolName: string,
  userId: string
): Promise<string | null> {
  const config = TOOL_RATE_LIMITS[toolName];
  if (!config) return null; // No rate limit for this tool

  const redis = getRedis();
  const key = `ai:tool:${userId}:${toolName}`;

  const result = await rateLimiter(redis, key, config.limit, config.windowSeconds);
  if (!result.allowed) {
    return `Tool rate limit exceeded for ${toolName}. Try again at ${result.resetAt.toISOString()}`;
  }

  return null;
}

/**
 * Build a human-readable description of what the tool is about to do.
 */
function buildApprovalDescription(
  toolName: string,
  action: string | undefined,
  input: Record<string, unknown>
): string {
  const parts: string[] = [];

  switch (toolName) {
    case 'execute_command':
      parts.push(`Execute "${input.commandType}" command`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'run_script':
      parts.push(`Run script ${(input.scriptId as string)?.slice(0, 8) ?? 'unknown'}...`);
      if (Array.isArray(input.deviceIds)) parts.push(`on ${input.deviceIds.length} device(s)`);
      break;

    case 'manage_services':
      parts.push(`${action?.toUpperCase()} service "${input.serviceName}"`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    // P2-4 (#4191): ticket-triage actions get real copy; every other
    // manage_tickets action (create/assign/update_status/link_alert/...)
    // falls through to the SAME generic `${toolName}: ${action}` shape the
    // top-level default produced before this case existed — no regression
    // for actions this case doesn't special-case. Deliberately NEVER
    // includes ticket subject/description/comment content — only ids,
    // hostnames, and field NAMES (never field VALUES, which is what elides
    // a categoryId's opaque uuid along with everything else).
    case 'manage_tickets': {
      const shortTicketId = typeof input.ticketId === 'string' ? `${input.ticketId.slice(0, 8)}...` : 'unknown';
      if (action === 'update_fields') {
        const fieldNames = input.fields && typeof input.fields === 'object'
          ? Object.keys(input.fields as Record<string, unknown>)
          : [];
        parts.push(`Update ticket #${shortTicketId} fields (${fieldNames.join(', ') || 'none'})`);
      } else if (action === 'link_device') {
        const target = typeof input.hostname === 'string'
          ? input.hostname
          : (typeof input.serial === 'string' ? input.serial : 'unknown device');
        parts.push(`Link device ${target} to ticket #${shortTicketId}`);
      } else if (action === 'comment') {
        parts.push(`Post private AI triage note on ticket #${shortTicketId}`);
      } else if (action === 'draft') {
        const kindLabel = input.kind === 'resolution_note' ? 'resolution note' : 'reply';
        parts.push(`Store AI ${kindLabel} draft on ticket #${shortTicketId}`);
      } else {
        parts.push(`${toolName}${action ? `: ${action}` : ''}`);
      }
      break;
    }

    case 'security_scan':
      parts.push(`Security: ${action}`);
      if (input.threatId) parts.push(`threat ${(input.threatId as string).slice(0, 8)}...`);
      break;

    case 'file_operations':
      parts.push(`File ${action}: ${input.path}`);
      break;

    case 'network_discovery':
      parts.push(`Network discovery scan`);
      if (input.subnet) parts.push(`on ${input.subnet}`);
      break;

    case 'take_screenshot':
      parts.push('Capture screenshot');
      if (input.deviceId) parts.push(`from device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'computer_control':
      parts.push(`Send input action: ${input.action}`);
      if (input.x !== undefined && input.y !== undefined) parts.push(`at (${input.x}, ${input.y})`);
      if (input.text) parts.push(`text: "${(input.text as string).slice(0, 30)}${(input.text as string).length > 30 ? '...' : ''}"`);
      if (input.key) parts.push(`key: ${input.key}`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    // Fleet tools
    case 'manage_configuration_policy':
      if (action === 'create') parts.push(`Create configuration policy "${input.name}"`);
      else if (action === 'delete') parts.push(`Delete configuration policy ${(input.policyId as string)?.slice(0, 8)}...`);
      else parts.push(`Config policy ${action}: ${(input.policyId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_deployments':
      if (action === 'create') parts.push(`Create deployment "${input.name}" (${input.targetType} target)`);
      else if (action === 'start') parts.push(`Start deployment ${(input.deploymentId as string)?.slice(0, 8)}...`);
      else if (action === 'cancel') parts.push(`Cancel deployment ${(input.deploymentId as string)?.slice(0, 8)}...`);
      else parts.push(`Deployment ${action}: ${(input.deploymentId as string)?.slice(0, 8) ?? ''}...`);
      break;

    case 'manage_patches':
      if (action === 'install') parts.push(`Install ${Array.isArray(input.patchIds) ? input.patchIds.length : 0} patch(es) on ${Array.isArray(input.deviceIds) ? input.deviceIds.length : 0} device(s)`);
      else if (action === 'scan') parts.push(`Trigger patch scan on ${Array.isArray(input.deviceIds) ? input.deviceIds.length : 0} device(s)`);
      else if (action === 'rollback') parts.push(`Rollback patch ${(input.patchId as string)?.slice(0, 8)}...`);
      else if (action === 'setup_auto_approval') parts.push(`Setup auto-approval for ${Array.isArray(input.autoApproveSeverities) ? (input.autoApproveSeverities as string[]).join(', ') : 'critical, important'} patches`);
      else parts.push(`Patch ${action}: ${(input.patchId as string)?.slice(0, 8) ?? ''}...`);
      break;

    case 'manage_groups':
      if (action === 'create') parts.push(`Create ${input.type ?? 'static'} device group "${input.name}"`);
      else if (action === 'delete') parts.push(`Delete device group ${(input.groupId as string)?.slice(0, 8)}...`);
      else parts.push(`Group ${action}: ${(input.groupId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_maintenance_windows':
      if (action === 'delete') parts.push(`Delete maintenance window ${(input.windowId as string)?.slice(0, 8)}...`);
      else parts.push(`Maintenance window ${action}: ${(input.windowId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_automations':
      if (action === 'create') parts.push(`Create automation "${input.name}"`);
      else if (action === 'delete') parts.push(`Delete automation ${(input.automationId as string)?.slice(0, 8)}...`);
      else if (action === 'run') parts.push(`Manually trigger automation ${(input.automationId as string)?.slice(0, 8)}...`);
      else parts.push(`Automation ${action}: ${(input.automationId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_alert_rules':
      if (action === 'delete_rule') parts.push(`Delete alert rule ${(input.ruleId as string)?.slice(0, 8)}...`);
      else parts.push(`Alert rule ${action}: ${(input.ruleId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_service_monitors':
      if (action === 'add') parts.push(`Add ${input.watchType} monitor "${input.displayName || input.name}"`);
      else if (action === 'remove') parts.push(`Remove monitor ${(input.watchId as string)?.slice(0, 8)}...`);
      else parts.push(`Service monitors: ${action}`);
      break;

    case 'manage_startup_items':
      parts.push(`${action?.toUpperCase()} startup item "${input.itemName}"`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      if (input.reason) parts.push(`(${(input.reason as string).slice(0, 50)})`);
      break;

    case 'set_agent_log_level':
      parts.push(`Set log level to ${input.level}`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      if (input.durationMinutes) parts.push(`for ${input.durationMinutes} minutes`);
      break;

    case 'capture_agent_pprof':
      parts.push(`Capture agent ${(input.profile as string) ?? 'all'} pprof profile(s)`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'apply_configuration_policy':
      parts.push(`Assign config policy ${(input.configPolicyId as string)?.slice(0, 8)}...`);
      parts.push(`to ${input.level} ${(input.targetId as string)?.slice(0, 8)}...`);
      break;

    case 'remove_configuration_policy_assignment':
      parts.push(`Remove config policy assignment ${(input.assignmentId as string)?.slice(0, 8)}...`);
      break;

    case 'execute_playbook': {
      parts.push('Execute self-healing playbook');
      if (input.playbookId) parts.push(`(playbook ${String(input.playbookId).slice(0, 8)}...)`);
      if (input.deviceId) parts.push(`on device ${String(input.deviceId).slice(0, 8)}...`);
      break;
    }

    case 'manage_scheduled_tasks':
      parts.push(`${action?.toUpperCase()} scheduled task "${input.taskName}"`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'manage_processes':
      if (action === 'kill') {
        parts.push(`Kill process PID ${input.processId}`);
      } else {
        parts.push('List processes');
      }
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'manage_tags':
      parts.push(`${action?.toUpperCase()} tags`);
      if (Array.isArray(input.tags)) parts.push(`[${(input.tags as string[]).join(', ')}]`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'registry_operations':
      parts.push(`Registry ${action}: ${input.keyPath}`);
      if (input.valueName) parts.push(`\\${input.valueName}`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'manage_organizations':
      if (action === 'create_org') parts.push(`Create organization "${input.name}" (with a default Main Office site)`);
      else if (action === 'update_org') parts.push(`Update organization ${(input.orgId as string)?.slice(0, 8)}...${input.status ? ` (status → ${input.status})` : ''}`);
      else if (action === 'create_site') parts.push(`Create site "${input.name}" in organization ${(input.orgId as string)?.slice(0, 8) ?? '(own org)'}...`);
      else if (action === 'add_contact') {
        // Review finding (fix round 1): `input.name` had no `??` fallback, so
        // a phone/mobile-only contact (legal since contacts_identifiable_chk
        // only needs ONE of name/email/phone/mobile) rendered literally as
        // `Add contact "undefined"` — the approver saw nothing identifying,
        // the exact failure spec §5 created this branch to prevent. Falls
        // back through the same priority order createContact accepts, and
        // lists every OTHER present identifier alongside it so the approver
        // sees everything supplied, not just whichever field won the fallback.
        const acName = typeof input.name === 'string' ? input.name : undefined;
        const acEmail = typeof input.email === 'string' ? input.email : undefined;
        const acPhone = typeof input.phone === 'string' ? input.phone : undefined;
        const acMobile = typeof input.mobile === 'string' ? input.mobile : undefined;
        const acHeadline = acName ?? acEmail ?? acPhone ?? acMobile ?? 'no identifying info provided';
        const acOthers = [
          acEmail && acEmail !== acHeadline ? `email: ${acEmail}` : null,
          acPhone && acPhone !== acHeadline ? `phone: ${acPhone}` : null,
          acMobile && acMobile !== acHeadline ? `mobile: ${acMobile}` : null,
        ].filter((part): part is string => part !== null);
        parts.push(
          `Add contact "${acHeadline}"${acOthers.length ? ` (${acOthers.join(', ')})` : ''} to organization ${(input.orgId as string)?.slice(0, 8) ?? '(own org)'}...`
        );
      } else parts.push(`Organizations: ${action}`);
      break;

    case 'manage_monitors':
      if (action === 'create') parts.push(`Create monitor "${input.name}" (${input.monitorType})`);
      else if (action === 'delete') parts.push(`Delete monitor ${(input.monitorId as string)?.slice(0, 8)}...`);
      else parts.push(`Monitor ${action}: ${(input.monitorId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;
    case 'run_backup_verification': {
      const verificationType = typeof input.verificationType === 'string' ? input.verificationType : 'integrity';
      parts.push(`Run ${verificationType} backup verification`);
      if (input.deviceId) parts.push(`on device ${String(input.deviceId).slice(0, 8)}...`);
      if (input.backupJobId) parts.push(`job ${String(input.backupJobId).slice(0, 8)}...`);
      break;
    }

    default:
      parts.push(`${toolName}${action ? `: ${action}` : ''}`);
  }

  return parts.join(' ');
}
