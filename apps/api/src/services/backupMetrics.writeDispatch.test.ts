import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordBackupWriteDispatch, setBackupMetricsRecorder } from './backupMetrics';

afterEach(() => setBackupMetricsRecorder(null));

describe('recordBackupWriteDispatch', () => {
  it('counts a credential delivery for any reason other than an expected one separately', () => {
    const dispatch = vi.fn();
    const unexpected = vi.fn();
    setBackupMetricsRecorder({ onWriteDispatch: dispatch, onUnexpectedLegacyWrite: unexpected });
    recordBackupWriteDispatch('backup_run', 'legacy_credential', 'helper_unsupported');
    recordBackupWriteDispatch('backup_run', 'legacy_credential', 'provider_not_s3');
    recordBackupWriteDispatch('backup_run', 'local', 'no_credential');
    recordBackupWriteDispatch('backup_run', 'brokered', 'ok');
    expect(unexpected).not.toHaveBeenCalled();
    recordBackupWriteDispatch('mssql_backup', 'legacy_credential', 'mint_failed');
    recordBackupWriteDispatch('backup_run', 'legacy_credential', 'server_origin_mismatch');
    expect(unexpected.mock.calls).toEqual([
      ['mssql_backup', 'mint_failed', 1],
      ['backup_run', 'server_origin_mismatch', 1],
    ]);
    expect(dispatch).toHaveBeenCalledTimes(6);
  });
});
