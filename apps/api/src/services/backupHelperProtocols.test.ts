import { describe, expect, it } from 'vitest';
import {
  BACKUP_INTEGRITY_PROTOCOL,
  BACKUP_WRITE_PROTOCOL,
  normalizeBackupIntegrityProtocolVersion,
  normalizeBackupWriteProtocolVersion,
} from './backupHelperProtocols';

describe('backup helper protocol normalization', () => {
  it.each([
    [0, 0], [1, 1], [2, 2], [3, 0], [-1, 0], [1.5, 0], ['2', 0], [undefined, 0], [null, 0], [Number.NaN, 0],
  ])('integrity %p -> %p', (input, expected) => {
    expect(normalizeBackupIntegrityProtocolVersion(input)).toBe(expected);
  });

  it.each([[0, 0], [1, 1], [2, 0], [-1, 0], ['1', 0], [true, 0], [undefined, 0], [null, 0]])(
    'write %p -> %p',
    (input, expected) => {
      expect(normalizeBackupWriteProtocolVersion(input)).toBe(expected);
    },
  );

  it('names the versions this server implements', () => {
    expect(BACKUP_INTEGRITY_PROTOCOL).toEqual({ PRODUCES_ATTESTATION: 1, ENFORCES_ON_RESTORE: 2 });
    expect(BACKUP_WRITE_PROTOCOL).toEqual({ BROKERED_WRITES: 1 });
  });
});
