/**
 * Integrity expectations for restore-shaped work.
 *
 * Every command that reads a snapshot back to a device (restore, verify,
 * test-restore, MSSQL and Hyper-V restore/verify, VM restore and instant boot,
 * bare-metal recovery and rebuild) and the bare-metal recovery bootstrap carry
 * an `integrity` block describing what the server knows about the snapshot's
 * attestation (services/backupAttestation.ts): the exact digests and sizes of
 * the snapshot's control objects when the attestation is usable, or why it is
 * not. A backup helper that understands the block checks every control object
 * against it before parsing it; one that does not ignores it.
 *
 * Whether a restore may run on these grounds is decided by
 * services/backupRestoreGate.ts (privileged restores of a snapshot without a
 * usable attestation need a confirmed authorization and carry an
 * `unattested_override` block naming it); read-only validation carries the
 * block below as a label.
 *
 * Wire shape (version 1; `objects` order is not significant):
 *   { v: 1, mode: "attested", trust: "server_verified" | "producer_only",
 *     snapshotId, objects: [{ role, key, sha256, size }, ...] }
 *   { v: 1, mode: "unattested", snapshotId,
 *     reason: "unattested_legacy" | "unattested" | "pending" | "attestation_failed" }
 *
 * `trust: "producer_only"` is a device-local destination the server cannot
 * read: the digests are the producing device's own statement.
 *
 * This module also owns the rule that binds a snapshot's server-built file
 * index to its attestation (`indexMatchesAttestation`), used wherever an index
 * authorizes a read.
 *
 * Leaf module on the command-delivery import path: it imports only the
 * database handle and schema tables, and builds control keys itself.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { backupSnapshots } from '../db/schema/backup';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';

export const RESTORE_INTEGRITY_FORMAT = 1;

export type IntegrityObjectRole = 'manifest' | 'layout' | 'system_state_manifest';

export type IntegrityObject = { role: IntegrityObjectRole; key: string; sha256: string; size: number };

export type UnattestedRestoreReason = 'unattested_legacy' | 'unattested' | 'pending' | 'attestation_failed';

export type RestoreIntegrity =
  | {
      mode: 'attested';
      trust: 'server_verified' | 'producer_only';
      snapshotId: string;
      sourceDeviceId: string;
      objects: IntegrityObject[];
    }
  | { mode: 'unattested'; snapshotId: string; reason: UnattestedRestoreReason };

/** The snapshot row fields the decision reads. */
export type IntegritySnapshotInput = {
  deviceId: string;
  jobId: string;
  /** Provider-side snapshot id. */
  snapshotId: string;
  storageIdentity: string | null;
  keyLayout: string;
  integrityStatus: string;
};

/** The attestation row fields the decision reads. */
export type IntegrityAttestationInput = {
  status: string;
  deviceId: string;
  jobId: string;
  providerSnapshotId: string;
  storageIdentity: string;
  keyLayout: string;
  manifestKey: string;
  manifestSha256: string;
  manifestSize: number;
  layoutSha256: string | null;
  layoutSize: number | null;
  systemStateManifestSha256: string | null;
  systemStateManifestSize: number | null;
};

/** Attestation statuses under which an index built from the attested manifest bytes may authorize reads. */
const INDEX_BINDABLE_ATTESTATION_STATUSES = new Set(['pending', 'verified', 'producer_only']);

export function controlObjectKey(snapshotId: string, role: IntegrityObjectRole): string {
  switch (role) {
    case 'manifest':
      return `snapshots/${snapshotId}/manifest.json`;
    case 'layout':
      return `snapshots/${snapshotId}/layout.json`;
    case 'system_state_manifest':
      return `snapshots/${snapshotId}/system-state/manifest.json`;
  }
}

function boundToSnapshot(snapshot: IntegritySnapshotInput, attestation: IntegrityAttestationInput): boolean {
  return snapshot.deviceId === attestation.deviceId
    && snapshot.jobId === attestation.jobId
    && snapshot.snapshotId === attestation.providerSnapshotId
    && snapshot.storageIdentity === attestation.storageIdentity
    && snapshot.keyLayout === attestation.keyLayout
    && attestation.manifestKey === controlObjectKey(attestation.providerSnapshotId, 'manifest');
}

function attestedObjects(attestation: IntegrityAttestationInput): IntegrityObject[] {
  const id = attestation.providerSnapshotId;
  const objects: IntegrityObject[] = [
    { role: 'manifest', key: controlObjectKey(id, 'manifest'), sha256: attestation.manifestSha256, size: attestation.manifestSize },
  ];
  if (attestation.layoutSha256 !== null && attestation.layoutSize !== null) {
    objects.push({ role: 'layout', key: controlObjectKey(id, 'layout'), sha256: attestation.layoutSha256, size: attestation.layoutSize });
  }
  if (attestation.systemStateManifestSha256 !== null && attestation.systemStateManifestSize !== null) {
    objects.push({
      role: 'system_state_manifest',
      key: controlObjectKey(id, 'system_state_manifest'),
      sha256: attestation.systemStateManifestSha256,
      size: attestation.systemStateManifestSize,
    });
  }
  return objects;
}

/**
 * Pure decision. `attested` only when the attestation is `verified` (server
 * fetched and compared the objects) or `producer_only` (device-local
 * destination) AND it still describes the snapshot row as it is now: same
 * source device, job, snapshot id, storage identity and key layout.
 */
export function evaluateRestoreIntegrity(
  snapshot: IntegritySnapshotInput,
  attestation: IntegrityAttestationInput | null,
): RestoreIntegrity {
  const unattested = (reason: UnattestedRestoreReason): RestoreIntegrity => ({
    mode: 'unattested',
    snapshotId: snapshot.snapshotId,
    reason,
  });

  if (!attestation) {
    // The projection only distinguishes why there is no row; it never
    // stands in for one.
    if (snapshot.integrityStatus === 'unattested_legacy') return unattested('unattested_legacy');
    if (snapshot.integrityStatus === 'attestation_failed') return unattested('attestation_failed');
    return unattested('unattested');
  }

  if (!boundToSnapshot(snapshot, attestation)) return unattested('attestation_failed');
  switch (attestation.status) {
    case 'pending':
      return unattested('pending');
    case 'verified':
    case 'producer_only':
      return {
        mode: 'attested',
        trust: attestation.status === 'verified' ? 'server_verified' : 'producer_only',
        snapshotId: snapshot.snapshotId,
        sourceDeviceId: attestation.deviceId,
        objects: attestedObjects(attestation),
      };
    default:
      // 'mismatch', or a status this server does not know.
      return unattested('attestation_failed');
  }
}

/**
 * True when the snapshot failed its integrity check: its attestation did not
 * match the stored objects, no longer describes the snapshot row, has a status
 * this server does not know, or was refused when it was reported. Such a
 * snapshot is never read from storage.
 */
export function snapshotIntegrityFailed(snapshot: IntegritySnapshotInput & { attestation: IntegrityAttestationInput | null }): boolean {
  const integrity = evaluateRestoreIntegrity(snapshot, snapshot.attestation);
  return integrity.mode === 'unattested' && integrity.reason === 'attestation_failed';
}

/** HydrationFailure prefixes (backupSnapshotFileIndex.ts) that mean the stored bytes are not the attested ones. */
const ATTESTATION_INDEX_FAILURES = ['manifest_differs_from_attestation', 'attestation_failed'];

/** True when a 'failed' index failed because the stored manifest is not the attested one. */
export function indexFailedOnAttestation(fileIndexError: string | null | undefined): boolean {
  const prefix = (fileIndexError ?? '').split(':', 1)[0] ?? '';
  return ATTESTATION_INDEX_FAILURES.includes(prefix);
}

/** The `integrity` block exactly as it goes on the wire. */
export function integrityPayload(integrity: RestoreIntegrity): Record<string, unknown> {
  if (integrity.mode === 'attested') {
    return {
      v: RESTORE_INTEGRITY_FORMAT,
      mode: 'attested',
      trust: integrity.trust,
      snapshotId: integrity.snapshotId,
      objects: integrity.objects.map((o) => ({ role: o.role, key: o.key, sha256: o.sha256, size: o.size })),
    };
  }
  return { v: RESTORE_INTEGRITY_FORMAT, mode: 'unattested', snapshotId: integrity.snapshotId, reason: integrity.reason };
}

/**
 * `status`/`reason` labels for breeze_backup_restore_integrity_total. `absent`
 * = read-only validation delivered without a block because its snapshot could
 * not be resolved (`snapshot_unresolved`). A lookup that fails is never
 * delivered at all.
 */
export function integrityMetricLabels(integrity: RestoreIntegrity | null): { status: string; reason: string } {
  if (!integrity) return { status: 'absent', reason: 'snapshot_unresolved' };
  if (integrity.mode === 'attested') return { status: 'attested', reason: integrity.trust };
  return { status: 'unattested', reason: integrity.reason };
}

/**
 * Whether a snapshot's server-built file index may authorize reads. The index
 * must be complete and, when the snapshot has an attestation, have been built
 * from exactly the manifest bytes the attestation names (the hydrator hashes
 * what it fetched; that digest must equal the attested one). A mismatched
 * attestation authorizes nothing, whatever the index digest: its failure may
 * lie in another control object.
 */
export function indexMatchesAttestation(
  index: { fileIndexStatus: string; fileIndexManifestSha256: string | null; integrityStatus?: string | null },
  attestation: { status: string; manifestSha256: string } | null,
): boolean {
  if (index.fileIndexStatus !== 'complete') return false;
  // A statement refused when it was reported leaves no row, only the
  // projection: treated exactly like a mismatched attestation.
  if (!attestation) return index.integrityStatus !== 'attestation_failed';
  if (!INDEX_BINDABLE_ATTESTATION_STATUSES.has(attestation.status)) return false;
  return index.fileIndexManifestSha256 !== null && index.fileIndexManifestSha256 === attestation.manifestSha256;
}

/**
 * SQL form of indexMatchesAttestation, for a statement that reads
 * backup_snapshots LEFT JOINed to backup_snapshot_attestations: the index is
 * complete, was built from the manifest bytes with digest `boundDigest` (the
 * digest the caller approved), and is bound to the attestation in force at
 * that statement. Used by every file-index membership read, so rows of an
 * index being rebuilt, rebuilt from other bytes, or of a snapshot whose
 * attestation did not match never count.
 */
export function boundIndexCondition(boundDigest: string | null): SQL {
  return and(
    eq(backupSnapshots.fileIndexStatus, 'complete'),
    sql`${backupSnapshots.fileIndexManifestSha256} IS NOT DISTINCT FROM ${boundDigest}`,
    sql`(
      (${backupSnapshotAttestations.id} IS NULL AND ${backupSnapshots.integrityStatus} <> 'attestation_failed')
      OR (${backupSnapshotAttestations.status} IN ('pending', 'verified', 'producer_only')
          AND ${backupSnapshotAttestations.manifestSha256} = ${backupSnapshots.fileIndexManifestSha256})
    )`,
  )!;
}

/** Columns for an attestation LEFT JOINed onto backup_snapshots (all null when there is none). */
export const attestationJoinColumns = () => ({
  status: backupSnapshotAttestations.status,
  deviceId: backupSnapshotAttestations.deviceId,
  jobId: backupSnapshotAttestations.jobId,
  providerSnapshotId: backupSnapshotAttestations.providerSnapshotId,
  storageIdentity: backupSnapshotAttestations.storageIdentity,
  keyLayout: backupSnapshotAttestations.keyLayout,
  manifestKey: backupSnapshotAttestations.manifestKey,
  manifestSha256: backupSnapshotAttestations.manifestSha256,
  manifestSize: backupSnapshotAttestations.manifestSize,
  layoutSha256: backupSnapshotAttestations.layoutSha256,
  layoutSize: backupSnapshotAttestations.layoutSize,
  systemStateManifestSha256: backupSnapshotAttestations.systemStateManifestSha256,
  systemStateManifestSize: backupSnapshotAttestations.systemStateManifestSize,
});

/**
 * A LEFT JOINed attestation as selected with attestationJoinColumns(), or null
 * when the snapshot has none. Tolerates a missing or all-null object.
 */
export function joinedAttestation(value: unknown): IntegrityAttestationInput | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<IntegrityAttestationInput>;
  if (typeof row.status !== 'string' || typeof row.manifestSha256 !== 'string') return null;
  return {
    status: row.status,
    deviceId: String(row.deviceId ?? ''),
    jobId: String(row.jobId ?? ''),
    providerSnapshotId: String(row.providerSnapshotId ?? ''),
    storageIdentity: String(row.storageIdentity ?? ''),
    keyLayout: String(row.keyLayout ?? ''),
    manifestKey: String(row.manifestKey ?? ''),
    manifestSha256: row.manifestSha256,
    manifestSize: Number(row.manifestSize ?? 0),
    layoutSha256: row.layoutSha256 ?? null,
    layoutSize: row.layoutSize ?? null,
    systemStateManifestSha256: row.systemStateManifestSha256 ?? null,
    systemStateManifestSize: row.systemStateManifestSize ?? null,
  };
}

/**
 * Resolves the integrity expectation for one snapshot row, in the caller's DB
 * context (RLS applies). Null when the snapshot is not visible there.
 */
export async function resolveRestoreIntegrity(snapshotDbId: string): Promise<RestoreIntegrity | null> {
  const [row] = await db
    .select({
      deviceId: backupSnapshots.deviceId,
      jobId: backupSnapshots.jobId,
      snapshotId: backupSnapshots.snapshotId,
      storageIdentity: backupSnapshots.storageIdentity,
      keyLayout: backupSnapshots.keyLayout,
      integrityStatus: backupSnapshots.integrityStatus,
      attestation: attestationJoinColumns(),
    })
    .from(backupSnapshots)
    .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id))
    .where(eq(backupSnapshots.id, snapshotDbId))
    .limit(1);
  if (!row) return null;
  return evaluateRestoreIntegrity(row, joinedAttestation(row.attestation));
}

/** Metric `type` label for the integrity block in a bare-metal recovery bootstrap. */
export const RECOVERY_BOOTSTRAP_INTEGRITY_TYPE = 'recovery_bootstrap';
