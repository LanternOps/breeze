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
