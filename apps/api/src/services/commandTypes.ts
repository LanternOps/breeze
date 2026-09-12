/**
 * The canonical `device_commands.type` table.
 *
 * #5128: extracted out of `commandQueue.ts` into a LEAF module with no imports.
 * `commandOfflinePolicy.ts` builds its fail-closed registry from this table at
 * module load, and `commandQueue.ts` imports the enqueue seam, which imports
 * that registry — leaving the table in `commandQueue.ts` made that a genuine
 * ESM initialisation cycle (the registry read `CommandTypes` before
 * `commandQueue`'s body had run, and which side won depended only on which
 * module the process happened to import first). `commandQueue.ts` re-exports
 * both symbols, so every existing `import { CommandTypes } from './commandQueue'`
 * keeps working.
 */
export const CommandTypes = {
  // Process management
  LIST_PROCESSES: 'list_processes',
  GET_PROCESS: 'get_process',
  KILL_PROCESS: 'kill_process',

  // Service management
  LIST_SERVICES: 'list_services',
  GET_SERVICE: 'get_service',
  START_SERVICE: 'start_service',
  STOP_SERVICE: 'stop_service',
  RESTART_SERVICE: 'restart_service',

  // Event logs (Windows)
  EVENT_LOGS_LIST: 'event_logs_list',
  EVENT_LOGS_QUERY: 'event_logs_query',
  EVENT_LOG_GET: 'event_log_get',

  // Scheduled tasks (Windows)
  TASKS_LIST: 'tasks_list',
  TASK_GET: 'task_get',
  TASK_RUN: 'task_run',
  TASK_ENABLE: 'task_enable',
  TASK_DISABLE: 'task_disable',
  TASK_HISTORY: 'task_history',

  // Registry (Windows)
  REGISTRY_KEYS: 'registry_keys',
  REGISTRY_VALUES: 'registry_values',
  REGISTRY_GET: 'registry_get',
  REGISTRY_SET: 'registry_set',
  REGISTRY_DELETE: 'registry_delete',
  REGISTRY_KEY_CREATE: 'registry_key_create',
  REGISTRY_KEY_DELETE: 'registry_key_delete',

  // File operations
  FILE_LIST: 'file_list',
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  FILE_DELETE: 'file_delete',
  FILE_MKDIR: 'file_mkdir',
  FILE_RENAME: 'file_rename',
  FILESYSTEM_ANALYSIS: 'filesystem_analysis',
  FILE_COPY: 'file_copy',
  FILE_TRASH_LIST: 'file_trash_list',
  FILE_TRASH_RESTORE: 'file_trash_restore',
  FILE_TRASH_PURGE: 'file_trash_purge',
  FILE_LIST_DRIVES: 'file_list_drives',

  // Terminal
  TERMINAL_START: 'terminal_start',
  TERMINAL_DATA: 'terminal_data',
  TERMINAL_RESIZE: 'terminal_resize',
  TERMINAL_STOP: 'terminal_stop',

  // Script execution
  SCRIPT: 'script',
  // #3525. WIRE CONTRACT: payload.executionId carries the ORIGINAL script
  // command's `device_commands.id` — the agent keys its running-process map on
  // cmd.ID (agent/internal/heartbeat/handlers_script.go), NOT on
  // script_executions.id. The execution row's own id travels as the additive
  // `scriptExecutionId` field, which deployed agents ignore. Getting this
  // backwards makes cancellation a fleet-wide silent no-op.
  SCRIPT_CANCEL: 'script_cancel',

  // Software management
  SOFTWARE_INSTALL: 'software_install',
  SOFTWARE_UNINSTALL: 'software_uninstall',
  SOFTWARE_UPDATE: 'software_update',
  // Opt-in macOS package-manager bootstrap (installs Homebrew itself).
  HOMEBREW_BOOTSTRAP: 'homebrew_bootstrap',
  CIS_BENCHMARK: 'cis_benchmark',
  APPLY_CIS_REMEDIATION: 'apply_cis_remediation',

  // Patch management
  PATCH_SCAN: 'patch_scan',
  INSTALL_PATCHES: 'install_patches',
  ROLLBACK_PATCHES: 'rollback_patches',
  COLLECT_RELIABILITY_METRICS: 'collect_reliability_metrics',

  // Security
  SECURITY_COLLECT_STATUS: 'security_collect_status',
  SECURITY_SCAN: 'security_scan',
  SECURITY_THREAT_QUARANTINE: 'security_threat_quarantine',
  SECURITY_THREAT_REMOVE: 'security_threat_remove',
  SECURITY_THREAT_RESTORE: 'security_threat_restore',
  SENSITIVE_DATA_SCAN: 'sensitive_data_scan',
  ENCRYPT_FILE: 'encrypt_file',
  SECURE_DELETE_FILE: 'secure_delete_file',
  QUARANTINE_FILE: 'quarantine_file',

  // Disk encryption (BitLocker / FileVault)
  ENCRYPTION_COLLECT_KEYS: 'encryption_collect_keys',
  ENCRYPTION_ROTATE_KEY: 'encryption_rotate_key',

  // Peripheral control — pushes full active policy set to agent
  PERIPHERAL_POLICY_SYNC: 'peripheral_policy_sync',
  PERIPHERAL_POLICY_SYNC_V2: 'peripheral_policy_sync_v2',
  AGENT_ROLLBACK_V1: 'agent_rollback_v1',

  // Log shipping
  SET_LOG_LEVEL: 'set_log_level',

  // Runtime diagnostics — on-demand pprof capture from the agent (#2389).
  // Profiles are captured in-process and returned base64 in the command
  // result; the agent never opens a listening socket for this.
  CAPTURE_PPROF: 'capture_pprof',

  // Screenshot (AI Vision)
  TAKE_SCREENSHOT: 'take_screenshot',

  // Computer control (AI Computer Use)
  COMPUTER_ACTION: 'computer_action',

  // Boot performance
  COLLECT_BOOT_PERFORMANCE: 'collect_boot_performance',
  MANAGE_STARTUP_ITEM: 'manage_startup_item',

  // Audit policy compliance
  COLLECT_AUDIT_POLICY: 'collect_audit_policy',
  APPLY_AUDIT_POLICY_BASELINE: 'apply_audit_policy_baseline',

  // Safe mode reboot (Windows only)
  REBOOT_SAFE_MODE: 'reboot_safe_mode',
  // Wake-on-LAN — sent to a relay agent on the target's LAN, not the offline target itself
  WAKE_ON_LAN: 'wake_on_lan',
  // On-demand inventory refresh — agent re-runs every send*Inventory collector,
  // so the API sees fresh hardware/software/network/etc. without waiting for
  // the next periodic cycle.
  REFRESH_INVENTORY: 'refresh_inventory',
  // Self-uninstall (remote wipe)
  SELF_UNINSTALL: 'self_uninstall',
  // Backup
  BACKUP_RUN: 'backup_run',
  BACKUP_STOP: 'backup_stop',
  BACKUP_RESTORE: 'backup_restore',
  BACKUP_VERIFY: 'backup_verify',
  BACKUP_TEST_RESTORE: 'backup_test_restore',
  BACKUP_CLEANUP: 'backup_cleanup',
  // VSS
  VSS_STATUS: 'vss_status',
  VSS_WRITER_LIST: 'vss_writer_list',
  // MSSQL
  MSSQL_DISCOVER: 'mssql_discover',
  MSSQL_BACKUP: 'mssql_backup',
  MSSQL_RESTORE: 'mssql_restore',
  MSSQL_VERIFY: 'mssql_verify',
  // Hyper-V
  HYPERV_DISCOVER: 'hyperv_discover',
  HYPERV_BACKUP: 'hyperv_backup',
  HYPERV_RESTORE: 'hyperv_restore',
  HYPERV_CHECKPOINT: 'hyperv_checkpoint',
  HYPERV_VM_STATE: 'hyperv_vm_state',
  // System state & BMR
  SYSTEM_STATE_COLLECT: 'system_state_collect',
  HARDWARE_PROFILE: 'hardware_profile',
  VM_RESTORE_FROM_BACKUP: 'vm_restore_from_backup',
  VM_RESTORE_ESTIMATE: 'vm_restore_estimate',
  VM_INSTANT_BOOT: 'vm_instant_boot',
  BMR_RECOVER: 'bmr_recover',
  // Vault
  VAULT_SYNC: 'vault_sync',
  VAULT_STATUS: 'vault_status',
  VAULT_CONFIGURE: 'vault_configure',
  // Incident response
  COLLECT_EVIDENCE: 'collect_evidence',
  EXECUTE_CONTAINMENT: 'execute_containment',
} as const;


export type CommandType = typeof CommandTypes[keyof typeof CommandTypes];

/**
 * `device_commands.type` values whose FIRST reply from the agent may be a
 * non-terminal queue-admission/started ack rather than the real outcome
 * (D20). Mirrors the agent's own `backupipc.IsQueuedWorkload`
 * (agent/internal/backupipc/types.go) MINUS `backup_run`: a backup_run
 * command is dispatched with a non-UUID commandId and never creates a
 * `device_commands` row at all (see routes/agentWs.ts's
 * processOrphanedCommandResult backup-job branch), so it never reaches the
 * device_commands-keyed code this constant gates
 * (services/commandResultAcceptance.ts, routes/agentWs.ts,
 * routes/agents/commands.ts). mssql_backup and hyperv_backup DO create a
 * device_commands row (routes/backup/mssql.ts, hyperv.ts call
 * executeCommand()), so they are the only two types that can actually reach
 * that CAS with a queue ack as the first frame.
 */
export const QUEUED_BACKUP_WORKLOAD_COMMAND_TYPES = [
  CommandTypes.MSSQL_BACKUP,
  CommandTypes.HYPERV_BACKUP,
] as const;
