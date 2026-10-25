/**
 * §5.8 — every table that references a device, classified for the install
 * incarnation boundary (#8318 wave 1a).
 *
 *  - `handler`: rows bound to the OLD install (work in flight, a grant, an
 *    authorization, a session, a secret, or install-specific cached state)
 *    that a boundary handler cancels, revokes, resets or clears. `handler`
 *    names it; `rebind_confirm` marks the one table wave 1b's confirm owns
 *    (credentials, §6.4 effect 2).
 *  - `configuration`: configuration or membership that survives and applies
 *    to the new install.
 *  - `history`: telemetry, inventory, evidence and finished records.
 *
 * The integration contract (`__tests__/integration/installBoundaryContract.integration.test.ts`)
 * discovers every table with a FOREIGN KEY to `devices(id)` in the live
 * schema — by FK, not by the column name, which is what catches
 * `topology_telemetry_arms.collector_device_id` — plus the curated FK-less
 * references below, and fails when one is not classified here, when an entry
 * here names a table that does not exist, or when a `handler` entry and the
 * handler's own `tables` disagree. A new device-referencing table holding
 * work or grants is therefore a red suite until someone decides what a
 * reinstall does to it.
 */
import type { BoundaryHandlerId } from './types';

export type InstallBoundaryClass =
  | { class: 'handler'; handler: BoundaryHandlerId | 'rebind_confirm'; reason: string }
  | { class: 'configuration'; reason: string }
  | { class: 'history'; reason: string };

/**
 * Device references that carry no FK, so discovery by FK cannot see them.
 * `column` is checked against the live schema by the contract test, and every
 * table here must also be classified.
 */
export const FK_LESS_DEVICE_REFERENCES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'ai_agent_fix_watches', column: 'device_id' },
  { table: 'ai_unattended_exposure', column: 'device_id' },
  { table: 'backup_snapshot_origins', column: 'origin_device_id' },
  { table: 'caller_verifications', column: 'workstation_device_ref' },
  { table: 'device_ownership_epoch_closures', column: 'device_id' },
  { table: 'device_ownership_epochs', column: 'device_id' },
  { table: 'device_pool_assignment_events', column: 'device_id' },
  { table: 'elevation_requests', column: 'device_id' },
  { table: 'fix_outcomes', column: 'device_id' },
  { table: 'fleet_finding_devices', column: 'device_id' },
  { table: 'maintenance_windows', column: 'device_ids' },
  { table: 'pam_actuation_results', column: 'device_id' },
  { table: 'pam_actuations', column: 'device_id' },
  { table: 'remediation_suggestions', column: 'target_device_ids' },
  { table: 'script_proposals', column: 'target_device_ids' },
  { table: 'topology_site_fingerprints', column: 'observer_device_ids' },
];

/**
 * FK-less columns whose NAME looks like a device reference but that name a
 * different kind of device (an SNMP target, a UniFi or vendor device, a phone).
 * The contract test sweeps `*device_id`, `*device_ids` and `*device_ref`
 * columns without a FK and requires each to be in FK_LESS_DEVICE_REFERENCES or
 * here, so a new FK-less Breeze device reference cannot slip past unclassified.
 */
export const NOT_A_BREEZE_DEVICE_REFERENCE: ReadonlyArray<{ table: string; column: string; reason: string }> = [
  { table: 'approval_requests', column: 'authenticator_device_id', reason: 'the approver’s authenticator (mobile) device' },
  { table: 'authenticator_devices', column: 'mobile_device_id', reason: 'a mobile device' },
  { table: 'backup_provider_device_history', column: 'provider_device_id', reason: 'a backup_provider_devices row' },
  { table: 'backup_provider_devices', column: 'vendor_device_id', reason: 'the backup vendor’s own device id' },
  { table: 'elevation_requests', column: 'authenticator_device_id', reason: 'the approver’s authenticator (mobile) device' },
  { table: 'm365_intune_devices', column: 'azure_ad_device_id', reason: 'an Entra ID device id' },
  { table: 'mobile_devices', column: 'device_id', reason: 'the phone’s own push device id' },
  { table: 'mobile_sessions', column: 'mobile_device_id', reason: 'a mobile device' },
  { table: 'push_notifications', column: 'mobile_device_id', reason: 'a mobile device' },
  { table: 'refresh_token_families', column: 'mobile_device_id', reason: 'a mobile device' },
  { table: 'snmp_alert_thresholds', column: 'device_id', reason: 'an SNMP device' },
  { table: 'snmp_metrics', column: 'device_id', reason: 'an SNMP device' },
  { table: 'unifi_clients', column: 'connected_device_id', reason: 'a UniFi device' },
  { table: 'unifi_device_telemetry', column: 'unifi_device_id', reason: 'a UniFi device' },
  { table: 'unifi_devices', column: 'unifi_device_id', reason: 'a UniFi device' },
];

/**
 * Tables that exist only when a first-party extension (ee/) is installed and
 * migrated. The contract test does not report them as stale when absent.
 */
export const EXTENSION_TABLES: ReadonlySet<string> = new Set([
  'workspace_crawl_runs',
  'workspace_file_activity',
  'workspace_file_index',
  'workspace_sources',
]);

const history = (reason: string): InstallBoundaryClass => ({ class: 'history', reason });
const configuration = (reason: string): InstallBoundaryClass => ({ class: 'configuration', reason });
const handled = (handler: BoundaryHandlerId | 'rebind_confirm', reason: string): InstallBoundaryClass => ({
  class: 'handler',
  handler,
  reason,
});

export const INSTALL_BOUNDARY_CLASSIFICATION: Readonly<Record<string, InstallBoundaryClass>> = {
  abuse_endpoint_fingerprints: history('abuse-signal corpus'),
  action_intents: handled('work_in_flight', 'live AI intents are detached from the device'),
  agent_health_observations: history('agent health telemetry'),
  agent_logs: history('agent diagnostic logs'),
  agent_rollback_directives: handled('grants', 'requested/in-progress directives expire'),
  agent_rollback_events: history('append-only directive evidence'),
  ai_agent_fix_watches: handled('work_in_flight', 'a recurrence on the new OS says nothing about the old fix'),
  ai_agent_runs: history('AI run record; its effects in flight are commands and intents'),
  ai_operator_task_targets: handled('work_in_flight', 'live targets detach (device_reinstalled)'),
  ai_operator_tasks: handled('work_in_flight', 'live tasks detach and stop (device_reinstalled)'),
  ai_run_artifacts: history('stored AI tool output'),
  ai_screenshots: history('expiring screenshots'),
  ai_sessions: history('technician chat with no install-bound authority'),
  ai_unattended_exposure: history('unattended-action ledger'),
  alerts: history('alerts (§5.1)'),
  asset_checkouts: configuration('physical asset loan of the same hardware'),
  asset_physical_placements: configuration('physical placement of the same hardware'),
  audit_baseline_results: history('audit baseline results'),
  audit_policy_states: history('collected audit policy'),
  automation_action_results: handled('commands', 'settled through the cancelled commands'),
  automation_policy_compliance: history('derived compliance, re-evaluated'),
  automation_run_device_results: history('rolled up from the action results'),
  backup_chains: handled('backup_recovery', 'the active chain is closed'),
  backup_jobs: handled('backup_recovery', 'pending/running jobs are cancelled'),
  backup_provider_devices: configuration('external backup vendor link'),
  backup_restore_authorizations: handled('backup_recovery', 'unused reservations are deleted; the rest die with their binding'),
  backup_sla_events: history('SLA events'),
  backup_snapshot_attestations: history('server-side snapshot verification'),
  backup_snapshot_id_reservations: history('settled when the job ends'),
  backup_snapshot_origins: history('snapshot provenance'),
  backup_snapshot_retirements: history('retired snapshots'),
  backup_snapshots: history('snapshots (§5.4); pre-incarnation restores need approval'),
  backup_storage_session_uploads: history('aborted in storage by the janitor once the session is revoked'),
  backup_storage_sessions: handled('backup_recovery', 'open sessions are revoked'),
  backup_verifications: handled('backup_recovery', 'pending/running verifications fail'),
  bare_metal_recoveries: handled('backup_recovery', 'in-flight recoveries fail'),
  brain_device_context: history('AI memory notes'),
  browser_extensions: history('browser extension inventory'),
  browser_policy_violations: history('policy violations'),
  caller_verifications: handled('grants', 'workstation grants are revoked'),
  capacity_predictions: history('derived predictions'),
  cis_baseline_results: history('CIS scan results'),
  cis_remediation_actions: handled('install_state', 'remediations of old-OS findings are cancelled'),
  deployment_devices: handled('install_state', 'running rows return to pending'),
  deployment_invites: history('invite and enrollment record'),
  deployment_results: handled('commands', 'settled through the cancelled commands'),
  device_agent_health_latest: history('latest agent health pointer'),
  device_boot_metrics: history('boot telemetry'),
  device_change_log: history('change log'),
  device_commands: handled('commands', 'earlier incarnations’ open rows are cancelled'),
  device_config_state: history('config-file observations, fully replaced by each report'),
  device_connections: history('connection snapshot'),
  device_custom_field_values: configuration('custom fields (§5.1)'),
  device_disks: history('inventory'),
  device_event_logs: history('event logs'),
  device_external_links: configuration('external RMM identity'),
  device_filesystem_cleanup_runs: handled('work_in_flight', 'running/previewed plans of the old OS fail'),
  device_filesystem_scan_state: handled('install_state', 'scan checkpoint of the old OS is dropped'),
  device_filesystem_snapshots: history('filesystem analysis snapshots'),
  device_function_assessments: configuration('what the machine is for'),
  device_group_memberships: configuration('group membership (§5.1)'),
  device_hardware: history('hardware inventory; the TPM baseline survives (§5.1)'),
  device_hardware_components: history('hardware components'),
  device_hardware_events: history('hardware events'),
  device_hardware_health: history('hardware health'),
  device_ip_history: history('IP history'),
  device_memory_modules: history('inventory'),
  device_metrics: history('metrics'),
  device_mtls_certificates: handled('rebind_confirm', 'the confirm activates the new certificate and demotes the old (§6.4, wave 1b)'),
  device_network: history('inventory'),
  device_ownership_epoch_closures: history('PAM ownership lineage, immutable'),
  device_ownership_epochs: history('PAM ownership lineage, immutable'),
  device_patches: handled('install_state', 'patch inventory of the old OS is cleared'),
  device_pool_assignment_events: history('holding-area ledger, append-only'),
  device_process_samples: history('process telemetry'),
  device_recovery_keys: history('BitLocker escrow; the new install’s escrow supersedes'),
  device_registry_state: history('registry observations, fully replaced by each report'),
  device_reliability: history('derived reliability score'),
  device_reliability_baselines: history('reliability baselines'),
  device_reliability_history: history('reliability history'),
  device_restore_point_attempts: handled('work_in_flight', 'requested restore points fail'),
  device_sessions: handled('install_state', 'sessions the old OS reported as active are closed'),
  device_software: history('legacy software inventory'),
  device_software_inventory_state: handled('install_state', 'the acceptance gate of the old inventory is dropped'),
  device_time_daily: history('time sync history'),
  device_time_status: handled('install_state', 'the old install’s sequence cursor is dropped'),
  device_vulnerabilities: history('findings, re-correlated from the new inventory'),
  device_warranty: configuration('warranty of the same hardware'),
  device_workload_runtimes: history('workload inventory'),
  device_workloads: history('workload inventory'),
  devices: handled('device_row', 'the row advances its incarnation and forgets the old capabilities'),
  diagnostic_access_grants: handled('grants', 'pending grants expire, active grants are revoked'),
  discovered_assets: configuration('network asset linked to the same hardware'),
  discovery_profiles: configuration('pinned scan agent'),
  dns_event_aggregations: history('DNS telemetry'),
  dns_security_events: history('DNS telemetry'),
  edr_actions: history('vendor-side EDR actions'),
  edr_detections: history('vendor-side detections'),
  edr_endpoints: configuration('EDR vendor link'),
  elevation_requests: handled('pam', 'live elevation requests expire'),
  endpoint_conversation_messages: history('chat history'),
  endpoint_conversations: handled('sessions', 'live chats close (device_reinstalled)'),
  endpoint_message_deliveries: handled('sessions', 'undelivered or displayed messages are superseded'),
  endpoint_message_receipts: history('message receipts'),
  fix_outcomes: history('settled by the outcome watcher once its command is cancelled'),
  fleet_finding_devices: history('fleet finding membership, reconciled'),
  group_membership_log: history('membership log'),
  huntress_agents: configuration('Huntress vendor link'),
  huntress_incidents: history('vendor incidents'),
  hyperv_vms: history('VM discovery'),
  invoice_line_devices: history('billing evidence'),
  local_vaults: handled('work_in_flight', 'a sync in flight fails; the vault configuration survives'),
  m365_intune_devices: configuration('Intune link'),
  maintenance_windows: configuration('maintenance window membership (§5.1)'),
  manual_assets: configuration('hand-entered asset link'),
  metric_anomalies: history('anomalies'),
  metric_anomaly_candidates: history('anomaly candidates'),
  metric_anomaly_episodes: history('anomaly episodes'),
  metric_anomaly_incidents: history('anomaly incidents'),
  metric_rollups: history('metric rollups'),
  monitor_device_state: configuration('monitor latch and pause'),
  monitor_episodes: history('monitor episodes'),
  network_change_events: history('network change events'),
  network_monitor_results: history('monitor results'),
  offline_transition_effects: history('server-side effects of a past offline transition'),
  onedrive_device_state: handled('install_state', 'the old install’s signed-in users are dropped'),
  pam_actuation_results: history('append-only PAM evidence'),
  pam_actuations: handled('pam', 'open actuations fail (superseded_by_reinstall)'),
  pam_ledger_retirements: history('PAM lineage, system-only'),
  partner_export_device_material_state: history('trigger-maintained export state'),
  patch_job_results: handled('commands', 'settled with the job counters through the cancelled commands'),
  patch_rollbacks: handled('work_in_flight', 'pending/running rollbacks are cancelled'),
  peripheral_events: history('peripheral telemetry'),
  peripheral_policy_delivery_events: history('append-only delivery evidence'),
  peripheral_policy_device_states: handled('install_state', 'the applied tuple is cleared so policy is resent'),
  playbook_executions: handled('work_in_flight', 'running executions are cancelled'),
  provision_credential_handles: handled('grants', 'unfetched one-time credentials of the old install are deleted'),
  psa_ticket_mappings: history('PSA ticket links'),
  recovery_key_access_events: history('recovery key audit'),
  recovery_readiness: history('derived readiness'),
  recovery_tokens: handled('backup_recovery', 'live recovery tokens are revoked'),
  remediation_suggestions: history('proposals; running one is fresh, gated work'),
  remote_sessions: handled('sessions', 'live sessions are disconnected'),
  restore_jobs: handled('backup_recovery', 'pending/running restores are cancelled'),
  s1_actions: history('vendor-side SentinelOne actions'),
  s1_agents: history('SentinelOne inventory, re-matched by sync'),
  s1_threats: history('vendor threats'),
  script_executions: handled('commands', 'settled through the cancelled commands'),
  script_proposals: history('immutable proposals; they run only through an intent'),
  security_agent_device_status: history('derived security agent coverage'),
  security_posture_snapshots: history('posture history'),
  security_scans: handled('work_in_flight', 'queued/running scans fail'),
  security_status: history('posture, replaced by the next report'),
  security_threats: history('threats'),
  sensitive_data_findings: history('findings'),
  sensitive_data_scans: handled('work_in_flight', 'queued/running scans fail'),
  service_process_check_results: history('check results'),
  software_compliance_status: handled('install_state', 'remediation state of the old install is dropped'),
  software_inventory: history('software projection, replaced by each accepted report'),
  software_inventory_observations: history('immutable inventory evidence'),
  software_policy_audit: history('software policy audit'),
  software_remediation_requests: handled('grants', 'unused MFA-gated authorizations expire'),
  sql_instances: history('SQL Server discovery'),
  support_sessions: history('ephemeral-device Quick Support sessions; ephemeral devices are never a target'),
  tickets: history('tickets (§5.1)'),
  time_series_metrics: history('metrics'),
  topology_device_presence: history('derived presence'),
  topology_device_presence_days: history('presence history'),
  topology_node_bindings: configuration('topology binding'),
  topology_site_fingerprints: history('derived site fingerprints'),
  topology_telemetry_arms: handled('work_in_flight', 'arms using it as collector are blocked'),
  tunnel_sessions: handled('sessions', 'live tunnels are disconnected'),
  unifi_collectors: configuration('UniFi controller collector; the API key is the controller’s'),
  // ee/workspace (EXTENSION_TABLES)
  workspace_crawl_runs: history('crawl runs; a stale running crawl is abandoned by its own sweep'),
  workspace_file_activity: history('file activity'),
  workspace_file_index: history('file index'),
  workspace_sources: configuration('crawl source pinned to the device'),
};

/** The `handler` entries of the manifest, by handler id. */
export function classifiedTablesByHandler(): Map<string, string[]> {
  const byHandler = new Map<string, string[]>();
  for (const [table, entry] of Object.entries(INSTALL_BOUNDARY_CLASSIFICATION)) {
    if (entry.class !== 'handler') continue;
    byHandler.set(entry.handler, [...(byHandler.get(entry.handler) ?? []), table]);
  }
  return byHandler;
}
