import { describe, expect, it } from 'vitest';
import { getCommandTimeoutMs } from './commandTimeouts';
import { CommandTypes } from './commandQueue';

describe('command timeouts', () => {
  it('uses the restore-specific timeout policy', () => {
    expect(getCommandTimeoutMs(CommandTypes.BACKUP_RESTORE)).toBe(30 * 60 * 1000);
    expect(getCommandTimeoutMs(CommandTypes.VM_RESTORE_FROM_BACKUP)).toBe(60 * 60 * 1000);
    expect(getCommandTimeoutMs(CommandTypes.VM_INSTANT_BOOT)).toBe(60 * 60 * 1000);
    expect(getCommandTimeoutMs(CommandTypes.BMR_RECOVER)).toBe(60 * 60 * 1000);
  });

  it('gives a claimed software install a two-hour execution budget (#5128)', () => {
    // #5128: `device_commands.deliver_by` now owns the delivery deadline for
    // an offline-queued install (see reapStaleDeviceCommands). This timeout
    // is purely the EXECUTION budget for an install the agent has already
    // claimed — above its own 15 min download + 30 min install ceilings.
    expect(getCommandTimeoutMs(CommandTypes.SOFTWARE_INSTALL)).toBe(2 * 60 * 60 * 1000);
  });
});
