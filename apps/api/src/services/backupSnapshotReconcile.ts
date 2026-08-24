import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { backupConfigs, backupJobs, backupSnapshots } from '../db/schema';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import type { ParsedBackupCommandResult } from '../routes/backup/resultSchemas';
import { applyBackupCommandResultToJob } from './backupResultPersistence';
import { captureException, captureMessage } from './sentry';
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
 * their `backup_configs` at the same physical bucket. Four defences, in
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
 *     unclaimed and get stolen. ANY foreign claim refuses the snapshot, even
 *     when one of our own jobs claims it too (see `foreignClaimed`).
 *  3. The claiming job must target THIS destination, so a restore point is
 *     never stamped with a config whose bucket does not hold the objects.
 *  4. If the destination's storage identity is shared with any other org's
 *     config, the weaker time-window matcher is disabled entirely — only exact
 *     `backup_jobs.snapshot_id` matches (which are unambiguous) are adopted.
 *     Sharing is tested on both `normalizeStorageIdentity` AND a cruder
 *     provider+bucket key, because the former only canonicalises the default
 *     AWS endpoint (see `coarseStorageIdentity`).
 */

/**
 * Job statuses a storage snapshot may be adopted into via an EXACT
 * `backup_jobs.snapshot_id` match.
 *
 * `completed` is included for one narrow, self-healing reason: adoption is not
 * atomic (`applyBackupCommandResultToJob` commits the job UPDATE before
 * inserting `backup_snapshots`), so a crash in between leaves a `completed`
 * job carrying a snapshot id with NO restore point — the #3006 failure mode
 * recurring inside its own fix, and unreachable forever if reconcile refused
 * to look at it again. A `completed` job is only ever treated as adoptable
 * when the snapshot has no `backup_snapshots` row at all (see the candidate
 * loop), which is precisely that half-written state; the write itself is an
 * upsert keyed on (jobId, snapshotId), so re-running is idempotent.
 *
 * `cancelled` and `partial` are deliberately absent: a user cancel is a
 * decision to respect, and a `partial` job already recorded its own outcome.
 */
const ADOPTABLE_JOB_STATUSES = ['pending', 'running', 'failed', 'completed'] as const;

/**
 * Job statuses eligible for the WEAKER time-window matcher.
 *
 * Narrower than the exact-match set on purpose. `pending` is excluded because
 * a pending job was never dispatched to an agent (backupWorker sets
 * `running` + `started_at` at dispatch), so it cannot have written a snapshot
 * — and with both `started_at` and `completed_at` NULL its window would
 * degenerate to "everything ever written to this destination". `completed` is
 * excluded because without an exact id there is nothing to prove the
 * half-written state, so adopting would be a guess.
 */
const TIME_WINDOW_JOB_STATUSES = ['running', 'failed'] as const;

/**
 * Tolerance applied to both ends of a job's [startedAt, completedAt] window
 * when matching a manifest by write time. Covers agent/server clock skew and
 * the gap between the last upload and the reaper stamping completedAt.
 */
export const RECONCILE_TIME_WINDOW_SKEW_MS = 60 * 60 * 1000;

/**
 * Ceiling on an open-ended run window. A job still `running` has no
 * `completed_at`, and treating "now" as the end would let a job that hung
 * three weeks ago claim a snapshot written yesterday. The stale reaper kills
 * silent jobs long before this, so anything older is not a live run.
 */
export const RECONCILE_MAX_OPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** The owning job is cancelled/partial, or went terminal underneath us. */
  | 'job-not-adoptable'
  /** The owning job belongs to a different destination than the one scanned. */
  | 'job-on-another-config'
  /** The manifest could not be fetched, parsed, or did not match. */
  | 'manifest-unreadable'
  /** The manifest read fine but the restore-point write failed. */
  | 'adoption-failed'
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
  /**
   * Snapshots this call did NOT adopt for a reason other than the limit.
   * Reported separately from `remaining` so "reconcile ran and recovered
   * nothing from 50 stranded snapshots" is a visible fact rather than
   * something an operator has to infer from an empty `adopted` count.
   */
  skipped: number;
  skippedByReason: Partial<Record<ReconcileSkipReason, number>>;
  candidates: ReconcileCandidate[];
};

type ClaimingJob = {
  jobId: string;
  orgId: string;
  deviceId: string;
  configId: string | null;
  status: string;
  createdAt: Date | null;
};

type SnapshotClaims = {
  /** snapshotId -> owning orgId, for snapshots that already have a row. */
  restorable: Map<string, string>;
  /** snapshotId -> the job that already recorded it. */
  jobs: Map<string, ClaimingJob>;
  /**
   * Snapshot ids claimed by a job in SOME OTHER org — tracked separately from
   * `jobs`, which keeps only one winner per id. Without this, two jobs in
   * different orgs sharing an id would let the dedupe silently discard the
   * foreign claim and hand the snapshot to whichever org's job sorted first.
   * Any foreign claim refuses the snapshot outright.
   */
  foreignClaimed: Set<string>;
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

function getStringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * A deliberately CRUDER destination key than `normalizeStorageIdentity`:
 * provider + bucket, ignoring the endpoint entirely.
 *
 * `normalizeStorageIdentity` only canonicalises the default AWS endpoint, so
 * two orgs pointed at the same Wasabi/MinIO/B2 bucket through different but
 * equivalent hostnames (`s3.wasabisys.com` vs `s3.us-east-2.wasabisys.com`,
 * `host:9000` vs `host`) produce two different identities. For GC that only
 * costs efficiency, and backupRetention.ts already carries a fail-closed
 * backstop for it. Here it would be a tenancy hole: a false "not shared"
 * re-enables the time-window matcher on a bucket another tenant is writing to.
 *
 * So sharing is asserted if EITHER key matches. A false "shared" merely
 * disables the weaker matcher (exact id matches still work); a false "not
 * shared" is a cross-tenant adoption. The asymmetry decides the design.
 */
function coarseStorageIdentity(provider: string, providerConfig: Record<string, unknown>): string {
  if (provider === 'local') {
    // Local paths have no endpoint ambiguity — normalizeStorageIdentity's
    // path.resolve is already the canonical form.
    return normalizeStorageIdentity(provider, providerConfig);
  }
  const bucket = (
    getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName')
  )
    .trim()
    .toLowerCase();
  return `${provider}::${bucket}`;
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
  configId: string;
  storageIdentity: string;
  coarseIdentity: string;
  snapshotIds: string[];
}): Promise<{ claims: SnapshotClaims; sharedDestination: boolean }> {
  const { orgId, configId, storageIdentity, coarseIdentity, snapshotIds } = params;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const restorable = new Map<string, string>();
      const jobs = new Map<string, ClaimingJob>();
      const foreignClaimed = new Set<string>();

      // Rank for the dedupe below: a claim on THIS destination beats one on a
      // sibling config (a customer who deleted and recreated a config against
      // the same bucket can produce both, since a journal resume keys on
      // provider identity, not configId), and newer beats older.
      const rank = (claim: ClaimingJob): [number, number, string] => [
        claim.configId === configId ? 1 : 0,
        claim.createdAt?.getTime() ?? 0,
        claim.jobId,
      ];
      const outranks = (a: ClaimingJob, b: ClaimingJob): boolean => {
        const [ac, at, aj] = rank(a);
        const [bc, bt, bj] = rank(b);
        if (ac !== bc) return ac > bc;
        if (at !== bt) return at > bt;
        return aj > bj;
      };

      for (const batch of chunk(snapshotIds, CLAIM_LOOKUP_CHUNK)) {
        const snapshotRows = await db
          .select({ snapshotId: backupSnapshots.snapshotId, orgId: backupSnapshots.orgId })
          .from(backupSnapshots)
          .where(inArray(backupSnapshots.snapshotId, batch));
        for (const row of snapshotRows) {
          restorable.set(row.snapshotId, row.orgId);
        }

        // NOT filtered by config or org: seeing ANOTHER tenant's claim is the
        // entire point (a filtered query would make their snapshot look
        // unclaimed and adoptable). Config/org are checked per-candidate below.
        const jobRows = await db
          .select({
            id: backupJobs.id,
            orgId: backupJobs.orgId,
            deviceId: backupJobs.deviceId,
            configId: backupJobs.configId,
            status: backupJobs.status,
            createdAt: backupJobs.createdAt,
            snapshotId: backupJobs.snapshotId,
          })
          .from(backupJobs)
          .where(inArray(backupJobs.snapshotId, batch));
        for (const row of jobRows) {
          if (!row.snapshotId) continue;
          const claim: ClaimingJob = {
            jobId: row.id,
            orgId: row.orgId,
            deviceId: row.deviceId,
            configId: row.configId ?? null,
            status: row.status,
            createdAt: row.createdAt ?? null,
          };
          if (claim.orgId !== orgId) {
            foreignClaimed.add(row.snapshotId);
          }
          // Duplicates are now normal: a journal resume reuses the SAME
          // snapshot id under a NEW backup_jobs row, and mid-run registration
          // records it on both. Rank deterministically rather than letting
          // scan order decide which run owns the objects.
          const existing = jobs.get(row.snapshotId);
          if (!existing || outranks(claim, existing)) {
            jobs.set(row.snapshotId, claim);
          }
        }
      }

      const otherConfigs = await db
        .select({
          orgId: backupConfigs.orgId,
          provider: backupConfigs.provider,
          providerConfig: backupConfigs.providerConfig,
        })
        .from(backupConfigs);

      const sharedDestination = otherConfigs.some((row) => {
        if (row.orgId === orgId) return false;
        const rowConfig = asRecord(row.providerConfig);
        return (
          normalizeStorageIdentity(row.provider, rowConfig) === storageIdentity ||
          coarseStorageIdentity(row.provider, rowConfig) === coarseIdentity
        );
      });

      return { claims: { restorable, jobs, foreignClaimed }, sharedDestination };
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
    inArray(backupJobs.status, [...TIME_WINDOW_JOB_STATUSES]),
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
  // An open-ended (still `running`) window is capped so an old hung job cannot
  // claim a recent snapshot — see RECONCILE_MAX_OPEN_WINDOW_MS.
  const end = job.completedAt ?? new Date(Math.min(now.getTime(), start.getTime() + RECONCILE_MAX_OPEN_WINDOW_MS));
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
  /**
   * Runs one DB phase inside a caller-supplied access context. The route
   * registers `/backup/reconcile` in SELF_MANAGED_DB_CONTEXT_ROUTES (#1448),
   * so there is NO ambient request transaction — pinning one across a
   * full-bucket S3 listing plus multi-MB manifest fetches would be the #1105
   * pool-poison class on a tenant-controlled endpoint host. Each DB phase
   * therefore opens its own short context, with the listing and manifest
   * fetches between them. (One pre-existing exception: provider-enforced
   * object lock is applied inside applyBackupCommandResultToJob, i.e. inside
   * the adoption write context — see the note in
   * middleware/selfManagedDbContextRoutes.ts.) Defaults to a pass-through for
   * callers that already hold a context.
   */
  runInDbContext?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<ReconcileResult> {
  const dryRun = params.dryRun ?? false;
  const limit = Math.min(params.limit ?? RECONCILE_DEFAULT_LIMIT, RECONCILE_MAX_LIMIT);
  const allowedDeviceIds = params.allowedDeviceIds ?? null;
  const allowedDeviceIdSet = allowedDeviceIds ? new Set(allowedDeviceIds) : null;
  const runInDbContext = params.runInDbContext ?? (<T>(fn: () => Promise<T>) => fn());

  // Defence 1: the destination must belong to the CALLER's org. Nothing below
  // can reach a bucket the caller does not already own a config for.
  const [config] = await runInDbContext(() =>
    db
      .select({
        id: backupConfigs.id,
        provider: backupConfigs.provider,
        providerConfig: backupConfigs.providerConfig,
      })
      .from(backupConfigs)
      .where(and(eq(backupConfigs.id, params.configId), eq(backupConfigs.orgId, params.orgId)))
      .limit(1)
  );

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
    // A bad credential, a deleted bucket, or a provider 5xx is an upstream
    // failure, not a malformed request — and it is invisible unless it is
    // logged here: nothing else in this path records it, and there is no UI
    // reading the response body.
    const message = `Could not list the backup destination: ${error instanceof Error ? error.message : String(error)}`;
    console.error(
      `[BackupReconcile] Destination listing failed for config ${params.configId} (org ${params.orgId}): ${message}`
    );
    captureException(error instanceof Error ? error : new Error(message));
    throw new BackupReconcileError('destination_unreadable', message);
  }

  const storageSnapshots = extractManifestBearingSnapshots(listing);
  const snapshotIds = [...storageSnapshots.keys()];

  const providerConfigRecord = asRecord(config.providerConfig);
  const storageIdentity = normalizeStorageIdentity(config.provider, providerConfigRecord);
  const coarseIdentity = coarseStorageIdentity(config.provider, providerConfigRecord);
  const { claims, sharedDestination } = await loadClaimsAndSharing({
    orgId: params.orgId,
    configId: params.configId,
    storageIdentity,
    coarseIdentity,
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
    // Checked BEFORE the winner: any foreign claim refuses the snapshot, even
    // when a same-org job also carries the id. Consulting only the deduped
    // winner would let a same-org job mask another tenant's claim.
    if (claims.foreignClaimed.has(snapshotId)) {
      skip('claimed-by-another-organization');
      continue;
    }

    const claimingJob = claims.jobs.get(snapshotId);
    if (claimingJob) {
      if (claimingJob.orgId !== params.orgId) {
        skip('claimed-by-another-organization');
        continue;
      }
      // The claim lookup is destination-blind by necessity (it must see other
      // tenants), so the config check lands here. Adopting a job that targets a
      // DIFFERENT destination would stamp the restore point with a config whose
      // bucket does not hold the objects — and object GC, which groups by
      // storage identity, would then not see them as live.
      if (claimingJob.configId !== params.configId) {
        skip('job-on-another-config');
        continue;
      }
      // `completed` is in ADOPTABLE_JOB_STATUSES only for the half-written
      // case, and reaching here PROVES it: `claims.restorable` had no row for
      // this snapshot, so a completed job carrying its id is a job whose
      // restore-point insert never landed.
      if (!ADOPTABLE_JOB_STATUSES.includes(claimingJob.status as (typeof ADOPTABLE_JOB_STATUSES)[number])) {
        skip('job-not-adoptable');
        continue;
      }
      if (allowedDeviceIdSet && !allowedDeviceIdSet.has(claimingJob.deviceId)) {
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
      unattributedJobs = await runInDbContext(() =>
        loadUnattributedJobs({
          orgId: params.orgId,
          configId: params.configId,
          allowedDeviceIds,
        })
      );
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

    // Phase 1 — READ. Only storage/parse failures may be reported as
    // 'manifest-unreadable'. Keeping the write out of this try is the whole
    // point: a DB failure mislabelled as a storage problem sends the operator
    // to look at a bucket that is perfectly fine.
    let result: ParsedBackupCommandResult;
    try {
      const manifestText = await fetchBackupObjectText({
        provider: config.provider,
        providerConfig: config.providerConfig,
        key: backupSnapshotManifestKey(entry.snapshotId),
      });
      result = manifestToCommandResult({
        snapshotId: entry.snapshotId,
        manifestText,
        matchedBy: entry.matchedBy,
      });
    } catch (error) {
      candidate.skipReason = 'manifest-unreadable';
      candidate.error = error instanceof Error ? error.message : String(error);
      candidates.push(candidate);
      continue;
    }

    candidate.fileCount = result.filesBackedUp ?? null;
    candidate.size = result.bytesBackedUp ?? null;

    if (dryRun) {
      candidates.push(candidate);
      continue;
    }

    // Phase 2 — WRITE.
    try {
      const applied = await runInDbContext(() =>
        applyBackupCommandResultToJob({
          jobId: entry.jobId,
          orgId: params.orgId,
          deviceId: entry.deviceId,
          resultStatus: 'completed',
          result,
          source: 'reconcile',
        })
      );
      if (!applied.applied) {
        // The job changed status underneath us (cancelled, or a real result
        // landed first). Report it rather than claiming an adoption.
        candidate.skipReason = 'job-not-adoptable';
        candidate.error = 'job was no longer adoptable';
      } else if (!applied.snapshotDbId) {
        // Job flipped but no restore-point row came back — the snapshot is
        // still not restorable, so this is NOT an adoption.
        candidate.skipReason = 'adoption-failed';
        candidate.error = 'job was updated but no restore point row was written';
      } else {
        candidate.adopted = true;
        adopted += 1;
      }
    } catch (error) {
      // applyBackupCommandResultToJob commits the job UPDATE before inserting
      // backup_snapshots, so a throw in between can leave the job terminal
      // with no restore point. That is #3006 recurring inside its own fix and
      // must reach Sentry, not a field in a response body nobody reads. (The
      // next reconcile run CAN recover it — a `completed` job whose snapshot
      // has no row is treated as adoptable — but the failure still needs to be
      // seen.)
      candidate.skipReason = 'adoption-failed';
      candidate.error = error instanceof Error ? error.message : String(error);
      const message =
        `[BackupReconcile] Adoption write failed for snapshot ${entry.snapshotId} ` +
        `(job ${entry.jobId}, device ${entry.deviceId}, org ${params.orgId}). The job row may now be ` +
        `terminal with no backup_snapshots row.`;
      console.error(message, error);
      captureException(error instanceof Error ? error : new Error(message));
    }

    candidates.push(candidate);
  }

  const skippedByReason: Partial<Record<ReconcileSkipReason, number>> = {};
  let skipped = 0;
  for (const candidate of candidates) {
    if (candidate.adopted || !candidate.skipReason || candidate.skipReason === 'limit-reached') {
      continue;
    }
    skipped += 1;
    skippedByReason[candidate.skipReason] = (skippedByReason[candidate.skipReason] ?? 0) + 1;
  }

  // The one skip reason no rerun will ever clear on its own: customer data this
  // feature has deliberately decided it cannot attribute. Surface it rather
  // than leaving it in a response body.
  const ambiguousCount = skippedByReason['shared-destination-ambiguous'] ?? 0;
  if (ambiguousCount > 0) {
    const message =
      `[BackupReconcile] ${ambiguousCount} snapshot(s) in the destination for config ${params.configId} ` +
      `(org ${params.orgId}) cannot be attributed: another organization's backup config targets the same ` +
      `bucket, so time-window matching is disabled. These snapshots stay stranded until their jobs carry a ` +
      `snapshot id.`;
    console.warn(message);
    captureMessage(message, { eventCode: 'backup_snapshot_ambiguous_destination' });
  }

  return {
    configId: params.configId,
    provider: config.provider,
    dryRun,
    sharedDestination,
    snapshotsInStorage: snapshotIds.length,
    adopted,
    remaining,
    skipped,
    skippedByReason,
    candidates,
  };
}
