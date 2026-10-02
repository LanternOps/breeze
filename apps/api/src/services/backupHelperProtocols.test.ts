import { describe, expect, it } from 'vitest';
import {
  BACKUP_INTEGRITY_PROTOCOL,
  BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE,
  BACKUP_HELPER_UNREPORTED_MESSAGE,
  BACKUP_WRITE_PROTOCOL,
  BACKUP_HELPER_PROTOCOL_MIN_VERSION,
  backupHelperProtocolColumnWrite,
  backupHelperProtocolForDelivery,
  backupHelperVersionPredates,
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

// The agent sends an explicit null for each helper protocol when its probe of
// the installed helper got no answer (not installed yet, timed out, crashed).
// That is "unknown", distinct from a helper that answered 0 and from an older
// agent that omits the field (which still reads as 0).
describe('backup helper protocol reported as unknown', () => {
  it.each([
    { name: 'last known 1 is kept', stored: 1, expected: undefined },
    { name: 'last known 2 is kept', stored: 2, expected: undefined },
    { name: 'never reported stays unreported', stored: null, expected: null },
    { name: 'a stored 0 becomes unreported, not a current "older helper"', stored: 0, expected: null },
  ])('column write for null: $name', ({ stored, expected }) => {
    expect(backupHelperProtocolColumnWrite(null, stored, normalizeBackupIntegrityProtocolVersion)).toBe(expected);
  });

  it.each([
    { name: 'a real 0 overwrites a stored 1', reported: 0, stored: 1, expected: 0 },
    { name: 'a report is normalized', reported: 2, stored: null, expected: 2 },
    { name: 'a future version reads as 0', reported: 3, stored: 2, expected: 0 },
    { name: 'absent (older agent) reads as 0', reported: undefined, stored: 2, expected: 0 },
  ])('column write for a value: $name', ({ reported, stored, expected }) => {
    expect(backupHelperProtocolColumnWrite(reported, stored, normalizeBackupIntegrityProtocolVersion)).toBe(expected);
  });

  it('delivery falls back to the stored column when this beat reported unknown', () => {
    expect(backupHelperProtocolForDelivery(null, normalizeBackupWriteProtocolVersion)).toBeUndefined();
    expect(backupHelperProtocolForDelivery(1, normalizeBackupWriteProtocolVersion)).toBe(1);
    expect(backupHelperProtocolForDelivery(0, normalizeBackupWriteProtocolVersion)).toBe(0);
    expect(backupHelperProtocolForDelivery(undefined, normalizeBackupWriteProtocolVersion)).toBe(0);
  });
});

// Operator-facing. A device can be online and heartbeating while its backup
// component cannot be asked (the probe keeps failing), so neither message may
// tell the operator to check that the agent is online.
describe('backup helper unreported messages', () => {
  it('the failure names the backup component and points at updating or reinstalling the agent', () => {
    expect(BACKUP_HELPER_UNREPORTED_MESSAGE).toBe(
      "The backup was not started because the backup component on this device hasn't reported which storage features it supports yet. "
      + 'If the device is online, update or reinstall the Breeze agent, then run the backup again.',
    );
  });

  it('the deferral names the backup component', () => {
    expect(BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE).toBe(
      'Waiting for the backup component on this device to report which storage features it supports.',
    );
  });
});

// A last known positive version is kept for an unknown report only while
// nothing in the same heartbeat says the installed helper is too old for it:
// a helper release that predates a protocol does not fail a brokered payload,
// it runs it against its own configured destination.
describe('unknown report from a helper older than the stored protocol', () => {
  it('names the first helper release of each protocol', () => {
    expect(BACKUP_HELPER_PROTOCOL_MIN_VERSION).toEqual({
      backupReadProtocolVersion: '0.118.0',
      backupIntegrityProtocolVersion: '0.119.0',
      backupWriteProtocolVersion: '0.119.0',
    });
  });

  it.each([
    { version: '0.118.2', min: '0.119.0', expected: true },
    { version: 'v0.118.2', min: '0.119.0', expected: true },
    { version: '0.119.0-rc.1', min: '0.119.0', expected: true },
    { version: '0.119.0', min: '0.119.0', expected: false },
    { version: '0.120.3', min: '0.119.0', expected: false },
    { version: '0.118.0', min: '0.118.0', expected: false },
    { version: undefined, min: '0.119.0', expected: false },
    { version: '', min: '0.119.0', expected: false },
    { version: 'dev-abc123', min: '0.119.0', expected: false },
  ])('helper $version predates $min: $expected', ({ version, min, expected }) => {
    expect(backupHelperVersionPredates(version, min)).toBe(expected);
  });

  it('a stored positive becomes unreported when the helper predates it', () => {
    expect(backupHelperProtocolColumnWrite(null, 1, normalizeBackupWriteProtocolVersion, { helperPredatesProtocol: true })).toBeNull();
    expect(backupHelperProtocolColumnWrite(null, 1, normalizeBackupWriteProtocolVersion, { helperPredatesProtocol: false })).toBeUndefined();
  });

  it('a numeric report is written as always, whatever the helper version', () => {
    expect(backupHelperProtocolColumnWrite(1, 1, normalizeBackupWriteProtocolVersion, { helperPredatesProtocol: true })).toBe(1);
  });
});
