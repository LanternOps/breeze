import { describe, expect, it } from 'vitest';
import { SYSTEM_CLEANUP_ACTION_IDS, systemCleanupRunBudgetMs } from '@breeze/shared/validators';
import { getCommandTimeoutMs, SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS } from './commandTimeouts';
import { CommandTypes } from './commandQueue';

describe('command timeouts', () => {
  it('uses the restore-specific timeout policy', () => {
    expect(getCommandTimeoutMs(CommandTypes.BACKUP_RESTORE)).toBe(30 * 60 * 1000);
    // #6415: whole-machine restores measured 1 h 57 m / 2 h 41 m / 3 h 15 m in
    // the #5498 lab run, so the old flat 60 min reaped healthy rebuilds a third
    // of the way through. These six carry the 24 h ceiling instead.
    const DAY = 24 * 60 * 60 * 1000;
    expect(getCommandTimeoutMs(CommandTypes.VM_RESTORE_FROM_BACKUP)).toBe(DAY);
    expect(getCommandTimeoutMs(CommandTypes.VM_INSTANT_BOOT)).toBe(DAY);
    expect(getCommandTimeoutMs(CommandTypes.BMR_RECOVER)).toBe(DAY);
    expect(getCommandTimeoutMs(CommandTypes.BARE_METAL_REBUILD)).toBe(DAY);
    expect(getCommandTimeoutMs(CommandTypes.MSSQL_RESTORE)).toBe(DAY);
    expect(getCommandTimeoutMs(CommandTypes.HYPERV_RESTORE)).toBe(DAY);
    // A restore that is 3 h in flight is still inside its budget — the exact
    // case #6415 reported as spuriously failed.
    expect(getCommandTimeoutMs(CommandTypes.BARE_METAL_REBUILD)).toBeGreaterThan(3 * 60 * 60 * 1000);
  });

  it('gives a claimed software install a two-hour execution budget (#5128)', () => {
    // #5128: `device_commands.deliver_by` now owns the delivery deadline for
    // an offline-queued install (see reapStaleDeviceCommands). This timeout
    // is purely the EXECUTION budget for an install the agent has already
    // claimed — above its own 15 min download + 30 min install ceilings.
    expect(getCommandTimeoutMs(CommandTypes.SOFTWARE_INSTALL)).toBe(2 * 60 * 60 * 1000);
  });

  it('caps a native cleanup run at three hours and a list at the medium tier', () => {
    // The CEILING, not the budget: the real budget is per-selection
    // (systemCleanupRunBudgetMs) and is stored on the run row. This only has
    // to be >= the largest budget the function can return, or the reaper
    // would terminalise a command whose run is still inside its own budget.
    expect(getCommandTimeoutMs('system_cleanup_run')).toBe(3 * 60 * 60 * 1000);
    expect(SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS).toBe(getCommandTimeoutMs('system_cleanup_run'));
    expect(SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(
      systemCleanupRunBudgetMs([...SYSTEM_CLEANUP_ACTION_IDS]),
    );
    // 30 minutes: the agent caps its own estimation phase at 3, so this is a
    // pure backstop rather than a working budget.
    expect(getCommandTimeoutMs('system_cleanup_list')).toBe(30 * 60 * 1000);
  });
});
