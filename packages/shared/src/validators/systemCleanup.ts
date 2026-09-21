/**
 * The OS-native cleanup catalogue, shared by the API route, the web panel and
 * (via a parity test) the Go agent (Disk Cleanup v2 §5.3, §7.2).
 *
 * This list IS the safety model. The native engine has no itemised preview to
 * check a selection against — it hands a fixed set of ids to a Go catalogue
 * that turns each one into an argv built entirely from constants. So the only
 * thing standing between a request body and a privileged process on a
 * customer's machine is "is this id in this list", which is why the list is
 * `as const`, exact-matched, and pinned by tests on both sides of the
 * language boundary (agent/internal/syscleanup/shared_ids_test.go reads THIS
 * file and fails on drift).
 *
 * Deliberately absent, and never to be added without the spec being amended:
 * DownloadsFolder (user data), Windows ESD installation files (breaks Reset
 * this PC), Language Pack (uninstalls installed languages), every per-user
 * cleanmgr handler (under the SYSTEM service account they operate on the
 * SYSTEM profile, and the file engine already covers user bins), and DISM
 * /ResetBase (makes every installed update permanent).
 */

import { z } from 'zod';

export const SYSTEM_CLEANUP_ACTION_IDS = [
  // Windows — cleanmgr. The bare id means "every allowlisted handler present
  // on this device"; each `:slug` selects one handler. The slug maps to a
  // registry key name inside the agent, never here and never on the wire.
  'win_cleanmgr',
  'win_cleanmgr:update_cleanup',
  'win_cleanmgr:delivery_optimization_files',
  'win_cleanmgr:device_driver_packages',
  'win_cleanmgr:previous_installations',
  'win_cleanmgr:upgrade_discarded_files',
  'win_cleanmgr:windows_upgrade_log_files',
  'win_cleanmgr:setup_log_files',
  'win_cleanmgr:temporary_setup_files',
  'win_cleanmgr:service_pack_cleanup',
  'win_cleanmgr:system_error_memory_dump_files',
  'win_cleanmgr:system_error_minidump_files',
  'win_cleanmgr:windows_error_reporting_files',
  'win_cleanmgr:windows_error_reporting_system_archive_files',
  'win_cleanmgr:windows_error_reporting_system_queue_files',
  'win_cleanmgr:temporary_files',
  'win_cleanmgr:windows_defender',
  'win_cleanmgr:old_chkdsk_files',
  'win_cleanmgr:diagnostic_data_viewer_database_files',
  'win_cleanmgr:branchcache',
  'win_cleanmgr:content_indexer_cleaner',
  // Windows — component store.
  'win_dism_component_cleanup',
  // macOS.
  'mac_tm_local_snapshots',
  'mac_brew_cleanup',
  // Linux.
  'linux_pkg_cache_clean',
  'linux_pkg_autoremove',
  'linux_journal_vacuum',
] as const;

export type SystemCleanupActionId = (typeof SYSTEM_CLEANUP_ACTION_IDS)[number];

const actionIdSet: ReadonlySet<string> = new Set<string>(SYSTEM_CLEANUP_ACTION_IDS);

/** Exact membership. No trimming, no case folding, no prefix matching. */
export function isSystemCleanupActionId(value: unknown): value is SystemCleanupActionId {
  return typeof value === 'string' && actionIdSet.has(value);
}

/** Risk flags an action may declare; rendered as badges by the web panel. */
export const SYSTEM_CLEANUP_RISK_FLAGS = [
  'long_running',
  'may_require_reboot',
  'may_require_reboot_free_state',
  'removes_driver_rollback',
  'removes_packages',
  // Spec §13 #15. Two losses a later action cannot undo and that the original
  // catalogue left undisclosed: deleting Windows.old / $WINDOWS.~BT ends the
  // "go back to the previous version" window, and deleting the local APFS
  // snapshots removes the only on-disk restore points a Mac has when its Time
  // Machine destination is not attached.
  'removes_os_rollback',
  'removes_recovery_points',
] as const;

export type SystemCleanupRiskFlag = (typeof SYSTEM_CLEANUP_RISK_FLAGS)[number];

/**
 * Per-action wall-clock caps, mirroring `actionTimeouts` in
 * `agent/internal/syscleanup/catalog.go`. The agent's `shared_ids_test.go`
 * reads this table and fails on drift.
 *
 * The server needs them because it sizes the run's deadline BEFORE queuing
 * (spec §13 #14) — the reaper and the route's lazy timeout both read the
 * stored deadline rather than recomputing it.
 */
export const SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS: Readonly<Record<string, number>> = {
  win_cleanmgr: 60 * 60,
  win_dism_component_cleanup: 90 * 60,
  mac_tm_local_snapshots: 10 * 60,
  mac_brew_cleanup: 10 * 60,
  linux_pkg_cache_clean: 5 * 60,
  linux_pkg_autoremove: 15 * 60,
  linux_journal_vacuum: 5 * 60,
};

/** Slack for probes, the two volume samples and process teardown. */
export const SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS = 10 * 60 * 1000;
/** Nothing a single run may exceed, whatever was selected. */
export const SYSTEM_CLEANUP_RUN_BUDGET_MAX_MS = 3 * 60 * 60 * 1000;

/**
 * Σ the selected actions' own timeouts + slack, capped.
 *
 * A single constant was wrong in both directions (spec §13 #14): a lone
 * `linux_pkg_cache_clean` would hold a two-hour budget for five minutes of
 * work, while cleanmgr (60 min) + DISM (90 min) needs 150 and would have been
 * reaped at 120 — mid-DISM.
 *
 * Duplicates collapse: a bare `win_cleanmgr` and its `:slug` sub-ids are ONE
 * execution on the agent, so they are counted once here too or the budget
 * drifts from the thing it is budgeting.
 */
export function systemCleanupRunBudgetMs(actionIds: readonly string[]): number {
  const counted = new Set<string>();
  let total = 0;
  for (const id of actionIds) {
    const key = id.startsWith('win_cleanmgr:') ? 'win_cleanmgr' : id;
    if (counted.has(key)) continue;
    const seconds = SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS[key];
    if (seconds === undefined) continue;
    counted.add(key);
    total += seconds * 1000;
  }
  return Math.min(total + SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS, SYSTEM_CLEANUP_RUN_BUDGET_MAX_MS);
}

/**
 * The ONE client-influenced integer in the whole feature (spec §5.3). Bounds
 * are mirrored in the agent (clampJournalVacuumBytes) so a request that
 * bypassed this schema still cannot widen them.
 */
export const JOURNAL_VACUUM_MIN_BYTES = 64 * 1024 * 1024;
export const JOURNAL_VACUUM_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const JOURNAL_VACUUM_DEFAULT_BYTES = 256 * 1024 * 1024;

export const systemCleanupParamsSchema = z.object({
  journalVacuumBytes: z
    .number()
    .int()
    .min(JOURNAL_VACUUM_MIN_BYTES)
    .max(JOURNAL_VACUUM_MAX_BYTES)
    .optional(),
});

/**
 * `.max(SYSTEM_CLEANUP_ACTION_IDS.length)` rather than an arbitrary cap: the
 * catalogue is closed, so no honest request can name more ids than it has,
 * and an oversized array is a client bug or an attempt to make the agent do
 * needless work.
 */
export const systemCleanupRunBodySchema = z.object({
  actionIds: z
    .array(z.enum(SYSTEM_CLEANUP_ACTION_IDS))
    .min(1)
    .max(SYSTEM_CLEANUP_ACTION_IDS.length),
  params: systemCleanupParamsSchema.optional(),
});

export type SystemCleanupRunBody = z.infer<typeof systemCleanupRunBodySchema>;
