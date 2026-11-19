/**
 * The standing-instruction verb map (#10428 W06, spec §5.3): which remembered
 * "don't …" verbs a device-targeted tool call can break.
 *
 * Code-owned, beside TOOL_TIERS. A remembered instruction ("never reboot
 * PC-01") carries one verb; a tool call is matched against it only through
 * this map:
 *   - `exact`: the call does that thing. A CONFIRMED, enforceable deny on an
 *     exact verb refuses the call.
 *   - `possible`: the call may do it, but the tool is opaque (a script can
 *     reboot; a deployment may). A possible match only ever WARNS, so an
 *     instruction never refuses a call on a guess.
 * Every mapped call that is not `'none'` also exactly matches `any_change`
 * ("don't touch PC-01").
 *
 * `'none'` marks a tool (or action) that changes nothing on the device:
 * screenshots, reads, diagnostics, and platform records about a device (tags,
 * tickets, incidents). An unmapped tool never matches;
 * aiToolStandingVerbs.contract.test.ts requires an entry for every Tier >= 2
 * tool with device arguments.
 *
 * Patch installs are an EXACT reboot: an AI-initiated install job runs under
 * the `if_required` reboot policy (patchJobFinalizer), so it reboots whenever a
 * patch needs it. This map only narrows what Wisp may do; it never admits a
 * call.
 */
import type { StandingVerb } from '@breeze/shared';
import { resolveActionForTool } from './aiGuardrails';

type VerbSet = { verbs: readonly StandingVerb[]; possible?: readonly StandingVerb[] };
export type VerbRule = 'none' | (VerbSet & { byAction?: Readonly<Record<string, 'none' | VerbSet>> });

/** Changes the device in a way no narrower verb names. */
const CHANGE: VerbSet = { verbs: [] };
/** Changes the device and may restart it as a side effect. */
const CHANGE_MAY_REBOOT: VerbSet = { verbs: [], possible: ['reboot'] };
/** Runs arbitrary code or steps on the device. */
const OPAQUE: VerbSet = { verbs: [], possible: ['reboot', 'shutdown'] };

export const STANDING_INSTRUCTION_VERB_MAP: Readonly<Record<string, VerbRule>> = {
  // Scripts and commands
  run_script: { verbs: ['run_script'], possible: ['reboot', 'shutdown'] },
  execute_command: {
    ...OPAQUE,
    byAction: {
      list_processes: 'none', list_services: 'none', file_list: 'none', file_read: 'none',
      event_logs_list: 'none', event_logs_query: 'none',
    },
  },
  execute_playbook: { verbs: [], possible: ['run_script', 'reboot', 'shutdown'] },
  computer_control: { ...OPAQUE, byAction: { screenshot: 'none' } },
  manage_scheduled_tasks: { ...CHANGE, byAction: { list: 'none', run: OPAQUE } },
  bootstrap_homebrew: CHANGE,

  // Patching and software
  manage_patches: {
    ...CHANGE,
    byAction: {
      list: 'none', compliance: 'none', device_history: 'none', scan: 'none', decline: 'none', defer: 'none',
      install: { verbs: ['patch_install', 'reboot'] },
      rollback: { verbs: ['patch_install'], possible: ['reboot'] },
      approve: { verbs: [], possible: ['patch_install', 'reboot'] },
      bulk_approve: { verbs: [], possible: ['patch_install', 'reboot'] },
    },
  },
  remediate_vulnerability: { verbs: [], possible: ['patch_install', 'reboot'] },
  manage_device_software: CHANGE_MAY_REBOOT,
  manage_software_deployments: {
    ...CHANGE_MAY_REBOOT,
    byAction: { list: 'none', get: 'none', summary: 'none', results: 'none', cancel: CHANGE },
  },
  remediate_software_violation: CHANGE_MAY_REBOOT,
  trigger_agent_upgrade: CHANGE,
  trigger_agent_restart: CHANGE,

  // Services, processes, files, registry, configuration
  manage_services: { ...CHANGE, byAction: { list: 'none' } },
  manage_processes: { ...CHANGE, byAction: { list: 'none' } },
  manage_startup_items: CHANGE,
  file_operations: { ...CHANGE, byAction: { list: 'none', read: 'none' } },
  registry_operations: { ...CHANGE, byAction: { read_key: 'none', get_value: 'none' } },
  disk_cleanup: { ...CHANGE, byAction: { preview: 'none' } },
  system_cleanup: { ...CHANGE, byAction: { list: 'none', status: 'none' } },
  apply_cis_remediation: CHANGE_MAY_REBOOT,
  manage_browser_policy: { ...CHANGE, byAction: { list: 'none' } },
  manage_audit_baselines: { ...CHANGE, byAction: { list: 'none', create: 'none', compliance: 'none', device_results: 'none' } },
  manage_groups: { ...CHANGE, byAction: { list: 'none', get: 'none', preview: 'none', membership_log: 'none' } },
  manage_maintenance_windows: { ...CHANGE, byAction: { list: 'none', get: 'none', active_now: 'none' } },
  manage_recovery_keys: { ...CHANGE, byAction: { list: 'none', collect: 'none' } },
  set_agent_log_level: CHANGE,
  request_elevation: CHANGE,
  create_operator_task: CHANGE,

  // Security
  security_scan: { ...CHANGE, byAction: { scan: 'none', status: 'none', vulnerabilities: 'none' } },
  edr_endpoint_action: { ...CHANGE, byAction: { scan: 'none' } },
  s1_isolate_device: CHANGE,
  execute_containment: CHANGE,
  release_containment: CHANGE,

  // Backup and recovery
  restore_snapshot: CHANGE_MAY_REBOOT,
  restore_as_vm: CHANGE,
  restore_hyperv_vm: CHANGE,
  restore_mssql_database: CHANGE,
  instant_boot_vm: CHANGE,
  configure_vault: CHANGE,
  manage_backup_verification: { ...CHANGE, byAction: { health: 'none', list: 'none', readiness: 'none' } },
  trigger_backup: 'none',
  trigger_mssql_backup: 'none',
  get_vss_status: 'none',
  configure_backup_sla: 'none',
  manage_dr_plan: 'none',

  // Reads, diagnostics and observation: nothing changes on the device
  take_screenshot: 'none',
  analyze_screen: 'none',
  network_discovery: 'none',
  run_topology_diagnostic: 'none',
  request_diagnostic_access: 'none',
  diagnostic_list_directory: 'none',
  diagnostic_read_file: 'none',
  capture_agent_pprof: 'none',
  collect_evidence: 'none',
  browse_device_event_log: 'none',
  get_monitor_activity: 'none',
  create_remote_session: 'none',
  set_device_context: 'none',

  // Platform records about a device
  manage_alerts: 'none',
  reset_monitor_escalation: 'none',
  create_incident: 'none',
  reliability_feedback: 'none',
  manage_device_anomalies: 'none',
  manage_device_function: 'none',
  manage_device_links: 'none',
  manage_manual_assets: 'none',
  manage_device_warranty: 'none',
  manage_tickets: 'none',
  manage_tags: 'none',
  manage_custom_fields: 'none',
};

export type StandingVerbMatch = { exact: StandingVerb[]; possible: StandingVerb[] };

/**
 * The verbs one call can break. A mapped, non-`'none'` call always includes
 * `any_change` in `exact`; `possible` never repeats an exact verb. A
 * multiplexed tool whose action is missing or unlisted uses its tool-level
 * rule, never `'none'`.
 */
export function standingVerbsFor(toolName: string, input: Record<string, unknown>): StandingVerbMatch {
  const rule = Object.prototype.hasOwnProperty.call(STANDING_INSTRUCTION_VERB_MAP, toolName)
    ? STANDING_INSTRUCTION_VERB_MAP[toolName]
    : undefined;
  if (rule === undefined || rule === 'none') return { exact: [], possible: [] };
  const action = resolveActionForTool(toolName, input);
  const byAction = action !== undefined && rule.byAction && Object.prototype.hasOwnProperty.call(rule.byAction, action)
    ? rule.byAction[action]
    : undefined;
  const set: VerbSet | 'none' = byAction ?? rule;
  if (set === 'none') return { exact: [], possible: [] };
  const exact = [...new Set<StandingVerb>([...set.verbs, 'any_change'])];
  const possible = [...new Set(set.possible ?? [])].filter((v) => !exact.includes(v));
  return { exact, possible };
}
