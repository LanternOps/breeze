// W09 (#6464) Task 5 — the pure decision table from Part 0 §1 "Server
// decision at authenticate/exchange". Deliberately has NO database or HTTP
// dependency: route handlers (bmr.ts authenticate, bmrRecoveries.ts exchange)
// gather NegotiationInput from the DB/provider-config resolution they already
// do, call this, and translate the result into a response. Keeping this pure
// is what makes the R1-R11 table exhaustively unit-testable without a DB.
import type { FileIndexStatus } from './backupSnapshotFileIndex';
import { BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY, hasMembershipCapability } from './backupObjectKey';

export type NegotiationInput = {
  clientCapabilities: readonly string[] | undefined;
  previouslyNegotiated: readonly string[] | null;
  referencedFiles: number | null;
  storageIdentity: string | null;
  resolvedProviderIdentity: string | null;
  fileIndex: {
    status: FileIndexStatus;
    manifestSha256: string | null;
    externalCount: number | null;
    originSnapshotIds: string[];
    error: string | null;
    retryable: boolean;
  };
};

type NegotiationErrorCode =
  | 'client_capability_required'
  | 'capability_downgrade'
  | 'snapshot_storage_identity_unknown'
  | 'storage_identity_drift'
  | 'snapshot_index_pending'
  | 'snapshot_index_failed';

export type NegotiationResult =
  | { ok: true; granted: string[]; fileIndex: { status: 'complete'; manifestSha256: string; externalCount: number; originSnapshotIds: string[] } | null; enqueueHydration: boolean }
  | { ok: false; status: 409; error: NegotiationErrorCode; message: string; retryAfterSeconds?: number; details?: Record<string, unknown>; enqueueHydration: boolean };

export const RECOVERY_REFUSAL_MESSAGES: Record<NegotiationErrorCode, string> = {
  client_capability_required:
    'This backup references files stored with earlier snapshots. The recovery media you booted is too old to read them — download the current recovery media from Breeze and boot again.',
  capability_downgrade:
    'This recovery session was started with cross-snapshot support and cannot continue without it.',
  snapshot_storage_identity_unknown:
    "Breeze has not yet verified where this snapshot's files are stored. Wait for the next retention run or choose a newer full backup.",
  storage_identity_drift:
    'The backup destination for this device has changed since this snapshot was written. Restore the previous destination settings or choose a snapshot written to the current destination.',
  snapshot_index_pending:
    'Breeze is preparing the file index for this snapshot (N files reference earlier snapshots). Retry in 30 seconds.',
  snapshot_index_failed:
    "Breeze could not verify this snapshot's file index: <reason>. Choose a newer full backup or contact support.",
};

const CAP = BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY;

function refuse(
  error: NegotiationErrorCode,
  opts: { retryAfterSeconds?: number; details?: Record<string, unknown>; message?: string; enqueueHydration?: boolean } = {},
): NegotiationResult {
  return {
    ok: false,
    status: 409,
    error,
    message: opts.message ?? RECOVERY_REFUSAL_MESSAGES[error],
    ...(opts.retryAfterSeconds !== undefined ? { retryAfterSeconds: opts.retryAfterSeconds } : {}),
    ...(opts.details ? { details: opts.details } : {}),
    enqueueHydration: opts.enqueueHydration ?? false,
  };
}

export function negotiateRecoveryCapabilities(input: NegotiationInput): NegotiationResult {
  const clientHasCap = hasMembershipCapability(input.clientCapabilities);
  const needs = typeof input.referencedFiles === 'number' && input.referencedFiles > 0;

  if (!needs) {
    return { ok: true, granted: clientHasCap ? [CAP] : [], fileIndex: null, enqueueHydration: false };
  }

  const previouslyHadCap = hasMembershipCapability(input.previouslyNegotiated);
  if (previouslyHadCap && !clientHasCap) {
    return refuse('capability_downgrade');
  }
  if (!clientHasCap) {
    return refuse('client_capability_required', { details: { referencedFiles: input.referencedFiles } });
  }

  if (!input.storageIdentity) {
    return refuse('snapshot_storage_identity_unknown');
  }
  if (input.resolvedProviderIdentity !== input.storageIdentity) {
    return refuse('storage_identity_drift');
  }

  if (input.fileIndex.status === 'none' || input.fileIndex.status === 'agent') {
    return refuse('snapshot_index_pending', { retryAfterSeconds: 30, enqueueHydration: true });
  }
  if (input.fileIndex.status === 'hydrating') {
    return refuse('snapshot_index_pending', { retryAfterSeconds: 30, enqueueHydration: false });
  }
  if (input.fileIndex.status === 'failed') {
    return refuse('snapshot_index_failed', {
      message: RECOVERY_REFUSAL_MESSAGES.snapshot_index_failed.replace('<reason>', input.fileIndex.error ?? 'unknown error'),
      enqueueHydration: input.fileIndex.retryable,
    });
  }

  return {
    ok: true,
    granted: [CAP],
    fileIndex: {
      status: 'complete',
      manifestSha256: input.fileIndex.manifestSha256!,
      externalCount: input.fileIndex.externalCount ?? 0,
      originSnapshotIds: input.fileIndex.originSnapshotIds,
    },
    enqueueHydration: false,
  };
}
