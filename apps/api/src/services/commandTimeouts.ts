import { CommandTypes } from './commandTypes';

// ── Timeout tiers (milliseconds) ──────────────────────────────────
const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;
const THREE_HOURS = 3 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = THIRTY_MINUTES;
// Extra buffer on top of a script's own timeout, so the agent-side timeout
// always fires first. Exported because the stale reaper needs it as the floor
// for its SQL pre-filter: every per-script deadline is at least this long, so
// nothing younger than the buffer can be due (#3190).
export const SCRIPT_GRACE_BUFFER_MS = 5 * 60 * 1000;
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
  CommandTypes.CAPTURE_PPROF,
  CommandTypes.PERIPHERAL_POLICY_SYNC,
  CommandTypes.PERIPHERAL_POLICY_SYNC_V2,
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
  CommandTypes.SYSTEM_CLEANUP_LIST,
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

/**
 * A diagnostic plan's own lifetime ceiling (120s, topologyDiagnosticLimitsSchema)
 * plus a delivery grace. Deliberately shorter than every other tier: an
 * accepted-but-delayed diagnostic must EXPIRE, never acquire a fresh execution
 * budget when the agent reconnects.
 */
export const NETWORK_DIAGNOSTIC_TIMEOUT_MS = 150 * 1000;

/**
 * #6415 — WHOLE-MACHINE restores. These six used to share a flat 60 minutes
 * measured from `executed_at`, and the reaper has no progress term
 * (`jobs/staleCommandReaper.ts`: `due = now - executedAt >= timeoutMs`), so a
 * healthy rebuild was terminalised a third of the way through: the #5498 lab
 * run measured 1 h 57 m, 2 h 41 m and 3 h 15 m for a ~106k-file Linux root.
 * The restore loop is latency-bound (one presign hop + one object GET per
 * file, ~10 files/s), so a cloud provider's RTT makes this slower, not faster
 * — **every** realistic whole-machine restore exceeds 60 minutes.
 *
 * Why a ceiling and not a stall clock. `backup_jobs` can use a 15-minute stall
 * window because the agent streams `backup_progress` continuously into
 * `last_progress_at`. Nothing equivalent exists here: `device_commands` has no
 * progress column, four of these six types report nothing at all mid-flight,
 * and the BMR pair's only mid-flight signal is a PHASE transition posted to
 * `/bmr/recover/progress` — the whole 3-hour restore sits inside a single
 * `restoring` phase. A stall clock keyed on that signal would reap healthy
 * restores EARLIER than the bug being fixed here. Until a real per-command
 * progress channel exists, the ceiling is the honest control, and 24 h mirrors
 * `BACKUP_ABSOLUTE_TIMEOUT_MS`, which the backup reaper applies for exactly
 * the same reason ("legacy agents: no progress signal exists").
 *
 * Cost of the wider ceiling: a genuinely dead restore holds its `sent` row (and
 * its snapshot pin) for up to 24 h instead of 1 h. That is the deliberate
 * trade — a disconnect mid-restore is not evidence of failure here, and the
 * previous setting produced a false "failed" on every real recovery.
 *
 * #6437: `/mssql/restore` and `/hyperv/restore` used to wait synchronously on
 * `executeCommand(..., { timeoutMs: 600000 })`, which terminalised those two
 * REST flows after 10 minutes regardless of this ceiling. Both now dispatch
 * async via `queueCommandForExecution` (the D20 queued-ack pattern from
 * #5447/PR #5461), so this reaper ceiling is what actually owns their
 * deadline too.
 */
export const WHOLE_MACHINE_RESTORE_TIMEOUT_MS = TWENTY_FOUR_HOURS;

const RESTORE_TIMEOUT_TYPES = new Set<string>([
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
  CommandTypes.BMR_RECOVER,
  CommandTypes.BARE_METAL_REBUILD,
  CommandTypes.MSSQL_RESTORE,
  CommandTypes.HYPERV_RESTORE,
]);

const LONG_TIMEOUT_TYPES = new Set<string>([
  CommandTypes.AGENT_ROLLBACK_V1,
  // #3525: deliberately NOT SHORT_TIMEOUT_TYPES. The generic reaper clocks
  // `pending` rows from createdAt (jobs/staleCommandReaper.ts), so a 5-minute
  // tier would expire a cancel that a merely-offline device never received —
  // while the cancellation clock, which starts at DELIVERY, has not started.
  // Two hours strictly exceeds the longest possible script lifetime
  // (MaxTimeout 3600s + SCRIPT_GRACE_BUFFER_MS = 65 min), so a cancel never
  // outlives the script it is chasing.
  CommandTypes.SCRIPT_CANCEL,
  // #5128: software_install used to get a bespoke SEVEN_DAYS here, standing in
  // for a delivery deadline this module has no business owning. `deliver_by`
  // now carries that, so this is purely the EXECUTION budget for an install the
  // agent has already claimed — two hours, above the agent's own 15 min
  // download + 30 min install ceilings.
  CommandTypes.SOFTWARE_INSTALL,
  CommandTypes.INSTALL_PATCHES,
  CommandTypes.BACKUP_VERIFY,
  CommandTypes.BACKUP_TEST_RESTORE,
  CommandTypes.BACKUP_CLEANUP,
  CommandTypes.MSSQL_BACKUP,
  CommandTypes.HYPERV_BACKUP,
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
  if (
    commandType === CommandTypes.NETWORK_DIAGNOSTIC ||
    commandType === CommandTypes.NETWORK_DIAGNOSTIC_CANCEL
  )
    return NETWORK_DIAGNOSTIC_TIMEOUT_MS;
  if (SHORT_TIMEOUT_TYPES.has(commandType)) return FIVE_MINUTES;
  if (MEDIUM_TIMEOUT_TYPES.has(commandType)) return THIRTY_MINUTES;
  if (RESTORE_TIMEOUT_TYPES.has(commandType)) return WHOLE_MACHINE_RESTORE_TIMEOUT_MS;
  // Disk Cleanup v2: a native run's real budget is per-selection and lives on
  // the row; this is the ceiling that keeps the reaper from terminalising a
  // command whose run is still inside it.
  if (commandType === CommandTypes.SYSTEM_CLEANUP_RUN) return THREE_HOURS;
  if (LONG_TIMEOUT_TYPES.has(commandType)) return TWO_HOURS;
  if (!EXCLUDED_COMMAND_TYPES.has(commandType)) {
    console.warn(`[commandTimeouts] Unknown command type "${commandType}" using default ${DEFAULT_TIMEOUT_MS / 60000}min timeout`);
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * The CEILING for one native cleanup run's command row (Disk Cleanup v2 §5.3,
 * §13 #14).
 *
 * It is not the run's budget. The budget is a function of the SELECTION —
 * `systemCleanupRunBudgetMs` in `@breeze/shared/validators`, Σ the chosen
 * actions' own timeouts + 10 minutes — and is computed once at queue time and
 * **stored on the row** as `plan.deadlineAt`. Both clocks that matter read
 * that stored value: the route's lazy `running → failed ('timed out')`
 * transition and, through it, the operator's view.
 *
 * This constant exists only because `getCommandTimeoutMs` is keyed by TYPE and
 * cannot see a selection. Three hours is the same cap the budget function
 * applies, so the reaper can never terminalise a command row while its run is
 * still legitimately inside its own budget.
 */
export const SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS = THREE_HOURS;
