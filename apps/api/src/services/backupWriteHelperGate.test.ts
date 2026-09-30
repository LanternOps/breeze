import { describe, expect, it } from 'vitest';
import {
  BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE,
  BACKUP_WRITE_GATED_COMMAND_TYPES,
  MIN_BACKUP_WRITE_PROTOCOL_VERSION,
  backupWriteHelperRefusal,
  isBackupWriteHelperUpdateRequiredError,
} from './backupWriteHelperGate';
import { BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE } from './backupReadHelperGate';

const s3Write = { jobId: 'job-1', provider: 's3', providerConfigRef: { configId: 'c', orgId: 'o' } };

describe('backupWriteHelperRefusal', () => {
  it('gates exactly the three backup types that write to a storage destination', () => {
    expect([...BACKUP_WRITE_GATED_COMMAND_TYPES].sort()).toEqual(['backup_run', 'hyperv_backup', 'mssql_backup']);
    expect(MIN_BACKUP_WRITE_PROTOCOL_VERSION).toBe(1);
  });

  it.each(BACKUP_WRITE_GATED_COMMAND_TYPES)('refuses %s to a helper below the brokered write protocol', (type) => {
    expect(backupWriteHelperRefusal(type, s3Write, 0)).toBe(BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE);
    expect(backupWriteHelperRefusal(type, s3Write, undefined)).toBe(BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE);
  });

  it.each(BACKUP_WRITE_GATED_COMMAND_TYPES)(
    'does not refuse %s for a device that has not reported its helper yet (the backup waits for the report)',
    (type) => {
      expect(backupWriteHelperRefusal(type, s3Write, null)).toBeNull();
    },
  );

  it.each(BACKUP_WRITE_GATED_COMMAND_TYPES)('allows %s to a helper that supports brokered writes', (type) => {
    expect(backupWriteHelperRefusal(type, s3Write, 1)).toBeNull();
    expect(backupWriteHelperRefusal(type, s3Write, 2)).toBeNull();
  });

  it('allows a local destination to any helper: it is a path the device reaches, not a credential', () => {
    for (const type of BACKUP_WRITE_GATED_COMMAND_TYPES) {
      expect(backupWriteHelperRefusal(type, { ...s3Write, provider: 'local' }, 0)).toBeNull();
    }
  });

  it('refuses a payload that names no provider (never assumed local)', () => {
    expect(backupWriteHelperRefusal('mssql_backup', { jobId: 'job-1' }, 0)).toBe(BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE);
    expect(backupWriteHelperRefusal('mssql_backup', null, 0)).toBe(BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE);
  });

  it.each(['backup_restore', 'backup_verify', 'vault_sync', 'backup_stop', 'script'])(
    'does not gate %s, which does not write to a storage destination',
    (type) => {
      expect(backupWriteHelperRefusal(type, s3Write, 0)).toBeNull();
    },
  );

  it('recognises its own message and nothing else', () => {
    expect(isBackupWriteHelperUpdateRequiredError(BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE)).toBe(true);
    expect(isBackupWriteHelperUpdateRequiredError(BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE)).toBe(false);
    expect(isBackupWriteHelperUpdateRequiredError('Device is offline, cannot execute command')).toBe(false);
    expect(isBackupWriteHelperUpdateRequiredError(null)).toBe(false);
  });

  it('uses the operator message verbatim', () => {
    expect(BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE).toBe(
      'Update the Breeze agent on this device, then try again. Backups now require secure storage access, '
        + 'and the backup component on this device has not reported support for it.',
    );
  });
});
