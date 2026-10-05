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
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { RESERVATION_CLEANUP_EVERY_MS, readSnapshotWriteState } from './backupSnapshotIdReservations';
import { backupSnapshots } from '../db/schema/backup';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import { classifyBackupObjectKey } from './backupObjectKey';
import {
  fetchBackupObjectBytes,
  isBackupObjectNotFound,
  isBackupObjectTooLarge,
  MANIFEST_FETCH_MAX_BYTES,
} from './backupSnapshotStorage';
import { expectedControlKey, type AttestationObjectRole } from './backupAttestation';
import { recordBackupAttestation } from './backupMetrics';
import { settleVerificationsForFailedAttestation } from './backupAttestationFailureSettlement';
import { asRecord, resolveSnapshotProviderConfig } from './recoveryBootstrap';

/** Largest layout / system-state manifest the verifier will fetch. */
export const ATTESTED_SIDECAR_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Retries after storage could not be read: the next attempt waits
 * RETRY_BASE_MS * 2^attempts, capped at RETRY_MAX_DELAY_MS. A snapshot whose
 * reservation is still sealing has a known end instead: its next attempt is
 * due when the cleanup job is expected to have published it (sealingRetryAt),
 * and the cleanup job queues the verification itself when it publishes
 * (jobs/backupWriteSessionJanitor.ts). After MAX_VERIFY_ATTEMPTS the row is
 * parked — still `pending` (a storage failure never decides it), but no
 * longer retried by the sweep.
 */
export const MAX_VERIFY_ATTEMPTS = 20;
const RETRY_BASE_MS = 15 * 60_000;
const RETRY_MAX_DELAY_MS = 24 * 60 * 60_000;

export type AttestationVerifyOutcome = 'verified' | 'mismatch' | 'retry' | 'skipped';

export type AttestationUnderVerification = {
  id: string;
  snapshotDbId: string;
  status: string;
  verificationMode: string;
  deviceId: string;
  jobId: string;
  providerSnapshotId: string;
  storageIdentity: string;
  keyLayout: string;
  parentProviderSnapshotId: string | null;
  objects: Array<{ role: AttestationObjectRole; key: string; sha256: string; size: number }>;
};

export type SnapshotUnderVerification = {
  deviceId: string;
  jobId: string;
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
    /**
     * A brokered write of the snapshot may still change its bytes (its id
     * reservation is sealing, or a completion or delete is in flight): the
     * row is retried later, never decided. Absent = false.
     */
    writeInFlight?: boolean;
    /** While the reservation is sealing: its sealed_until. Absent = unknown. */
    sealedUntil?: Date | null;
  } | null>;
  fetchObject: (args: { provider: string; providerConfig: Record<string, unknown>; key: string; maxBytes: number }) => Promise<Uint8Array>;
  /**
   * Moves a still-pending row to its terminal status, re-checking the
   * snapshot binding at write time: a `verified` whose binding no longer
   * holds is written as `mismatch` / `binding_changed`. Returns the status
   * written, or null when the row was no longer pending.
   */
  finish: (args: { attestationId: string; snapshotDbId: string; status: 'verified' | 'mismatch'; verifyError: string | null }) => Promise<'verified' | 'mismatch' | null>;
  /**
   * Schedules another attempt for a still-pending row: at `retryAt` when it
   * is given and still ahead (bounded by the maximum backoff), otherwise
   * after the exponential backoff. Every deferral counts as an attempt.
   */
  defer: (args: { attestationId: string; reason: string; retryAt?: Date }) => Promise<{ attemptCount: number; parked: boolean } | null>;
};

export type AttestationVerifyResult = { outcome: AttestationVerifyOutcome; reason?: string };

/**
 * When to retry a snapshot whose reservation is sealing: once the cleanup job
 * has had a run after sealed_until, i.e. when it is expected to have
 * published the reservation. Null without a known bound.
 */
export function sealingRetryAt(sealedUntil: Date | null | undefined): Date | null {
  if (!sealedUntil || Number.isNaN(sealedUntil.getTime())) return null;
  return new Date(sealedUntil.getTime() + RESERVATION_CLEANUP_EVERY_MS);
}

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
    const written = await deps.finish({ attestationId: attestation.id, snapshotDbId, status, verifyError });
    if (!written) return { outcome: 'skipped', reason: 'already_decided' };
    recordBackupAttestation(written);
    // The write-time re-check may have turned a match into binding_changed.
    const error = written === status ? verifyError : 'binding_changed';
    return error ? { outcome: written, reason: error } : { outcome: written };
  };
  const retry = async (reason: string, retryAt: Date | null = null): Promise<AttestationVerifyResult> => {
    const scheduled = await deps.defer({ attestationId: attestation.id, reason, ...(retryAt ? { retryAt } : {}) });
    // No longer pending: another verification of the snapshot decided it
    // after this one read it.
    if (!scheduled) return { outcome: 'skipped', reason: 'already_decided' };
    recordBackupAttestation('verify_unavailable');
    if (scheduled.parked) {
      recordBackupAttestation('verify_parked');
      console.warn(
        `[BackupAttestationVerify] Snapshot ${snapshotDbId} stays pending after ${scheduled.attemptCount} attempts ` +
          `(${reason}); it is no longer retried automatically.`,
      );
    }
    return { outcome: 'retry', reason };
  };

  if (
    snapshot.jobId !== attestation.jobId
    || snapshot.deviceId !== attestation.deviceId
    || snapshot.snapshotId !== attestation.providerSnapshotId
    || snapshot.storageIdentity !== attestation.storageIdentity
    || snapshot.keyLayout !== attestation.keyLayout
  ) {
    return finish('mismatch', 'binding_changed');
  }

  // Bytes that may still change are never read, let alone decided on.
  if (loaded.writeInFlight) return retry('snapshot_sealing', sealingRetryAt(loaded.sealedUntil));

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
      // A missing object is reported on its own but, like any storage
      // failure, never decides the row.
      if (isBackupObjectNotFound(err)) return retry(`object_missing:${object.role}`);
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
          jobId: backupSnapshots.jobId,
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
      const write = snapshot ? await readSnapshotWriteState(snapshot.snapshotId) : null;
      return {
        writeInFlight: write?.inFlight ?? false,
        sealedUntil: write?.sealedUntil ?? null,
        attestation: {
          id: row.id,
          snapshotDbId: row.snapshotDbId,
          status: row.status,
          verificationMode: row.verificationMode,
          deviceId: row.deviceId,
          jobId: row.jobId,
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
      // Re-read the binding under a row lock, so a snapshot row rewritten
      // between the read phase and this write cannot end up attested.
      const [snapshot] = await db
        .select({
          jobId: backupSnapshots.jobId,
          deviceId: backupSnapshots.deviceId,
          snapshotId: backupSnapshots.snapshotId,
          storageIdentity: backupSnapshots.storageIdentity,
          keyLayout: backupSnapshots.keyLayout,
        })
        .from(backupSnapshots)
        .where(eq(backupSnapshots.id, snapshotDbId))
        .for('update');
      const [row] = await db
        .select({
          jobId: backupSnapshotAttestations.jobId,
          deviceId: backupSnapshotAttestations.deviceId,
          providerSnapshotId: backupSnapshotAttestations.providerSnapshotId,
          storageIdentity: backupSnapshotAttestations.storageIdentity,
          keyLayout: backupSnapshotAttestations.keyLayout,
          manifestSha256: backupSnapshotAttestations.manifestSha256,
        })
        .from(backupSnapshotAttestations)
        .where(and(eq(backupSnapshotAttestations.id, attestationId), eq(backupSnapshotAttestations.status, 'pending')))
        .for('update');
      if (!snapshot || !row) return null;
      const bound =
        snapshot.jobId === row.jobId
        && snapshot.deviceId === row.deviceId
        && snapshot.snapshotId === row.providerSnapshotId
        && snapshot.storageIdentity === row.storageIdentity
        && snapshot.keyLayout === row.keyLayout;
      const written: 'verified' | 'mismatch' = status === 'verified' && !bound ? 'mismatch' : status;
      const moved = await db
        .update(backupSnapshotAttestations)
        .set({
          status: written,
          verifyError: written === status ? verifyError : 'binding_changed',
          verifiedAt: new Date(),
        })
        .where(and(eq(backupSnapshotAttestations.id, attestationId), eq(backupSnapshotAttestations.status, 'pending')))
        .returning({ id: backupSnapshotAttestations.id });
      if (moved.length === 0) return null;
      await db
        .update(backupSnapshots)
        .set({ integrityStatus: written === 'verified' ? 'attested' : 'attestation_failed' })
        .where(eq(backupSnapshots.id, snapshotDbId));
      // The snapshot's file index follows the decision, under the same row
      // lock hydration publishes under (backupSnapshotFileIndex.ts): a
      // complete index built from other manifest bytes than the verified ones
      // goes back to 'none' (hydration rebuilds it on its next use), and no
      // index of a snapshot that did not match stays usable. Its rows stay
      // until hydration replaces them; a non-complete index authorizes
      // nothing. Readers apply the same rule (indexMatchesAttestation), so
      // this only keeps the stored state honest.
      if (written === 'verified') {
        await db
          .update(backupSnapshots)
          .set({ fileIndexStatus: 'none', fileIndexError: null })
          .where(and(
            eq(backupSnapshots.id, snapshotDbId),
            eq(backupSnapshots.fileIndexStatus, 'complete'),
            sql`${backupSnapshots.fileIndexManifestSha256} IS DISTINCT FROM ${row.manifestSha256}`,
          ));
      } else {
        await db
          .update(backupSnapshots)
          .set({
            fileIndexStatus: 'failed',
            fileIndexError: "attestation_failed: the snapshot's attestation does not match its stored objects",
          })
          .where(and(eq(backupSnapshots.id, snapshotDbId), eq(backupSnapshots.fileIndexStatus, 'complete')));
        // Verifications waiting on the snapshot end now, with the integrity
        // reason, instead of at their timeout.
        await settleVerificationsForFailedAttestation(snapshotDbId);
      }
      return written;
    }),
  defer: ({ attestationId, reason, retryAt }) =>
    systemContext(async () => {
      const backoff = sql`now() + least(
        ${RETRY_BASE_MS}::bigint * power(2, least(${backupSnapshotAttestations.attemptCount}, 30))::bigint,
        ${RETRY_MAX_DELAY_MS}::bigint
      ) * interval '1 millisecond'`;
      // A known retry time that has already passed (a sealing reservation
      // held back by a completion or delete in flight) falls back to the
      // backoff, so a stuck row still backs off and is eventually parked.
      const nextAttemptAt = retryAt
        ? sql`CASE WHEN ${retryAt.toISOString()}::timestamptz > now()
            THEN least(${retryAt.toISOString()}::timestamptz, now() + ${RETRY_MAX_DELAY_MS}::bigint * interval '1 millisecond')
            ELSE ${backoff} END`
        : backoff;
      const [row] = await db
        .update(backupSnapshotAttestations)
        .set({
          attemptCount: sql`${backupSnapshotAttestations.attemptCount} + 1`,
          nextAttemptAt,
          verifyError: reason,
        })
        .where(and(eq(backupSnapshotAttestations.id, attestationId), eq(backupSnapshotAttestations.status, 'pending')))
        .returning({ attemptCount: backupSnapshotAttestations.attemptCount });
      if (!row) return null;
      return { attemptCount: row.attemptCount, parked: row.attemptCount >= MAX_VERIFY_ATTEMPTS };
    }),
};
