/**
 * Device cascade registration lists (#4142 W3).
 *
 * The tables permanent device deletion reclaims, detaches or unlinks, and the
 * per-table predicates it deletes by. They moved here from
 * routes/devices/core.ts so services/deviceDeletion.ts, and every purge worker
 * over it, no longer imports a route file for data: that edge pinned
 * deviceBulkPurge, quickSupportReaper and removedDevicePurge to socket-owner
 * placement in the worker registry.
 *
 * Keep this module a leaf over the schema (drizzle-orm and the extension
 * tenancy registry only). workerEntrypointClosure.contract.test.ts fails if it
 * reaches any routes/ file. cascadeDelete.test.ts guards the lists themselves.
 */
import { sql, type SQL } from 'drizzle-orm';
import { withExtensionDeviceCascade } from '../extensions/tenancyRegistry';

/**
 * Tables where linked_device_id (not device_id) references devices.id.
 * These get SET NULL rather than deleted during cascade.
 */
export const DEVICE_LINKED_DEVICE_ID_TABLES = [
  'network_change_events',
  'discovered_assets',
  // #4622 — a manual asset points at the device an agent was later installed
  // on. DETACHED, never deleted: the row is hand-entered inventory (serial,
  // asset tag, assigned contact, notes) that must outlive the device row.
  // No DEVICE_LINK_DEPENDENT_COLUMNS entry: manual_assets declares no
  // link-conditional CHECK constraint, so nothing else needs clearing.
  // Deliberately absent from CORE_DEVICE_ORG_DENORMALIZED_TABLES too — it has
  // no device_id column, so it is link-only rather than device-managed, and
  // moveOrg.coverage.test.ts reports a listed non-device-managed table as an
  // orphan. Its cross-org detach is hand-written in moveOrg.ts instead.
  'manual_assets',
] as const;

/**
 * Per-table columns that describe the LINK rather than the row, keyed by a
 * table in {@link DEVICE_LINKED_DEVICE_ID_TABLES}. Each must be cleared in the
 * SAME `UPDATE` that nulls `linked_device_id` (services/deviceDeletion.ts).
 *
 * #3952 — `discovered_assets.link_source` records HOW the asset came to be
 * linked ('manual' | 'auto'), and 2026-06-27-discovered-asset-link-source.sql
 * forbids the nonsensical "source without a link":
 *
 *   CHECK (link_source IS NULL OR linked_device_id IS NOT NULL)
 *
 * The cascade nulled `linked_device_id` alone, leaving `link_source = 'auto'`
 * behind, so permanently deleting any AUTO-linked device raised 23514 and
 * rolled the whole transaction back as a 500 — a self-hoster hit this on
 * 0.107.0.
 *
 * The constraint draws NO manual/auto distinction: a manually-linked asset
 * failed identically. 'auto' is simply what the bug report carried, and why no
 * manual-link report arrived is NOT established — do not read the reported
 * shape as the bug's boundary. (It is specifically not an API asymmetry:
 * #3261/#3295 removed the manual-only rule from the unlink route on
 * 2026-08-11, ten days before 0.107.0 was tagged, so by then that route
 * unlinked both.) The integration test covers both link sources for this
 * reason.
 *
 * Rows are DETACHED, never deleted: a discovered asset is a network-inventory
 * record about an endpoint that exists whether or not Breeze manages it, and
 * it carries operator-curated state (label, notes, tags, approval/dismissal,
 * type classification, first_seen_at) that must outlive the device row. The
 * table's membership in {@link DEVICE_LINKED_DEVICE_ID_TABLES} already encodes
 * that decision — this registry only completes the detach.
 *
 * NOT every linked table belongs here, which is why this is per-table and not
 * a flat column list: `network_change_events` has no `link_source`, and
 * appending the assignment there would trade 23514 for 42703
 * (undefined_column) — a 500 either way.
 *
 * `auto_link_suppressed_at` is deliberately ABSENT. It is a durable record of
 * a human's "stop re-linking this" (#3261), not a property of the link, and
 * the CHECK constraint does not cover it. Deleting a device says nothing about
 * that preference, so the cascade must leave it alone.
 *
 * cascadeDelete.test.ts derives the required entries from the CHECK
 * constraints in apps/api/migrations and fails CI when one is missing.
 */
export const DEVICE_LINK_DEPENDENT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  discovered_assets: ['link_source'],
};

/**
 * Tables with a device_id FK to devices.id whose rows are tenant business
 * records — preserve history, detach the device (device_id SET NULL) instead
 * of cascade-deleting during permanent device deletion. Deviceless tickets
 * are first-class (tickets.device_id is nullable).
 */
// support_sessions (Quick Support) detaches rather than cascades: the session
// row is the audit trail for an ad-hoc support session and must outlive the
// ephemeral device the reaper purges 6h after the session ends. Its device_id
// FK is declared ON DELETE SET NULL to match.
// abuse_endpoint_fingerprints (recidivist-endpoint abuse detector) also
// detaches: it's an operator corpus that must survive device hard-delete so
// cross-partner endpoint correlation still works after the originating
// device is gone. Its device_id FK is declared ON DELETE SET NULL to match.
// invoice_line_devices (#3205 W07) also detaches: the row is billing evidence
// that must outlive the device it names — a past invoice still says which
// devices it charged for, by hostname, after a hard delete. Its device_id FK is
// declared ON DELETE SET NULL to match, and the table is deliberately NOT
// append-only so this generic UPDATE loop can run as breeze_app.
// ai_operator_tasks (#5205 W03, #5208) also detaches: an AI Operator task is
// durable remediation history — what was attempted, on what, with what result —
// and must outlive the device it targeted, exactly like an agent run. Its
// device_id FK is ON DELETE SET NULL to match. Two callers stamp the reason
// beyond the generic device_id = NULL this list drives: deviceDeletion.ts
// ('device_deleted') and moveOrg.ts ('device_moved'); both also fence any live
// task, because a task whose target has vanished must not keep executing.
// ai_operator_task_targets (recipe library E2, #6167) detaches for the same
// reason one level down: a target is the frozen record of WHAT a task was
// pointed at, and its target_label must outlive the device. Three callers stamp
// more than the generic device_id = NULL this list drives — deviceDeletion.ts
// ('device_deleted'), moveOrg.ts ('device_moved') and the merge fence
// ('org_merged') — and all three also set state = 'detached'. The generic
// device_id = NULL is itself safe: the table's BEFORE UPDATE trigger
// ai_operator_task_targets_stamp_detach stamps the detach in the same row
// write, which one_pointer_chk requires.
export const DEVICE_DETACH_DEVICE_ID_TABLES = [
  'abuse_endpoint_fingerprints', 'ai_agent_runs', 'ai_operator_task_targets', 'ai_operator_tasks', 'invoice_line_devices', 'support_sessions', 'tickets',
] as const;

/**
 * All tables with a device_id column that device deletion must reclaim,
 * ordered so children come before parents (to avoid FK violations during
 * cascade delete). Most FK to devices.id; the PAM chain and ownership-epoch
 * tables have none and are deleted by exact epoch (see
 * DEVICE_CASCADE_DELETE_PREDICATES).
 *
 * Tables whose only FK to devices is via an intermediate table with ON DELETE CASCADE
 * (e.g. vault_snapshot_inventory → local_vaults) don't need to be listed here.
 *
 * IMPORTANT: When you add a new table with a device_id FK, add it here.
 * The test in cascadeDelete.test.ts will fail CI if you forget.
 */
const CORE_DEVICE_CASCADE_DELETE_TABLES = [
  'topology_node_bindings',
  'topology_device_presence',
  'topology_device_presence_days',
  'bare_metal_recoveries',
  'offline_transition_effects',
  // recovery_tokens & backup_chains FK to backup_snapshots (no cascade),
  // so delete them first, then restore_jobs → backup_snapshots → backup_jobs
  'recovery_tokens', 'backup_chains',
  // Brokered storage sessions reference the snapshot, the command and the
  // device (executing = device_id; the snapshot's source device cascades by FK).
  // A write session's multipart upload rows go first, then the session, then
  // the snapshot id reservations it names (deleting a reservation tombstones
  // its id).
  'backup_storage_session_uploads',
  'backup_storage_sessions',
  // Restore authorizations reference the snapshot, the target device and a
  // recovery token or recovery (all CASCADE); listed before them anyway.
  'backup_restore_authorizations',
  // Snapshot attestations reference the snapshot, the job and the device.
  'backup_snapshot_attestations',
  'backup_snapshot_id_reservations',
  'restore_jobs', 'backup_verifications', 'backup_snapshots', 'backup_jobs', 'backup_snapshot_retirements',
  // Application backup & DR
  'sql_instances', 'local_vaults', 'hyperv_vms',
  // Deployment invites (FK device_id → devices.id; no cascade)
  'deployment_invites',
  // Core device tables
  // Latest projection references the immutable observation, so it must be
  // deleted before the observation in the explicit device cascade.
  'device_agent_health_latest', 'device_software_inventory_state',
  // #5290 — monitor_device_state.current_episode_id FKs to monitor_episodes
  // (ON DELETE SET NULL), so delete the state rows before the episodes.
  'monitor_device_state', 'monitor_episodes',
  'agent_health_observations', 'software_inventory_observations',
  'device_group_memberships', 'group_membership_log',
  'device_hardware',
  'device_hardware_components',
  'device_hardware_events',
  'device_hardware_health',
  'device_time_daily',
  'device_time_status',
  'device_wake_attempts',
  'device_wake_status',
  'device_network', 'device_ip_history', 'device_disks', 'device_memory_modules',
  'device_metrics', 'device_software', 'device_registry_state', 'device_config_state',
  // Restore-checkpoint attempt ledger (#4755) — FK (device_id, org_id) ->
  // devices(id, org_id) ON DELETE CASCADE; leaf table, no children. Default
  // device_id predicate (no DEVICE_CASCADE_DELETE_PREDICATES entry).
  'device_restore_point_attempts',
  // Vendor update policy side (#11242) — FK (device_id, org_id) -> devices(id, org_id)
  // ON DELETE CASCADE; leaf table, no children.
  'device_oem_policy_side',
  // Vendor update status (#11068) — FK (device_id, org_id) -> devices(id, org_id)
  // ON DELETE CASCADE; leaf table, no children.
  'device_oem_update_status',
  // Network-isolation episodes (#10089) — FK (device_id, org_id) -> devices(id, org_id) ON DELETE CASCADE;
  // leaf table, no children. Device delete with an unresolved episode is refused upstream (W1c).
  'device_network_isolations',
  'device_commands', 'device_connections', 'device_boot_metrics',
  'device_sessions', 'device_change_log', 'device_warranty', 'device_vulnerabilities',
  // #3834 — workload inventory: leaf tables, FK (device_id, org_id) ->
  // devices(id, org_id) ON DELETE CASCADE.
  'device_workload_runtimes', 'device_workloads',
  // Administrator-approved diagnostic read grants — FK device_id -> devices.id
  // plus a deferred composite (device_id, org_id) -> devices(id, org_id), both
  // without cascade. approval_requests rows reference it ON DELETE SET NULL;
  // a BEFORE DELETE trigger expires their pending cards first. Grants for a
  // deleted device are void.
  'diagnostic_access_grants',
  // Durable external-system identity (#3257 W06) — FK (device_id, org_id) ->
  // devices(id, org_id) ON DELETE CASCADE; leaf table, no children.
  'device_external_links',
  // mTLS certificate history (Wave 5 Task 2, security remediation) — FK
  // device_id -> devices.id ON DELETE CASCADE (composite with org_id);
  // leaf table, no children.
  'device_mtls_certificates',
  // custom-field values (#3257 W05) — FK (device_id, org_id) ->
  // devices(id, org_id) ON DELETE CASCADE; leaf table, no children.
  'device_custom_field_values',
  // device function assessments (Fleet Designer W02, #5652) — FK
  // (device_id, org_id) -> devices(id, org_id) ON DELETE CASCADE; leaf table,
  // no children.
  'device_function_assessments',
  // Patches
  'device_patches', 'patch_job_results', 'patch_rollbacks',
  // Deployments & software
  'deployment_devices', 'deployment_results', 'software_inventory',
  'software_compliance_status', 'software_policy_audit', 'software_remediation_requests',
  // Remote access
  'remote_sessions', 'tunnel_sessions',
  // Monitoring & logs. Site-owned topology alerts detach before this sweep;
  // only device-owned alerts still reference the device and are deleted.
  'service_process_check_results', 'alerts', 'agent_logs', 'script_executions',
  // #5291 W04 - probe results now name the device they ran FROM.
  'network_monitor_results',
  'device_event_logs', 'automation_policy_compliance', 'backup_sla_events',
  // Per-device automation execution results (FK device_id → devices.id ON DELETE
  // CASCADE; leaf table, no children) — #2023
  'automation_action_results', 'automation_run_device_results',
  // Security
  'sensitive_data_scans', 'sensitive_data_findings',
  'dns_security_events', 'dns_event_aggregations',
  'security_status', 'security_threats', 'security_scans', 'security_posture_snapshots',
  // #6960 W03 — security-agent coverage; FK (device_id, org_id) ON DELETE CASCADE.
  'security_agent_device_status',
  'cis_baseline_results', 'cis_remediation_actions',
  'browser_extensions', 'browser_policy_violations',
  'audit_baseline_results', 'audit_policy_states',
  // Recovery-key escrow (#2021). Both FK device_id → devices.id ON DELETE
  // CASCADE; recovery_key_access_events.key_id → device_recovery_keys.id
  // ON DELETE CASCADE, so delete the access-event ledger before its parent keys.
  'recovery_key_access_events', 'device_recovery_keys',
  // PAM chain + ownership-epoch lineage (#8203, #8204, spec §4.4). None of
  // these has an FK to devices any more: the chain FKs onto the epoch row, and
  // the epoch tables have no device FK at all. Every entry here is deleted by
  // the EXACT current epoch, (device_id, org_id, epoch) = the live device's —
  // see DEVICE_CASCADE_DELETE_PREDICATES below — so an earlier epoch's rows,
  // which are another org's evidence (or the same org's, on A -> B -> A),
  // survive the device. Order: results, actuations (FK -> epoch, results FK ->
  // actuation), requests (FK -> epoch, NO ACTION; elevation_audit cascades from
  // the request), closures (FK -> epoch), then the epoch row itself.
  // pam_ledger_retirements carries no org or evidence and cascades from
  // devices by FK; it is deleted by device_id.
  'pam_actuation_results', 'pam_actuations', 'elevation_requests',
  'device_ownership_epoch_closures', 'device_ownership_epochs', 'pam_ledger_retirements',
  // Endpoint messaging (#8742 W02): receipts before deliveries (receipts ->
  // deliveries FK, ON DELETE CASCADE either way).
  'endpoint_message_receipts', 'endpoint_message_deliveries',
  // Endpoint live chat (#8743 W03): messages before conversations (messages ->
  // conversations FK, ON DELETE CASCADE either way).
  'endpoint_conversation_messages', 'endpoint_conversations',
  'peripheral_policy_delivery_events', 'peripheral_policy_device_states', 'peripheral_events',
  'agent_rollback_events', 'agent_rollback_directives',
  's1_agents', 's1_threats', 's1_actions',
  'huntress_agents', 'huntress_incidents',
  // AI & context
  'ai_sessions', 'ai_screenshots', 'brain_device_context',
  // Unattended-exposure ledger (Wave 5 Part A, #3827) — live device_id
  // column (NOT NULL), no FK to devices, leaf table, no children. Same
  // situation as fleet_finding_devices below: the app-level DELETE is the
  // only thing that reclaims these rows.
  'ai_unattended_exposure',
  // Fix-held watch ledger (Wave 6 PR 2, #3828) — live device_id column
  // (NOT NULL), no FK to devices, leaf table, no children. Same situation
  // as ai_unattended_exposure directly above: the app-level DELETE is the
  // only thing that reclaims these rows. NOT in ai_agent_circuit_state's
  // company here — that table has no device_id column at all (org_id +
  // agent_id only), so it needs no entry in this device-cascade list.
  'ai_agent_fix_watches',
  // AI Suggested Fixes W1 — attempt history for a deleted device goes with it
  // (no device FK; leaf table). deleteDeviceCascade deletes these rows first
  // through fixMemory/store deleteDeviceFixOutcomes, which stale-marks the
  // aggregates they fed so the sweeper rebuilds them (#7278); this generic
  // entry then finds nothing. Listed for the coverage contract.
  'fix_outcomes',
  // Analytics & reliability
  'device_reliability_history', 'device_reliability_baselines', 'device_reliability',
  'playbook_executions', 'time_series_metrics', 'capacity_predictions',
  'device_process_samples', 'remediation_suggestions',
  // metric_anomaly_episodes: device_id + denormalized org_id (episodes W01). Its
  // only inbound FK is metric_anomalies.episode_id ON DELETE SET NULL, so the
  // position relative to metric_anomalies is not load-bearing.
  'metric_anomaly_candidates', 'metric_anomalies', 'metric_anomaly_episodes', 'metric_anomaly_incidents', 'metric_rollups',
  // Portal & integrations (tickets are detached, not deleted —
  // see DEVICE_DETACH_DEVICE_ID_TABLES)
  'psa_ticket_mappings', 'asset_checkouts', 'asset_physical_placements',
  // Filesystem
  'device_filesystem_snapshots', 'device_filesystem_cleanup_runs', 'device_filesystem_scan_state',
  // Backup verification
  'recovery_readiness',
  // Provisioning one-time credential handles (FK device_id → devices.id ON DELETE CASCADE;
  // listed for the explicit-cascade coverage contract — leaf table, no children)
  'provision_credential_handles',
  // OneDrive helper — persisted device state (PK = device_id; leaf table, no children)
  'onedrive_device_state',
  // Fleet hygiene finding membership — live device_id column (no FK; the
  // device-move trigger rewrites org_id in place), leaf table, no children.
  'fleet_finding_devices',
] as const;

export function getDeviceCascadeDeleteTables(): readonly string[] {
  return withExtensionDeviceCascade(CORE_DEVICE_CASCADE_DELETE_TABLES);
}

/** The live device's current ownership, read under the deletion's row lock. */
export interface DeviceCurrentOwnership {
  deviceId: string;
  orgId: string;
  ownershipEpoch: number;
}

/**
 * Per-table row predicate for device permanent deletion, replacing the default
 * `device_id = $device` (PAM ownership epochs W2, #8204, spec §4.4). Each entry
 * matches only the device's CURRENT ownership epoch. The ownership is passed in
 * as literals rather than re-read in a subquery because the append-only tables
 * are deleted under `breeze_audit_admin`, which cannot read `devices`. Every
 * key must also be in CORE_DEVICE_CASCADE_DELETE_TABLES (cascadeDelete.test.ts).
 */
const currentEpochPredicate = (epochColumn: 'device_epoch' | 'epoch') => (o: DeviceCurrentOwnership): SQL =>
  sql`(device_id, org_id, ${sql.identifier(epochColumn)}) = (${o.deviceId}::uuid, ${o.orgId}::uuid, ${o.ownershipEpoch}::integer)`;

export const DEVICE_CASCADE_DELETE_PREDICATES: ReadonlyMap<string, (o: DeviceCurrentOwnership) => SQL> = new Map([
  ['pam_actuation_results', currentEpochPredicate('device_epoch')],
  ['pam_actuations', currentEpochPredicate('device_epoch')],
  ['elevation_requests', currentEpochPredicate('device_epoch')],
  ['device_ownership_epoch_closures', currentEpochPredicate('epoch')],
  ['device_ownership_epochs', currentEpochPredicate('epoch')],
]);

/** @deprecated Static core-only snapshot retained for call sites that predate extensions. */
export const DEVICE_CASCADE_DELETE_TABLES = CORE_DEVICE_CASCADE_DELETE_TABLES;
