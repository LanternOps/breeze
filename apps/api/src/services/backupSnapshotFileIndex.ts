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
import { backupSnapshotManifestKey, fetchBackupObjectBytes, isBackupObjectNotFound } from './backupSnapshotStorage';
import { parseBackupObjectKey } from './backupObjectKey';

export type FileIndexStatus = 'none' | 'agent' | 'hydrating' | 'complete' | 'failed';

export type HydrationFailure =
  | 'storage_identity_unknown'
  | 'storage_identity_drift'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'manifest_key_invalid'
  | 'origin_unverifiable'
  | 'origin_identity_pending'
  | 'provider_error';

const HYDRATION_FAILURES: readonly HydrationFailure[] = [
  'storage_identity_unknown', 'storage_identity_drift', 'manifest_missing', 'manifest_invalid',
  'manifest_key_invalid', 'origin_unverifiable', 'origin_identity_pending', 'provider_error',
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
            backupPath: z.string().min(1),
            size: z.number().nonnegative().optional(),
            modTime: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

function defaultDeps(): HydrationDeps {
  return {
    fetchManifestBytes: (args) => fetchBackupObjectBytes(args),
  };
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
      fileIndexHydratedAt: backupSnapshots.fileIndexHydratedAt,
    })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, snapshotDbId))
    .limit(1);
  return row ?? null;
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

export async function hydrateSnapshotFileIndex(
  snapshotDbId: string,
  opts?: { force?: boolean; deps?: HydrationDeps },
): Promise<HydrationOutcome> {
  const deps = opts?.deps ?? defaultDeps();
  const now = deps.now?.() ?? new Date();

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const snapshot = await loadSnapshotForHydration(snapshotDbId);
      if (!snapshot) {
        return { status: 'failed', failure: 'manifest_missing', reason: 'snapshot not found', retryable: false } as const;
      }

      const referencedFiles = await loadReferencedFiles(snapshot.jobId);

      if ((referencedFiles ?? 0) === 0) {
        return { status: 'skipped', reason: 'not_referenced' } as const;
      }
      if (snapshot.fileIndexStatus === 'complete' && !opts?.force) {
        return { status: 'skipped', reason: 'already_complete' } as const;
      }
      if (
        snapshot.fileIndexStatus === 'hydrating' &&
        snapshot.fileIndexHydratedAt &&
        now.getTime() - snapshot.fileIndexHydratedAt.getTime() < HYDRATING_STALE_MS
      ) {
        return { status: 'skipped', reason: 'in_progress' } as const;
      }

      // CAS to 'hydrating' — the predicate itself expresses staleness so a
      // row stuck in 'hydrating' past HYDRATING_STALE_MS can actually be
      // reclaimed: `ne(status, 'hydrating')` alone can never match a row
      // whose status IS 'hydrating', no matter how old, which made the
      // stale-reclaim path dead code. 0 rows means a concurrent (non-stale)
      // claim won the race.
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
        .returning({ id: backupSnapshots.id });
      if (!claimed) {
        return { status: 'skipped', reason: 'in_progress' } as const;
      }

      try {
        return await hydrateClaimedSnapshot(snapshotDbId, snapshot, now, deps);
      } catch (err) {
        await fail(snapshotDbId, 'provider_error', err instanceof Error ? err.message : String(err));
        throw err;
      }
    }),
  );
}

async function hydrateClaimedSnapshot(
  snapshotDbId: string,
  snapshot: NonNullable<Awaited<ReturnType<typeof loadSnapshotForHydration>>>,
  now: Date,
  deps: HydrationDeps,
): Promise<HydrationOutcome> {
  {
      const resolved = await resolveSnapshotProviderConfig(snapshotDbId);
      const providerType = resolved?.providerType ?? null;
      const providerConfig = asRecord(resolved?.providerConfig);
      if (!snapshot.storageIdentity) {
        return fail(snapshotDbId, 'storage_identity_unknown', 'snapshot has no pinned storage identity');
      }
      if (!providerType) {
        return fail(snapshotDbId, 'storage_identity_unknown', 'could not resolve a provider for this snapshot');
      }
      const resolvedIdentity = normalizeStorageIdentity(providerType, providerConfig);
      if (resolvedIdentity !== snapshot.storageIdentity) {
        return fail(snapshotDbId, 'storage_identity_drift', `resolved identity ${resolvedIdentity} does not match pinned ${snapshot.storageIdentity}`);
      }

      let bytes: Uint8Array;
      try {
        bytes = await deps.fetchManifestBytes({
          provider: providerType,
          providerConfig,
          key: backupSnapshotManifestKey(snapshot.snapshotId),
        });
      } catch (err) {
        if (isBackupObjectNotFound(err)) {
          return fail(snapshotDbId, 'manifest_missing', 'manifest object not found in storage');
        }
        return fail(snapshotDbId, 'provider_error', err instanceof Error ? err.message : String(err));
      }

      const manifestSha256 = createHash('sha256').update(bytes).digest('hex');

      let parsed: z.infer<typeof hydrationManifestSchema>;
      try {
        const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
        parsed = hydrationManifestSchema.parse(json);
        if (parsed.id !== snapshot.snapshotId) {
          throw new Error(`manifest id ${parsed.id} does not match snapshot ${snapshot.snapshotId}`);
        }
      } catch (err) {
        return fail(snapshotDbId, 'manifest_invalid', err instanceof Error ? err.message : String(err));
      }

      const files = parsed.files ?? [];
      const ownPrefix = `snapshots/${snapshot.snapshotId}/`;
      const originCounts = new Map<string, number>();
      const fileRows: Array<{ snapshotDbId: string; sourcePath: string; backupPath: string; size: number | null; modifiedAt: Date | null }> = [];

      for (const file of files) {
        if (!file.backupPath) continue;
        const parsedKey = parseBackupObjectKey(file.backupPath);
        if (!parsedKey) {
          return fail(snapshotDbId, 'manifest_key_invalid', `unparseable backupPath: ${file.backupPath}`);
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

      // Write file rows in 1,000-row batches, each its own transaction —
      // storage I/O already happened above, outside any DB transaction.
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
      await db.transaction(async (tx) => {
        await tx.delete(backupSnapshotOrigins).where(eq(backupSnapshotOrigins.snapshotDbId, snapshotDbId));
        if (originRows.length > 0) {
          await tx.insert(backupSnapshotOrigins).values(originRows.map((o) => ({ snapshotDbId, ...o })));
        }
        const [current] = await tx.select({ metadata: backupSnapshots.metadata }).from(backupSnapshots).where(eq(backupSnapshots.id, snapshotDbId)).limit(1);
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
      });

      return {
        status: 'complete',
        manifestSha256,
        entryCount: fileRows.length,
        externalCount,
        originSnapshotIds: [...originCounts.keys()],
      };
  }
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
  const [row] = await db
    .select({
      status: backupSnapshots.fileIndexStatus,
      manifestSha256: backupSnapshots.fileIndexManifestSha256,
      externalCount: backupSnapshots.fileIndexExternalCount,
      error: backupSnapshots.fileIndexError,
      jobId: backupSnapshots.jobId,
      storageIdentity: backupSnapshots.storageIdentity,
    })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, snapshotDbId))
    .limit(1);
  if (!row) return null;
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
