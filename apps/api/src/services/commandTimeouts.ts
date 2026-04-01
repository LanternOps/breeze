import { CommandTypes } from './commandQueue';

// ── Timeout tiers (milliseconds) ──────────────────────────────────
const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const SIXTY_MINUTES = 60 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = THIRTY_MINUTES;
const SCRIPT_GRACE_BUFFER_MS = 5 * 60 * 1000; // extra buffer on top of per-script timeout
const DEFAULT_SCRIPT_TIMEOUT_S = 300;

// ── Commands that should never be reaped (interactive sessions) ───
export const EXCLUDED_COMMAND_TYPES = new Set<string>([
  CommandTypes.TERMINAL_START,
  CommandTypes.TERMINAL_DATA,
  CommandTypes.TERMINAL_RESIZE,
  CommandTypes.TERMINAL_STOP,
]);

// ── Per-type timeout map ──────────────────────────────────────────
const SHORT_TIMEOUT_TYPES = new Set<string>([
  CommandTypes.LIST_PROCESSES,
  CommandTypes.GET_PROCESS,
  CommandTypes.KILL_PROCESS,
  CommandTypes.LIST_SERVICES,
  CommandTypes.GET_SERVICE,
  CommandTypes.START_SERVICE,
  CommandTypes.STOP_SERVICE,
  CommandTypes.RESTART_SERVICE,
  CommandTypes.EVENT_LOGS_LIST,
  CommandTypes.EVENT_LOGS_QUERY,
  CommandTypes.EVENT_LOG_GET,
  CommandTypes.TASKS_LIST,
  CommandTypes.TASK_GET,
  CommandTypes.TASK_RUN,
  CommandTypes.TASK_ENABLE,
  CommandTypes.TASK_DISABLE,
  CommandTypes.TASK_HISTORY,
  CommandTypes.REGISTRY_KEYS,
  CommandTypes.REGISTRY_VALUES,
  CommandTypes.REGISTRY_GET,
  CommandTypes.REGISTRY_SET,
  CommandTypes.REGISTRY_DELETE,
  CommandTypes.REGISTRY_KEY_CREATE,
  CommandTypes.REGISTRY_KEY_DELETE,
  CommandTypes.FILE_LIST,
  CommandTypes.FILE_READ,
  CommandTypes.FILE_WRITE,
  CommandTypes.FILE_DELETE,
  CommandTypes.FILE_MKDIR,
  CommandTypes.FILE_RENAME,
  CommandTypes.FILE_COPY,
  CommandTypes.FILE_TRASH_LIST,
  CommandTypes.FILE_TRASH_RESTORE,
  CommandTypes.FILE_TRASH_PURGE,
  CommandTypes.FILE_LIST_DRIVES,
  CommandTypes.TAKE_SCREENSHOT,
  CommandTypes.COMPUTER_ACTION,
  CommandTypes.SET_LOG_LEVEL,
  CommandTypes.PERIPHERAL_POLICY_SYNC,
  CommandTypes.COLLECT_BOOT_PERFORMANCE,
  CommandTypes.MANAGE_STARTUP_ITEM,
  CommandTypes.COLLECT_AUDIT_POLICY,
  CommandTypes.SECURITY_COLLECT_STATUS,
]);

const MEDIUM_TIMEOUT_TYPES = new Set<string>([
  CommandTypes.SECURITY_SCAN,
  CommandTypes.PATCH_SCAN,
  CommandTypes.SOFTWARE_UNINSTALL,
  CommandTypes.FILESYSTEM_ANALYSIS,
  CommandTypes.REBOOT_SAFE_MODE,
  CommandTypes.SELF_UNINSTALL,
  CommandTypes.COLLECT_EVIDENCE,
  CommandTypes.EXECUTE_CONTAINMENT,
  CommandTypes.ROLLBACK_PATCHES,
  CommandTypes.COLLECT_RELIABILITY_METRICS,
  CommandTypes.APPLY_CIS_REMEDIATION,
  CommandTypes.APPLY_AUDIT_POLICY_BASELINE,
  CommandTypes.SECURITY_THREAT_QUARANTINE,
  CommandTypes.SECURITY_THREAT_REMOVE,
  CommandTypes.SECURITY_THREAT_RESTORE,
  CommandTypes.BACKUP_RESTORE,
]);

const RESTORE_TIMEOUT_TYPES = new Set<string>([
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
  CommandTypes.BMR_RECOVER,
]);

const LONG_TIMEOUT_TYPES = new Set<string>([
  CommandTypes.INSTALL_PATCHES,
  CommandTypes.BACKUP_VERIFY,
  CommandTypes.BACKUP_TEST_RESTORE,
  CommandTypes.BACKUP_CLEANUP,
  CommandTypes.CIS_BENCHMARK,
  CommandTypes.SENSITIVE_DATA_SCAN,
  CommandTypes.ENCRYPT_FILE,
  CommandTypes.SECURE_DELETE_FILE,
  CommandTypes.QUARANTINE_FILE,
]);

/**
 * Returns the server-side timeout for a command type in milliseconds.
 * For 'script' commands, reads payload.timeoutSeconds and adds a grace buffer
 * so the agent-side timeout fires first.
 */
export function getCommandTimeoutMs(
  commandType: string,
  payload?: Record<string, unknown> | null,
): number {
  if (commandType === CommandTypes.SCRIPT) {
    const timeoutSeconds =
      typeof payload?.timeoutSeconds === 'number'
        ? payload.timeoutSeconds
        : DEFAULT_SCRIPT_TIMEOUT_S;
    return timeoutSeconds * 1000 + SCRIPT_GRACE_BUFFER_MS;
  }
  if (SHORT_TIMEOUT_TYPES.has(commandType)) return FIVE_MINUTES;
  if (MEDIUM_TIMEOUT_TYPES.has(commandType)) return THIRTY_MINUTES;
  if (RESTORE_TIMEOUT_TYPES.has(commandType)) return SIXTY_MINUTES;
  if (LONG_TIMEOUT_TYPES.has(commandType)) return TWO_HOURS;
  if (!EXCLUDED_COMMAND_TYPES.has(commandType)) {
    console.warn(`[commandTimeouts] Unknown command type "${commandType}" using default ${DEFAULT_TIMEOUT_MS / 60000}min timeout`);
  }
  return DEFAULT_TIMEOUT_MS;
}
