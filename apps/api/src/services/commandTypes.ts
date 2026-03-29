// Command type constants and audited command set.
// Extracted from commandQueue.ts to keep file sizes manageable.

// Command types for system tools
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

  // Software management
  SOFTWARE_UNINSTALL: 'software_uninstall',
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

  // Peripheral control — pushes full active policy set to agent
  PERIPHERAL_POLICY_SYNC: 'peripheral_policy_sync',

  // Log shipping
  SET_LOG_LEVEL: 'set_log_level',

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
  // Self-uninstall (remote wipe)
  SELF_UNINSTALL: 'self_uninstall',
  // Backup verification
  BACKUP_VERIFY: 'backup_verify',
  BACKUP_TEST_RESTORE: 'backup_test_restore',
  BACKUP_CLEANUP: 'backup_cleanup',

  // VSS backup management
  VSS_STATUS: 'vss_status',
  VSS_WRITER_LIST: 'vss_writer_list',

  // Bare metal recovery / system state
  SYSTEM_STATE_COLLECT: 'system_state_collect',
  HARDWARE_PROFILE: 'hardware_profile',
  VM_RESTORE_FROM_BACKUP: 'vm_restore_from_backup',
  VM_RESTORE_ESTIMATE: 'vm_restore_estimate',
  VM_INSTANT_BOOT: 'vm_instant_boot',
  BMR_RECOVER: 'bmr_recover',

  // MSSQL backup management
  MSSQL_DISCOVER: 'mssql_discover',
  MSSQL_BACKUP: 'mssql_backup',
  MSSQL_RESTORE: 'mssql_restore',
  MSSQL_VERIFY: 'mssql_verify',

  // Hyper-V VM backup management
  HYPERV_DISCOVER: 'hyperv_discover',
  HYPERV_BACKUP: 'hyperv_backup',
  HYPERV_RESTORE: 'hyperv_restore',
  HYPERV_CHECKPOINT: 'hyperv_checkpoint',
  HYPERV_VM_STATE: 'hyperv_vm_state',

  // Local vault (SMB share / USB drive)
  VAULT_SYNC: 'vault_sync',
  VAULT_STATUS: 'vault_status',
  VAULT_CONFIGURE: 'vault_configure',
} as const;

export type CommandType = typeof CommandTypes[keyof typeof CommandTypes];

// Commands that modify system state or access sensitive data (e.g., screen capture) and should always be audit-logged
export const AUDITED_COMMANDS: Set<string> = new Set([
  CommandTypes.KILL_PROCESS,
  CommandTypes.START_SERVICE,
  CommandTypes.STOP_SERVICE,
  CommandTypes.RESTART_SERVICE,
  CommandTypes.TASK_RUN,
  CommandTypes.TASK_ENABLE,
  CommandTypes.TASK_DISABLE,
  CommandTypes.REGISTRY_SET,
  CommandTypes.REGISTRY_DELETE,
  CommandTypes.REGISTRY_KEY_CREATE,
  CommandTypes.REGISTRY_KEY_DELETE,
  CommandTypes.FILE_WRITE,
  CommandTypes.FILE_DELETE,
  CommandTypes.FILE_MKDIR,
  CommandTypes.FILE_RENAME,
  CommandTypes.FILE_COPY,
  CommandTypes.FILE_TRASH_RESTORE,
  CommandTypes.FILE_TRASH_PURGE,
  CommandTypes.TERMINAL_START,
  CommandTypes.SCRIPT,
  CommandTypes.PATCH_SCAN,
  CommandTypes.INSTALL_PATCHES,
  CommandTypes.ROLLBACK_PATCHES,
  CommandTypes.SOFTWARE_UNINSTALL,
  CommandTypes.CIS_BENCHMARK,
  CommandTypes.APPLY_CIS_REMEDIATION,
  CommandTypes.SECURITY_SCAN,
  CommandTypes.SECURITY_THREAT_QUARANTINE,
  CommandTypes.SECURITY_THREAT_REMOVE,
  CommandTypes.SECURITY_THREAT_RESTORE,
  CommandTypes.SENSITIVE_DATA_SCAN,
  CommandTypes.ENCRYPT_FILE,
  CommandTypes.SECURE_DELETE_FILE,
  CommandTypes.QUARANTINE_FILE,
  CommandTypes.TAKE_SCREENSHOT,
  CommandTypes.COMPUTER_ACTION,
  CommandTypes.MANAGE_STARTUP_ITEM,
  CommandTypes.APPLY_AUDIT_POLICY_BASELINE,
  // Peripheral control — pushes full active policy set to agent
  CommandTypes.PERIPHERAL_POLICY_SYNC,
  // Safe mode reboot
  CommandTypes.REBOOT_SAFE_MODE,
  // Self-uninstall (remote wipe)
  CommandTypes.SELF_UNINSTALL,
  CommandTypes.BACKUP_VERIFY,
  CommandTypes.BACKUP_TEST_RESTORE,
  CommandTypes.VSS_WRITER_LIST,
  CommandTypes.SYSTEM_STATE_COLLECT,
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
  CommandTypes.BMR_RECOVER,
  CommandTypes.MSSQL_BACKUP,
  CommandTypes.MSSQL_RESTORE,
  CommandTypes.MSSQL_VERIFY,
  CommandTypes.HYPERV_BACKUP,
  CommandTypes.HYPERV_RESTORE,
  CommandTypes.HYPERV_CHECKPOINT,
  CommandTypes.HYPERV_VM_STATE,
  CommandTypes.VAULT_SYNC,
  CommandTypes.VAULT_CONFIGURE,
]);
