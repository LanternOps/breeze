// W09 (#6464) Task 3 — server-side, verified-complete file index for any
// snapshot whose owning job reported referenced_files > 0. Never trusts the
// agent-reported backup_snapshot_files rows (they may be entirely absent —
// the helper drops snapshot.files past a 5MB delivery budget, Part 0 §0) —
// this reads snapshots/<id>/manifest.json itself and verifies every
// referenced OLDER snapshot's provenance before marking the index complete.
// See docs/superpowers/plans/backup/_w09-part0.md §3 for the full algorithm.
import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import {
  backupJobs,
  backupSnapshotFiles,
  backupSnapshotOrigins,
  backupSnapshotRetirements,
  backupSnapshots,
} from '../db/schema';
import { asRecord, getStringValue, resolveSnapshotProviderConfig } from './recoveryBootstrap';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import { backupSnapshotManifestKey, isBackupObjectNotFound, isBackupObjectTooLarge, MANIFEST_STREAM_MAX_BYTES, openBackupObjectStream } from './backupSnapshotStorage';
import { ManifestScanError, scanManifest } from './backupManifestScanner';
import { spoolManifest, type ManifestSpool } from './backupManifestSpool';
import { parseBackupObjectKey } from './backupObjectKey';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { indexMatchesAttestation } from './backupRestoreIntegrity';
import { physicalKeyFor, sameKeyRoot, snapshotKeyRootOf, type SnapshotKeyRoot } from './backupKeyLayout';
import { recordSnapshotFileIndex } from './backupMetrics';
import { refreshSnapshotFileIndexStatistics } from './backupSnapshotFileIndexStatistics';
import { captureException } from './sentry';
import { contentlessEntryKind, type SnapshotEntryKind } from './backupSnapshotEntryKind';
import {
  HYDRATING_STALE_MS,
  hydrationFailureFromError,
  isRetryableHydrationFailure,
  type FileIndexStatus,
  type HydrationFailure,
} from './backupSnapshotIndexView';

export {
  hydrationFailureFromError,
  isRetryableHydrationFailure,
  RETRYABLE_HYDRATION_FAILURES,
  type FileIndexStatus,
  type HydrationFailure,
} from './backupSnapshotIndexView';

export type HydrationOutcome =
  | { status: 'complete'; manifestSha256: string; entryCount: number; externalCount: number; originSnapshotIds: string[] }
  | { status: 'failed'; failure: HydrationFailure; reason: string; retryable: boolean }
  | { status: 'skipped'; reason: 'not_referenced' | 'already_complete' | 'in_progress' | 'superseded' };

export type HydrationDeps = {
  /** The manifest's bytes. W03 passes a device upload through this same seam. */
  openManifest: (args: { provider: string; providerConfig: Record<string, unknown>; key: string }) => Promise<NodeJS.ReadableStream>;
  now?: () => Date;
  /** Test seams for the spool: where it goes, its cap, and a failing disk. */
  spoolBaseDir?: string;
  spoolMaxBytes?: number;
  openSpoolWriter?: (path: string) => Writable;
  /** Test seam: rows a publish must write before it analyzes the table (#11209). */
  statisticsRefreshMinRows?: number;
};

/**
 * Each batch is one JSON string, and those strings are what survives into the
 * old generation during a million-entry hydration. 1,000 rows went over the
 * 300 MB peak-RSS bound in one of two runs at 1.1M entries; 250 stays under it
 * for about the same wall time (#11026).
 */
const FILE_ROW_BATCH_SIZE = 250;
/**
 * Distinct older snapshots one manifest may name. Each costs a lookup inside the
 * publish transaction, and a real chain is bounded by retention, so anything near
 * this is not a backup. Also bounds the one map pass 1 keeps.
 */
const MAX_MANIFEST_ORIGINS = 10_000;

// The entry shape of backupSnapshotReconcile.ts's private reconcileManifestSchema
// — duplicated deliberately (see W09 Task 3 Interfaces note: a shared schema
// module would be a bigger refactor than this wave needs). The manifest's own id
// is checked against the snapshot being hydrated separately, as defense against
// a corrupted/swapped object at the expected key.
const hydrationEntrySchema = z
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
    // Checked here, so a date the database could not take is a bad entry found
    // before anything is written, not a failure partway through the write.
    modTime: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'modTime is not a date' })
      .optional(),
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
  });

type HydrationEntry = z.infer<typeof hydrationEntrySchema>;

// Reporting every issue by array position (`files[41233].backupPath`) on a
// 100k-entry manifest is a multi-megabyte string a tech cannot map back to a
// file. The first issue is reported with the offending entry's sourcePath, and
// the rest only as a count.
function describeEntryIssue(error: z.ZodError, entry: unknown, index: number): string {
  const first = error.issues[0];
  const where = ['files', index, ...(first?.path ?? [])].map(String).join('.');
  const sourcePath = entry && typeof entry === 'object' ? (entry as { sourcePath?: unknown }).sourcePath : undefined;
  const named = typeof sourcePath === 'string' ? ` (entry sourcePath ${JSON.stringify(sourcePath.slice(0, 1024))})` : '';
  return `${where}: ${first?.message ?? 'failed schema validation'}${named}`;
}

function defaultDeps(): HydrationDeps {
  return {
    openManifest: (args) => openBackupObjectStream({ ...args, maxBytes: MANIFEST_STREAM_MAX_BYTES }),
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
  integrityStatus?: string | null,
): { failure: 'attestation_failed' | 'manifest_differs_from_attestation'; reason: string } | null {
  if (!attestation) {
    // A statement refused when it was reported leaves no row, only the
    // projection: treated exactly like a mismatched attestation.
    return integrityStatus === 'attestation_failed'
      ? { failure: 'attestation_failed', reason: "the snapshot's attestation was refused when it was reported" }
      : null;
  }
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
      keyLayout: backupSnapshots.keyLayout,
      keyPrefix: backupSnapshots.keyPrefix,
      // consumed by loadReferencedFiles below — without it hydration is a
      // permanent no-op.
      jobId: backupSnapshots.jobId,
      fileIndexStatus: backupSnapshots.fileIndexStatus,
      fileIndexManifestSha256: backupSnapshots.fileIndexManifestSha256,
      fileIndexHydratedAt: backupSnapshots.fileIndexHydratedAt,
      integrityStatus: backupSnapshots.integrityStatus,
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

/**
 * One hydration's hold on a snapshot: the row it claimed and the
 * `file_index_hydrated_at` it stamped there. Every write this run makes is
 * scoped by both, so a run that lost its claim (a stale reclaim by another
 * worker, an org move resetting the index, a fresh agent result) never
 * overwrites the newer state.
 */
type HydrationClaim = { id: string; claimedAt: Date };

/** Stored when the claim phase throws; raw error text can name hosts, so it is not kept. */
const CLAIM_PHASE_FAILURE_REASON = 'the snapshot could not be prepared for indexing';

const SUPERSEDED: HydrationOutcome = { status: 'skipped', reason: 'superseded' };

function claimPredicate(claim: HydrationClaim) {
  return and(
    eq(backupSnapshots.id, claim.id),
    eq(backupSnapshots.fileIndexStatus, 'hydrating'),
    eq(backupSnapshots.fileIndexHydratedAt, claim.claimedAt),
  );
}

const MAX_STORED_REASON_LENGTH = 200;

/** Last labels that mean a file name, not a host, in a dotted token. */
const FILE_EXTENSIONS = new Set([
  'json', 'txt', 'gz', 'tgz', 'zip', 'log', 'js', 'ts', 'yaml', 'yml', 'xml', 'csv', 'db', 'bin', 'dat', 'tmp', 'bak', 'sql', 'pem', 'crt', 'key', 'enc', 'zst', 'xz', 'tar',
]);

/**
 * Provider and network errors name the host they could not reach
 * (`connect ECONNREFUSED 127.0.0.1:9`). The stored text keeps the error code
 * and wording but not URLs, IP addresses, host:port tokens, or the host after a
 * network error code (#11280). Dotted hostnames are redacted unless the last label is a file extension.
 */
export function redactIndexFailureReason(reason: string): string {
  return reason
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted]')
    .replace(/\[[0-9a-f:]*:[0-9a-f:]*\](?::\d+)?/gi, '[redacted]')
    .replace(/(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4})?|::1\b/gi, '[redacted]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[redacted]')
    .replace(/\b[a-z0-9][a-z0-9.-]*:\d{2,5}\b/gi, '[redacted]')
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})\b/gi, (match, last: string) =>
      FILE_EXTENSIONS.has(last.toLowerCase()) ? match : '[redacted]')
    // The token after a network error code is the host it names.
    .replace(/\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\s+\S+/g, '$1 [redacted]')
    .slice(0, MAX_STORED_REASON_LENGTH);
}

async function fail(
  claim: HydrationClaim,
  failure: HydrationFailure,
  reason: string,
): Promise<HydrationOutcome> {
  const [written] = await db
    .update(backupSnapshots)
    .set({ fileIndexStatus: 'failed', fileIndexError: `${failure}: ${redactIndexFailureReason(reason)}` })
    .where(claimPredicate(claim))
    .returning({ id: backupSnapshots.id });
  if (!written) return SUPERSEDED;
  return { status: 'failed', failure, reason, retryable: isRetryableHydrationFailure(failure) };
}

// Failure paths reached while no DB context is held (the manifest
// fetch/parse phase below, and the outer catch-all once the final write
// transaction has already closed) need to open their own short context —
// `fail` itself assumes an ambient one, which is correct for every call site
// still inside a transaction (see below) but would hit the contextless-write
// guard here.
async function failOutsideContext(
  claim: HydrationClaim,
  failure: HydrationFailure,
  reason: string,
): Promise<HydrationOutcome> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => fail(claim, failure, reason)));
}

type LoadedSnapshot = NonNullable<Awaited<ReturnType<typeof loadSnapshotForHydration>>>;
// Once claimSnapshotForHydration's own storage_identity_unknown check has run,
// storageIdentity is verified non-null for the rest of the pipeline — phases 2
// and 3 read it unconditionally (origin verification, SQL equality checks). The
// null check and its use live in different functions, so a plain narrowed
// re-read of `snapshot.storageIdentity` at the return site doesn't survive the
// function boundary; this type carries the guarantee across it instead.
type ClaimedSnapshot = Omit<LoadedSnapshot, 'storageIdentity'> & HydrationClaim & { storageIdentity: string; keyRoot: SnapshotKeyRoot };

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
  | { thrown: unknown }
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
          {
            fileIndexStatus: snapshot.fileIndexStatus,
            fileIndexManifestSha256: snapshot.fileIndexManifestSha256 ?? null,
            integrityStatus: snapshot.integrityStatus ?? null,
          },
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
      const claim: HydrationClaim = { id: snapshotDbId, claimedAt: now };
      const claimedRow = { ...snapshot, ...claimed, ...claim };

      // From here the row is 'hydrating' under this run's claim. A throw (not a
      // classified refusal) would leave it with no reason until the 30-minute
      // stale reclaim, so record one (#11179). The write happens here, inside
      // the context, and the error is handed back to be rethrown: throwing out
      // of the context would roll the failure write back with it.
      try {
        // Nothing an index could be built from is trustworthy for a snapshot
        // whose attestation did not match; storage is not read at all.
        const failedIntegrity = attestationRefusal(snapshot.attestation, null, snapshot.integrityStatus ?? null);
        if (failedIntegrity) {
          return { outcome: await fail(claim, failedIntegrity.failure, failedIntegrity.reason) };
        }
        // The manifest is read under the snapshot's recorded key root (#7081),
        // never a guessed one; storage is not read for a root this server
        // cannot read. (The root is immutable, so the pre-claim read is exact.)
        const keyRoot = snapshotKeyRootOf(snapshot);
        if (!keyRoot) {
          return { outcome: await fail(claim, 'key_root_invalid', `unreadable key root (${String(snapshot.keyLayout)})`) };
        }

        const resolved = await resolveSnapshotProviderConfig(snapshotDbId);
        const providerType = resolved?.providerType ?? null;
        const providerConfig = asRecord(resolved?.providerConfig);
        if (!claimedRow.storageIdentity) {
          return { outcome: await fail(claim, 'storage_identity_unknown', 'snapshot has no pinned storage identity') };
        }
        if (!providerType) {
          return { outcome: await fail(claim, 'storage_identity_unknown', 'could not resolve a provider for this snapshot') };
        }
        const resolvedIdentity = normalizeStorageIdentity(providerType, providerConfig);
        if (resolvedIdentity !== claimedRow.storageIdentity) {
          return { outcome: await fail(claim, 'storage_identity_drift', `resolved identity ${resolvedIdentity} does not match pinned ${claimedRow.storageIdentity}`) };
        }

        return {
          // Rebuilt (not the bare narrowed variable) so the object literal's own
          // storageIdentity field carries the non-null type this scope just
          // proved, across the function boundary into ClaimedSnapshot.
          snapshot: { ...claimedRow, storageIdentity: claimedRow.storageIdentity, keyRoot },
          providerType,
          providerConfig,
        };
      } catch (err) {
        console.error(`[backupSnapshotFileIndex] Claim phase failed for snapshot ${snapshotDbId}:`, err);
        // The stored reason is deliberately generic; the cause goes to Sentry.
        captureException(err instanceof Error ? err : new Error(String(err)));
        try {
          await fail(claim, 'provider_error', CLAIM_PHASE_FAILURE_REASON);
        } catch (recordErr) {
          // Keep the original error. A DB error here has aborted this
          // transaction, which rolls the claim back with it: nothing is left
          // 'hydrating'.
          console.error(`[backupSnapshotFileIndex] Could not record the claim-phase failure of snapshot ${snapshotDbId}:`, recordErr);
        }
        return { thrown: err };
      }
    }),
  );
}

type FileRowJson = {
  source_path: string;
  backup_path: string;
  size: number | null;
  modified_at: string | null;
  kind: SnapshotEntryKind | null;
};

/** What pass 1 learned about a spooled manifest. The rows stay on disk until pass 2. */
type ParsedManifest = {
  manifestSha256: string;
  spool: ManifestSpool;
  /**
   * Entries that become rows: every entry, content-less dirs and symlinks
   * included (#11235), so the index lists the tree the manifest records.
   */
  eligibleEntries: number;
  originCounts: Map<string, number>;
};

/**
 * Phase 2a (no DB context held): copy the manifest to disk, hashing as it
 * arrives. This is the network round trip, sized only by
 * MANIFEST_STREAM_MAX_BYTES, and it must not pin a pooled connection for however
 * long it takes.
 */
async function spoolManifestForHydration(
  snapshot: ClaimedSnapshot,
  providerType: string,
  providerConfig: Record<string, unknown>,
  deps: HydrationDeps,
): Promise<{ outcome: HydrationOutcome } | { spool: ManifestSpool }> {
  try {
    const source = await deps.openManifest({
      provider: providerType,
      providerConfig,
      key: physicalKeyFor(snapshot.keyRoot, backupSnapshotManifestKey(snapshot.snapshotId)),
    });
    const spool = await spoolManifest(source, {
      maxBytes: deps.spoolMaxBytes ?? MANIFEST_STREAM_MAX_BYTES,
      ...(deps.spoolBaseDir ? { baseDir: deps.spoolBaseDir } : {}),
      ...(deps.openSpoolWriter ? { openWriter: deps.openSpoolWriter } : {}),
    });
    return { spool };
  } catch (err) {
    if (isBackupObjectNotFound(err)) {
      return { outcome: await failOutsideContext(snapshot, 'manifest_missing', 'manifest object not found in storage') };
    }
    if (isBackupObjectTooLarge(err)) {
      return { outcome: await failOutsideContext(snapshot, 'manifest_too_large', err.message) };
    }
    // A broken download and a full spool disk are both worth another try, and
    // neither has touched the existing rows.
    return { outcome: await failOutsideContext(snapshot, 'provider_error', err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * Phase 2b (no DB context held), pass 1: check the digest, then read every
 * entry from the spool, validating and counting. Nothing is written until the
 * whole manifest has passed, the same rule as when it was parsed in memory.
 */
async function validateSpooledManifest(
  snapshot: ClaimedSnapshot,
  spool: ManifestSpool,
): Promise<{ outcome: HydrationOutcome } | { manifest: ParsedManifest }> {
  // Checked again under the snapshot row lock when the index is published; this
  // early check only avoids reading a manifest that could never be published.
  const refusal = attestationRefusal(snapshot.attestation, spool.sha256);
  if (refusal) {
    return { outcome: await failOutsideContext(snapshot, refusal.failure, refusal.reason) };
  }

  const ownPrefix = `snapshots/${snapshot.snapshotId}/`;
  const originCounts = new Map<string, number>();
  let eligibleEntries = 0;
  let firstIssue: string | null = null;
  let issueCount = 0;
  let invalidKey: string | null = null;
  let tooManyOrigins = false;

  let scanned: Awaited<ReturnType<typeof scanManifest>>;
  try {
    scanned = await scanManifest(spool.open(), {
      onEntry: (entry, index) => {
        const result = hydrationEntrySchema.safeParse(entry);
        if (!result.success) {
          issueCount += result.error.issues.length;
          firstIssue ??= describeEntryIssue(result.error, entry, index);
          return;
        }
        const { backupPath } = result.data;
        // A content-less entry (dir/symlink) uploads nothing: the schema above
        // guarantees an empty backupPath only ever appears on one. It is still
        // a row (#11235), with no key to check and no origin.
        if (!backupPath) {
          eligibleEntries += 1;
          return;
        }
        const parsedKey = parseBackupObjectKey(backupPath);
        if (!parsedKey) {
          invalidKey ??= backupPath;
          return;
        }
        if (!backupPath.startsWith(ownPrefix)) {
          if (originCounts.size >= MAX_MANIFEST_ORIGINS && !originCounts.has(parsedKey.snapshotId)) {
            tooManyOrigins = true;
            return;
          }
          originCounts.set(parsedKey.snapshotId, (originCounts.get(parsedKey.snapshotId) ?? 0) + 1);
        }
        eligibleEntries += 1;
      },
    });
  } catch (err) {
    if (err instanceof ManifestScanError) {
      const failure = err.kind === 'limit' ? 'manifest_too_large' : 'manifest_invalid';
      return { outcome: await failOutsideContext(snapshot, failure, err.message) };
    }
    // Reading the private spool back failed: the disk, not the manifest.
    return { outcome: await failOutsideContext(snapshot, 'provider_error', err instanceof Error ? err.message : String(err)) };
  }

  // In the order whole-document validation reported them: the document's
  // shape, then whose it is, then its keys.
  if (scanned.id === null) {
    issueCount += 1;
    firstIssue = 'id: manifest has no id';
  }
  if (firstIssue !== null) {
    const more = issueCount > 1 ? `; ${issueCount - 1} more issue(s)` : '';
    return { outcome: await failOutsideContext(snapshot, 'manifest_invalid', `${firstIssue}${more}`) };
  }
  if (scanned.id !== snapshot.snapshotId) {
    return { outcome: await failOutsideContext(snapshot, 'manifest_invalid', `manifest id ${scanned.id} does not match snapshot ${snapshot.snapshotId}`) };
  }
  // Not the same as `files: null`, which is how the agent writes an empty slice:
  // no key at all means this is not a manifest, and publishing it would show an
  // empty snapshot as a complete index.
  if (!scanned.hasFilesKey) {
    return { outcome: await failOutsideContext(snapshot, 'manifest_invalid', 'manifest has no files key') };
  }
  if (invalidKey !== null) {
    return { outcome: await failOutsideContext(snapshot, 'manifest_key_invalid', `unparseable backupPath: ${invalidKey}`) };
  }
  if (tooManyOrigins) {
    return { outcome: await failOutsideContext(snapshot, 'manifest_invalid', `manifest references more than ${MAX_MANIFEST_ORIGINS} other snapshots`) };
  }

  return { manifest: { manifestSha256: spool.sha256, spool, eligibleEntries, originCounts } };
}

/** The spool's bytes, held to the digest pass 1 accepted as they pass. */
async function* verifiedSpoolBytes(spool: ManifestSpool): AsyncGenerator<Buffer> {
  const hash = createHash('sha256');
  for await (const chunk of spool.open()) {
    hash.update(chunk as Buffer);
    yield chunk as Buffer;
  }
  // A throw here rolls back everything pass 2 inserted. Only something
  // rewriting a private file mid-run could cause it, and then none of it holds.
  if (hash.digest('hex') !== spool.sha256) {
    throw new Error('the spooled manifest changed between validation and publish');
  }
}

/**
 * Phase 3 (one transaction, opened fresh — no connection was held across the
 * fetch in phase 2): take the snapshot row lock, confirm this run still holds
 * its claim, verify each referenced origin against current DB state, re-check
 * the attestation, and only then replace the file/origin rows and publish.
 *
 * Everything here commits together, so a reader sees the previous rows until
 * the new index is published and never a partial one. The lock comes first,
 * as in result persistence and the attestation verifier, so the three never
 * deadlock; and because every check runs after it, a stale worker or a
 * tenancy move can never be published over (#11026, D5).
 */
async function verifyOriginsAndWrite(
  snapshotDbId: string,
  snapshot: ClaimedSnapshot,
  manifest: ParsedManifest,
): Promise<HydrationOutcome> {
  const { manifestSha256, spool, eligibleEntries, originCounts } = manifest;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => db.transaction(async (tx): Promise<HydrationOutcome> => {
      const [current] = await tx
        .select({
          fileIndexStatus: backupSnapshots.fileIndexStatus,
          fileIndexHydratedAt: backupSnapshots.fileIndexHydratedAt,
          orgId: backupSnapshots.orgId,
          deviceId: backupSnapshots.deviceId,
          metadata: backupSnapshots.metadata,
          integrityStatus: backupSnapshots.integrityStatus,
        })
        .from(backupSnapshots)
        .where(eq(backupSnapshots.id, snapshotDbId))
        .limit(1)
        .for('update');
      // Another worker reclaimed the row, an org move reset it (the tenancy
      // trigger sets 'none'), a newer result rewrote it, or it is gone. Its
      // state is newer than this run's: leave it, and its rows, alone.
      if (
        !current
        || current.fileIndexStatus !== 'hydrating'
        || current.fileIndexHydratedAt?.getTime() !== snapshot.claimedAt.getTime()
        || current.orgId !== snapshot.orgId
        || current.deviceId !== snapshot.deviceId
      ) {
        return SUPERSEDED;
      }

      type OriginRow = {
        originSnapshotId: string; originOrgId: string; originDeviceId: string;
        originStorageIdentity: string; originStoragePrefix: string | null; provenance: 'live' | 'retired'; objectCount: number;
      };
      const originRows: OriginRow[] = [];
      // An origin is verified only under the snapshot's own key root (#7081
      // I4): its external refs are later served under that root.
      const originRootMatches = (row: { keyLayout: unknown; keyPrefix: unknown }) => {
        const originRoot = snapshotKeyRootOf(row);
        return originRoot !== null && sameKeyRoot(originRoot, snapshot.keyRoot);
      };
      const rootMismatch = (originId: string) =>
        fail(snapshot, 'origin_key_root_mismatch', `origin ${originId}: recorded under another key root than this snapshot`);
      for (const [originId, objectCount] of originCounts) {
        const [live] = await tx
          .select({
            id: backupSnapshots.id,
            orgId: backupSnapshots.orgId,
            deviceId: backupSnapshots.deviceId,
            storageIdentity: backupSnapshots.storageIdentity,
            keyLayout: backupSnapshots.keyLayout,
            keyPrefix: backupSnapshots.keyPrefix,
            metadata: backupSnapshots.metadata,
          })
          .from(backupSnapshots)
          .where(and(eq(backupSnapshots.snapshotId, originId), eq(backupSnapshots.orgId, snapshot.orgId), eq(backupSnapshots.deviceId, snapshot.deviceId)))
          .limit(1);
        if (live && live.storageIdentity === snapshot.storageIdentity) {
          if (!originRootMatches(live)) return rootMismatch(originId);
          originRows.push({
            originSnapshotId: originId, originOrgId: snapshot.orgId, originDeviceId: snapshot.deviceId,
            originStorageIdentity: snapshot.storageIdentity, originStoragePrefix: getStringValue(asRecord(live.metadata), 'storagePrefix'),
            provenance: 'live', objectCount,
          });
          continue;
        }
        const [retired] = await tx
          .select({
            orgId: backupSnapshotRetirements.orgId,
            deviceId: backupSnapshotRetirements.deviceId,
            storageIdentity: backupSnapshotRetirements.storageIdentity,
            keyLayout: backupSnapshotRetirements.keyLayout,
            keyPrefix: backupSnapshotRetirements.keyPrefix,
          })
          .from(backupSnapshotRetirements)
          .where(and(eq(backupSnapshotRetirements.snapshotId, originId), eq(backupSnapshotRetirements.storageIdentity, snapshot.storageIdentity), eq(backupSnapshotRetirements.orgId, snapshot.orgId), eq(backupSnapshotRetirements.deviceId, snapshot.deviceId)))
          .limit(1);
        if (retired) {
          if (!originRootMatches(retired)) return rootMismatch(originId);
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
          return fail(snapshot, 'origin_identity_pending', `origin ${originId}: live snapshot row has no storage identity yet (GC heals it on its next listing)`);
        }
        return fail(snapshot, 'origin_unverifiable', `origin ${originId}: no live snapshot or retirement record for this device/destination`);
      }

      // The attestation is read by a LATER statement than the lock: under
      // READ COMMITTED a statement's snapshot is taken before it waits for a
      // lock, so only a statement issued after the lock is held sees the
      // attestation in force when the index becomes visible. The verifier
      // (backupAttestationVerify.ts finish) and an attestation being recorded
      // (backupAttestation.ts) take the same row lock first.
      const [attestationRow] = await tx
        .select(indexAttestationColumns())
        .from(backupSnapshotAttestations)
        .where(eq(backupSnapshotAttestations.snapshotDbId, snapshotDbId))
        .limit(1);
      const refusal = attestationRefusal(indexAttestationOf(attestationRow), manifestSha256, current.integrityStatus ?? null);
      if (refusal) {
        // Refused before anything is replaced: the previous rows stay, and
        // the reader gate keeps them from being listed.
        await tx
          .update(backupSnapshots)
          .set({ fileIndexStatus: 'failed', fileIndexError: `${refusal.failure}: ${redactIndexFailureReason(refusal.reason)}` })
          .where(claimPredicate(snapshot));
        return { status: 'failed', failure: refusal.failure, reason: refusal.reason, retryable: false };
      }

      // Pass 2. Batched only to bound each statement's size and what is held
      // in memory: all of them commit together with the publish below.
      await tx.delete(backupSnapshotFiles).where(eq(backupSnapshotFiles.snapshotDbId, snapshotDbId));
      let inserted = 0;
      let batch: FileRowJson[] = [];
      const writeBatch = async () => {
        if (batch.length === 0) return;
        // One JSON parameter, not the query builder's multi-row VALUES: its
        // objects for 5,000 values a statement were two thirds of everything
        // that outlived a minor GC at 1.1M entries, and what grew the heap.
        // The ::text keeps the driver from serializing the string as JSON again.
        const written = await tx.execute(sql`
          INSERT INTO ${backupSnapshotFiles} (snapshot_db_id, source_path, backup_path, size, modified_at, kind)
          SELECT ${snapshotDbId}::uuid, r.source_path, r.backup_path, r.size, r.modified_at, r.kind
          FROM json_to_recordset(${JSON.stringify(batch)}::text::json)
            AS r(source_path text, backup_path text, size bigint, modified_at timestamp, kind text)
        `);
        // The database's own count of rows written.
        inserted += extractRowCount(written);
        batch = [];
      };
      await scanManifest(verifiedSpoolBytes(spool), {
        onEntry: async (entry) => {
          // Pass 1 validated these same bytes, and verifiedSpoolBytes holds
          // them to it.
          const file = entry as HydrationEntry;
          batch.push({
            source_path: file.originalPath ?? file.sourcePath,
            backup_path: file.backupPath,
            size: file.size ?? null,
            // As the column's own mapping sends it: a UTC ISO string, stored
            // in a timestamp without time zone.
            modified_at: file.modTime ? new Date(file.modTime).toISOString() : null,
            kind: contentlessEntryKind(file),
          });
          if (batch.length >= FILE_ROW_BATCH_SIZE) await writeBatch();
        },
      });
      await writeBatch();
      if (inserted !== eligibleEntries) {
        // Rolls back with the transaction: the previous rows stay.
        throw new Error(`snapshot ${snapshot.snapshotId}: expected to write ${eligibleEntries} file rows but wrote ${inserted}`);
      }

      const externalCount = [...originCounts.values()].reduce((a, b) => a + b, 0);
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
          // 3: content-less entries are rows (#11235). An index of version 2
          // is still correct for every file; it only omits those entries.
          metadata: { ...asRecord(current.metadata), hasIndexedFiles: true, fileIndexVersion: 3 },
        })
        .where(claimPredicate(snapshot));

      return {
        status: 'complete',
        manifestSha256,
        entryCount: inserted,
        externalCount,
        originSnapshotIds: [...originCounts.keys()],
      };
    })),
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
  let outcome: HydrationOutcome;
  try {
    outcome = await runHydration(snapshotDbId, opts);
  } catch (err) {
    recordSnapshotFileIndex('hydration', 'error');
    throw err;
  }
  // The label stays a closed set: `complete`, a failure code, or a skip reason
  // (superseded shows lost claims), never free text.
  recordSnapshotFileIndex(
    'hydration',
    outcome.status === 'failed' ? outcome.failure : outcome.status === 'skipped' ? outcome.reason : outcome.status,
  );
  return outcome;
}

async function runHydration(
  snapshotDbId: string,
  opts?: { force?: boolean; deps?: HydrationDeps; includeUnreferenced?: boolean },
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
  if ('thrown' in claim) {
    throw claim.thrown;
  }
  const { snapshot, providerType, providerConfig } = claim;

  // No DB context is held across either of these steps.
  const spooled = await spoolManifestForHydration(snapshot, providerType, providerConfig, deps);
  if ('outcome' in spooled) {
    return spooled.outcome;
  }

  let outcome: HydrationOutcome;
  try {
    const validated = await validateSpooledManifest(snapshot, spooled.spool);
    if ('outcome' in validated) {
      return validated.outcome;
    }
    outcome = await verifyOriginsAndWrite(snapshotDbId, snapshot, validated.manifest);
  } catch (err) {
    try {
      await failOutsideContext(snapshot, 'provider_error', err instanceof Error ? err.message : String(err));
    } catch (recordErr) {
      // Keep the original error: it is the one that explains the run. The
      // claim then goes stale and is reclaimed.
      console.error(`[backupSnapshotFileIndex] Could not record the failure of snapshot ${snapshotDbId}:`, recordErr);
    }
    throw err;
  } finally {
    await spooled.spool.remove();
  }

  // After the publish has committed, and outside the catch above: the index is
  // already complete and correct, so a failed refresh must not fail the run
  // (it never throws). It is here, not left to autovacuum, because the person
  // who waited for this index reads it straight away (#11209).
  if (outcome.status === 'complete') {
    await refreshSnapshotFileIndexStatistics(outcome.entryCount, { minRows: deps.statisticsRefreshMinRows });
  }
  return outcome;
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
  integrityStatus: string | null,
): T {
  if (row.status !== 'complete') return row;
  if (indexMatchesAttestation({ fileIndexStatus: row.status, fileIndexManifestSha256: row.manifestSha256, integrityStatus }, attestation)) {
    return row;
  }
  const refusal = attestationRefusal(attestation, row.manifestSha256, integrityStatus);
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
      integrityStatus: backupSnapshots.integrityStatus,
      attestation: indexAttestationColumns(),
    })
    .from(backupSnapshots)
    .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id))
    .where(eq(backupSnapshots.id, snapshotDbId))
    .limit(1);
  if (!raw) return null;
  const row = boundIndexState(raw, indexAttestationOf(raw.attestation), raw.integrityStatus ?? null);
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
