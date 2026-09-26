/**
 * The agent-facing tool catalog: which tools an ai_agent principal can reach,
 * how they group into capabilities for the picker, and what each operation
 * resolves to under the guardrails. Everything security-relevant here is
 * DERIVED (checkGuardrails, POLICY_DECIDABLE_TIER3, ACT_MANIFEST); only the
 * capability placement and kind presets are authored. Contract test:
 * agentToolCatalog.contract.test.ts.
 */
import type { AiToolDomain } from '@breeze/shared';
import type {
  AiAgentKind,
  AgentToolCatalogDto,
  AgentToolCatalogToolDto,
  AgentToolOperationDto,
} from '@breeze/shared/types/aiAgents';
import { aiTools } from '../aiToolNames';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { m365ToolTiers } from '../aiToolsM365';
import { googleToolTiers } from '../aiToolsGoogle';
import {
  TOOL_ACTION_INPUT_KEYS,
  checkGuardrails, isReadOnlyResolution, isNeverAgentTool,
} from '../aiGuardrails';
import { toolActionEnum } from '../aiToolActions';
import { isPolicyDecidableKey } from '../actionIntents/policyDecidable';
import { ACT_MANIFEST, SCRIPT_GATED_ACT_TOOLS } from './actManifest';

export type AgentCapabilityId =
  | 'alerts_monitoring' | 'services_startup' | 'files_disk' | 'scripts_commands' | 'tickets'
  | 'patching_software' | 'security_response' | 'backup_recovery' | 'config_policies' | 'network'
  | 'remote_access' | 'endpoint_agent' | 'automations_reports' | 'business' | 'tenancy'
  | 'author_scripts' | 'workspace';

export const AGENT_CAPABILITIES: readonly { id: AgentCapabilityId; tone: 'standard' | 'high' }[] = [
  { id: 'alerts_monitoring', tone: 'standard' },
  { id: 'services_startup', tone: 'standard' },
  { id: 'files_disk', tone: 'standard' },
  { id: 'scripts_commands', tone: 'standard' },
  // 'high' tone: authoring novel code is a qualitatively different grant from
  // running a reviewed library script, and the picker must say so.
  { id: 'author_scripts', tone: 'high' },
  { id: 'tickets', tone: 'standard' },
  { id: 'patching_software', tone: 'standard' },
  { id: 'security_response', tone: 'high' },
  { id: 'backup_recovery', tone: 'high' },
  { id: 'config_policies', tone: 'standard' },
  { id: 'network', tone: 'standard' },
  { id: 'remote_access', tone: 'standard' },
  { id: 'endpoint_agent', tone: 'standard' },
  { id: 'automations_reports', tone: 'standard' },
  { id: 'business', tone: 'standard' },
  { id: 'tenancy', tone: 'high' },
  // W04 adds the `workspace_*` tools under this same capability — whichever
  // wave lands first adds it, the second finds it already present.
  { id: 'workspace', tone: 'standard' },
];

/**
 * Which tool domains (spec 2026-09-17, `AI_TOOL_DOMAINS`) a capability may
 * contain. The capability is the agent-builder grouping (with `tone`); the
 * domain is the load/grant grouping. They overlap but are not 1:1, so this
 * relation is what keeps them from drifting silently: a tool whose domain is
 * not in its capability's set fails agentToolCatalog.domainRelation.contract.
 * Widen an entry in the same commit as the tool that needs it, with a reason.
 */
export const CAPABILITY_DOMAINS: Readonly<Record<AgentCapabilityId, readonly AiToolDomain[]>> = {
  alerts_monitoring: ['monitoring', 'integrations', 'devices', 'patching'], // notification channels; fleet hygiene findings; manage_maintenance_windows domain is patching (#6341)
  services_startup: ['devices'],
  files_disk: ['devices'],
  scripts_commands: ['scripts', 'devices'],
  author_scripts: ['scripts'],
  tickets: ['tickets'],
  patching_software: ['patching', 'security'], // compliance policies and enforcement status
  security_response: ['security', 'integrations', 'monitoring'], // S1/Huntress; incident tools
  backup_recovery: ['backup', 'integrations'], // M365/Google cloud-to-cloud backup and restore
  config_policies: ['security', 'patching', 'backup', 'network'], // policy prerequisites; DNS security policies
  network: ['network'],
  remote_access: ['devices'],
  endpoint_agent: ['admin', 'devices'],
  automations_reports: ['scripts', 'admin', 'monitoring', 'core', 'devices', 'security'], // core context/docs; device inventory/performance; audit/change logs
  business: ['billing', 'accounts', 'tickets'],
  tenancy: ['accounts', 'admin', 'core', 'integrations', 'ai'], // list_organizations is core; webhooks/PSA/M365; AI-agent governance
  workspace: ['ai', 'admin'], // dataset exports feed workspace analysis
};

/**
 * Every registered headless tool → capability. The contract test fails on a
 * registered tool missing here, an entry naming an unregistered tool, or an
 * entry naming an unknown capability — so adding a tool means adding a line
 * here. Read-only tools are mapped too (the picker lists them under "always
 * on"); a read-only tool takes its mutating siblings' capability (e.g.
 * `query_backups` -> backup_recovery, alongside `trigger_backup`). Assigned
 * against `[...aiTools.keys()].sort()` (184 registered tools as of this
 * writing) per spec §4.1's table; ambiguous ones resolved by reading the
 * tool's own description/handler rather than guessing from the name alone.
 */
export const TOOL_CAPABILITY: Readonly<Record<string, AgentCapabilityId>> = {
  // ---- alerts_monitoring ----
  list_remediation_suggestions: 'alerts_monitoring',
  list_incidents: 'alerts_monitoring',
  manage_alerts: 'alerts_monitoring',
  manage_delivery: 'alerts_monitoring',
  manage_alert_rules: 'alerts_monitoring',
  manage_monitors: 'alerts_monitoring',
  // #5289 — monitor DEFINITIONS (the authored condition+response object), not
  // the network monitors `manage_monitors` above covers.
  list_monitors: 'alerts_monitoring',
  get_monitor: 'alerts_monitoring',
  // #5290 (W03): per-device breach activity/escalation for a monitor
  // definition, same capability as the other monitor-definition tools above.
  get_monitor_activity: 'alerts_monitoring',
  reset_monitor_escalation: 'alerts_monitoring',
  manage_monitor_definitions: 'alerts_monitoring',
  manage_service_monitors: 'alerts_monitoring',
  manage_notification_channels: 'alerts_monitoring',
  manage_maintenance_windows: 'alerts_monitoring', // scheduled alert suppression, not a config policy
  query_monitors: 'alerts_monitoring',
  get_service_monitoring_status: 'alerts_monitoring',
  get_fleet_findings: 'alerts_monitoring',
  search_logs: 'alerts_monitoring', // agent event-log search/correlation, diagnostic monitoring
  get_log_trends: 'alerts_monitoring',
  detect_log_correlations: 'alerts_monitoring',

  // ---- services_startup ----
  manage_services: 'services_startup',
  manage_startup_items: 'services_startup',

  // ---- files_disk ----
  file_operations: 'files_disk',
  disk_cleanup: 'files_disk',
  analyze_disk_usage: 'files_disk',
  // Deliberately NOT added to any AGENT_KIND_PRESETS default (spec §9.3 item
  // 7): an operator turns this on per agent, on purpose. `triage` and
  // `helpdesk` ship with `disk_cleanup:execute` because a previewed,
  // path-pinned file delete is rule-equivalent; a native cleaner is not.
  system_cleanup: 'files_disk',

  // ---- author_scripts ----
  propose_script: 'author_scripts',
  get_script_proposal: 'author_scripts',
  // ---- scripts_commands ----
  run_script: 'scripts_commands',
  execute_command: 'scripts_commands',
  execute_playbook: 'scripts_commands',
  cancel_script_execution: 'scripts_commands',
  manage_processes: 'scripts_commands',
  manage_scheduled_tasks: 'scripts_commands',
  registry_operations: 'scripts_commands',
  list_scripts: 'scripts_commands',
  get_script_details: 'scripts_commands',
  list_script_templates: 'scripts_commands',
  get_script_execution_history: 'scripts_commands',
  get_script_execution: 'scripts_commands',
  search_script_library: 'scripts_commands',
  list_playbooks: 'scripts_commands',
  get_playbook_history: 'scripts_commands',

  // ---- tickets ----
  manage_tickets: 'tickets',
  manage_ticket_checklist: 'tickets',
  list_time_entries: 'tickets',
  get_running_timer: 'tickets',
  get_timesheet: 'tickets',


  // ---- patching_software ----
  manage_patches: 'patching_software',
  manage_deployments: 'patching_software',
  manage_update_rings: 'patching_software',
  manage_software_policies: 'patching_software',
  manage_software_policy: 'patching_software',
  remediate_software_violation: 'patching_software',
  remediate_vulnerability: 'patching_software',
  get_vulnerability_report: 'patching_software',
  get_device_vulnerabilities: 'patching_software',
  get_software_compliance: 'patching_software',
  query_compliance_policies: 'patching_software',
  get_compliance_status: 'patching_software',

  // ---- security_response (tone: high) ----
  security_scan: 'security_response',
  s1_isolate_device: 'security_response',
  s1_threat_action: 'security_response',
  get_s1_status: 'security_response',
  get_s1_threats: 'security_response',
  execute_containment: 'security_response',
  apply_cis_remediation: 'security_response',
  get_cis_compliance: 'security_response',
  get_cis_device_report: 'security_response',
  remediate_sensitive_data: 'security_response',
  get_security_posture: 'security_response',
  get_sensitive_data_overview: 'security_response',
  get_huntress_status: 'security_response',
  get_huntress_incidents: 'security_response',
  sync_huntress_data: 'security_response',
  create_incident: 'security_response',
  collect_evidence: 'security_response',
  get_incident_timeline: 'security_response',
  generate_incident_report: 'security_response',
  request_elevation: 'security_response', // PAM
  revoke_elevation: 'security_response',
  get_elevation_history: 'security_response',
  get_user_risk_scores: 'security_response',
  get_user_risk_detail: 'security_response',
  assign_security_training: 'security_response',

  // ---- backup_recovery (tone: high) ----
  trigger_backup: 'backup_recovery',
  restore_snapshot: 'backup_recovery',
  query_backups: 'backup_recovery',
  get_backup_status: 'backup_recovery',
  browse_snapshots: 'backup_recovery',
  restore_as_vm: 'backup_recovery',
  instant_boot_vm: 'backup_recovery',
  get_vm_restore_estimate: 'backup_recovery',
  trigger_hyperv_backup: 'backup_recovery',
  restore_hyperv_vm: 'backup_recovery',
  query_hyperv_vms: 'backup_recovery',
  get_hyperv_vm_details: 'backup_recovery',
  manage_hyperv_vm: 'backup_recovery',
  manage_hyperv_checkpoints: 'backup_recovery',
  trigger_mssql_backup: 'backup_recovery',
  restore_mssql_database: 'backup_recovery',
  query_mssql_instances: 'backup_recovery',
  get_mssql_backup_status: 'backup_recovery',
  verify_mssql_backup: 'backup_recovery',
  execute_dr_plan: 'backup_recovery',
  manage_dr_plan: 'backup_recovery',
  query_dr_plans: 'backup_recovery',
  get_dr_plan_details: 'backup_recovery',
  get_dr_execution_status: 'backup_recovery',
  query_vaults: 'backup_recovery',
  get_vault_status: 'backup_recovery',
  trigger_vault_sync: 'backup_recovery',
  configure_vault: 'backup_recovery',
  query_backup_sla: 'backup_recovery',
  get_sla_breaches: 'backup_recovery',
  get_sla_compliance_report: 'backup_recovery',
  configure_backup_sla: 'backup_recovery',
  manage_backup_profiles: 'backup_recovery',
  manage_backup_configs: 'backup_recovery',
  query_c2c_connections: 'backup_recovery', // cloud-to-cloud (M365/Google) backup
  query_c2c_jobs: 'backup_recovery',
  search_c2c_items: 'backup_recovery',
  trigger_c2c_sync: 'backup_recovery',
  restore_c2c_items: 'backup_recovery',

  // ---- config_policies ----
  apply_configuration_policy: 'config_policies',
  remove_configuration_policy_assignment: 'config_policies',
  manage_configuration_policy: 'config_policies',
  manage_policy_feature_link: 'config_policies',
  list_configuration_policies: 'config_policies',
  get_effective_configuration: 'config_policies',
  preview_configuration_change: 'config_policies',
  get_configuration_policy: 'config_policies',
  configuration_policy_compliance: 'config_policies',
  manage_dns_policy: 'config_policies',
  get_dns_security: 'config_policies',
  manage_browser_policy: 'config_policies',
  get_browser_security: 'config_policies',
  manage_peripheral_policy: 'config_policies',
  manage_peripheral_policies: 'config_policies',
  get_peripheral_activity: 'config_policies',

  // ---- network ----
  network_discovery: 'network',
  acknowledge_network_device: 'network',
  configure_network_baseline: 'network',
  get_network_changes: 'network',
  get_ip_history: 'network',
  list_network_assets: 'network',
  get_network_asset: 'network',
  get_network_asset_reachability: 'network',

  // ---- remote_access ----
  take_screenshot: 'remote_access',
  analyze_screen: 'remote_access',
  computer_control: 'remote_access',
  create_remote_session: 'remote_access',
  list_remote_sessions: 'remote_access',

  // ---- endpoint_agent ----
  trigger_agent_upgrade: 'endpoint_agent',
  trigger_agent_restart: 'endpoint_agent',
  set_agent_log_level: 'endpoint_agent',
  capture_agent_pprof: 'endpoint_agent',
  search_agent_logs: 'endpoint_agent',
  query_agent_versions: 'endpoint_agent',

  // ---- automations_reports ----
  manage_automations: 'automations_reports',
  generate_report: 'automations_reports',
  manage_groups: 'automations_reports',
  manage_tags: 'automations_reports',
  manage_saved_filters: 'automations_reports',
  query_custom_fields: 'automations_reports',
  query_devices: 'automations_reports',
  get_device_details: 'automations_reports',
  get_device_hardware_health: 'automations_reports',
  get_device_context: 'automations_reports',
  set_device_context: 'automations_reports',
  resolve_device_context: 'automations_reports',
  query_analytics: 'automations_reports',
  get_executive_summary: 'automations_reports',
  query_audit_log: 'automations_reports',
  query_change_log: 'automations_reports',
  search_documentation: 'automations_reports',
  get_invite_funnel: 'automations_reports', // deployment/enrollment funnel report
  get_fleet_health: 'automations_reports', // device reliability scoring/reporting
  analyze_metrics: 'automations_reports',
  analyze_fleet_metrics: 'automations_reports',
  get_active_users: 'automations_reports',
  get_user_experience_metrics: 'automations_reports',
  analyze_boot_performance: 'automations_reports',

  // ---- business ----
  manage_quotes: 'business',
  list_quotes: 'business',
  get_quote: 'business',
  manage_invoices: 'business',
  list_invoices: 'business',
  get_invoice: 'business',
  manage_contracts: 'business',
  list_contracts: 'business',
  manage_org_documents: 'business',
  list_org_documents: 'business',
  get_contract: 'business',
  // Service deliverables W02 (#5573): the recurring service obligations a
  // contract promises, and the org key dates beside them — same commercial
  // capability as the contracts they hang off.
  list_deliverables: 'business',
  // Deliverable template sets W05 (#5573): the reusable service tier behind
  // those deliverables - same commercial capability.
  list_deliverable_templates: 'business',
  manage_deliverables: 'business',
  manage_key_dates: 'business',
  manage_catalog: 'business',
  search_catalog: 'business',
  lookup_distributor_product: 'business',
  get_catalog_item: 'business',

  // ---- tenancy (tone: high) ----
  manage_organizations: 'tenancy',
  list_ai_agents: 'tenancy',
  list_ai_agent_runs: 'tenancy',
  get_ai_agent_run: 'tenancy',
  list_sites: 'tenancy',
  get_site: 'tenancy',
  list_org_contacts: 'tenancy',
  list_organizations: 'tenancy',
  delete_tenant: 'tenancy',
  test_webhook: 'tenancy',
  query_webhooks: 'tenancy',
  query_psa_status: 'tenancy',
  manage_ai_agents: 'tenancy', // AGENT_HUMAN_ONLY_TOOLS; mapped for completeness, never reachable
  // M365 typed Graph read-query tools (aiToolsM365.ts's registerM365Tools) —
  // headless-registered and in TOOL_TIERS, distinct from the session-only
  // helpdesk M365 tools in `m365ToolTiers`. RBAC resource is `organizations`
  // (aiGuardrails.ts TOOL_PERMISSIONS), same as list_organizations/manage_organizations.
  m365_query_users: 'tenancy',
  m365_query_signins: 'tenancy',
  m365_query_intune_devices: 'tenancy',
  m365_query_groups: 'tenancy',
  m365_query_org: 'tenancy',
  m365_query_sites: 'tenancy',

  // ---- workspace ----
  export_dataset: 'workspace',
  // A-W05 (D13a): reads a stored tool-result artifact back.
  read_artifact: 'workspace',
  // ---- workspace (execution plane W04) ----
  workspace_stage: 'workspace',
  workspace_run: 'workspace',
  workspace_collect: 'workspace',
  workspace_cancel: 'workspace',
};

export const AGENT_KIND_PRESETS: Readonly<Record<AiAgentKind, readonly string[]>> = {
  triage: [
    'manage_alerts:acknowledge',
    'manage_alerts:resolve',
    'manage_services:restart',
    'manage_startup_items:disable',
    'disk_cleanup:execute',
    'run_script',
  ],
  // AI patch agent (W01): `manage_deployments:start` dropped — it is the
  // software-rollout engine, not patch jobs. This is the create-time default
  // for the DEVICE lane only; existing agents keep their stored allowlists,
  // and a `patch`-profile run ignores this entirely (patchToolAllowlist is a
  // floor, not an intersection).
  patch: [
    'manage_patches:approve',
    'manage_patches:install',
    'manage_services:restart',
  ],
  helpdesk: ['manage_services:restart', 'disk_cleanup:execute', 'run_script'],
  // Fleet Designer (W01): reads by the guardrail rule (`designToolAllowlist`
  // is a FLOOR, not an intersection with this preset), one outcome tool —
  // never a mutating operation. A designer agent's toolAllowlist form still
  // exists (shared UI component) but a design run never consults it.
  designer: [],
};

function isSessionOnly(name: string): boolean {
  return name in m365ToolTiers || name in googleToolTiers;
}

/**
 * The runtime deny set `checkAgentGuardrails` enforces unconditionally,
 * regardless of policy — a blocked tool (tier 4), a secret-bearing tool, an
 * `AGENT_HUMAN_ONLY_TOOLS` entry and an `AGENT_DENIED_READ_TOOLS` entry
 * (W01-D5, quorum amendment WQ4, #6755) — is never reachable, so the catalog
 * must exclude all four here rather than let a reachable-but-always-denied
 * tool appear in the picker. `isNeverAgentTool` (aiGuardrails.ts) is the one
 * shared predicate for that check; this function and `checkAgentGuardrails`
 * used to hand-duplicate it.
 */
export function listAgentReachableTools(): string[] {
  return [...aiTools.keys()]
    .filter((name) =>
      name in TOOL_TIERS
      && !isSessionOnly(name)
      && !isNeverAgentTool(name))
    .sort();
}

/**
 * Every registered tool NOT in `listAgentReachableTools()` — not just the
 * ones absent from `TOOL_TIERS`, but also whichever of the same runtime-deny
 * filters `isNeverAgentTool` covers (`AGENT_HUMAN_ONLY_TOOLS`,
 * `AGENT_DENIED_READ_TOOLS`, `BLOCKED_TOOLS`, secret-bearing) trip on a tool
 * that otherwise HAS a tier. Lets the picker (Task 7, #5049) tell a stale
 * allowlist entry naming a real-but-unreachable tool (`unreachable_tool`)
 * apart from one that never existed (`unknown_tool`).
 */
export function listUnreachableRegisteredTools(): string[] {
  const reachable = new Set(listAgentReachableTools());
  return [...aiTools.keys()].filter((name) => !reachable.has(name)).sort();
}

/**
 * Frozen colon-keyed act-manifest surface, derived from `ACT_MANIFEST` once:
 * `'manage_services.restart'` -> `'manage_services:restart'`; a dotless key
 * (`'run_script'`, `'execute_playbook'`) stays bare. The virtual
 * `remediation_suggestion` entry is excluded — it has no real `toolName` an
 * agent call can ever carry (see actManifest.ts's docstring on that entry).
 */
const ACT_ELIGIBLE_OPERATION_KEYS: ReadonlySet<string> = new Set(
  ACT_MANIFEST
    .filter((op) => op.key !== 'remediation_suggestion')
    .map((op) => {
      const dot = op.key.indexOf('.');
      return dot === -1 ? op.key : `${op.key.slice(0, dot)}:${op.key.slice(dot + 1)}`;
    }),
);

function resolveOperation(toolName: string, action: string | null): AgentToolOperationDto {
  const key = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
  const input: Record<string, unknown> = action === null ? {} : { [key]: action };
  const check = checkGuardrails(toolName, input);
  // Every tool this is called for is a member of `aiTools` and `TOOL_TIERS`
  // by construction (listAgentReachableTools), so tier 4 ("blocked"/"unknown
  // tool") is a reachability-filter bug, not a value to paper over — throw
  // rather than clamp it into a false tier 3.
  if (check.tier === 4) {
    throw new Error(`agentToolCatalog: ${toolName} resolves to tier 4 but passed the reachability filter`);
  }
  const readOnly = isReadOnlyResolution(toolName, check);
  const opKey = action === null ? toolName : `${toolName}:${action}`;
  return {
    key: opKey,
    action,
    tier: check.tier,
    readOnly,
    policyDecidable: isPolicyDecidableKey(opKey),
    // Membership in the frozen manifest surface, not a synthetic-input probe
    // of `matches()` — `run_script`/`execute_playbook` match on scriptId /
    // playbookId+deviceId, which this operation's synthetic `{ action }`
    // input never carries, so probing `resolveActOperation` here always came
    // back null for them.
    actEligible: ACT_ELIGIBLE_OPERATION_KEYS.has(opKey) && !readOnly,
    // The outcome rule (packages/shared agentOutcome.ts) downgrades this to an
    // approval request while the row has no authorized script — the same
    // gate hasActEligibleSurface / remediationActResolver apply at runtime.
    actRequiresAuthorizedScripts: SCRIPT_GATED_ACT_TOOLS.has(toolName),
  };
}

let memo: AgentToolCatalogDto | null = null;

export function buildAgentToolCatalog(): AgentToolCatalogDto {
  if (memo) return memo;
  const tools: AgentToolCatalogToolDto[] = listAgentReachableTools().map((name) => {
    const actions = toolActionEnum(name);
    const operations = actions ? actions.sort().map((a) => resolveOperation(name, a)) : [resolveOperation(name, null)];
    const baseTier = aiTools.get(name)!.tier;
    // Same reachability invariant as resolveOperation's tier check above —
    // throw rather than silently clamp a tier-4 tool into a false tier 3.
    if (baseTier === 4) {
      throw new Error(`agentToolCatalog: ${name} has base tier 4 but passed the reachability filter`);
    }
    return {
      name,
      // Non-null: the contract test's completeness check guarantees every
      // name in listAgentReachableTools() (a subset of aiTools.keys()) has a
      // TOOL_CAPABILITY entry; noUncheckedIndexedAccess can't see that.
      capability: TOOL_CAPABILITY[name]!,
      tier: baseTier,
      readOnly: operations.every((op) => op.readOnly),
      operations,
    };
  });
  memo = {
    capabilities: AGENT_CAPABILITIES.map((c) => ({ ...c })),
    tools,
    presets: {
      triage: [...AGENT_KIND_PRESETS.triage],
      patch: [...AGENT_KIND_PRESETS.patch],
      helpdesk: [...AGENT_KIND_PRESETS.helpdesk],
      designer: [...AGENT_KIND_PRESETS.designer],
    },
    unreachableTools: listUnreachableRegisteredTools(),
  };
  return memo;
}

/** Test seam: registries are static per process, but the test file order is not. */
export function resetAgentToolCatalogMemo(): void {
  memo = null;
}
