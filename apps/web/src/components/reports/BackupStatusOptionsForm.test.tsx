import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKUP_STATUS_OPTIONS,
  backupStatusOptionsFromConfig,
} from './BackupStatusOptionsForm';

// backupStatusOptionsFromConfig reads a persisted report `config` back into
// option state for the edit page. The include toggle must be "on unless
// === false" (never fall back to a default the moment a legacy config used a
// non-boolean value), and `sources` must fall back to both sources for
// anything that isn't a genuinely non-empty array of the two known values —
// never silently narrow a stored report's scope because of a corrupted or
// hand-edited config.
describe('backupStatusOptionsFromConfig', () => {
  it('the include toggle is "on unless === false" — any other value, even a falsy one, stays on', () => {
    expect(backupStatusOptionsFromConfig({ includeDevicesWithoutBackup: false }).includeDevicesWithoutBackup).toBe(false);
    expect(backupStatusOptionsFromConfig({ includeDevicesWithoutBackup: true }).includeDevicesWithoutBackup).toBe(true);
    expect(backupStatusOptionsFromConfig({}).includeDevicesWithoutBackup).toBe(true);
    expect(backupStatusOptionsFromConfig({ includeDevicesWithoutBackup: 0 }).includeDevicesWithoutBackup).toBe(true);
    expect(backupStatusOptionsFromConfig({ includeDevicesWithoutBackup: 'no' }).includeDevicesWithoutBackup).toBe(true);
  });

  it('falls back to both sources when the key is absent entirely', () => {
    expect(backupStatusOptionsFromConfig({}).sources).toEqual(DEFAULT_BACKUP_STATUS_OPTIONS.sources);
  });

  it('falls back to both sources for an empty array — an empty selection is never persisted as "no sources"', () => {
    expect(backupStatusOptionsFromConfig({ sources: [] }).sources).toEqual(['breeze', 'provider']);
  });

  it('falls back to both sources when the array contains an unrecognized value', () => {
    expect(backupStatusOptionsFromConfig({ sources: ['breeze', 'carbonite'] }).sources).toEqual(['breeze', 'provider']);
  });

  it('falls back to both sources for a non-array value like the string "breeze"', () => {
    expect(backupStatusOptionsFromConfig({ sources: 'breeze' }).sources).toEqual(['breeze', 'provider']);
  });

  it('keeps a genuinely narrowed, valid single-source selection', () => {
    expect(backupStatusOptionsFromConfig({ sources: ['provider'] }).sources).toEqual(['provider']);
    expect(backupStatusOptionsFromConfig({ sources: ['breeze'] }).sources).toEqual(['breeze']);
  });

  it('keeps a valid two-source selection regardless of order', () => {
    expect(backupStatusOptionsFromConfig({ sources: ['provider', 'breeze'] }).sources).toEqual(['provider', 'breeze']);
  });
});
