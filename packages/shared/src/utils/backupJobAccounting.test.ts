import { describe, expect, it } from 'vitest';
import {
  BACKUP_FULL_RUN_REASONS,
  deriveBackupJobDataAccounting,
  isBackupFullRunReason,
} from './backupJobAccounting';

type Row = Parameters<typeof deriveBackupJobDataAccounting>[0];

const row = (overrides: Partial<Row> = {}): Row => ({
  status: 'completed',
  backupMode: 'file',
  backupType: 'file',
  totalSize: 1000,
  transferredSize: 100,
  referencedSize: 900,
  baseSnapshotId: 'snap-base',
  fullBackupReason: null,
  ...overrides,
});

describe('isBackupFullRunReason', () => {
  it.each(BACKUP_FULL_RUN_REASONS)('accepts %s', (reason) => {
    expect(isBackupFullRunReason(reason)).toBe(true);
  });

  it.each(['', 'nothing_reused', 'unrecorded', 'something_new', null, undefined, 7])('rejects %s', (value) => {
    expect(isBackupFullRunReason(value)).toBe(false);
  });
});

describe('deriveBackupJobDataAccounting', () => {
  it('completed incremental', () => {
    expect(deriveBackupJobDataAccounting(row())).toEqual({
      protectedBytes: 1000,
      uploadedBytes: 100,
      reusedBytes: 900,
      processedBytes: null,
      runKind: 'incremental',
      fullRunReason: null,
    });
  });

  it('failed run reports processed, not uploaded', () => {
    const result = deriveBackupJobDataAccounting(
      row({ status: 'failed', totalSize: 2e12, transferredSize: 1.4e12, referencedSize: null }),
    );
    expect(result.uploadedBytes).toBeNull();
    expect(result.reusedBytes).toBeNull();
    expect(result.protectedBytes).toBeNull();
    expect(result.processedBytes).toBe(1.4e12);
  });

  it.each(['pending', 'running', 'cancelled'])('%s run reports processed, not uploaded', (status) => {
    const result = deriveBackupJobDataAccounting(row({ status, transferredSize: 500 }));
    expect(result.uploadedBytes).toBeNull();
    expect(result.processedBytes).toBe(500);
  });

  it('legacy full run', () => {
    const result = deriveBackupJobDataAccounting(
      row({ baseSnapshotId: null, fullBackupReason: null, referencedSize: null }),
    );
    expect(result.runKind).toBe('full');
    expect(result.fullRunReason).toBe('unrecorded');
  });

  it('stamped reason passes through', () => {
    const result = deriveBackupJobDataAccounting(
      row({ baseSnapshotId: null, fullBackupReason: 'key_root_changed', referencedSize: null }),
    );
    expect(result.runKind).toBe('full');
    expect(result.fullRunReason).toBe('key_root_changed');
  });

  it('unknown stored reason becomes unrecorded', () => {
    const result = deriveBackupJobDataAccounting(
      row({ baseSnapshotId: null, fullBackupReason: 'reason_from_a_newer_api' }),
    );
    expect(result.fullRunReason).toBe('unrecorded');
  });

  it('base but nothing reused is nothing_reused', () => {
    for (const referencedSize of [0, null]) {
      const result = deriveBackupJobDataAccounting(row({ referencedSize }));
      expect(result.runKind).toBe('full');
      expect(result.fullRunReason).toBe('nothing_reused');
      expect(result.uploadedBytes).toBe(1000);
      expect(result.reusedBytes).toBe(0);
    }
  });

  it('a base on a run that has not finished stays incremental, since reuse is not known yet', () => {
    const result = deriveBackupJobDataAccounting(row({ status: 'running', referencedSize: null }));
    expect(result.runKind).toBe('incremental');
    expect(result.fullRunReason).toBeNull();
  });

  it('hyperv/mssql runKind null', () => {
    // backup_type defaults to 'file' at the column, so the mode has to win.
    for (const backupMode of ['hyperv', 'mssql']) {
      const result = deriveBackupJobDataAccounting(
        row({ backupMode, backupType: 'file', baseSnapshotId: null, referencedSize: null }),
      );
      expect(result.runKind).toBeNull();
      expect(result.fullRunReason).toBeNull();
      expect(result.protectedBytes).toBe(1000);
    }
  });

  it('a legacy row with no mode falls back to its backup type', () => {
    expect(deriveBackupJobDataAccounting(row({ backupMode: null, backupType: 'system_image' })).runKind).toBe('incremental');
    expect(deriveBackupJobDataAccounting(row({ backupMode: null, backupType: 'database' })).runKind).toBeNull();
    expect(deriveBackupJobDataAccounting(row({ backupMode: null, backupType: null })).runKind).toBeNull();
  });

  it('partial counts as restorable', () => {
    for (const status of ['partial', 'completed_with_errors']) {
      const result = deriveBackupJobDataAccounting(row({ status }));
      expect(result.uploadedBytes).toBe(100);
      expect(result.reusedBytes).toBe(900);
      expect(result.processedBytes).toBeNull();
    }
  });

  it('never reports negative uploaded bytes', () => {
    expect(deriveBackupJobDataAccounting(row({ totalSize: 100, referencedSize: 900 })).uploadedBytes).toBe(0);
  });

  it('a restorable run with no recorded total has no uploaded figure', () => {
    const result = deriveBackupJobDataAccounting(row({ totalSize: null, referencedSize: null }));
    expect(result.protectedBytes).toBeNull();
    expect(result.uploadedBytes).toBeNull();
  });

  it('a failed run that never reported progress has no processed figure', () => {
    expect(deriveBackupJobDataAccounting(row({ status: 'failed', transferredSize: null })).processedBytes).toBeNull();
  });
});
