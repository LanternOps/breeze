type BackupMetricsRecorder = {
  onDispatchFailure: (operation: string, reason: string, count?: number) => void;
  onVerificationSkip: (verificationType: string, reason: string, count?: number) => void;
  onRestoreTimeout: (commandType: string, count?: number) => void;
  onCommandTimeout: (commandType: string, source: string, count?: number) => void;
  onVerificationResult: (
    verificationType: string,
    status: string,
    count?: number
  ) => void;
  onLowReadinessDevices: (count: number) => void;
  onReadDispatch: (commandType: string, mode: string, reason: string, count?: number) => void;
  onCapabilityRegressed: (capability: string, count?: number) => void;
  onStorageSessionCall: (scope: string, op: string, status: number, count?: number) => void;
  onStorageSessionObjects: (scope: string, method: string, count?: number) => void;
  onStorageSessionMint: (scope: string, outcome: string, reason: string, count?: number) => void;
  onWriteDispatch: (commandType: string, mode: string, reason: string, count?: number) => void;
  onAttestation: (outcome: string, count?: number) => void;
  onWriteJanitor: (action: string, outcome: string, count?: number) => void;
  onUnexpectedLegacyWrite: (commandType: string, reason: string, count?: number) => void;
  onConditionalWriteProbe: (outcome: string, reason: string, count?: number) => void;
  onSnapshotPublishRefused: (reason: string, count?: number) => void;
  onRestoreIntegrity: (commandType: string, status: string, reason: string, count?: number) => void;
};

const noop = () => {};

let recorder: BackupMetricsRecorder = {
  onDispatchFailure: noop,
  onVerificationSkip: noop,
  onRestoreTimeout: noop,
  onCommandTimeout: noop,
  onVerificationResult: noop,
  onLowReadinessDevices: noop,
  onReadDispatch: noop,
  onCapabilityRegressed: noop,
  onStorageSessionCall: noop,
  onStorageSessionObjects: noop,
  onStorageSessionMint: noop,
  onWriteDispatch: noop,
  onAttestation: noop,
  onWriteJanitor: noop,
  onUnexpectedLegacyWrite: noop,
  onConditionalWriteProbe: noop,
  onSnapshotPublishRefused: noop,
  onRestoreIntegrity: noop,
};

export function setBackupMetricsRecorder(next: Partial<BackupMetricsRecorder> | null | undefined): void {
  recorder = {
    onDispatchFailure: next?.onDispatchFailure ?? noop,
    onVerificationSkip: next?.onVerificationSkip ?? noop,
    onRestoreTimeout: next?.onRestoreTimeout ?? noop,
    onCommandTimeout: next?.onCommandTimeout ?? noop,
    onVerificationResult: next?.onVerificationResult ?? noop,
    onLowReadinessDevices: next?.onLowReadinessDevices ?? noop,
    onReadDispatch: next?.onReadDispatch ?? noop,
    onCapabilityRegressed: next?.onCapabilityRegressed ?? noop,
    onStorageSessionCall: next?.onStorageSessionCall ?? noop,
    onStorageSessionObjects: next?.onStorageSessionObjects ?? noop,
    onStorageSessionMint: next?.onStorageSessionMint ?? noop,
    onWriteDispatch: next?.onWriteDispatch ?? noop,
    onAttestation: next?.onAttestation ?? noop,
    onWriteJanitor: next?.onWriteJanitor ?? noop,
    onUnexpectedLegacyWrite: next?.onUnexpectedLegacyWrite ?? noop,
    onConditionalWriteProbe: next?.onConditionalWriteProbe ?? noop,
    onSnapshotPublishRefused: next?.onSnapshotPublishRefused ?? noop,
    onRestoreIntegrity: next?.onRestoreIntegrity ?? noop,
  };
}

export function recordBackupDispatchFailure(operation: string, reason: string, count = 1): void {
  recorder.onDispatchFailure(operation, reason, count);
}

export function recordBackupVerificationSkip(
  verificationType: string,
  reason: string,
  count = 1
): void {
  recorder.onVerificationSkip(verificationType, reason, count);
}

export function recordRestoreTimeout(commandType: string, count = 1): void {
  recorder.onRestoreTimeout(commandType, count);
}

export function recordBackupCommandTimeout(commandType: string, source: string, count = 1): void {
  recorder.onCommandTimeout(commandType, source, count);
}

export function recordBackupVerificationResult(
  verificationType: string,
  status: string,
  count = 1
): void {
  recorder.onVerificationResult(verificationType, status, count);
}

export function setLowReadinessDevices(count: number): void {
  recorder.onLowReadinessDevices(Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0);
}

/**
 * One restore-shaped command delivery attempt, by `mode`: `brokered` (a storage
 * session was delivered), `local` (a local destination path), `deferred`
 * (released until the snapshot's file index is ready), `refused` (never
 * delivered), or `legacy` (a VM command delivered as queued, carrying no
 * destination) — with the reason the command could not be brokered. A storage
 * destination is never delivered for a read.
 */
export function recordBackupReadDispatch(
  commandType: string,
  mode: 'brokered' | 'local' | 'deferred' | 'refused' | 'legacy',
  reason: string,
  count = 1,
): void {
  recorder.onReadDispatch(commandType, mode, reason, count);
}

/** Backup-helper protocols a device reports (routes/agents/heartbeat.ts). */
export type BackupHelperCapability = 'read' | 'integrity' | 'write';

/**
 * A device's backup helper reported a LOWER protocol version than the one
 * stored for it (a helper downgrade or reinstall, or an agent that stopped
 * reporting it). Counted once per drop, never per heartbeat; the per-device
 * record is the `device.backup_capability.regressed` audit event.
 */
export function recordBackupCapabilityRegressed(capability: BackupHelperCapability, count = 1): void {
  recorder.onCapabilityRegressed(capability, count);
}

/** What a storage session grants: reading one snapshot, or writing one. */
export type StorageSessionScope = 'snapshot_read' | 'snapshot_write';

/** Agent-facing storage-session operations (routes/agents/storageSessions.ts). */
export type StorageSessionOp =
  | 'resolve'
  | 'renew'
  | 'object'
  | 'resume'
  | 'multipart_create'
  | 'multipart_complete'
  | 'multipart_abort'
  | 'list'
  | 'delete';

/** How a presigned storage-session object URL may be used. */
export type StorageSessionObjectMethod = 'GET' | 'PUT' | 'UPLOAD_PART';

/**
 * One agent call to a storage-session endpoint, by the HTTP status it was
 * answered with (410 = the session expired, was revoked or ended with its
 * command). Never labelled by session, device or key.
 */
export function recordStorageSessionCall(scope: StorageSessionScope, op: StorageSessionOp, status: number, count = 1): void {
  recorder.onStorageSessionCall(scope, op, status, count);
}

/** Presigned object URLs handed out by storage-session calls. */
export function recordStorageSessionObjects(
  scope: StorageSessionScope,
  method: StorageSessionObjectMethod,
  count: number,
): void {
  recorder.onStorageSessionObjects(scope, method, count);
}

/**
 * One storage-session issuance decision at command delivery: `minted` (a
 * session row was created), or the reason none was: `refused`, `deferred`
 * (released until the snapshot's file index is ready) or `legacy` (delivered
 * as queued, without a session).
 */
export function recordStorageSessionMint(
  scope: StorageSessionScope,
  outcome: 'minted' | 'refused' | 'deferred' | 'legacy',
  reason: string,
  count = 1,
): void {
  recorder.onStorageSessionMint(scope, outcome, reason, count);
}

/**
 * How a backup write command reached the device: `brokered` (through a
 * storage session), `legacy_credential` (carrying the storage destination
 * with its credentials), `local` (a local destination path, no credential)
 * or `refused`. Recorded once per command actually handed to the agent —
 * except `deferred`, recorded each time a queued command is held back
 * because the device has not reported its backup helper yet.
 */
export type BackupWriteDispatchMode = 'brokered' | 'legacy_credential' | 'local' | 'refused' | 'deferred';

/**
 * Backups to S3 storage are delivered only through write sessions, so no
 * write is expected to carry its storage credential any more: every
 * `legacy_credential` count is also counted by `onUnexpectedLegacyWrite`, so
 * it can be alerted on.
 */
const EXPECTED_LEGACY_WRITE_REASONS = new Set<string>();

export function recordBackupWriteDispatch(
  commandType: string,
  mode: BackupWriteDispatchMode,
  reason: string,
  count = 1,
): void {
  recorder.onWriteDispatch(commandType, mode, reason, count);
  if (mode === 'legacy_credential' && !EXPECTED_LEGACY_WRITE_REASONS.has(reason)) {
    recorder.onUnexpectedLegacyWrite(commandType, reason, count);
  }
}

/**
 * A backup result whose snapshot row the database refused because its id is
 * owned elsewhere: `not_current_job` (a server-issued id another backup job
 * of the organization now holds) or `foreign_claim` (the id belongs to
 * another backup, possibly another organization's).
 */
export function recordSnapshotPublishRefused(reason: 'not_current_job' | 'foreign_claim', count = 1): void {
  recorder.onSnapshotPublishRefused(reason, count);
}

/** One destination probe for create-only write support, by outcome and reason. */
export function recordConditionalWriteProbe(outcome: 'supported' | 'unsupported', reason: string, count = 1): void {
  recorder.onConditionalWriteProbe(outcome, reason, count);
}


/**
 * Snapshot attestation outcomes (services/backupAttestation.ts and
 * jobs/backupSnapshotAttestationWorker.ts). At recording: `recorded`,
 * `duplicate_same`, `conflict`, `binding_mismatch`, `invalid`,
 * `missing_from_capable` (a capable helper reported no attestation),
 * `not_offered` (an older helper), `missing_expectation` (the result was not
 * bound to a consumed dispatch expectation), `job_reuse_refused` (a result
 * from another job for a snapshot that already carries an attestation). At
 * verification: `verified`, `mismatch`, `verify_unavailable` (storage not
 * readable; retried later), `verify_parked` (still pending after the last
 * automatic attempt).
 */
export type BackupAttestationMetricOutcome =
  | 'recorded'
  | 'duplicate_same'
  | 'conflict'
  | 'binding_mismatch'
  | 'invalid'
  | 'missing_from_capable'
  | 'not_offered'
  | 'capability_unknown'
  | 'missing_expectation'
  | 'job_reuse_refused'
  | 'verified'
  | 'mismatch'
  | 'verify_unavailable'
  | 'verify_parked';

export function recordBackupAttestation(outcome: BackupAttestationMetricOutcome, count = 1): void {
  recorder.onAttestation(outcome, count);
}

/**
 * One action of the brokered-write cleanup job (jobs/backupWriteSessionJanitor.ts):
 * `abort_upload` (a recorded multipart upload aborted), `sweep_prefix` (every
 * stray multipart upload under a finished snapshot prefix aborted), `publish`
 * (a sealing snapshot published once every issued upload URL expired) or
 * `abandon` (a reservation whose job ended without publishing). Outcome is
 * `ok` or `failed` (left for the next run).
 */
export type BackupWriteJanitorAction = 'abort_upload' | 'settle_delete' | 'sweep_prefix' | 'publish' | 'abandon';

export function recordBackupWriteJanitor(action: BackupWriteJanitorAction, outcome: 'ok' | 'failed', count = 1): void {
  recorder.onWriteJanitor(action, outcome, count);
}

/**
 * The integrity expectation delivered with one restore-shaped command or
 * recovery bootstrap (services/backupRestoreIntegrity.ts): `attested` (reason
 * = trust: `server_verified` | `producer_only`), `unattested` (reason =
 * `unattested_legacy` | `unattested` | `pending` | `attestation_failed`), or
 * `absent` (no block; the snapshot could not be resolved). `override` and
 * `refused` are reserved for when restores are gated on it.
 */
export type RestoreIntegrityMetricStatus = 'attested' | 'unattested' | 'absent' | 'override' | 'refused';

export function recordRestoreIntegrity(
  commandType: string,
  status: RestoreIntegrityMetricStatus,
  reason: string,
  count = 1,
): void {
  recorder.onRestoreIntegrity(commandType, status, reason, count);
}
