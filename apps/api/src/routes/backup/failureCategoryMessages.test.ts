import { describe, expect, it } from 'vitest';
import { classifyBackupFailure, type BackupFailureCategory } from '@breeze/shared';
import { STALE_BACKUP_REAP_MARKER } from '../../db/schema/backup';
import { BACKUP_CATCH_UP_NOT_STARTED_ERROR, BACKUP_MISSED_ERROR } from '../../jobs/backupCatchUp';
import { BACKUP_HELPER_UNREPORTED_MESSAGE } from '../../services/backupHelperProtocols';
import {
  RECONCILE_PRIOR_ERROR_PREFIX,
  RESERVATION_MISMATCH_MESSAGE,
} from '../../services/backupResultPersistence';
import { backupWriteRefusalMessage } from '../../services/backupStorageWriteDelivery';
import { BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE } from '../../services/backupWriteHelperGate';
import { PARKED_DEVICE_CANCEL_REASON } from '../../services/unassignedPool/deliveryEligibility';

// The classifier in @breeze/shared keys on prose it cannot import. These rows
// read the API's real constants, so rewording one of them fails here instead of
// silently moving its failures to `unknown` (#11027).
const failed = (errorLog: string) => classifyBackupFailure({ status: 'failed', errorLog });

describe('backup failure category vs the API message constants', () => {
  it.each<[string, string, BackupFailureCategory]>([
    ['BACKUP_MISSED_ERROR', BACKUP_MISSED_ERROR, 'device_offline'],
    ['BACKUP_CATCH_UP_NOT_STARTED_ERROR', BACKUP_CATCH_UP_NOT_STARTED_ERROR, 'timeout'],
    ['BACKUP_HELPER_UNREPORTED_MESSAGE', BACKUP_HELPER_UNREPORTED_MESSAGE, 'agent'],
    ['BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE', BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE, 'agent'],
    ['RESERVATION_MISMATCH_MESSAGE', RESERVATION_MISMATCH_MESSAGE, 'agent'],
    ['PARKED_DEVICE_CANCEL_REASON', PARKED_DEVICE_CANCEL_REASON, 'configuration'],
  ])('%s', (_name, message, expected) => {
    expect(failed(message)).toBe(expected);
  });

  it.each<[string, BackupFailureCategory]>([
    ['helper_unsupported', 'agent'],
    ['provider_not_s3', 'storage'],
    ['insecure_endpoint', 'storage'],
    ['server_origin_mismatch', 'storage'],
    ['server_origin_unavailable', 'storage'],
    ['insecure_server_origin', 'storage'],
    ['mint_failed', 'storage'],
    ['invalid_destination_prefix', 'storage'],
    ['key_root_invalid', 'storage'],
    ['device_org_mismatch', 'configuration'],
    ['job_not_live', 'configuration'],
    ['inline_destination', 'configuration'],
    ['no_reference', 'configuration'],
    ['no_job', 'configuration'],
    ['provider_changed', 'configuration'],
    ['encryption_plan_changed', 'configuration'],
    ['base_key_root_mismatch', 'configuration'],
  ])('write refusal %s', (reason, expected) => {
    expect(failed(backupWriteRefusalMessage(reason))).toBe(expected);
  });

  it('strips the real reaper marker', () => {
    expect(failed(`${STALE_BACKUP_REAP_MARKER} Device went offline during backup`)).toBe('device_offline');
  });

  it('strips the real reconcile prefix', () => {
    expect(failed(`${RECONCILE_PRIOR_ERROR_PREFIX}backup helper exited unexpectedly`)).toBe('agent');
  });
});
