/**
 * Server-side verification of a snapshot attestation: the API fetches the
 * snapshot's control objects from storage with its own configuration and
 * compares them, byte for byte (SHA-256 and length), with what the producing
 * device attested (services/backupAttestation.ts). A `pending` row moves to
 * `verified` or `mismatch` exactly once; a storage failure leaves it `pending`
 * for a later retry and never fails it.
 *
 * Identity, not tenancy, is compared: the snapshot row must still name the
 * attested device, snapshot id, storage identity and key layout. The org is
 * not part of the comparison — a device that moved organizations keeps its
 * snapshots and their attestations.
 *
 * No DB context is held while objects are read from storage (reads run between two
 * short system-scoped contexts), the same rule as backupSnapshotFileIndex.ts.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { backupSnapshots } from '../db/schema/backup';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import { classifyBackupObjectKey } from './backupObjectKey';
import {
  fetchBackupObjectBytes,
  isBackupObjectTooLarge,
  MANIFEST_FETCH_MAX_BYTES,
} from './backupSnapshotStorage';
import { expectedControlKey, type AttestationObjectRole } from './backupAttestation';
import { recordBackupAttestation } from './backupMetrics';
import { asRecord, resolveSnapshotProviderConfig } from './recoveryBootstrap';

/** Largest layout / system-state manifest the verifier will fetch. */
export const ATTESTED_SIDECAR_MAX_BYTES = 16 * 1024 * 1024;

export type AttestationVerifyOutcome = 'verified' | 'mismatch' | 'retry' | 'skipped';

export type AttestationUnderVerification = {
  id: string;
  snapshotDbId: string;
  status: string;
  verificationMode: string;
  deviceId: string;
  providerSnapshotId: string;
  storageIdentity: string;
  keyLayout: string;
  parentProviderSnapshotId: string | null;
  objects: Array<{ role: AttestationObjectRole; key: string; sha256: string; size: number }>;
};

export type SnapshotUnderVerification = {
  deviceId: string;
  snapshotId: string;
  storageIdentity: string | null;
  keyLayout: string;
};

export type AttestationVerifyDeps = {
  /** Loads the attestation row and its snapshot (system scope). */
  load: (snapshotDbId: string) => Promise<{
    attestation: AttestationUnderVerification;
    snapshot: SnapshotUnderVerification | null;
    provider: { type: string; config: Record<string, unknown> } | null;
  } | null>;
  fetchObject: (args: { provider: string; providerConfig: Record<string, unknown>; key: string; maxBytes: number }) => Promise<Uint8Array>;
  /** Moves a still-pending row to its terminal status; false when it was no longer pending. */
  finish: (args: { attestationId: string; snapshotDbId: string; status: 'verified' | 'mismatch'; verifyError: string | null }) => Promise<boolean>;
};

export type AttestationVerifyResult = { outcome: AttestationVerifyOutcome; reason?: string };

function maxBytesFor(role: AttestationObjectRole): number {
  return role === 'manifest' ? MANIFEST_FETCH_MAX_BYTES : ATTESTED_SIDECAR_MAX_BYTES;
}

/**
 * The manifest of a run attested as full (no parent) must reference only
 * objects under its own snapshot. Returns a mismatch reason, or null.
 */
function fullRunReferenceProblem(manifestBytes: Uint8Array, providerSnapshotId: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  } catch {
    return 'manifest_unparseable';
  }
  if (!json || typeof json !== 'object') return 'manifest_unparseable';
  const files = (json as { files?: unknown }).files;
  if (files === undefined || files === null) return null;
  if (!Array.isArray(files)) return 'manifest_unparseable';
  for (const file of files) {
    const backupPath = file && typeof file === 'object' ? (file as { backupPath?: unknown }).backupPath : undefined;
    if (backupPath === undefined || backupPath === null || backupPath === '') continue;
    if (typeof backupPath !== 'string') return 'manifest_unparseable';
    const scope = classifyBackupObjectKey(backupPath, providerSnapshotId);
    if (!scope || scope.kind !== 'own') return 'unexpected_references';
  }
  return null;
}

export async function verifySnapshotAttestation(
  snapshotDbId: string,
  deps: AttestationVerifyDeps = defaultVerifyDeps,
): Promise<AttestationVerifyResult> {
  const loaded = await deps.load(snapshotDbId);
  if (!loaded) return { outcome: 'skipped', reason: 'no_attestation' };
  const { attestation, snapshot, provider } = loaded;
  if (attestation.verificationMode !== 'server_fetched') return { outcome: 'skipped', reason: 'not_server_fetched' };
  if (attestation.status !== 'pending') return { outcome: 'skipped', reason: 'already_decided' };
  if (!snapshot) return { outcome: 'skipped', reason: 'snapshot_gone' };

  const finish = async (status: 'verified' | 'mismatch', verifyError: string | null): Promise<AttestationVerifyResult> => {
    const moved = await deps.finish({ attestationId: attestation.id, snapshotDbId, status, verifyError });
    if (!moved) return { outcome: 'skipped', reason: 'already_decided' };
    recordBackupAttestation(status);
    return verifyError ? { outcome: status, reason: verifyError } : { outcome: status };
  };
  const retry = (reason: string): AttestationVerifyResult => {
    recordBackupAttestation('verify_unavailable');
    return { outcome: 'retry', reason };
  };

  if (
    snapshot.deviceId !== attestation.deviceId
    || snapshot.snapshotId !== attestation.providerSnapshotId
    || snapshot.storageIdentity !== attestation.storageIdentity
    || snapshot.keyLayout !== attestation.keyLayout
  ) {
    return finish('mismatch', 'binding_changed');
  }

  // The destination must still resolve to the attested storage identity; an
  // edited or missing configuration cannot be read on the snapshot's behalf.
  if (!provider) return retry('provider_unresolved');
  if (normalizeStorageIdentity(provider.type, provider.config) !== attestation.storageIdentity) {
    return retry('storage_identity_changed');
  }

  let manifestBytes: Uint8Array | null = null;
  for (const object of attestation.objects) {
    if (object.key !== expectedControlKey(attestation.providerSnapshotId, object.role)) {
      return finish('mismatch', `${object.role}_key_mismatch`);
    }
    if (object.size > maxBytesFor(object.role)) {
      return finish('mismatch', `${object.role}_too_large`);
    }
    let bytes: Uint8Array;
    try {
      // Bounded by the attested size: a larger stored object is a mismatch
      // without reading it all.
      bytes = await deps.fetchObject({
        provider: provider.type,
        providerConfig: provider.config,
        key: object.key,
        maxBytes: object.size,
      });
    } catch (err) {
      if (isBackupObjectTooLarge(err)) return finish('mismatch', `${object.role}_size_mismatch`);
      return retry(`fetch_failed:${object.role}`);
    }
    if (bytes.byteLength !== object.size) return finish('mismatch', `${object.role}_size_mismatch`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== object.sha256) return finish('mismatch', `${object.role}_digest_mismatch`);
    if (object.role === 'manifest') manifestBytes = bytes;
  }

  if (!manifestBytes) return finish('mismatch', 'manifest_not_attested');
  if (attestation.parentProviderSnapshotId === null) {
    const problem = fullRunReferenceProblem(manifestBytes, attestation.providerSnapshotId);
    if (problem) return finish('mismatch', problem);
  }

  return finish('verified', null);
}

// ── Default (database + storage) deps ───────────────────────────────────────

function objectsOf(row: typeof backupSnapshotAttestations.$inferSelect): AttestationUnderVerification['objects'] {
  const objects: AttestationUnderVerification['objects'] = [];
  if (row.layoutSha256 !== null && row.layoutSize !== null) {
    objects.push({ role: 'layout', key: expectedControlKey(row.providerSnapshotId, 'layout'), sha256: row.layoutSha256, size: row.layoutSize });
  }
  objects.push({ role: 'manifest', key: row.manifestKey, sha256: row.manifestSha256, size: row.manifestSize });
  if (row.systemStateManifestSha256 !== null && row.systemStateManifestSize !== null) {
    objects.push({
      role: 'system_state_manifest',
      key: expectedControlKey(row.providerSnapshotId, 'system_state_manifest'),
      sha256: row.systemStateManifestSha256,
      size: row.systemStateManifestSize,
    });
  }
  return objects;
}

const systemContext = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

export const defaultVerifyDeps: AttestationVerifyDeps = {
  load: (snapshotDbId) =>
    systemContext(async () => {
      const [row] = await db
        .select()
        .from(backupSnapshotAttestations)
        .where(eq(backupSnapshotAttestations.snapshotDbId, snapshotDbId))
        .limit(1);
      if (!row) return null;
      const [snapshot] = await db
        .select({
          deviceId: backupSnapshots.deviceId,
          snapshotId: backupSnapshots.snapshotId,
          storageIdentity: backupSnapshots.storageIdentity,
          keyLayout: backupSnapshots.keyLayout,
        })
        .from(backupSnapshots)
        .where(eq(backupSnapshots.id, snapshotDbId))
        .limit(1);
      let provider: { type: string; config: Record<string, unknown> } | null = null;
      if (snapshot && row.status === 'pending' && row.verificationMode === 'server_fetched') {
        const resolved = await resolveSnapshotProviderConfig(snapshotDbId);
        // Only the destination's own configuration row — never provider
        // details carried in snapshot metadata.
        if (resolved?.config?.provider) {
          provider = { type: resolved.config.provider, config: asRecord(resolved.config.providerConfig) };
        }
      }
      return {
        attestation: {
          id: row.id,
          snapshotDbId: row.snapshotDbId,
          status: row.status,
          verificationMode: row.verificationMode,
          deviceId: row.deviceId,
          providerSnapshotId: row.providerSnapshotId,
          storageIdentity: row.storageIdentity,
          keyLayout: row.keyLayout,
          parentProviderSnapshotId: row.parentProviderSnapshotId,
          objects: objectsOf(row),
        },
        snapshot: snapshot ?? null,
        provider,
      };
    }),
  fetchObject: (args) => fetchBackupObjectBytes(args),
  finish: ({ attestationId, snapshotDbId, status, verifyError }) =>
    systemContext(async () => {
      const moved = await db
        .update(backupSnapshotAttestations)
        .set({ status, verifyError, verifiedAt: new Date() })
        .where(and(eq(backupSnapshotAttestations.id, attestationId), eq(backupSnapshotAttestations.status, 'pending')))
        .returning({ id: backupSnapshotAttestations.id });
      if (moved.length === 0) return false;
      await db
        .update(backupSnapshots)
        .set({ integrityStatus: status === 'verified' ? 'attested' : 'attestation_failed' })
        .where(eq(backupSnapshots.id, snapshotDbId));
      return true;
    }),
};
