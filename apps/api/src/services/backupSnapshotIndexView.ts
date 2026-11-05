/**
 * What a person may be told about a snapshot's file index, and whether reading
 * it should ask for one (#11026). The rule lives in one pure function so the
 * browse route, selective restore and the rebuild route answer alike.
 *
 * Reading rows is gated separately, in the statement that reads them, by
 * readableIndexCondition (backupRestoreIntegrity.ts). This view never decides
 * what is listed: it decides what to say when nothing can be, and it only ever
 * carries failure codes, because file_index_error can hold storage keys and
 * provider messages.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs, backupSnapshotFiles, backupSnapshots } from '../db/schema/backup';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { INDEX_BINDABLE_ATTESTATION_STATUSES, indexFailedOnAttestation } from './backupRestoreIntegrity';

export type FileIndexStatus = 'none' | 'agent' | 'hydrating' | 'complete' | 'failed';

export type HydrationFailure =
  | 'storage_identity_unknown'
  | 'storage_identity_drift'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'manifest_too_large'
  | 'manifest_key_invalid'
  | 'origin_unverifiable'
  | 'origin_identity_pending'
  | 'provider_error'
  // The manifest bytes read from storage are not the ones the snapshot's
  // attestation names.
  | 'manifest_differs_from_attestation'
  // The snapshot's attestation did not match its stored objects.
  | 'attestation_failed'
  // The snapshot records a key root this server cannot read (#7081).
  | 'key_root_invalid'
  // An origin the manifest references lives under another key root than the
  // snapshot (#7081 I4): a dedupe chain never spans roots.
  | 'origin_key_root_mismatch';

const HYDRATION_FAILURES: readonly HydrationFailure[] = [
  'storage_identity_unknown', 'storage_identity_drift', 'manifest_missing', 'manifest_invalid',
  'manifest_too_large', 'manifest_key_invalid', 'origin_unverifiable', 'origin_identity_pending', 'provider_error',
  'manifest_differs_from_attestation', 'attestation_failed', 'key_root_invalid', 'origin_key_root_mismatch',
];

// Retryability is a pure function of the failure code so that the route glue
// (authenticate/exchange) and the BullMQ worker agree without a second column:
// transient storage/network conditions and "GC has not healed this identity
// yet" retry; a malformed manifest or an unprovable origin never will.
export const RETRYABLE_HYDRATION_FAILURES: ReadonlySet<HydrationFailure> = new Set<HydrationFailure>([
  'manifest_missing', 'provider_error', 'origin_identity_pending',
]);
export function isRetryableHydrationFailure(failure: HydrationFailure): boolean {
  return RETRYABLE_HYDRATION_FAILURES.has(failure);
}
export function hydrationFailureFromError(error: string | null): HydrationFailure | null {
  if (!error) return null;
  const prefix = error.split(':', 1)[0] ?? '';
  return (HYDRATION_FAILURES as readonly string[]).includes(prefix) ? (prefix as HydrationFailure) : null;
}

/** A row left in 'hydrating' longer than this belongs to a worker that died; it may be claimed again. */
export const HYDRATING_STALE_MS = 30 * 60 * 1000;
/** How soon after a claim a retryable failure may be requested again by reading the index. */
export const INDEX_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

export type SnapshotIndexView =
  | { state: 'ready' }
  | { state: 'building' }
  | {
      state: 'unavailable';
      failure: HydrationFailure | 'never_indexed';
      retryable: boolean;
      /** The API cannot read this destination, so it cannot read the manifest there. */
      deviceLocal: boolean;
    };

export type SnapshotIndexViewInput = {
  status: FileIndexStatus | string;
  manifestSha256: string | null;
  error: string | null;
  integrityStatus: string | null;
  attestation: { status: string; manifestSha256: string } | null;
  hasRows: boolean;
  /** Files UPLOADED by the run (backup_snapshots.file_count); null when the agent reported none. */
  fileCount: number | null;
  /** Files the run took from older snapshots (backup_jobs.referenced_files). */
  referencedFiles?: number | null;
  hydratedAt: Date | null;
  storageIdentity: string | null;
  now?: Date;
};

export type SnapshotIndexViewOutcome = { view: SnapshotIndexView; shouldRequestHydration: boolean };

/**
 * Whether a snapshot with no rows may still hold files. `file_count` counts
 * only what the run uploaded, so an unchanged incremental reads 0 while every
 * file comes from an older snapshot; and an unknown count is no evidence of an
 * empty snapshot. Only a known zero of both is. The manifest settles the rest:
 * a truly empty snapshot hydrates to a complete, empty index.
 */
function mayHaveFiles(input: Pick<SnapshotIndexViewInput, 'fileCount' | 'referencedFiles'>): boolean {
  if (input.fileCount === null) return true;
  return input.fileCount > 0 || (input.referencedFiles ?? 0) > 0;
}

export function snapshotIndexView(input: SnapshotIndexViewInput): SnapshotIndexViewOutcome {
  const { status, manifestSha256, attestation, hasRows } = input;
  const now = input.now ?? new Date();
  const deviceLocal = input.storageIdentity?.startsWith('local::') ?? false;
  const unavailable = (failure: HydrationFailure | 'never_indexed', retryable: boolean, shouldRequestHydration = false): SnapshotIndexViewOutcome => ({
    view: { state: 'unavailable', failure, retryable, deviceLocal },
    shouldRequestHydration,
  });
  const ready: SnapshotIndexViewOutcome = { view: { state: 'ready' }, shouldRequestHydration: false };
  const building = (shouldRequestHydration: boolean): SnapshotIndexViewOutcome => ({ view: { state: 'building' }, shouldRequestHydration });

  // Whatever the status: a snapshot that failed its integrity check lists nothing.
  if (input.integrityStatus === 'attestation_failed' || (attestation && !INDEX_BINDABLE_ATTESTATION_STATUSES.has(attestation.status))) {
    return unavailable('attestation_failed', false);
  }

  // Rows built from bytes other than the attested ones are never readable.
  // Inline rows carry no digest and are unaffected.
  const rowsFromOtherBytes = hasRows && attestation !== null && manifestSha256 !== null && manifestSha256 !== attestation.manifestSha256;
  const usableRows = hasRows && !rowsFromOtherBytes;

  switch (status) {
    case 'complete':
      if (attestation && manifestSha256 !== attestation.manifestSha256) return building(true);
      return ready;
    case 'hydrating': {
      if (usableRows) return ready;
      // A worker that died mid-run would otherwise read as building forever.
      const stale = !input.hydratedAt || now.getTime() - input.hydratedAt.getTime() >= HYDRATING_STALE_MS;
      return building(stale);
    }
    case 'failed': {
      if (indexFailedOnAttestation(input.error)) {
        return unavailable(hydrationFailureFromError(input.error) ?? 'attestation_failed', false);
      }
      if (usableRows) return ready;
      const failure = hydrationFailureFromError(input.error);
      // Text that names no known code came from before the codes existed:
      // trying again costs one job, and the person is told the truth meanwhile.
      const retryable = failure === null || isRetryableHydrationFailure(failure);
      if (!retryable) return unavailable(failure ?? 'never_indexed', false);
      const outsideCooldown = !input.hydratedAt || now.getTime() - input.hydratedAt.getTime() >= INDEX_RETRY_COOLDOWN_MS;
      return unavailable(failure ?? 'never_indexed', true, outsideCooldown);
    }
    default:
      // 'none' and 'agent'. An inline index that lost its rows (a re-adopted
      // result can carry an empty list) reads the same as one never built, so
      // a snapshot with files is never shown as an empty tree.
      if (usableRows) return ready;
      if (rowsFromOtherBytes || mayHaveFiles(input)) return building(true);
      return ready;
  }
}

/**
 * One statement: the snapshot's index columns, its attestation and whether it
 * has any rows, scoped to the org, then the view of them. Null when the snapshot
 * is not visible in the caller's context or belongs to another org.
 */
export async function readSnapshotIndexView(
  snapshotDbId: string,
  orgId: string,
): Promise<(SnapshotIndexViewOutcome & { id: string; fileCount: number | null }) | null> {
  const [row] = await db
    .select({
      id: backupSnapshots.id,
      fileCount: backupSnapshots.fileCount,
      fileIndexStatus: backupSnapshots.fileIndexStatus,
      fileIndexManifestSha256: backupSnapshots.fileIndexManifestSha256,
      fileIndexError: backupSnapshots.fileIndexError,
      fileIndexHydratedAt: backupSnapshots.fileIndexHydratedAt,
      integrityStatus: backupSnapshots.integrityStatus,
      storageIdentity: backupSnapshots.storageIdentity,
      attestationStatus: backupSnapshotAttestations.status,
      attestationManifestSha256: backupSnapshotAttestations.manifestSha256,
      referencedFiles: backupJobs.referencedFiles,
      hasRows: sql<boolean>`EXISTS (SELECT 1 FROM ${backupSnapshotFiles} WHERE ${backupSnapshotFiles.snapshotDbId} = ${backupSnapshots.id})`,
    })
    .from(backupSnapshots)
    .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id))
    .leftJoin(backupJobs, eq(backupJobs.id, backupSnapshots.jobId))
    .where(and(eq(backupSnapshots.id, snapshotDbId), eq(backupSnapshots.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  const outcome = snapshotIndexView({
    status: row.fileIndexStatus,
    manifestSha256: row.fileIndexManifestSha256 ?? null,
    error: row.fileIndexError ?? null,
    integrityStatus: row.integrityStatus ?? null,
    attestation: row.attestationStatus && row.attestationManifestSha256
      ? { status: row.attestationStatus, manifestSha256: row.attestationManifestSha256 }
      : null,
    hasRows: row.hasRows === true,
    fileCount: row.fileCount ?? null,
    referencedFiles: row.referencedFiles ?? null,
    hydratedAt: row.fileIndexHydratedAt ?? null,
    storageIdentity: row.storageIdentity ?? null,
  });
  return { ...outcome, id: row.id, fileCount: row.fileCount ?? null };
}
