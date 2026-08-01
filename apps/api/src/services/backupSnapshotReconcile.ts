import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { backupConfigs, backupJobs, backupSnapshots } from '../db/schema';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import type { ParsedBackupCommandResult } from '../routes/backup/resultSchemas';
import { applyBackupCommandResultToJob } from './backupResultPersistence';
import {
  BACKUP_SNAPSHOT_MANIFEST_KEY,
  BACKUP_SNAPSHOT_ROOT_DIR,
  backupSnapshotManifestKey,
  backupSnapshotRootPrefix,
  fetchBackupObjectText,
  listBackupObjectsUnderPrefix,
} from './backupSnapshotStorage';

/**
 * Orphaned-snapshot reconciliation (#3006).
 *
 * A backup run uploads `snapshots/<id>/manifest.json` plus `files/...` to the
 * customer's destination and only then sends its terminal result. When that
 * result is lost in transit (#3001 oversized IPC payload, #2998 helper death)
 * the job row never learns the snapshot ID, so nothing links the uploaded
 * objects to a restore point: the data is complete and paid-for but
 * unreachable through the product, and — because retention only ever looks at
 * `backup_snapshots` rows — it is neither restorable nor reaped.
 *
 * This service enumerates a destination's manifest-bearing snapshot prefixes
 * and adopts the unclaimed ones into `backup_snapshots` rows, which makes them
 * restorable AND visible to both retention phases (row-level expiry and the
 * mark-and-sweep object GC).
 *
 * TENANCY. The destination is a customer-owned bucket that Breeze does not
 * partition by org — the agent writes `snapshots/<id>/...` verbatim with no
 * org or device prefix (see the KNOWN GAP note in backupSnapshotStorage.ts).
 * Enumerating it is therefore a cross-tenant read risk whenever two orgs point
 * their `backup_configs` at the same physical bucket. Three defences, in
 * order of strength:
 *
 *  1. The caller may only name a `configId` their OWN org owns (checked below
 *     against `backup_configs.org_id`), so they can never point reconcile at
 *     another tenant's destination.
 *  2. Adoption requires an existing `backup_jobs` row in the caller's org —
 *     `backup_snapshots.job_id` and `.device_id` are NOT NULL, so there is no
 *     way to manufacture a restore point without one. Claims are resolved in a
 *     SYSTEM db context precisely so a row owned by ANOTHER org is VISIBLE and
 *     can be refused; under the caller's own RLS context it would look
 *     unclaimed and get stolen.
 *  3. If the destination's storage identity is shared with any other org's
 *     config, the weaker time-window matcher is disabled entirely — only exact
 *     `backup_jobs.snapshot_id` matches (which are unambiguous) are adopted.
 */

/** Job statuses a storage snapshot may be adopted into. */
const ADOPTABLE_JOB_STATUSES = ['pending', 'running', 'failed'] as const;

/**
 * Tolerance applied to both ends of a job's [startedAt, completedAt] window
 * when matching a manifest by write time. Covers agent/server clock skew and
 * the gap between the last upload and the reaper stamping completedAt.
 */
export const RECONCILE_TIME_WINDOW_SKEW_MS = 60 * 60 * 1000;

/**
 * How many snapshots one call may adopt. Adoption re-indexes the manifest's
 * full file list into `backup_snapshot_files` (a real backup can carry >100k
 * files), so this is a synchronous-request budget, not a policy limit — call
 * again to continue.
 */
export const RECONCILE_DEFAULT_LIMIT = 5;
export const RECONCILE_MAX_LIMIT = 25;

/** `inArray` batch size — a destination can hold thousands of snapshots. */
const CLAIM_LOOKUP_CHUNK = 500;

export type BackupReconcileErrorCode =
  | 'config_not_found'
  | 'provider_unsupported'
  | 'destination_unreadable';

export class BackupReconcileError extends Error {
  constructor(
    readonly code: BackupReconcileErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BackupReconcileError';
  }
}

export type ReconcileSkipReason =
  /** A `backup_snapshots` row already exists — this snapshot is restorable. */
  | 'already-restorable'
  /** Another org's job or snapshot row owns this snapshot ID. */
  | 'claimed-by-another-organization'
  /** Unclaimed, but the bucket is shared with another org — cannot attribute. */
  | 'shared-destination-ambiguous'
  /** No job in this org/config plausibly produced it. */
  | 'no-matching-job'
  /** More than one job matches its write time — refusing to guess. */
  | 'ambiguous-job-match'
  /** The owning job is cancelled or already completed. */
  | 'job-not-adoptable'
  /** The manifest could not be fetched, parsed, or did not match. */
  | 'manifest-unreadable'
  /** Adoption was skipped because the per-call limit was reached. */
  | 'limit-reached';

export type ReconcileCandidate = {
  snapshotId: string;
  /** How the snapshot was attributed to a job, or null when it was skipped. */
  matchedBy: 'job-snapshot-id' | 'time-window' | null;
  jobId: string | null;
  deviceId: string | null;
  /** Manifest object's last-modified time — the write-time attribution key. */
  writtenAt: string | null;
  adopted: boolean;
  fileCount: number | null;
  size: number | null;
  skipReason: ReconcileSkipReason | null;
  error: string | null;
};

export type ReconcileResult = {
  configId: string;
  provider: string;
  dryRun: boolean;
  /** True when another org's config targets the same physical bucket. */
  sharedDestination: boolean;
  /** Manifest-bearing snapshot prefixes found in the destination. */
  snapshotsInStorage: number;
  adopted: number;
  /** Adoptable snapshots left over because the per-call limit was hit. */
  remaining: number;
  candidates: ReconcileCandidate[];
};

type ClaimingJob = {
  jobId: string;
  orgId: string;
  deviceId: string;
  status: string;
};

type SnapshotClaims = {
  /** snapshotId -> owning orgId, for snapshots that already have a row. */
  restorable: Map<string, string>;
  /** snapshotId -> the job that already recorded it. */
  jobs: Map<string, ClaimingJob>;
};

type AdoptableJob = {
  id: string;
  deviceId: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
};

/**
 * The agent's snapshot manifest (agent/internal/backup/snapshot.go's
 * `Snapshot`, encoded verbatim). Deliberately permissive: an unmodelled or
 * malformed field must never fail the whole parse and strand the snapshot
 * again — the same lesson as the agent result schemas (F13). `modTime` is NOT
 * validated as a datetime here; it is sanitized per-file below, because a
 * single bad OS mtime among 100k files must not cost the restore point.
 */
const reconcileManifestSchema = z
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
            backupPath: z.string().min(1),
            size: z.number().nonnegative().optional(),
            modTime: z.string().optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function toIsoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Extract the snapshot IDs that own a `snapshots/<id>/manifest.json` object,
 * mapped to that manifest's last-modified time. A prefix without a manifest is
 * an in-flight or abandoned upload, never an adoptable snapshot — the manifest
 * is written last, so its presence is the agent's own completion marker (the
 * same signal the GC mark phase keys on).
 */
function extractManifestBearingSnapshots(
  listing: { key: string; lastModified: Date | null }[]
): Map<string, Date | null> {
  const rootPrefix = `${BACKUP_SNAPSHOT_ROOT_DIR}/`;
  const manifestSuffix = `/${BACKUP_SNAPSHOT_MANIFEST_KEY}`;
  const found = new Map<string, Date | null>();

  for (const object of listing) {
    if (!object.key.startsWith(rootPrefix) || !object.key.endsWith(manifestSuffix)) {
      continue;
    }
    const snapshotId = object.key.slice(rootPrefix.length, object.key.length - manifestSuffix.length);
    // Only a DIRECT child of snapshots/ is a snapshot root; a nested
    // `manifest.json` under files/ belongs to the customer's own data.
    if (!snapshotId || snapshotId.includes('/')) {
      continue;
    }
    found.set(snapshotId, object.lastModified);
  }
  return found;
}

/**
 * Resolve, in a SYSTEM db context, who already owns each snapshot ID and
 * whether the destination is shared with another org.
 *
 * System scope is required, not convenient: under the caller's own RLS context
 * another tenant's `backup_jobs`/`backup_snapshots` row is invisible, which
 * would make an already-owned snapshot look unclaimed and let one tenant adopt
 * another's data. Only ownership facts (org ids, job ids) cross back out of
 * this block — no other tenant's `provider_config` (which holds destination
 * credentials in the clear) is returned, it is reduced to a storage-identity
 * string and discarded inside.
 */
async function loadClaimsAndSharing(params: {
  orgId: string;
  storageIdentity: string;
  snapshotIds: string[];
}): Promise<{ claims: SnapshotClaims; sharedDestination: boolean }> {
  const { orgId, storageIdentity, snapshotIds } = params;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const restorable = new Map<string, string>();
      const jobs = new Map<string, ClaimingJob>();

      for (const batch of chunk(snapshotIds, CLAIM_LOOKUP_CHUNK)) {
        const snapshotRows = await db
          .select({ snapshotId: backupSnapshots.snapshotId, orgId: backupSnapshots.orgId })
          .from(backupSnapshots)
          .where(inArray(backupSnapshots.snapshotId, batch));
        for (const row of snapshotRows) {
          restorable.set(row.snapshotId, row.orgId);
        }

        const jobRows = await db
          .select({
            id: backupJobs.id,
            orgId: backupJobs.orgId,
            deviceId: backupJobs.deviceId,
            status: backupJobs.status,
            snapshotId: backupJobs.snapshotId,
          })
          .from(backupJobs)
          .where(inArray(backupJobs.snapshotId, batch));
        for (const row of jobRows) {
          if (!row.snapshotId) continue;
          jobs.set(row.snapshotId, {
            jobId: row.id,
            orgId: row.orgId,
            deviceId: row.deviceId,
            status: row.status,
          });
        }
      }

      const otherConfigs = await db
        .select({
          orgId: backupConfigs.orgId,
          provider: backupConfigs.provider,
          providerConfig: backupConfigs.providerConfig,
        })
        .from(backupConfigs);

      const sharedDestination = otherConfigs.some(
        (row) =>
          row.orgId !== orgId &&
          normalizeStorageIdentity(row.provider, asRecord(row.providerConfig)) === storageIdentity
      );

      return { claims: { restorable, jobs }, sharedDestination };
    })
  );
}

/**
 * Jobs in the caller's org and config that could own an unattributed snapshot:
 * no snapshot ID recorded, not terminal-in-a-way-that-forbids-adoption, and no
 * restore point of their own yet.
 */
async function loadUnattributedJobs(params: {
  orgId: string;
  configId: string;
  allowedDeviceIds: string[] | null;
}): Promise<AdoptableJob[]> {
  const conditions = [
    eq(backupJobs.orgId, params.orgId),
    eq(backupJobs.configId, params.configId),
    isNull(backupJobs.snapshotId),
    inArray(backupJobs.status, [...ADOPTABLE_JOB_STATUSES]),
  ];
  if (params.allowedDeviceIds) {
    if (params.allowedDeviceIds.length === 0) {
      return [];
    }
    conditions.push(inArray(backupJobs.deviceId, params.allowedDeviceIds));
  }

  const rows = await db
    .select({
      id: backupJobs.id,
      deviceId: backupJobs.deviceId,
      startedAt: backupJobs.startedAt,
      completedAt: backupJobs.completedAt,
      createdAt: backupJobs.createdAt,
    })
    .from(backupJobs)
    .where(and(...conditions));

  if (rows.length === 0) {
    return [];
  }

  // A job that already owns a restore point cannot adopt another snapshot.
  const claimedJobIds = new Set<string>();
  for (const batch of chunk(
    rows.map((row) => row.id),
    CLAIM_LOOKUP_CHUNK
  )) {
    const claimed = await db
      .select({ jobId: backupSnapshots.jobId })
      .from(backupSnapshots)
      .where(inArray(backupSnapshots.jobId, batch));
    for (const row of claimed) {
      claimedJobIds.add(row.jobId);
    }
  }

  return rows.filter((row) => !claimedJobIds.has(row.id));
}

/**
 * True when `writtenAt` falls inside the job's run window (both ends widened
 * by RECONCILE_TIME_WINDOW_SKEW_MS). The manifest is uploaded LAST, so its
 * write time lands between the job starting and the job being marked terminal.
 */
function jobCoversWriteTime(job: AdoptableJob, writtenAt: Date, now: Date): boolean {
  const start = job.startedAt ?? job.createdAt;
  if (!start) {
    return false;
  }
  const end = job.completedAt ?? now;
  return (
    writtenAt.getTime() >= start.getTime() - RECONCILE_TIME_WINDOW_SKEW_MS &&
    writtenAt.getTime() <= end.getTime() + RECONCILE_TIME_WINDOW_SKEW_MS
  );
}

/**
 * Turn a stored manifest into the same `ParsedBackupCommandResult` shape the
 * agent would have sent, so adoption runs through the ONE code path that
 * creates restore points (`applyBackupCommandResultToJob`) and inherits its
 * file indexing, legal-hold/immutability application and GFS/expiry
 * computation — the last of which is what finally makes the snapshot visible
 * to retention.
 */
function manifestToCommandResult(params: {
  snapshotId: string;
  manifestText: string;
  matchedBy: 'job-snapshot-id' | 'time-window';
}): ParsedBackupCommandResult {
  const parsed = reconcileManifestSchema.parse(JSON.parse(params.manifestText));

  if (parsed.id !== params.snapshotId) {
    throw new Error(
      `manifest declares snapshot ${parsed.id} but is stored under ${params.snapshotId}`
    );
  }

  const files = (parsed.files ?? []).map((file) => {
    // Drop an unparseable mtime rather than letting `new Date(...)` reach
    // Postgres as an Invalid Date and abort the whole adoption.
    const modTime =
      file.modTime && Number.isFinite(Date.parse(file.modTime)) ? file.modTime : undefined;
    return {
      sourcePath: file.sourcePath,
      backupPath: file.backupPath,
      size: file.size !== undefined ? Math.trunc(file.size) : undefined,
      modTime,
    };
  });

  const declaredSize = parsed.size !== undefined ? Math.trunc(parsed.size) : undefined;
  const summedSize = files.reduce((total, file) => total + (file.size ?? 0), 0);
  const size = declaredSize ?? summedSize;

  const timestamp =
    parsed.timestamp && Number.isFinite(Date.parse(parsed.timestamp)) ? parsed.timestamp : undefined;

  return {
    snapshotId: params.snapshotId,
    filesBackedUp: files.length,
    bytesBackedUp: size,
    snapshot: { id: params.snapshotId, timestamp, size, files },
    metadata: {
      // Consumed by backupResultPersistence to set backup_snapshots.location.
      storagePrefix: `${BACKUP_SNAPSHOT_ROOT_DIR}/${params.snapshotId}`,
      reconciledFromStorage: true,
      reconciledAt: new Date().toISOString(),
      reconcileMatchedBy: params.matchedBy,
    },
  };
}

/**
 * Adopt every unclaimed, attributable snapshot in one destination into a
 * restore point. See the tenancy note at the top of this file before changing
 * anything about how candidates are attributed.
 */
export async function reconcileOrphanedBackupSnapshots(params: {
  orgId: string;
  configId: string;
  dryRun?: boolean;
  limit?: number;
  /**
   * Site-scoped callers (`permissions.allowedSiteIds`) may only adopt
   * snapshots belonging to devices they can see. Site scope is an
   * app-layer-only authz axis — RLS does not defend it — so it has to be
   * applied here explicitly. `null` means unrestricted.
   */
  allowedDeviceIds?: string[] | null;
}): Promise<ReconcileResult> {
  const dryRun = params.dryRun ?? false;
  const limit = Math.min(params.limit ?? RECONCILE_DEFAULT_LIMIT, RECONCILE_MAX_LIMIT);
  const allowedDeviceIds = params.allowedDeviceIds ?? null;

  // Defence 1: the destination must belong to the CALLER's org. Nothing below
  // can reach a bucket the caller does not already own a config for.
  const [config] = await db
    .select({
      id: backupConfigs.id,
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
    })
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, params.configId), eq(backupConfigs.orgId, params.orgId)))
    .limit(1);

  if (!config) {
    throw new BackupReconcileError('config_not_found', 'Backup destination not found');
  }
  if (config.provider !== 's3' && config.provider !== 'local') {
    throw new BackupReconcileError(
      'provider_unsupported',
      `Provider ${config.provider} does not support snapshot enumeration`
    );
  }

  let listing;
  try {
    listing = await listBackupObjectsUnderPrefix({
      provider: config.provider,
      providerConfig: config.providerConfig,
      prefix: backupSnapshotRootPrefix(),
    });
  } catch (error) {
    throw new BackupReconcileError(
      'destination_unreadable',
      `Could not list the backup destination: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const storageSnapshots = extractManifestBearingSnapshots(listing);
  const snapshotIds = [...storageSnapshots.keys()];

  const storageIdentity = normalizeStorageIdentity(config.provider, asRecord(config.providerConfig));
  const { claims, sharedDestination } = await loadClaimsAndSharing({
    orgId: params.orgId,
    storageIdentity,
    snapshotIds,
  });

  // Process oldest-written first so the time-window matcher consumes jobs
  // deterministically and a rerun produces the same attribution.
  const ordered = snapshotIds.slice().sort((a, b) => {
    const aTime = storageSnapshots.get(a)?.getTime() ?? 0;
    const bTime = storageSnapshots.get(b)?.getTime() ?? 0;
    return aTime === bTime ? a.localeCompare(b) : aTime - bTime;
  });

  const now = new Date();
  const candidates: ReconcileCandidate[] = [];
  const adoptable: {
    snapshotId: string;
    jobId: string;
    deviceId: string;
    matchedBy: 'job-snapshot-id' | 'time-window';
    writtenAt: Date | null;
  }[] = [];

  let unattributedJobs: AdoptableJob[] | null = null;
  const consumedJobIds = new Set<string>();

  for (const snapshotId of ordered) {
    const writtenAt = storageSnapshots.get(snapshotId) ?? null;
    const skip = (skipReason: ReconcileSkipReason) => {
      candidates.push({
        snapshotId,
        matchedBy: null,
        jobId: null,
        deviceId: null,
        writtenAt: toIsoOrNull(writtenAt),
        adopted: false,
        fileCount: null,
        size: null,
        skipReason,
        error: null,
      });
    };

    const restorableOwner = claims.restorable.get(snapshotId);
    if (restorableOwner) {
      skip(restorableOwner === params.orgId ? 'already-restorable' : 'claimed-by-another-organization');
      continue;
    }

    // Exact match: the job already recorded this snapshot ID (mid-run, via
    // backup_progress — the #3006 structural fix) but never got a terminal
    // result, so it has no restore point. Unambiguous and safe even on a
    // shared bucket.
    const claimingJob = claims.jobs.get(snapshotId);
    if (claimingJob) {
      if (claimingJob.orgId !== params.orgId) {
        skip('claimed-by-another-organization');
        continue;
      }
      if (!ADOPTABLE_JOB_STATUSES.includes(claimingJob.status as (typeof ADOPTABLE_JOB_STATUSES)[number])) {
        skip('job-not-adoptable');
        continue;
      }
      if (allowedDeviceIds && !allowedDeviceIds.includes(claimingJob.deviceId)) {
        skip('no-matching-job');
        continue;
      }
      adoptable.push({
        snapshotId,
        jobId: claimingJob.jobId,
        deviceId: claimingJob.deviceId,
        matchedBy: 'job-snapshot-id',
        writtenAt,
      });
      continue;
    }

    // Defence 3: with no recorded snapshot ID anywhere, attribution rests on
    // write time alone. That is only sound while this bucket belongs to one
    // org — otherwise the "orphan" may be another tenant's snapshot whose job
    // row we are simply not allowed to correlate.
    if (sharedDestination) {
      skip('shared-destination-ambiguous');
      continue;
    }
    if (!writtenAt) {
      skip('no-matching-job');
      continue;
    }

    if (unattributedJobs === null) {
      unattributedJobs = await loadUnattributedJobs({
        orgId: params.orgId,
        configId: params.configId,
        allowedDeviceIds,
      });
    }

    const matches = unattributedJobs.filter(
      (job) => !consumedJobIds.has(job.id) && jobCoversWriteTime(job, writtenAt, now)
    );
    if (matches.length === 0) {
      skip('no-matching-job');
      continue;
    }
    if (matches.length > 1) {
      // Two runs of the same config could both have been in flight. Guessing
      // would attach the data to the wrong device; refuse and let an operator
      // decide.
      skip('ambiguous-job-match');
      continue;
    }

    const job = matches[0]!;
    consumedJobIds.add(job.id);
    adoptable.push({
      snapshotId,
      jobId: job.id,
      deviceId: job.deviceId,
      matchedBy: 'time-window',
      writtenAt,
    });
  }

  let adopted = 0;
  let remaining = 0;

  for (const entry of adoptable) {
    if (adopted >= limit) {
      remaining += 1;
      candidates.push({
        snapshotId: entry.snapshotId,
        matchedBy: entry.matchedBy,
        jobId: entry.jobId,
        deviceId: entry.deviceId,
        writtenAt: toIsoOrNull(entry.writtenAt),
        adopted: false,
        fileCount: null,
        size: null,
        skipReason: 'limit-reached',
        error: null,
      });
      continue;
    }

    const candidate: ReconcileCandidate = {
      snapshotId: entry.snapshotId,
      matchedBy: entry.matchedBy,
      jobId: entry.jobId,
      deviceId: entry.deviceId,
      writtenAt: toIsoOrNull(entry.writtenAt),
      adopted: false,
      fileCount: null,
      size: null,
      skipReason: null,
      error: null,
    };

    try {
      const manifestText = await fetchBackupObjectText({
        provider: config.provider,
        providerConfig: config.providerConfig,
        key: backupSnapshotManifestKey(entry.snapshotId),
      });
      const result = manifestToCommandResult({
        snapshotId: entry.snapshotId,
        manifestText,
        matchedBy: entry.matchedBy,
      });
      candidate.fileCount = result.filesBackedUp ?? null;
      candidate.size = result.bytesBackedUp ?? null;

      if (!dryRun) {
        const applied = await applyBackupCommandResultToJob({
          jobId: entry.jobId,
          orgId: params.orgId,
          deviceId: entry.deviceId,
          resultStatus: 'completed',
          result,
          source: 'reconcile',
        });
        if (!applied.applied) {
          // The job changed status underneath us (cancelled, or a real result
          // landed first). Report it rather than claiming an adoption.
          candidate.skipReason = 'job-not-adoptable';
        } else {
          candidate.adopted = true;
          adopted += 1;
        }
      }
    } catch (error) {
      candidate.skipReason = 'manifest-unreadable';
      candidate.error = error instanceof Error ? error.message : String(error);
    }

    candidates.push(candidate);
  }

  return {
    configId: params.configId,
    provider: config.provider,
    dryRun,
    sharedDestination,
    snapshotsInStorage: snapshotIds.length,
    adopted,
    remaining,
    candidates,
  };
}
