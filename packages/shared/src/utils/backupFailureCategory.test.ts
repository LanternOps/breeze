import { describe, expect, it } from 'vitest';
import {
  BACKUP_FAILURE_CATEGORIES,
  classifyBackupFailure,
  type BackupFailureCategory,
} from './backupFailureCategory';

// Corpus sources (#11027). Every errorLog writer and reaper message was read in:
//   apps/api/src/jobs/backupWorker.ts          (markJobFailed, dispatch details)
//   apps/api/src/jobs/backupCatchUp.ts         (BACKUP_MISSED_ERROR and friends)
//   apps/api/src/jobs/staleCommandReaper.ts    (reapBackupJobRow messages)
//   apps/api/src/services/backupResultPersistence.ts (fences, RESERVATION_MISMATCH_MESSAGE)
//   apps/api/src/services/backupStorageWriteDelivery.ts (WRITE_REFUSAL_MESSAGES)
//   apps/api/src/services/backupHelperProtocols.ts (BACKUP_HELPER_UNREPORTED_MESSAGE)
//   apps/api/src/services/backupWriteHelperGate.ts (update-required message)
//   apps/api/src/services/backupEncryption.ts  (encryption plan refusals)
//   apps/api/src/routes/backup/jobs.ts         (enqueue failures, cancel)
//   agent/internal/backup/backup.go, brokered_journal.go,
//   agent/internal/sessionbroker/backup.go     (job errors and warnings)
type Row = [status: string, errorLog: string | null, expected: BackupFailureCategory | null];

const REAPER = '[stale-backup-reaper]';
const REPARSE_FRAGMENT =
  '2 reparse point(s) were not backed up (junctions and mount points are skipped, not followed; 2 other): ' +
  'C:\\a.exe (other reparse point, tag 0x8000001B); ' +
  'C:\\b.exe (other reparse point, tag 0x9000701A, reparse data unreadable: Access is denied.)';

const BINDING_CORPUS: Row[] = [
  ['failed', `${REAPER} Device went offline during backup`, 'device_offline'],
  ['failed', `${REAPER} Backup stalled: no progress reported for 15 minutes`, 'timeout'],
  ['failed', `${REAPER} Backup stalled: no data transferred for 24h while the agent was still responding (limit 24h)`, 'timeout'],
  ['failed', `${REAPER} Backup timed out (no completion after 24h)`, 'timeout'],
  ['failed', `${REAPER} Backup dispatch never completed`, 'timeout'],
  ['failed', `${REAPER} Backup command timed out: Server-side timeout: no response from agent after 60 minutes`, 'timeout'],
  ['failed', 'publish_lease_expired: late result rejected — the publish lease expired before this result arrived', 'timeout'],
  ['failed', 'could not ask to continue interrupted snapshot snapshot-1: storage session: session is no longer usable: renew rejected with status 410', 'storage'],
  ['failed', 'failed to upload file to s3 with multipart upload: AccessDenied: Access Denied', 'storage'],
  ['failed', 'base_retired: late result rejected — the base snapshot was retired before this result arrived', 'storage'],
  ['failed', 'backup helper exited unexpectedly', 'agent'],
  ['failed', 'IPC recv error: ipc: read header: EOF', 'agent'],
  ['failed', 'IPC recv error: ipc: message too large: 2065852772', 'agent'],
  ['failed', 'The backup reported a different snapshot than it was allowed to write.', 'agent'],
  ['failed', 'No backup targets resolved (mode=file). Ensure discovery has been run for this device.', 'configuration'],
  ['failed', 'VSS shadow copy could not be created', 'source_access'],
  ['partial', 'failed to open source file: open C:\\data\\x.pst: Access is denied.', 'source_access'],
  ['completed_with_errors', '3 files could not be read', 'source_access'],
  ['failed', `Partial dispatch: 1 target(s) failed to send (system_image)\n${REAPER} Device went offline during backup`, 'device_offline'],
  ['failed', 'something nobody has seen before', 'unknown'],
  ['failed', null, 'unknown'],
  ['cancelled', 'Cancelled by user', 'cancelled'],
  ['completed', 'VSS shadow copy could not be created', null],
  ['running', null, null],
];

// One row per distinct message the writers above can produce.
const WRITER_CORPUS: Row[] = [
  // Reaper: exact current wording.
  ['failed', `${REAPER} Backup stalled: no data transferred or verified for 3h while the agent was still responding (limit 2h)`, 'timeout'],
  ['failed', `${REAPER} Backup command timed out: Device did not reconnect before 2026-11-05T00:00:00.000Z; command was never delivered`, 'device_offline'],
  ['failed', `${REAPER} Backup command timed out: Command expired: agent never received the command (120 min timeout)`, 'device_offline'],
  // A refused delivery timed out only because it was refused: the refusal is the cause.
  ['failed', `${REAPER} Backup command timed out: Command was not delivered: Backups to S3 storage require agents to reach Breeze over HTTPS. Serve the agent API over HTTPS.`, 'storage'],
  ['failed', `${REAPER} Backup command timed out: Command was not delivered: The backup destination changed provider after this backup was queued. Start it again.`, 'configuration'],

  // Worker: device reachability.
  ['failed', 'Agent not connected', 'device_offline'],
  ['failed', 'Missed: device was offline for the whole catch-up window', 'device_offline'],
  ['failed', 'Failed to send command to agent', 'device_offline'],
  ['failed', 'Failed to send backup_run command to agent', 'device_offline'],
  // Deliberately not the offline bucket: reporting keeps this "a backup that broke".
  ['failed', 'Catch-up did not start: the device came online during the catch-up window, but the backup could not be dispatched', 'timeout'],

  // Worker: backup component on the device.
  ['failed', "The backup was not started because the backup component on this device hasn't reported which storage features it supports yet. If the device is online, update or reinstall the Breeze agent, then run the backup again.", 'agent'],
  ['failed', 'Update the Breeze agent on this device, then try again. Backups now require secure storage access, and the backup component on this device has not reported support for it.', 'agent'],
  ['failed', 'The backup was not started: it could not be queued again while waiting for the device to report its backup features. Run the backup again.', 'agent'],
  ['failed', 'Malformed backup result payload: status: Invalid input', 'agent'],

  // Worker: configuration and scope.
  ['failed', 'Backup config not found', 'configuration'],
  ['failed', 'backup_config_changed', 'configuration'],
  ['failed', 'device_org_changed', 'configuration'],
  ['failed', 'device_pending_assignment', 'configuration'],
  ['failed', 'Catch-up cancelled: the backup policy no longer applies to this device.', 'configuration'],
  ['failed', 'Catch-up cancelled: running missed backups was turned off on the backup policy.', 'configuration'],
  ['failed', 'whole-machine backup is not supported on darwin', 'configuration'],
  ['failed', 'Backup destination configuration not found for this snapshot', 'configuration'],
  ['failed', 'Backup encryption is currently enforceable only for S3 storage with explicit server-side encryption settings.', 'configuration'],
  ['failed', 'S3 KMS backup encryption requires a kmsKeyId or keyArn.', 'configuration'],
  ['failed', 'Backup encryption is enabled but no enforceable client encryption or S3 SSE/KMS policy is configured.', 'configuration'],

  // WRITE_REFUSAL_MESSAGES.
  ['failed', 'This backup destination uses a storage provider that backups no longer support. Change the backup destination to S3-compatible storage or a local path.', 'storage'],
  ['failed', 'Backups to S3 storage require the storage endpoint to use HTTPS. Change the backup destination endpoint to HTTPS.', 'storage'],
  ['failed', 'This device connects to Breeze at an address the server is not configured to serve, so a secure storage session cannot be issued. Set PUBLIC_API_URL to the address agents use.', 'storage'],
  ['failed', 'The server address agents use is not configured, so a secure storage session cannot be issued. Set PUBLIC_API_URL.', 'storage'],
  ['failed', 'Backups to S3 storage require agents to reach Breeze over HTTPS. Serve the agent API over HTTPS.', 'storage'],
  ['failed', 'The backup was not started: a secure storage session could not be issued for it. Run the backup again.', 'storage'],
  ['failed', "The backup destination's key prefix is invalid. Edit the destination and save a valid prefix.", 'storage'],
  ['failed', 'This backup was started under a storage location this server cannot read. Start the backup again.', 'storage'],
  ['failed', 'The backup destination can no longer be used: destination config missing', 'storage'],
  ['failed', 'The target device no longer belongs to the organization that owns this backup destination.', 'configuration'],
  ['failed', 'This backup job has already finished or been cancelled.', 'configuration'],
  ['failed', 'This backup was queued by an earlier version of Breeze and can no longer be delivered. Start it again.', 'configuration'],
  ['failed', 'This backup command carries no usable backup destination reference. Start it again.', 'configuration'],
  ['failed', 'This backup command is not linked to a backup job. Start it again.', 'configuration'],
  ['failed', 'The backup destination changed provider after this backup was queued. Start it again.', 'configuration'],
  ['failed', 'The backup destination encryption settings changed after this backup was queued. Start it again.', 'configuration'],
  ['failed', "The destination's key prefix changed after this backup was scheduled. The next scheduled run will take a full backup under the new prefix.", 'configuration'],

  // Agent job errors.
  ['failed', 'failed to upload file to gcs: googleapi: Error 403: forbidden', 'storage'],
  ['failed', 'failed to upload file to azure: RESPONSE 403', 'storage'],
  ['failed', 'system state publish failed: put object: EOF', 'storage'],
  ['failed', 'layout manifest publish failed: put object: EOF', 'storage'],
  ['failed', 'resume check failed, refusing to guess whether snapshots/a was already published: EOF', 'storage'],
  ['failed', 'the interrupted snapshot this backup continued is already published, but its manifest could not be read', 'storage'],
  ['failed', 'write to local destination: no space left on device', 'storage'],
  // Local-path destination (agent/internal/backup/providers/local.go): a permission
  // error on the destination is storage, not the source files.
  ['failed', 'failed to create backup directory: mkdir /mnt/backups/x: permission denied', 'storage'],
  ['partial', '2 of 10 files failed to upload: failed to create destination file: open /mnt/backups/x/a: permission denied', 'storage'],
  ['failed', 'failed to close destination file: input/output error', 'storage'],
  ['failed', 'failed to store backup file: rename /mnt/backups/x/a.tmp: access is denied', 'storage'],
  ['partial', '1 of 5 files failed to upload: failed to stat source file: lstat C:\\a.pst: Access is denied.', 'source_access'],
  ['partial', '2 of 10 files failed to upload: failed to open source file: open C:\\a.pst: The process cannot access the file because it is being used by another process.', 'source_access'],
  ['failed', '10 of 10 files failed to upload: failed to upload file to s3: SignatureDoesNotMatch', 'storage'],
  ['failed', '4 file(s) could not be read during collection: open /srv/a: permission denied', 'source_access'],
  ['failed', 'VSS shadow copy could not be created, so every path was read from the live volume, not a point-in-time copy', 'source_access'],

  ['failed', 'backup stopped', 'cancelled'],
  ['failed', `backup stopped; ${REPARSE_FRAGMENT}`, 'cancelled'],

  // Server-side faults with no operator-facing bucket: raw text is the honest answer.
  ['failed', 'Unknown error', 'unknown'],
  ['failed', 'Failed to create backup job', 'unknown'],
  ['failed', 'Failed to enqueue backup dispatch: Connection is closed.', 'unknown'],
  ['failed', 'Backup dispatch aborted; the backup_run target never reached the agent: deadlock detected', 'unknown'],
  ['failed', 'Failed to send backup_run command to agent (dispatch outcome held)', 'unknown'],
  ['failed', 'Partial dispatch: 1 target(s) failed to send (system_image)', 'unknown'],

  // Status fallbacks.
  ['partial', 'nothing a rule recognises', 'source_access'],
  ['completed_with_errors', null, 'source_access'],
  ['cancelled', null, 'cancelled'],
  ['cancelled', `${REAPER} Device went offline during backup`, 'cancelled'],
  ['pending', 'Agent not connected', null],
];

describe('classifyBackupFailure (#11027)', () => {
  it('declares the eight categories the UI has copy for', () => {
    expect([...BACKUP_FAILURE_CATEGORIES]).toEqual([
      'device_offline', 'timeout', 'storage', 'agent', 'configuration', 'source_access', 'cancelled', 'unknown',
    ]);
  });

  it.each(BINDING_CORPUS)('classifies the production message corpus: %s / %s', (status, errorLog, expected) => {
    expect(classifyBackupFailure({ status, errorLog })).toBe(expected);
  });

  it.each(WRITER_CORPUS)('classifies every message a writer can produce: %s / %s', (status, errorLog, expected) => {
    expect(classifyBackupFailure({ status, errorLog })).toBe(expected);
  });

  describe('last line decides', () => {
    it('lets a reaper line outrank the dispatch note before it', () => {
      expect(classifyBackupFailure({
        status: 'failed',
        errorLog: `Partial dispatch: 1 target(s) failed to send (system_image)\n${REAPER} Device went offline during backup`,
      })).toBe('device_offline');
    });

    it('lets a reaper offline line outrank an earlier storage error', () => {
      expect(classifyBackupFailure({
        status: 'failed',
        errorLog: `failed to upload file to s3: SlowDown\n${REAPER} Device went offline during backup`,
      })).toBe('device_offline');
    });

    it('lets a lower-priority last line outrank a higher-priority earlier line', () => {
      // device_offline is tried before agent within a line, but only within one.
      expect(classifyBackupFailure({
        status: 'failed',
        errorLog: 'Agent not connected\nbackup helper exited unexpectedly',
      })).toBe('agent');
    });

    it('falls back to an earlier line when the last one matches nothing', () => {
      expect(classifyBackupFailure({
        status: 'failed',
        errorLog: 'backup helper exited unexpectedly\nsomething nobody has seen before',
      })).toBe('agent');
    });

    it('ignores blank lines and CRLF line endings', () => {
      expect(classifyBackupFailure({
        status: 'failed',
        errorLog: 'failed to upload file to s3: SlowDown\r\nbackup helper exited unexpectedly\r\n\r\n',
      })).toBe('agent');
    });
  });

  describe('within a line', () => {
    it('lets the failing error of an "error; warning" join outrank a VSS warning', () => {
      expect(classifyBackupFailure({
        status: 'failed',
        errorLog: 'failed to upload file to s3: SlowDown; VSS shadow copy could not be created, so every path was read from the live volume',
      })).toBe('storage');
    });

    it('strips every leading tag and the reconcile prefix before matching', () => {
      expect(classifyBackupFailure({
        status: 'failed',
        errorLog: '[reconciled-from-storage] prior failure: [stale-backup-reaper] Device went offline during backup',
      })).toBe('device_offline');
    });

    it('does not read a storage transfer timeout as a backup timeout', () => {
      expect(classifyBackupFailure({
        status: 'failed',
        errorLog: 'failed to upload file to s3: dial tcp: connection timed out',
      })).toBe('storage');
    });
  });

  describe('reparse fragment', () => {
    it('reparse fragment alone on completed_with_errors is source_access', () => {
      expect(classifyBackupFailure({ status: 'completed_with_errors', errorLog: REPARSE_FRAGMENT })).toBe('source_access');
    });

    it('does not let text inside the reparse fragment classify a failed run', () => {
      // The fragment carries "Access is denied." but skipping is by design.
      expect(classifyBackupFailure({ status: 'failed', errorLog: REPARSE_FRAGMENT })).toBe('unknown');
    });

    it('classifies the real error beside the fragment', () => {
      expect(classifyBackupFailure({
        status: 'failed',
        errorLog: `backup helper exited unexpectedly; ${REPARSE_FRAGMENT}`,
      })).toBe('agent');
    });
  });

  it('treats undefined errorLog like null', () => {
    expect(classifyBackupFailure({ status: 'failed', errorLog: undefined })).toBe('unknown');
  });
});
