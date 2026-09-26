import { describe, expect, it } from 'vitest';
import {
  BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE,
  BACKUP_READ_CREDENTIAL_COMMAND_TYPES,
  backupReadHelperRefusal,
  isBackupHelperUpdateRequiredError,
} from './backupReadHelperGate';

const s3Read = { snapshotId: 'snap-1', provider: 's3', providerConfigRef: { configId: 'c', orgId: 'o' } };

describe('backupReadHelperRefusal', () => {
  it.each(BACKUP_READ_CREDENTIAL_COMMAND_TYPES)('refuses %s to a helper below the brokered read protocol', (type) => {
    expect(backupReadHelperRefusal(type, s3Read, 0)).toBe(BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE);
    expect(backupReadHelperRefusal(type, s3Read, null)).toBe(BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE);
    expect(backupReadHelperRefusal(type, s3Read, undefined)).toBe(BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE);
  });

  it.each(BACKUP_READ_CREDENTIAL_COMMAND_TYPES)('allows %s to a helper that supports the protocol', (type) => {
    expect(backupReadHelperRefusal(type, s3Read, 1)).toBeNull();
    expect(backupReadHelperRefusal(type, s3Read, 2)).toBeNull();
  });

  it('allows a local destination to any helper: it is a path the device reaches, not a credential', () => {
    expect(backupReadHelperRefusal('backup_restore', { ...s3Read, provider: 'local' }, 0)).toBeNull();
  });

  it.each(['vm_restore_from_backup', 'vm_instant_boot', 'backup_run', 'mssql_backup', 'script'])(
    'does not gate %s, which is never sent a storage destination for a read',
    (type) => {
      expect(backupReadHelperRefusal(type, s3Read, 0)).toBeNull();
    },
  );

  it('recognises its own message and nothing else', () => {
    expect(isBackupHelperUpdateRequiredError(BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE)).toBe(true);
    expect(isBackupHelperUpdateRequiredError('Device is offline, cannot execute command')).toBe(false);
  });

  it('tells the operator what to do first', () => {
    expect(BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE.startsWith('Update the Breeze agent on this device')).toBe(true);
  });
});
