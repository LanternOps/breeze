import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_CLEANUP_ACTION_IDS, systemCleanupRunBudgetMs } from '@breeze/shared/validators';
import {
  BACKUP_JOB_ABSOLUTE_TIMEOUT_MS,
  CALLER_VERIFY_TIMEOUT_MS,
  getCommandTimeoutMs,
  getCommandUndeliveredTimeoutMs,
  RESTORE_POINT_CHECKPOINT_BUDGET_MS,
  SCRIPT_GRACE_BUFFER_MS,
  SECURITY_SCAN_COMMAND_GRACE_MS,
  SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS,
} from './commandTimeouts';
import { CommandTypes } from './commandQueue';
import { WORKSTATION_TIMEOUT_MAX_MS } from './callerVerification/workstationProtocol';

describe('command timeouts', () => {
  it('gives pam_request_notify an explicit 2-minute timeout without the unknown-type warning (#8928)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getCommandTimeoutMs(CommandTypes.PAM_REQUEST_NOTIFY)).toBe(2 * 60 * 1000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('times caller_verify out just past the longest prompt the helper can show (#6354 W02)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const timeout = getCommandTimeoutMs(CommandTypes.CALLER_VERIFY);
      expect(timeout).toBe(CALLER_VERIFY_TIMEOUT_MS);
      expect(timeout).toBeGreaterThan(WORKSTATION_TIMEOUT_MAX_MS);
      expect(timeout).toBeLessThanOrEqual(WORKSTATION_TIMEOUT_MAX_MS + 60_000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('gives backup_run the backup job ceiling instead of the unknown-type default (#7105)', () => {
    // backup_run used to fall through to the 30-minute default with an
    // "Unknown command type" warning. A file backup is governed by the
    // backup_jobs reaper, whose last-resort cap is 24 h, so a command row for
    // it must never be timed out before that.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getCommandTimeoutMs(CommandTypes.BACKUP_RUN)).toBe(24 * 60 * 60 * 1000);
      expect(BACKUP_JOB_ABSOLUTE_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

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

  describe('script deadline with a stamped restore-point block (#9162)', () => {
    const block = (enabled: boolean) => ({
      v: 1,
      requestId: '00000000-0000-4000-8000-000000000001',
      enabled,
      label: 'Breeze: script',
      resolvedAt: '2026-10-18T00:00:00.000Z',
      policyRevision: '',
      validUntil: '2026-10-19T00:00:00.000Z',
    });

    it('mirrors the agent checkpoint budget (systemrestore.CommandBudget = 5m)', () => {
      expect(RESTORE_POINT_CHECKPOINT_BUDGET_MS).toBe(5 * 60 * 1000);
    });

    it('adds the checkpoint budget when the block is enabled', () => {
      expect(
        getCommandTimeoutMs(CommandTypes.SCRIPT, { timeoutSeconds: 60, restorePoint: block(true) }),
      ).toBe(60_000 + SCRIPT_GRACE_BUFFER_MS + RESTORE_POINT_CHECKPOINT_BUDGET_MS);
    });

    it('adds it on top of the default script timeout too', () => {
      expect(getCommandTimeoutMs(CommandTypes.SCRIPT, { restorePoint: block(true) })).toBe(
        300_000 + SCRIPT_GRACE_BUFFER_MS + RESTORE_POINT_CHECKPOINT_BUDGET_MS,
      );
    });

    it('leaves the deadline unchanged with no block, a disabled block, or a malformed one', () => {
      const base = 60_000 + SCRIPT_GRACE_BUFFER_MS;
      expect(getCommandTimeoutMs(CommandTypes.SCRIPT, { timeoutSeconds: 60 })).toBe(base);
      expect(
        getCommandTimeoutMs(CommandTypes.SCRIPT, { timeoutSeconds: 60, restorePoint: block(false) }),
      ).toBe(base);
      for (const restorePoint of [null, 'yes', true, { enabled: 'true' }, []]) {
        expect(getCommandTimeoutMs(CommandTypes.SCRIPT, { timeoutSeconds: 60, restorePoint })).toBe(base);
      }
    });

    it('does not extend non-script command types', () => {
      expect(
        getCommandTimeoutMs(CommandTypes.SOFTWARE_INSTALL, { restorePoint: block(true) }),
      ).toBe(getCommandTimeoutMs(CommandTypes.SOFTWARE_INSTALL));
      expect(
        getCommandTimeoutMs(CommandTypes.INSTALL_PATCHES, { restorePoint: block(true) }),
      ).toBe(getCommandTimeoutMs(CommandTypes.INSTALL_PATCHES));
    });
  });

  // #10057: the server timeout used to be a flat 30 minutes, while a policy
  // can give the agent up to 720 (SECURITY_SCAN_TIMEOUT_MINUTES_RANGE) and a
  // scan with no policy has no agent deadline at all. The reaper then failed
  // the command while the agent was still scanning.
  describe('security_scan (#10057)', () => {
    const MIN = 60_000;

    it('derives the deadline from the scan budget the payload carries', () => {
      expect(getCommandTimeoutMs(CommandTypes.SECURITY_SCAN, { timeoutMinutes: 120 })).toBe(
        120 * MIN + SECURITY_SCAN_COMMAND_GRACE_MS,
      );
      expect(getCommandTimeoutMs(CommandTypes.SECURITY_SCAN, { timeoutMinutes: 720 })).toBe(
        720 * MIN + SECURITY_SCAN_COMMAND_GRACE_MS,
      );
      // Never shorter than the agent's own deadline, at any budget.
      for (const minutes of [5, 30, 31, 240, 719, 720]) {
        expect(getCommandTimeoutMs(CommandTypes.SECURITY_SCAN, { timeoutMinutes: minutes })).toBeGreaterThan(
          minutes * MIN,
        );
      }
    });

    it('covers the rule-set load the agent does before its scan clock starts', () => {
      // agent/internal/heartbeat/handlers_security.go ruleSetLoadTimeout = 5 min.
      expect(SECURITY_SCAN_COMMAND_GRACE_MS).toBeGreaterThan(5 * MIN);
    });

    it('uses the 720-minute ceiling when no budget was sent (the agent then has no deadline)', () => {
      const ceiling = 720 * MIN + SECURITY_SCAN_COMMAND_GRACE_MS;
      expect(getCommandTimeoutMs(CommandTypes.SECURITY_SCAN)).toBe(ceiling);
      expect(getCommandTimeoutMs(CommandTypes.SECURITY_SCAN, null)).toBe(ceiling);
      expect(getCommandTimeoutMs(CommandTypes.SECURITY_SCAN, { scanRecordId: 'x' })).toBe(ceiling);
      for (const timeoutMinutes of [0, -5, '120', null, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(getCommandTimeoutMs(CommandTypes.SECURITY_SCAN, { timeoutMinutes })).toBe(ceiling);
      }
    });

    it('clamps an out-of-range budget into the policy range', () => {
      expect(getCommandTimeoutMs(CommandTypes.SECURITY_SCAN, { timeoutMinutes: 5000 })).toBe(
        720 * MIN + SECURITY_SCAN_COMMAND_GRACE_MS,
      );
      expect(getCommandTimeoutMs(CommandTypes.SECURITY_SCAN, { timeoutMinutes: 1 })).toBe(
        5 * MIN + SECURITY_SCAN_COMMAND_GRACE_MS,
      );
    });

    it('leaves the other security command types on their fixed tiers', () => {
      expect(getCommandTimeoutMs(CommandTypes.SECURITY_THREAT_QUARANTINE, { timeoutMinutes: 720 })).toBe(30 * MIN);
      expect(getCommandTimeoutMs(CommandTypes.SECURITY_COLLECT_STATUS, { timeoutMinutes: 720 })).toBe(5 * MIN);
    });
  });

  // Verify / test restore budgets scale with the snapshot: the payload carries
  // `timeBudgetSeconds`, computed when the verification is created.
  describe.each([CommandTypes.BACKUP_VERIFY, CommandTypes.BACKUP_TEST_RESTORE])('%s', (type) => {
    const HOUR = 60 * 60 * 1000;

    it('reads the execution budget from payload.timeBudgetSeconds, clamped to [2h, 12h]', () => {
      expect(getCommandTimeoutMs(type, { timeBudgetSeconds: 395 * 60 })).toBe(395 * 60 * 1000);
      expect(getCommandTimeoutMs(type, { timeBudgetSeconds: 60 })).toBe(2 * HOUR);
      expect(getCommandTimeoutMs(type, { timeBudgetSeconds: 100 * 3600 })).toBe(12 * HOUR);
    });

    it('falls back to 2h for an absent or invalid budget', () => {
      expect(getCommandTimeoutMs(type)).toBe(2 * HOUR);
      expect(getCommandTimeoutMs(type, null)).toBe(2 * HOUR);
      for (const timeBudgetSeconds of ['36000', null, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
        expect(getCommandTimeoutMs(type, { timeBudgetSeconds })).toBe(2 * HOUR);
      }
    });

    it('keeps the undelivered limit at the 2h base whatever the execution budget', () => {
      // No deliver_by on these rows: the reaper's pending clock is
      // created_at + this, and a command cannot wait 12 h to be delivered.
      expect(getCommandUndeliveredTimeoutMs(type, { timeBudgetSeconds: 12 * 3600 })).toBe(2 * HOUR);
      expect(getCommandUndeliveredTimeoutMs(type)).toBe(2 * HOUR);
    });
  });

  it('uses the execution timeout as the undelivered limit for every other type', () => {
    expect(getCommandUndeliveredTimeoutMs(CommandTypes.SCRIPT, { timeoutSeconds: 600 })).toBe(
      getCommandTimeoutMs(CommandTypes.SCRIPT, { timeoutSeconds: 600 }),
    );
    expect(getCommandUndeliveredTimeoutMs(CommandTypes.BACKUP_RUN)).toBe(getCommandTimeoutMs(CommandTypes.BACKUP_RUN));
    expect(getCommandUndeliveredTimeoutMs(CommandTypes.LIST_PROCESSES)).toBe(5 * 60 * 1000);
  });
});
