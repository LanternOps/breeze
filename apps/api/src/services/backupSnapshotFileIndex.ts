// W09 (#6464) Task 3 — server-side, verified-complete file index for any
// snapshot whose owning job reported referenced_files > 0. Never trusts the
// agent-reported backup_snapshot_files rows (they may be entirely absent —
// the helper drops snapshot.files past a 5MB delivery budget, Part 0 §0) —
// this reads snapshots/<id>/manifest.json itself and verifies every
// referenced OLDER snapshot's provenance before marking the index complete.
// See docs/superpowers/plans/backup/_w09-part0.md §3 for the full algorithm.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  backupJobs,
  backupSnapshotFiles,
  backupSnapshotOrigins,
  backupSnapshotRetirements,
  backupSnapshots,
} from '../db/schema';
import { asRecord, getStringValue, resolveSnapshotProviderConfig } from './recoveryBootstrap';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import { backupSnapshotManifestKey, fetchBackupObjectBytes, isBackupObjectNotFound, isBackupObjectTooLarge, MANIFEST_FETCH_MAX_BYTES } from './backupSnapshotStorage';
import { parseBackupObjectKey } from './backupObjectKey';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { indexMatchesAttestation } from './backupRestoreIntegrity';

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
  | 'attestation_failed';

const HYDRATION_FAILURES: readonly HydrationFailure[] = [
  'storage_identity_unknown', 'storage_identity_drift', 'manifest_missing', 'manifest_invalid',
  'manifest_too_large', 'manifest_key_invalid', 'origin_unverifiable', 'origin_identity_pending', 'provider_error',
  'manifest_differs_from_attestation', 'attestation_failed',
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

export type HydrationOutcome =
  | { status: 'complete'; manifestSha256: string; entryCount: number; externalCount: number; originSnapshotIds: string[] }
  | { status: 'failed'; failure: HydrationFailure; reason: string; retryable: boolean }
  | { status: 'skipped'; reason: 'not_referenced' | 'already_complete' | 'in_progress' };

export type HydrationDeps = {
  fetchManifestBytes: (args: { provider: string; providerConfig: Record<string, unknown>; key: string }) => Promise<Uint8Array>;
  now?: () => Date;
};

const HYDRATING_STALE_MS = 30 * 60 * 1000;
const FILE_ROW_BATCH_SIZE = 1000;

// Same field shape as backupSnapshotReconcile.ts's private reconcileManifestSchema
// — duplicated deliberately (see Task 3 Interfaces note: a shared schema
// module would be a bigger refactor than this wave needs) plus a refine that
// the manifest actually belongs to the snapshot being hydrated (defense
// against a corrupted/swapped object at the expected key).
const hydrationManifestSchema = z
  .object({
    id: z.string().min(1),
    timestamp: z.string().optional(),
    size: z.number().nonnegative().optional(),
    formatVersion: z.number().optional(),
    baseSnapshotId: z.string().optional(),
    files: z
      .array(
        z
          .object({
            sourcePath: z.string().min(1),
            originalPath: z.string().min(1).optional(),
            // Empty ONLY on a content-less entry — see the refine below.
            backupPath: z.string(),
            // agent/internal/backup/snapshot.go SnapshotFile.Kind: "" (or
            // omitted — the tag is omitempty) for a regular file whose
            // bytes live at backupPath; "symlink" / "dir" for an entry
            // that uploads nothing and so carries backupPath "". A plain
            // string, not an enum: a newer agent adding a kind must not
            // fail the whole manifest closed here — the refine below only
            // lets the two known content-less kinds omit their object.
            kind: z.string().optional(),
            size: z.number().nonnegative().optional(),
            modTime: z.string().optional(),
          })
          .passthrough()
          // D-W09-1 (#6491 KIT lab): a real manifest carries backupPath ""
          // on every dir/symlink entry (8,220 of 107,636 on a stock Ubuntu
          // 24.04 host), so a blanket .min(1) rejected every real agent
          // manifest with manifest_invalid. Tighten by kind instead: a
          // CONTENT entry (no kind) must still name its object — dropping
          // the check for files would let a corrupt manifest hydrate a
          // file with no key and only fail at restore time.
          .refine((f) => f.backupPath.length > 0 || f.kind === 'symlink' || f.kind === 'dir', {
            message: 'backupPath must be non-empty on a content entry (kind "" / omitted)',
            path: ['backupPath'],
          }),
      )
      .optional(),
  })
  .passthrough();

// A ZodError's message is the JSON dump of EVERY issue, indexed by array
// position (`files[41233].backupPath`). On a 100k-entry manifest that is a
// multi-megabyte string a tech cannot map back to a file. Report the first
// issue with the offending entry's sourcePath plus the total count instead.
function summarizeManifestIssues(error: z.ZodError, json: unknown): string {
  const issues = error.issues;
  const first = issues[0];
  if (!first) return 'manifest failed schema validation';
  const where = first.path.map(String).join('.');
  let entry = '';
  if (first.path[0] === 'files' && typeof first.path[1] === 'number') {
    const files = (json as { files?: unknown[] } | null)?.files;
    const row = Array.isArray(files) ? files[first.path[1]] : undefined;
    const sourcePath = row && typeof row === 'object' ? (row as { sourcePath?: unknown }).sourcePath : undefined;
    if (typeof sourcePath === 'string') entry = ` (entry sourcePath ${JSON.stringify(sourcePath)})`;
  }
  const more = issues.length > 1 ? `; ${issues.length - 1} more issue(s)` : '';
  return `${where || 'manifest'}: ${first.message}${entry}${more}`;
}

function defaultDeps(): HydrationDeps {
  return {
    fetchManifestBytes: (args) => fetchBackupObjectBytes({ ...args, maxBytes: MANIFEST_FETCH_MAX_BYTES }),
  };
}

/**
 * The snapshot's attestation as far as its file index is concerned: its status
 * and the manifest digest it names (see indexMatchesAttestation). Null when
 * the snapshot has none (a LEFT JOIN yields all-null columns).
 */
type IndexAttestation = { status: string; manifestSha256: string } | null;

const indexAttestationColumns = () => ({
  status: backupSnapshotAttestations.status,
  manifestSha256: backupSnapshotAttestations.manifestSha256,
});

function indexAttestationOf(value: unknown): IndexAttestation {
  if (!value || typeof value !== 'object') return null;
  const { status, manifestSha256 } = value as { status?: unknown; manifestSha256?: unknown };
  return typeof status === 'string' && typeof manifestSha256 === 'string' ? { status, manifestSha256 } : null;
}

/**
 * Why an index built from manifest bytes with `manifestSha256` must not be
 * published for a snapshot with `attestation`, or null when it may. Any
 * attestation binds the index to the manifest bytes it names, whatever its
 * status; a mismatched attestation refuses every index.
 */
function attestationRefusal(
  attestation: IndexAttestation,
  manifestSha256: string | null,
): { failure: 'attestation_failed' | 'manifest_differs_from_attestation'; reason: string } | null {
  if (!attestation) return null;
  if (attestation.status === 'mismatch') {
    return { failure: 'attestation_failed', reason: "the snapshot's attestation does not match its stored objects" };
  }
  if (manifestSha256 !== null && manifestSha256 !== attestation.manifestSha256) {
    return {
      failure: 'manifest_differs_from_attestation',
      reason: `manifest digest ${manifestSha256} is not the attested ${attestation.manifestSha256}`,
    };
  }
  return null;
}

async function loadSnapshotForHydration(snapshotDbId: string) {
  const [row] = await db
    .select({
      id: backupSnapshots.id,
      orgId: backupSnapshots.orgId,
      deviceId: backupSnapshots.deviceId,
      snapshotId: backupSnapshots.snapshotId,
      storageIdentity: backupSnapshots.storageIdentity,
      // consumed by loadReferencedFiles below — without it hydration is a
      // permanent no-op.
      jobId: backupSnapshots.jobId,
      fileIndexStatus: backupSnapshots.fileIndexStatus,
      fileIndexManifestSha256: backupSnapshots.fileIndexManifestSha256,
      fileIndexHydratedAt: backupSnapshots.fileIndexHydratedAt,
      attestation: indexAttestationColumns(),
    })
    .from(backupSnapshots)
    .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id))
    .where(eq(backupSnapshots.id, snapshotDbId))
    .limit(1);
  return row ? { ...row, attestation: indexAttestationOf(row.attestation) } : null;
}

async function loadReferencedFiles(jobId: string | null | undefined): Promise<number | null> {
  if (!jobId) return null;
  const [job] = await db
    .select({ referencedFiles: backupJobs.referencedFiles })
    .from(backupJobs)
    .where(eq(backupJobs.id, jobId))
    .limit(1);
  return job?.referencedFiles ?? null;
}

async function fail(
  snapshotDbId: string,
  failure: HydrationFailure,
  reason: string,
): Promise<HydrationOutcome> {
  await db
    .update(backupSnapshots)
    .set({ fileIndexStatus: 'failed', fileIndexError: `${failure}: ${reason}` })
    .where(eq(backupSnapshots.id, snapshotDbId));
  return { status: 'failed', failure, reason, retryable: isRetryableHydrationFailure(failure) };
}

// Failure paths reached while no DB context is held (the manifest
// fetch/parse phase below, and the outer catch-all once the final write
// transaction has already closed) need to open their own short context —
// `fail` itself assumes an ambient one, which is correct for every call site
// still inside a transaction (see below) but would hit the contextless-write
// guard here.
async function failOutsideContext(
  snapshotDbId: string,
  failure: HydrationFailure,
  reason: string,
): Promise<HydrationOutcome> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => fail(snapshotDbId, failure, reason)));
}

type LoadedSnapshot = NonNullable<Awaited<ReturnType<typeof loadSnapshotForHydration>>>;
// Once claimSnapshotForHydration's own storage_identity_unknown check has run,
// storageIdentity is verified non-null for the rest of the pipeline — phases 2
// and 3 read it unconditionally (origin verification, SQL equality checks). The
// null check and its use live in different functions, so a plain narrowed
// re-read of `snapshot.storageIdentity` at the return site doesn't survive the
// function boundary; this type carries the guarantee across it instead.
type ClaimedSnapshot = Omit<LoadedSnapshot, 'storageIdentity'> & { storageIdentity: string };

/**
 * Phase 1 (short transaction): load the snapshot, apply the skip checks,
 * CAS-claim it into 'hydrating', and resolve/verify its provider config and
 * storage identity. Every statement here is a small, bounded read or a
 * single-row write — nothing here waits on the network.
 */
async function claimSnapshotForHydration(
  snapshotDbId: string,
  now: Date,
  force: boolean,
  includeUnreferenced: boolean,
): Promise<
  | { outcome: HydrationOutcome }
  | { snapshot: ClaimedSnapshot; providerType: string; providerConfig: Record<string, unknown> }
> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const snapshot = await loadSnapshotForHydration(snapshotDbId);
      if (!snapshot) {
        return { outcome: { status: 'failed', failure: 'manifest_missing', reason: 'snapshot not found', retryable: false } as const };
      }

      const referencedFiles = await loadReferencedFiles(snapshot.jobId);

      if ((referencedFiles ?? 0) === 0 && !includeUnreferenced) {
        return { outcome: { status: 'skipped', reason: 'not_referenced' } as const };
      }
      // A complete index counts as done only when it was built from the
      // manifest bytes the snapshot's attestation names; any other one is
      // rebuilt (or refused below), so an index built before an attestation
      // existed, or from other bytes, is repaired on its next use.
      if (
        snapshot.fileIndexStatus === 'complete'
        && !force
        && indexMatchesAttestation(
          { fileIndexStatus: snapshot.fileIndexStatus, fileIndexManifestSha256: snapshot.fileIndexManifestSha256 ?? null },
          snapshot.attestation,
        )
      ) {
        return { outcome: { status: 'skipped', reason: 'already_complete' } as const };
      }
      if (
        snapshot.fileIndexStatus === 'hydrating' &&
        snapshot.fileIndexHydratedAt &&
        now.getTime() - snapshot.fileIndexHydratedAt.getTime() < HYDRATING_STALE_MS
      ) {
        return { outcome: { status: 'skipped', reason: 'in_progress' } as const };
      }

      // CAS to 'hydrating' — the predicate itself expresses staleness so a
      // row stuck in 'hydrating' past HYDRATING_STALE_MS can actually be
      // reclaimed: `ne(status, 'hydrating')` alone can never match a row
      // whose status IS 'hydrating', no matter how old, which made the
      // stale-reclaim path dead code. 0 rows means a concurrent (non-stale)
      // claim won the race.
      //
      // #6488: hydration pins the snapshot's org/device into every
      // backup_snapshot_origins row, so it must use the row AS CLAIMED, not
      // the pre-claim read above. A concurrent org-move holding this row's
      // lock makes the claim wait for it; under READ COMMITTED the UPDATE
      // then re-evaluates against the committed (moved) row, and RETURNING
      // yields its org/device — while `snapshot` still holds the source
      // org, whose origin lookups would miss and terminally fail the index
      // as origin_unverifiable. The move's own trigger
      // (backup_snapshots_file_index_tenancy_reset) covers the other order.
      const staleBefore = new Date(now.getTime() - HYDRATING_STALE_MS);
      const [claimed] = await db
        .update(backupSnapshots)
        .set({ fileIndexStatus: 'hydrating', fileIndexHydratedAt: now })
        .where(
          and(
            eq(backupSnapshots.id, snapshotDbId),
            or(
              ne(backupSnapshots.fileIndexStatus, 'hydrating'),
              lt(backupSnapshots.fileIndexHydratedAt, staleBefore),
              isNull(backupSnapshots.fileIndexHydratedAt),
            ),
          ),
        )
        .returning({
          id: backupSnapshots.id,
          orgId: backupSnapshots.orgId,
          deviceId: backupSnapshots.deviceId,
          snapshotId: backupSnapshots.snapshotId,
          storageIdentity: backupSnapshots.storageIdentity,
        });
      if (!claimed) {
        return { outcome: { status: 'skipped', reason: 'in_progress' } as const };
      }

      // Everything below pins the row AS CLAIMED (see the note above the CAS),
      // not the pre-claim read.
      const claimedRow = { ...snapshot, ...claimed };

      // Nothing an index could be built from is trustworthy for a snapshot
      // whose attestation did not match; storage is not read at all.
      if (snapshot.attestation?.status === 'mismatch') {
        const refusal = attestationRefusal(snapshot.attestation, null)!;
        return { outcome: await fail(snapshotDbId, refusal.failure, refusal.reason) };
      }

      const resolved = await resolveSnapshotProviderConfig(snapshotDbId);
      const providerType = resolved?.providerType ?? null;
      const providerConfig = asRecord(resolved?.providerConfig);
      if (!claimedRow.storageIdentity) {
        return { outcome: await fail(snapshotDbId, 'storage_identity_unknown', 'snapshot has no pinned storage identity') };
      }
      if (!providerType) {
        return { outcome: await fail(snapshotDbId, 'storage_identity_unknown', 'could not resolve a provider for this snapshot') };
      }
      const resolvedIdentity = normalizeStorageIdentity(providerType, providerConfig);
      if (resolvedIdentity !== claimedRow.storageIdentity) {
        return { outcome: await fail(snapshotDbId, 'storage_identity_drift', `resolved identity ${resolvedIdentity} does not match pinned ${claimedRow.storageIdentity}`) };
      }

      return {
        // Rebuilt (not the bare narrowed variable) so the object literal's own
        // storageIdentity field carries the non-null type this scope just
        // proved, across the function boundary into ClaimedSnapshot.
        snapshot: { ...claimedRow, storageIdentity: claimedRow.storageIdentity },
        providerType,
        providerConfig,
      };
    }),
  );
}

type ParsedManifest = {
  manifestSha256: string;
  fileRows: Array<{ snapshotDbId: string; sourcePath: string; backupPath: string; size: number | null; modifiedAt: Date | null }>;
  originCounts: Map<string, number>;
};

/**
 * Phase 2 (no DB context held): fetch and parse the manifest. This is the
 * network round trip and the CPU-bound hash/parse step — sized only by
 * MANIFEST_FETCH_MAX_BYTES — and it must not pin a pooled connection idle
 * for however long it takes.
 */
async function fetchAndParseManifest(
  snapshotDbId: string,
  snapshot: ClaimedSnapshot,
  providerType: string,
  providerConfig: Record<string, unknown>,
  deps: HydrationDeps,
): Promise<{ outcome: HydrationOutcome } | { manifest: ParsedManifest }> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.fetchManifestBytes({
      provider: providerType,
      providerConfig,
      key: backupSnapshotManifestKey(snapshot.snapshotId),
    });
  } catch (err) {
    if (isBackupObjectNotFound(err)) {
      return { outcome: await failOutsideContext(snapshotDbId, 'manifest_missing', 'manifest object not found in storage') };
    }
    if (isBackupObjectTooLarge(err)) {
      return { outcome: await failOutsideContext(snapshotDbId, 'manifest_too_large', err.message) };
    }
    return { outcome: await failOutsideContext(snapshotDbId, 'provider_error', err instanceof Error ? err.message : String(err)) };
  }

  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  // Checked again under the snapshot row lock when the index is published; this
  // early check only avoids writing rows that could never be published.
  const refusal = attestationRefusal(snapshot.attestation, manifestSha256);
  if (refusal) {
    return { outcome: await failOutsideContext(snapshotDbId, refusal.failure, refusal.reason) };
  }

  let parsed: z.infer<typeof hydrationManifestSchema>;
  try {
    const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const result = hydrationManifestSchema.safeParse(json);
    if (!result.success) {
      return { outcome: await failOutsideContext(snapshotDbId, 'manifest_invalid', summarizeManifestIssues(result.error, json)) };
    }
    parsed = result.data;
    if (parsed.id !== snapshot.snapshotId) {
      throw new Error(`manifest id ${parsed.id} does not match snapshot ${snapshot.snapshotId}`);
    }
  } catch (err) {
    return { outcome: await failOutsideContext(snapshotDbId, 'manifest_invalid', err instanceof Error ? err.message : String(err)) };
  }

  const files = parsed.files ?? [];
  const ownPrefix = `snapshots/${snapshot.snapshotId}/`;
  const originCounts = new Map<string, number>();
  const fileRows: ParsedManifest['fileRows'] = [];

  for (const file of files) {
    // Content-less entries (dir/symlink) upload nothing — the schema above
    // guarantees an empty backupPath only ever appears on one.
    if (!file.backupPath) continue;
    const parsedKey = parseBackupObjectKey(file.backupPath);
    if (!parsedKey) {
      return { outcome: await failOutsideContext(snapshotDbId, 'manifest_key_invalid', `unparseable backupPath: ${file.backupPath}`) };
    }
    if (!file.backupPath.startsWith(ownPrefix)) {
      originCounts.set(parsedKey.snapshotId, (originCounts.get(parsedKey.snapshotId) ?? 0) + 1);
    }
    fileRows.push({
      snapshotDbId,
      sourcePath: file.originalPath ?? file.sourcePath,
      backupPath: file.backupPath,
      size: file.size ?? null,
      modifiedAt: file.modTime ? new Date(file.modTime) : null,
    });
  }

  return { manifest: { manifestSha256, fileRows, originCounts } };
}

/**
 * Phase 3 (short transaction, opened fresh — no connection was held across
 * the fetch in phase 2): verify each referenced origin against current DB
 * state and write the file/origin rows plus the completion status.
 */
async function verifyOriginsAndWrite(
  snapshotDbId: string,
  snapshot: ClaimedSnapshot,
  manifest: ParsedManifest,
): Promise<HydrationOutcome> {
  const { manifestSha256, fileRows, originCounts } = manifest;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      type OriginRow = {
        originSnapshotId: string; originOrgId: string; originDeviceId: string;
        originStorageIdentity: string; originStoragePrefix: string | null; provenance: 'live' | 'retired'; objectCount: number;
      };
      const originRows: OriginRow[] = [];
      for (const [originId, objectCount] of originCounts) {
        const [live] = await db
          .select({ id: backupSnapshots.id, orgId: backupSnapshots.orgId, deviceId: backupSnapshots.deviceId, storageIdentity: backupSnapshots.storageIdentity, metadata: backupSnapshots.metadata })
          .from(backupSnapshots)
          .where(and(eq(backupSnapshots.snapshotId, originId), eq(backupSnapshots.orgId, snapshot.orgId), eq(backupSnapshots.deviceId, snapshot.deviceId)))
          .limit(1);
        if (live && live.storageIdentity === snapshot.storageIdentity) {
          originRows.push({
            originSnapshotId: originId, originOrgId: snapshot.orgId, originDeviceId: snapshot.deviceId,
            originStorageIdentity: snapshot.storageIdentity, originStoragePrefix: getStringValue(asRecord(live.metadata), 'storagePrefix'),
            provenance: 'live', objectCount,
          });
          continue;
        }
        const [retired] = await db
          .select({ orgId: backupSnapshotRetirements.orgId, deviceId: backupSnapshotRetirements.deviceId, storageIdentity: backupSnapshotRetirements.storageIdentity })
          .from(backupSnapshotRetirements)
          .where(and(eq(backupSnapshotRetirements.snapshotId, originId), eq(backupSnapshotRetirements.storageIdentity, snapshot.storageIdentity), eq(backupSnapshotRetirements.orgId, snapshot.orgId), eq(backupSnapshotRetirements.deviceId, snapshot.deviceId)))
          .limit(1);
        if (retired) {
          originRows.push({
            originSnapshotId: originId, originOrgId: snapshot.orgId, originDeviceId: snapshot.deviceId,
            originStorageIdentity: snapshot.storageIdentity, originStoragePrefix: null, provenance: 'retired', objectCount,
          });
          continue;
        }
        // A live row existed on this device but with a NULL/mismatched
        // identity (GC heals this eventually) is origin_identity_pending
        // (retryable); genuinely no record anywhere for this org/device is
        // origin_unverifiable (terminal).
        if (live && !live.storageIdentity) {
          return fail(snapshotDbId, 'origin_identity_pending', `origin ${originId}: live snapshot row has no storage identity yet (GC heals it on its next listing)`);
        }
        return fail(snapshotDbId, 'origin_unverifiable', `origin ${originId}: no live snapshot or retirement record for this device/destination`);
      }

      // Write file rows in 1,000-row batches, each its own transaction.
      // The delete rides in the SAME transaction as the first insert batch so a
      // crash between them cannot leave a snapshot with zero rows; every later
      // batch is its own short transaction. Status stays 'hydrating' until the
      // final publish, so partial rows are never read as an index.
      for (let i = 0; i < Math.max(fileRows.length, 1); i += FILE_ROW_BATCH_SIZE) {
        const batch = fileRows.slice(i, i + FILE_ROW_BATCH_SIZE);
        await db.transaction(async (tx) => {
          if (i === 0) {
            await tx.delete(backupSnapshotFiles).where(eq(backupSnapshotFiles.snapshotDbId, snapshotDbId));
          }
          if (batch.length > 0) {
            await tx.insert(backupSnapshotFiles).values(batch);
          }
        });
      }

      const externalCount = [...originCounts.values()].reduce((a, b) => a + b, 0);
      const refused = await db.transaction(async (tx) => {
        // The snapshot row lock serializes publication with the attestation
        // verifier (backupAttestationVerify.ts finish) and with an attestation
        // being recorded (backupAttestation.ts), which take the same lock
        // first: the attestation read here is the one in force when the index
        // becomes visible.
        const [current] = await tx
          .select({ metadata: backupSnapshots.metadata, attestation: indexAttestationColumns() })
          .from(backupSnapshots)
          .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id))
          .where(eq(backupSnapshots.id, snapshotDbId))
          .limit(1)
          .for('update', { of: backupSnapshots });
        const refusal = attestationRefusal(indexAttestationOf(current?.attestation), manifestSha256);
        if (refusal) {
          await tx
            .update(backupSnapshots)
            .set({ fileIndexStatus: 'failed', fileIndexError: `${refusal.failure}: ${refusal.reason}` })
            .where(eq(backupSnapshots.id, snapshotDbId));
          return refusal;
        }
        await tx.delete(backupSnapshotOrigins).where(eq(backupSnapshotOrigins.snapshotDbId, snapshotDbId));
        if (originRows.length > 0) {
          await tx.insert(backupSnapshotOrigins).values(originRows.map((o) => ({ snapshotDbId, ...o })));
        }
        await tx
          .update(backupSnapshots)
          .set({
            fileIndexStatus: 'complete',
            fileIndexManifestSha256: manifestSha256,
            fileIndexHydratedAt: new Date(),
            fileIndexExternalCount: externalCount,
            fileIndexError: null,
            metadata: { ...asRecord(current?.metadata), hasIndexedFiles: true, fileIndexVersion: 2 },
          })
          .where(eq(backupSnapshots.id, snapshotDbId));
        return null;
      });
      if (refused) {
        return { status: 'failed', failure: refused.failure, reason: refused.reason, retryable: false };
      }

      return {
        status: 'complete',
        manifestSha256,
        entryCount: fileRows.length,
        externalCount,
        originSnapshotIds: [...originCounts.keys()],
      };
    }),
  );
}

export async function hydrateSnapshotFileIndex(
  snapshotDbId: string,
  opts?: {
    force?: boolean;
    deps?: HydrationDeps;
    /**
     * Also hydrate a snapshot whose job referenced no older snapshots. The
     * brokered storage-read path authorizes objects by EXACT index
     * membership, so it needs a server-verified index for full snapshots
     * too, not only for incrementals with external references.
     */
    includeUnreferenced?: boolean;
  },
): Promise<HydrationOutcome> {
  const deps = opts?.deps ?? defaultDeps();
  const now = deps.now?.() ?? new Date();

  const claim = await claimSnapshotForHydration(
    snapshotDbId,
    now,
    opts?.force ?? false,
    opts?.includeUnreferenced ?? false,
  );
  if ('outcome' in claim) {
    return claim.outcome;
  }
  const { snapshot, providerType, providerConfig } = claim;

  // No DB context is held across this step — see fetchAndParseManifest.
  const parsedManifest = await fetchAndParseManifest(snapshotDbId, snapshot, providerType, providerConfig, deps);
  if ('outcome' in parsedManifest) {
    return parsedManifest.outcome;
  }

  try {
    return await verifyOriginsAndWrite(snapshotDbId, snapshot, parsedManifest.manifest);
  } catch (err) {
    await failOutsideContext(snapshotDbId, 'provider_error', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * The index state as readers must see it: a complete index that was not built
 * from the manifest bytes the snapshot's attestation names is reported as not
 * built yet ('none': hydration rebuilds it), or as failed when the attestation
 * did not match. Only a bound index is ever reported complete.
 */
function boundIndexState<T extends { status: string; manifestSha256: string | null; error: string | null }>(
  row: T,
  attestation: IndexAttestation,
): T {
  if (row.status !== 'complete') return row;
  if (indexMatchesAttestation({ fileIndexStatus: row.status, fileIndexManifestSha256: row.manifestSha256 }, attestation)) {
    return row;
  }
  const refusal = attestationRefusal(attestation, row.manifestSha256);
  if (refusal?.failure === 'attestation_failed') {
    return { ...row, status: 'failed', manifestSha256: null, error: `${refusal.failure}: ${refusal.reason}` };
  }
  return { ...row, status: 'none', manifestSha256: null, error: null };
}

export async function readSnapshotFileIndexState(snapshotDbId: string): Promise<{
  status: FileIndexStatus;
  manifestSha256: string | null;
  externalCount: number | null;
  originSnapshotIds: string[];
  error: string | null;
  retryable: boolean;
  referencedFiles: number | null;
  storageIdentity: string | null;
} | null> {
  const [raw] = await db
    .select({
      status: backupSnapshots.fileIndexStatus,
      manifestSha256: backupSnapshots.fileIndexManifestSha256,
      externalCount: backupSnapshots.fileIndexExternalCount,
      error: backupSnapshots.fileIndexError,
      jobId: backupSnapshots.jobId,
      storageIdentity: backupSnapshots.storageIdentity,
      attestation: indexAttestationColumns(),
    })
    .from(backupSnapshots)
    .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id))
    .where(eq(backupSnapshots.id, snapshotDbId))
    .limit(1);
  if (!raw) return null;
  const row = boundIndexState(raw, indexAttestationOf(raw.attestation));
  const referencedFiles = await loadReferencedFiles(row.jobId);
  const status = row.status as FileIndexStatus;
  const originSnapshotIds =
    status === 'complete'
      ? (
          await db
            .select({ originSnapshotId: backupSnapshotOrigins.originSnapshotId })
            .from(backupSnapshotOrigins)
            .where(eq(backupSnapshotOrigins.snapshotDbId, snapshotDbId))
            .orderBy(backupSnapshotOrigins.originSnapshotId)
        ).map((o) => o.originSnapshotId)
      : [];
  const failure = hydrationFailureFromError(row.error);
  return {
    status,
    manifestSha256: row.manifestSha256,
    externalCount: row.externalCount,
    originSnapshotIds,
    error: row.error,
    retryable: failure ? isRetryableHydrationFailure(failure) : false,
    referencedFiles,
    storageIdentity: row.storageIdentity,
  };
}
