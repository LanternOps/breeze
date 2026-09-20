import { describe, expect, it } from 'vitest';
import {
  JOURNAL_VACUUM_DEFAULT_BYTES,
  JOURNAL_VACUUM_MAX_BYTES,
  JOURNAL_VACUUM_MIN_BYTES,
  SYSTEM_CLEANUP_ACTION_IDS,
  SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS,
  SYSTEM_CLEANUP_RISK_FLAGS,
  SYSTEM_CLEANUP_RUN_BUDGET_MAX_MS,
  SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS,
  isSystemCleanupActionId,
  systemCleanupRunBodySchema,
  systemCleanupRunBudgetMs,
} from './systemCleanup';

describe('SYSTEM_CLEANUP_ACTION_IDS (spec §5.3, §7.2)', () => {
  it('is the closed 27-entry catalogue in agent order', () => {
    expect(SYSTEM_CLEANUP_ACTION_IDS).toEqual([
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
      'win_dism_component_cleanup',
      'mac_tm_local_snapshots',
      'mac_brew_cleanup',
      'linux_pkg_cache_clean',
      'linux_pkg_autoremove',
      'linux_journal_vacuum',
    ]);
  });

  it('never offers a handler that touches user data or recovery state', () => {
    const joined = SYSTEM_CLEANUP_ACTION_IDS.join(' ').toLowerCase();
    for (const forbidden of [
      'downloads', 'esd', 'language_pack', 'recycle', 'thumbnail',
      'internet_cache', 'active_setup', 'game', 'resetbase',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it('isSystemCleanupActionId is exact, not a prefix or case-insensitive match', () => {
    expect(isSystemCleanupActionId('linux_journal_vacuum')).toBe(true);
    for (const value of [
      '', 'LINUX_JOURNAL_VACUUM', 'linux_journal_vacuum ', 'win_cleanmgr:',
      'win_cleanmgr:DownloadsFolder', 'linux_journal_vacuum; rm -rf /', 42, null, undefined, {},
    ]) {
      expect(isSystemCleanupActionId(value)).toBe(false);
    }
  });
});

describe('systemCleanupRunBodySchema', () => {
  it('accepts a subset of the catalogue', () => {
    const parsed = systemCleanupRunBodySchema.parse({
      actionIds: ['linux_pkg_cache_clean', 'linux_journal_vacuum'],
      params: { journalVacuumBytes: JOURNAL_VACUUM_DEFAULT_BYTES },
    });
    expect(parsed.actionIds).toEqual(['linux_pkg_cache_clean', 'linux_journal_vacuum']);
    expect(parsed.params?.journalVacuumBytes).toBe(JOURNAL_VACUUM_DEFAULT_BYTES);
  });

  it('rejects an empty selection — it must never read as "run everything"', () => {
    expect(systemCleanupRunBodySchema.safeParse({ actionIds: [] }).success).toBe(false);
  });

  it('rejects any id outside the catalogue', () => {
    for (const actionIds of [
      ['not_an_action'],
      ['linux_pkg_cache_clean', 'not_an_action'],
      ['win_cleanmgr:DownloadsFolder'],
      ['../../etc/passwd'],
    ]) {
      expect(systemCleanupRunBodySchema.safeParse({ actionIds }).success).toBe(false);
    }
  });

  it('bounds journalVacuumBytes to 64 MiB - 4 GiB and rejects non-integers', () => {
    expect(JOURNAL_VACUUM_MIN_BYTES).toBe(64 * 1024 * 1024);
    expect(JOURNAL_VACUUM_MAX_BYTES).toBe(4 * 1024 * 1024 * 1024);
    const ok = (bytes: number) =>
      systemCleanupRunBodySchema.safeParse({
        actionIds: ['linux_journal_vacuum'],
        params: { journalVacuumBytes: bytes },
      }).success;
    expect(ok(JOURNAL_VACUUM_MIN_BYTES)).toBe(true);
    expect(ok(JOURNAL_VACUUM_MAX_BYTES)).toBe(true);
    expect(ok(JOURNAL_VACUUM_MIN_BYTES - 1)).toBe(false);
    expect(ok(JOURNAL_VACUUM_MAX_BYTES + 1)).toBe(false);
    expect(ok(0)).toBe(false);
    expect(ok(-1)).toBe(false);
    expect(ok(1.5)).toBe(false);
    expect(ok(Number.NaN)).toBe(false);
  });

  it('caps the selection length so one call cannot enumerate an unbounded list', () => {
    const tooMany = Array.from({ length: 64 }, () => 'linux_pkg_cache_clean');
    expect(systemCleanupRunBodySchema.safeParse({ actionIds: tooMany }).success).toBe(false);
  });

  it('exposes the risk flags the UI renders as badges', () => {
    expect(SYSTEM_CLEANUP_RISK_FLAGS).toEqual([
      'long_running',
      'may_require_reboot',
      'may_require_reboot_free_state',
      'removes_driver_rollback',
      'removes_packages',
      'removes_os_rollback',
      'removes_recovery_points',
    ]);
  });
});

describe('systemCleanupRunBudgetMs (spec §13 #14)', () => {
  const minutes = (n: number) => n * 60 * 1000;

  it('sums the selected actions timeouts plus slack', () => {
    expect(systemCleanupRunBudgetMs(['linux_pkg_cache_clean'])).toBe(minutes(15));
    expect(systemCleanupRunBudgetMs(['linux_pkg_cache_clean', 'linux_journal_vacuum'])).toBe(minutes(20));
    // 60 + 90 + 10. A flat two-hour constant would have reaped this mid-DISM.
    expect(systemCleanupRunBudgetMs(['win_cleanmgr', 'win_dism_component_cleanup'])).toBe(minutes(160));
  });

  it('counts a bare win_cleanmgr and its sub-ids once — they are one execution', () => {
    expect(systemCleanupRunBudgetMs([
      'win_cleanmgr', 'win_cleanmgr:update_cleanup', 'win_cleanmgr:setup_log_files',
    ])).toBe(minutes(70));
  });

  it('caps at three hours and ignores unknown ids', () => {
    expect(systemCleanupRunBudgetMs([...SYSTEM_CLEANUP_ACTION_IDS])).toBe(SYSTEM_CLEANUP_RUN_BUDGET_MAX_MS);
    expect(systemCleanupRunBudgetMs(['not_an_action'])).toBe(SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS);
    expect(systemCleanupRunBudgetMs([])).toBe(SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS);
  });

  it('covers every top-level catalogue id, so no selection is budgeted at zero', () => {
    const topLevel = SYSTEM_CLEANUP_ACTION_IDS.filter((id) => !id.startsWith('win_cleanmgr:'));
    for (const id of topLevel) {
      expect(SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS[id]).toBeGreaterThan(0);
    }
  });
});
