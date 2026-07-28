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

  it('gives queued software installs the 7-day offline window', () => {
    // Must match SOFTWARE_QUEUED_EXPIRY_MS in jobs/staleCommandReaper.ts —
    // a shorter value would let the generic reaper kill offline-queued
    // installs before the device ever reconnects.
    expect(getCommandTimeoutMs(CommandTypes.SOFTWARE_INSTALL)).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
