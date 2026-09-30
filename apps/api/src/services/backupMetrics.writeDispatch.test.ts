import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordBackupWriteDispatch, setBackupMetricsRecorder } from './backupMetrics';

afterEach(() => setBackupMetricsRecorder(null));

describe('recordBackupWriteDispatch', () => {
  it('counts every write delivered with its storage credential as unexpected: backups to S3 are brokered only', () => {
    const dispatch = vi.fn();
    const unexpected = vi.fn();
    setBackupMetricsRecorder({ onWriteDispatch: dispatch, onUnexpectedLegacyWrite: unexpected });
    recordBackupWriteDispatch('backup_run', 'local', 'no_credential');
    recordBackupWriteDispatch('backup_run', 'brokered', 'ok');
    recordBackupWriteDispatch('mssql_backup', 'refused', 'helper_unsupported');
    expect(unexpected).not.toHaveBeenCalled();
    recordBackupWriteDispatch('backup_run', 'legacy_credential', 'helper_unsupported');
    recordBackupWriteDispatch('mssql_backup', 'legacy_credential', 'mint_failed');
    expect(unexpected.mock.calls).toEqual([
      ['backup_run', 'helper_unsupported', 1],
      ['mssql_backup', 'mint_failed', 1],
    ]);
    expect(dispatch).toHaveBeenCalledTimes(5);
  });
});
