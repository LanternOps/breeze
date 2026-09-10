/**
 * Backup Retention — GFS tagging and legal-hold-aware cleanup
 *
 * GFS (Grandfather-Father-Son) retention tags every completed backup snapshot
 * with daily/weekly/monthly/yearly labels. Retention cleanup respects legal
 * holds and immutability windows.
 */

import { resolve as resolveLocalPath } from 'node:path';
import { db, withSystemDbAccessContext, assertOutsideHeldDbContext } from '../db';
import {
  backupSnapshots,
  backupPolicies,
  backupJobs,
  configPolicyBackupSettings,
  backupConfigs,
  restoreJobs,
  backupSnapshotRetirements,
  IN_FLIGHT_BACKUP_JOB_STATUSES,
  devices,
} from '../db/schema';
import { recoveryTokens } from '../db/schema/recoveryTokens';
import { eq, and, or, lt, gt, gte, desc, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import {
  resolveMsKnob,
  resolveBackupRestorePinLingerMs,
  resolveBackupPublishMarginMs,
  resolveBackupBaseLeaseMs,
  resolveBackupOrphanManifestMaxAgeMs,
} from '../services/backupGcKnobs';
import { backupHelperSupportsServerBase } from '../services/backupHelperCapabilities';
import {
  BACKUP_SNAPSHOT_ROOT_DIR,
  BACKUP_SNAPSHOT_MANIFEST_KEY,
  backupLayoutManifestKey,
  backupSnapshotManifestKey,
  backupSnapshotRootPrefix,
  backupSystemStateArtifactKey,
  backupSystemStateManifestKey,
  deleteBackupObjectKeys,
  fetchBackupObjectText,
  isBackupObjectNotFound,
  listBackupObjectsUnderPrefix,
  type BackupObjectListing,
} from '../services/backupSnapshotStorage';
import { asRecord, getStringValue } from '../services/recoveryBootstrap';
import { captureException } from '../services/sentry';
import { pgErrorCode, pgErrorConstraint } from '../utils/pgErrors';
import { createHash } from 'node:crypto';
import { getRedis, isRedisAvailable } from '../services/redis';

// ── GFS tag types ────────────────────────────────────────────────────────────

export type GfsTags = {
  daily: boolean;
  weekly?: boolean;
  monthly?: boolean;
  yearly?: boolean;
};

export type GfsConfig = {
  daily?: number;
  weekly?: number;
  monthly?: number;
  yearly?: number;
  weeklyDay?: number;
  retentionDays?: number;
  maxVersions?: number;
};

// ── GFS tag computation ──────────────────────────────────────────────────────

export function computeGfsTags(
  completedAt: Date,
  gfsConfig: GfsConfig | null | undefined
): GfsTags {
  const tags: GfsTags = { daily: true }; // every backup is daily

  if (!gfsConfig) return tags;

  const dayOfWeek = completedAt.getUTCDay(); // 0=Sunday
  const dayOfMonth = completedAt.getUTCDate();
  const month = completedAt.getUTCMonth();

  // Weekly: backup on the configured day (default Sunday=0)
  const gfsWeeklyDay = gfsConfig.weeklyDay ?? 0;
  if (dayOfWeek === gfsWeeklyDay) {
    tags.weekly = true;
  }

  // Monthly: last day of month (next day rolls into a new month)
  const nextDay = new Date(completedAt);
  nextDay.setUTCDate(dayOfMonth + 1);
  if (nextDay.getUTCMonth() !== month) {
    tags.monthly = true;
  }

  // Yearly: last day of December
  if (month === 11 && tags.monthly) {
    tags.yearly = true;
  }

  return tags;
}

// ── Resolve GFS config from job's policy ─────────────────────────────────────

export async function resolveGfsConfigForJob(
  jobId: string
): Promise<GfsConfig | null> {
  const [job] = await db
    .select({
      featureLinkId: backupJobs.featureLinkId,
      policyId: backupJobs.policyId,
    })
    .from(backupJobs)
    .where(eq(backupJobs.id, jobId))
    .limit(1);

  if (!job) return null;

  // New path: config policy backup settings
  if (job.featureLinkId) {
    const [settings] = await db
      .select({ retention: configPolicyBackupSettings.retention })
      .from(configPolicyBackupSettings)
      .where(eq(configPolicyBackupSettings.featureLinkId, job.featureLinkId))
      .limit(1);

    if (settings?.retention) {
      const r = settings.retention as Record<string, number>;
      return {
        daily: r.keepDaily,
        weekly: r.keepWeekly,
        monthly: r.keepMonthly,
        yearly: r.keepYearly,
        weeklyDay: r.weeklyDay,
        retentionDays: r.retentionDays,
        maxVersions: r.maxVersions,
      };
    }
  }

  // Legacy fallback: deprecated backupPolicies
  if (job.policyId) {
    const [policy] = await db
      .select({ gfsConfig: backupPolicies.gfsConfig })
      .from(backupPolicies)
      .where(eq(backupPolicies.id, job.policyId))
      .limit(1);

    return (policy?.gfsConfig as GfsConfig) ?? null;
  }

  return null;
}

// ── Apply GFS tags to a snapshot ─────────────────────────────────────────────

export async function applyGfsTagsToSnapshot(
  snapshotDbId: string,
  completedAt: Date,
  jobId: string
): Promise<GfsTags> {
  const gfsConfig = await resolveGfsConfigForJob(jobId);
  const tags = computeGfsTags(completedAt, gfsConfig);

  await db
    .update(backupSnapshots)
    .set({ gfsTags: tags })
    .where(eq(backupSnapshots.id, snapshotDbId));

  return tags;
}

// ── Retention cleanup (legal hold + immutability aware) ──────────────────────

export type RetentionCleanupResult = {
  deleted: number;
  skippedLegalHold: number;
  skippedImmutable: number;
  // D18 W01 (#5429/section 3.2): a row pinned by an in-flight/leased backup
  // base, an in-flight/lingering restore, or an active/lingering recovery
  // token.
  skippedPinned: number;
  // D18 W01 review fix: a row whose storage_identity is unresolved (NULL) is
  // never retired with an invented identity -- it is retried on a later run
  // once identity resolves (a live write stamping it, or W02's sweep
  // self-heal). Counted separately from skippedPinned so operators can see
  // "how many rows are stuck on identity resolution" distinctly.
  skippedUnresolved: number;
  prunedByMaxVersions: number;
  // D17: a row whose DELETE was rejected by the DB (most commonly a
  // NO-ACTION FK still pointing at it from a history table -- restore_jobs,
  // recovery_tokens, backup_chains, backup_verifications, or its own
  // parent_snapshot_id self-reference) is counted here rather than aborting
  // the whole pass. It is retried on the next run -- nothing here is a
  // permanent skip.
  failed: number;
};

type DeleteSnapshotOutcome = 'deleted' | 'pinned' | 'legalHold' | 'immutable' | 'unresolved';

/**
 * Deletes a `backup_snapshots` ROW ONLY, after RE-READING legal hold /
 * immutability under the row's own `FOR UPDATE` lock (review fix -- the
 * caller's enumeration-pass copy of those columns can be stale by the time
 * this row's turn comes up: a hold set or cleared in between must be honored
 * NOW, not then), checking every pin type (D18 section 3.2: backup-job base
 * pin via publish_lease_expires_at + margin, restore-job pin, recovery-token
 * pin), and writing a durable retirement tombstone
 * (backup_snapshot_retirements) in the SAME per-row system context as the
 * delete. The caller (`tryDeleteSnapshotRow`) wraps this whole function in
 * its own `withSystemDbAccessContext` call -- since `cleanupExpiredSnapshots`
 * is no longer invoked from inside any ambient transaction (D18 section 3.7,
 * jobs/backupWorker.ts), that call opens a REAL top-level Postgres
 * transaction distinct from every other row's, so a retirement written here
 * commits durably before the next candidate row is even considered.
 *
 * A row whose `storage_identity` is NULL is never retired with an invented
 * identity (review fix): a retirement's uniqueness and every lookup against
 * it is keyed on `(storage_identity, snapshot_id)`, and a fabricated
 * identity would let two genuinely different unresolved rows collide, or
 * hand GC an identity it can never match against a real bucket listing.
 * Such a row is left alone (`'unresolved'`) and retried on a later run once
 * identity resolves.
 *
 * Every lookup that matches a row by the bare (agent-supplied) `snapshotId`
 * string is additionally scoped by `storageIdentity`, since
 * `backup_snapshots.snapshot_id` carries no uniqueness constraint
 * (`schema/backup.ts` -- `snapshotIdIdx` is a plain, non-unique index): a
 * bare string match alone is not guaranteed to identify the row this
 * function is actually retiring.
 *
 * Deliberately does NOT touch object storage -- under the incremental/
 * synthetic-full manifest model, an incremental snapshot's unchanged files
 * are references whose backupPath points into an OLDER snapshot's prefix, so
 * eagerly nuking this snapshot's whole storage prefix the instant its row
 * expires would delete objects a still-retained sibling snapshot's manifest
 * still points at. Object deletion is the mark-and-sweep GC's exclusive job
 * (sweepUnreferencedBackupObjects, W02): the retirement row this function
 * writes is what lets that sweep treat this snapshot's exclusive objects as
 * garbage immediately, with no age-based ambiguity between "expired" and
 * merely "orphaned".
 */
async function deleteSnapshotRow(params: {
  id: string;
  snapshotId: string;
  orgId: string;
  configId: string | null;
  deviceId: string | null;
  storageIdentity: string | null;
  backupType: (typeof backupSnapshots.$inferSelect)['backupType'];
  reason: 'expired' | 'max_versions';
}): Promise<DeleteSnapshotOutcome> {
  const now = new Date();
  const restoreLingerMs = resolveBackupRestorePinLingerMs();
  const restoreLingerCutoff = new Date(Date.now() - restoreLingerMs);
  const publishMarginMs = resolveBackupPublishMarginMs();
  const publishMarginCutoff = new Date(Date.now() - publishMarginMs);

  const [locked] = await db
    .select({
      id: backupSnapshots.id,
      legalHold: backupSnapshots.legalHold,
      isImmutable: backupSnapshots.isImmutable,
      immutableUntil: backupSnapshots.immutableUntil,
    })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, params.id))
    .for('update');

  if (!locked) {
    // Already gone (concurrent delete/adoption) -- nothing to do.
    return 'deleted';
  }

  // Re-read under the lock -- authoritative, not the enumeration pass's copy.
  if (locked.legalHold) return 'legalHold';
  if (locked.isImmutable && locked.immutableUntil && locked.immutableUntil > now) return 'immutable';

  if (!params.storageIdentity) return 'unresolved';
  const storageIdentity = params.storageIdentity;

  // Backup pin (section 3.1/3.2): a backup_jobs row still building on this
  // snapshot as its base, SCOPED BY storageIdentity (a bare snapshotId match
  // is not enough -- see docstring). status IN (pending, running) covers an
  // in-flight run; publish_lease_expires_at > now() - margin covers a
  // reaped-but-still-uploading helper (the same lease+margin the helper
  // itself enforces before publishing -- see spec section 3.1's "publish
  // margin").
  const [backupPin] = await db
    .select({ id: backupJobs.id })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.baseSnapshotId, params.snapshotId),
        eq(backupJobs.storageIdentity, storageIdentity),
        or(
          inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES),
          gt(backupJobs.publishLeaseExpiresAt, publishMarginCutoff),
        ),
      ),
    )
    .limit(1);
  if (backupPin) return 'pinned';

  // Restore pin (section 3.2, F8): scoped by the row's own uuid
  // (backupSnapshots.id) -- unambiguous already, no storageIdentity scoping
  // needed here. The in-flight status check only counts once a command
  // exists (a commandless pending row is reaped by staleCommandReaper's own
  // 1h rule instead of pinning forever); the linger separately covers both
  // that crash window and a helper reading past the server's restore
  // timeout.
  const [restorePin] = await db
    .select({ id: restoreJobs.id })
    .from(restoreJobs)
    .where(
      and(
        eq(restoreJobs.snapshotId, params.id),
        or(
          and(inArray(restoreJobs.status, ['pending', 'running']), sql`${restoreJobs.commandId} IS NOT NULL`),
          gt(restoreJobs.createdAt, restoreLingerCutoff),
        ),
      ),
    )
    .limit(1);
  if (restorePin) return 'pinned';

  // Recovery pin (section 3.2): also scoped by the row's own uuid --
  // unambiguous. Active/authenticated token, or one not yet completed and
  // still within its expiry + the same linger (covers a BMR session
  // mid-download).
  const [recoveryPin] = await db
    .select({ id: recoveryTokens.id })
    .from(recoveryTokens)
    .where(
      and(
        eq(recoveryTokens.snapshotId, params.id),
        or(
          inArray(recoveryTokens.status, ['active', 'authenticated']),
          and(isNull(recoveryTokens.completedAt), gt(recoveryTokens.expiresAt, restoreLingerCutoff)),
        ),
      ),
    )
    .limit(1);
  if (recoveryPin) return 'pinned';

  await db.insert(backupSnapshotRetirements).values({
    orgId: params.orgId,
    configId: params.configId,
    deviceId: params.deviceId,
    snapshotId: params.snapshotId,
    storageIdentity,
    backupType: params.backupType,
    reason: params.reason,
  });

  await db.delete(backupSnapshots).where(eq(backupSnapshots.id, params.id));
  return 'deleted';
}

/**
 * D18 section 3.7: opens ONE real top-level Postgres transaction per
 * candidate row (`withSystemDbAccessContext`, called with no ambient context
 * already open -- see jobs/backupWorker.ts's Task 8) so a `deleteSnapshotRow`
 * outcome (retirement insert + row delete) for THIS row commits independently
 * of every other row's outcome and of the D17 `failed > 0` throw at the end
 * of `cleanupExpiredSnapshots`. An unexpected DB error (lock timeout,
 * connection blip, an as-yet-unregistered referencing table) is caught here
 * rather than aborting the whole cleanup pass -- logged with the PG
 * SQLSTATE/constraint when the driver surfaces one, and the row is simply
 * retried on the next run.
 */
async function tryDeleteSnapshotRow(snap: {
  id: string;
  snapshotId: string;
  orgId: string;
  configId: string | null;
  deviceId: string | null;
  storageIdentity: string | null;
  backupType: (typeof backupSnapshots.$inferSelect)['backupType'];
  reason: 'expired' | 'max_versions';
}): Promise<DeleteSnapshotOutcome | 'failed'> {
  try {
    return await withSystemDbAccessContext(() => deleteSnapshotRow(snap));
  } catch (error) {
    const code = pgErrorCode(error);
    const constraint = pgErrorConstraint(error);
    console.error(
      `[BackupRetention] Failed to delete snapshot ${snap.snapshotId} (id ${snap.id})` +
      (code ? ` -- PG ${code}` : ' -- no PG SQLSTATE on the error') +
      (constraint ? ` (constraint ${constraint})` : '') +
      ' -- skipping this row; will retry next run:',
      error,
    );
    return 'failed';
  }
}

/**
 * Cleans up expired snapshots for an org, respecting legal holds,
 * immutability, and every D18 pin type (backup base, restore, recovery
 * token). Both passes (expiry-date and maxVersions) route every candidate
 * row through `tryDeleteSnapshotRow`, which opens its OWN per-row system
 * context (D18 section 3.7) -- legal hold / immutability are decided
 * ONLY inside that call, re-read under the row's FOR UPDATE lock; the
 * enumeration selects below no longer fetch legalHold/isImmutable/
 * immutableUntil at all (review fix — the stale comment this replaces
 * claimed they were still fetched "incidentally"; they are not).
 */
function applyDeleteOutcome(result: RetentionCleanupResult, outcome: DeleteSnapshotOutcome | 'failed'): void {
  switch (outcome) {
    case 'deleted': result.deleted++; break;
    case 'pinned': result.skippedPinned++; break;
    case 'legalHold': result.skippedLegalHold++; break;
    case 'immutable': result.skippedImmutable++; break;
    case 'unresolved': result.skippedUnresolved++; break;
    case 'failed': result.failed++; break;
  }
}

export async function cleanupExpiredSnapshots(
  orgId: string
): Promise<RetentionCleanupResult> {
  // D18 §3.7 review fix: the whole per-row-commit contract this function
  // exists to provide depends on being called with NO ambient DB context
  // already held (jobs/backupWorker.ts:1069-1084's comment is the only
  // other guard). If a future caller wraps this in `withSystemDbAccessContext`
  // (or any `withDbAccessContext`), every "per-row transaction" below
  // silently collapses into savepoints inside that ONE ambient transaction —
  // exactly the D17 resurrection bug this wave fixes. Assert it explicitly
  // rather than relying on a comment nobody re-reads.
  assertOutsideHeldDbContext('cleanupExpiredSnapshots');
  const result: RetentionCleanupResult = {
    deleted: 0,
    skippedLegalHold: 0,
    skippedImmutable: 0,
    skippedPinned: 0,
    skippedUnresolved: 0,
    prunedByMaxVersions: 0,
    failed: 0,
  };

  // D18 section 3.7: this read runs with no ambient context
  // (cleanupExpiredSnapshots is no longer called from inside one) -- a
  // snapshot-in-time read is fine here since every candidate is
  // independently re-verified (legal hold, immutability, storage identity,
  // every pin) with FOR UPDATE inside its own per-row commit below.
  const expired = await withSystemDbAccessContext(() =>
    db
      .select({
        id: backupSnapshots.id,
        snapshotId: backupSnapshots.snapshotId,
        deviceId: backupSnapshots.deviceId,
        configId: backupSnapshots.configId,
        storageIdentity: backupSnapshots.storageIdentity,
        backupType: backupSnapshots.backupType,
      })
      .from(backupSnapshots)
      .where(
        and(
          eq(backupSnapshots.orgId, orgId),
          lt(backupSnapshots.expiresAt, new Date())
        )
      )
  );

  for (const snap of expired) {
    const outcome = await tryDeleteSnapshotRow({
      id: snap.id,
      snapshotId: snap.snapshotId,
      orgId,
      configId: snap.configId,
      deviceId: snap.deviceId,
      storageIdentity: snap.storageIdentity,
      backupType: snap.backupType,
      reason: 'expired',
    });
    applyDeleteOutcome(result, outcome);
  }

  const versionBoundSnapshots = await withSystemDbAccessContext(() =>
    db
      .select({
        id: backupSnapshots.id,
        snapshotId: backupSnapshots.snapshotId,
        timestamp: backupSnapshots.timestamp,
        deviceId: backupSnapshots.deviceId,
        configId: backupSnapshots.configId,
        storageIdentity: backupSnapshots.storageIdentity,
        backupType: backupSnapshots.backupType,
        retention: configPolicyBackupSettings.retention,
      })
      .from(backupSnapshots)
      .innerJoin(backupJobs, eq(backupSnapshots.jobId, backupJobs.id))
      .leftJoin(
        configPolicyBackupSettings,
        eq(backupJobs.featureLinkId, configPolicyBackupSettings.featureLinkId),
      )
      .where(eq(backupSnapshots.orgId, orgId))
      .orderBy(
        backupSnapshots.deviceId,
        backupSnapshots.configId,
        desc(backupSnapshots.timestamp),
      )
  );

  const snapshotsByGroup = new Map<string, typeof versionBoundSnapshots>();
  for (const row of versionBoundSnapshots) {
    const groupKey = `${row.deviceId}:${row.configId ?? 'none'}`;
    const existing = snapshotsByGroup.get(groupKey);
    if (existing) existing.push(row);
    else snapshotsByGroup.set(groupKey, [row]);
  }

  for (const groupRows of snapshotsByGroup.values()) {
    const retention = groupRows[0]?.retention as Record<string, unknown> | null | undefined;
    const maxVersions = typeof retention?.maxVersions === 'number' ? retention.maxVersions : null;
    if (!maxVersions || maxVersions < 1 || groupRows.length <= maxVersions) continue;

    for (const snap of groupRows.slice(maxVersions)) {
      const outcome = await tryDeleteSnapshotRow({
        id: snap.id,
        snapshotId: snap.snapshotId,
        orgId,
        configId: snap.configId,
        deviceId: snap.deviceId,
        storageIdentity: snap.storageIdentity,
        backupType: snap.backupType,
        reason: 'max_versions',
      });
      if (outcome === 'deleted') result.prunedByMaxVersions++;
      applyDeleteOutcome(result, outcome);
    }
  }

  if (
    result.deleted > 0 || result.skippedLegalHold > 0 || result.skippedImmutable > 0 ||
    result.skippedPinned > 0 || result.skippedUnresolved > 0 || result.prunedByMaxVersions > 0 || result.failed > 0
  ) {
    console.log(
      `[BackupRetention] Org ${orgId}: deleted ${result.deleted}, ` +
      `skipped ${result.skippedLegalHold} (legal hold), ${result.skippedImmutable} (immutable), ` +
      `${result.skippedPinned} (pinned), ${result.skippedUnresolved} (unresolved identity), ` +
      `pruned ${result.prunedByMaxVersions} by maxVersions` +
      (result.failed > 0 ? `, FAILED ${result.failed} delete(s) (see prior per-row errors -- will retry next run)` : '')
    );
  }

  // D17 summary: surfaced once per org run (not per row, which console.error
  // in tryDeleteSnapshotRow already covers) so a run with failures is visible
  // in Sentry beyond stdout, mirroring sweepUnreferencedBackupObjects's
  // wedge-message convention below.
  if (result.failed > 0) {
    const summary =
      `[BackupRetention] Org ${orgId}: ${result.failed} snapshot row delete(s) failed this run -- ` +
      'see prior per-row error logs for the specific snapshot id(s) and PG error; will retry next run.';
    console.error(summary);
    captureException(new Error(summary));
  }

  return result;
}

/**
 * Applies GFS-based expiration dates to a snapshot based on its tags and the
 * GFS retention config. Called after GFS tags have been applied.
 *
 * The highest-tier tag determines the longest retention:
 *   yearly > monthly > weekly > daily
 */
export function computeExpiresAt(
  completedAt: Date,
  tags: GfsTags,
  gfsConfig: GfsConfig | null | undefined
): Date | null {
  if (!gfsConfig) return null;

  let maxDays = 0;

  if (tags.daily && gfsConfig.daily) {
    maxDays = Math.max(maxDays, gfsConfig.daily);
  }
  if (tags.weekly && gfsConfig.weekly) {
    maxDays = Math.max(maxDays, gfsConfig.weekly * 7);
  }
  if (tags.monthly && gfsConfig.monthly) {
    maxDays = Math.max(maxDays, gfsConfig.monthly * 30);
  }
  if (tags.yearly && gfsConfig.yearly) {
    maxDays = Math.max(maxDays, gfsConfig.yearly * 365);
  }

  if (maxDays === 0 && gfsConfig.retentionDays) {
    maxDays = gfsConfig.retentionDays;
  }

  if (maxDays === 0) return null;

  const expires = new Date(completedAt);
  expires.setUTCDate(expires.getUTCDate() + maxDays);
  return expires;
}

// ── Mark-and-sweep GC for unreferenced backup objects ────────────────────────
//
// Incremental snapshots reference objects living under OLDER snapshots'
// prefixes (see design doc's "reference mechanism" and deleteSnapshotRow's
// comment above), so object-storage cleanup can no longer be "delete this
// snapshot's whole prefix when its row expires" — that would delete objects
// a still-retained, newer sibling snapshot's manifest points at. This phase
// runs AFTER row-level retention (cleanupExpiredSnapshots) has already
// deleted expired backup_snapshots rows (writing a durable
// backup_snapshot_retirements tombstone as it goes), and is the ONLY code
// path that deletes backup objects.
//
// D18 W02 (#5451, spec v3 docs/superpowers/specs/backup/2026-09-09-backup-gc-reclamation-design.md):
//
//   Identity: sweeps run per STORAGE IDENTITY (provider + endpoint + bucket),
//             not per backupConfigs row — see normalizeStorageIdentity.
//   Root set: every backup_snapshots row whose storage_identity matches this
//             identity (ANY backupType — the manifest layout
//             (snapshots/<id>/manifest.json (+ system-state/ for D15)) is
//             shared by every mode, so scoping is by identity, not type), PLUS
//             every backup_snapshots row with storage_identity IS NULL whose
//             config_id maps here (unconditionally a root — "resolved" only
//             gates self-heal/deferral, never root membership, see §3.6 v3).
//   Retired:  a snapshot with a backup_snapshot_retirements row (sweptAt IS
//             NULL) for this identity is NEVER a root regardless of age, and
//             is reclaimed via the two-phase (non-manifest, then manifest)
//             rule below.
//   Orphan:   a listed manifest-bearing prefix with NO row and NO retirement
//             is a root only while younger than ORPHAN_WINDOW — giving
//             reconcile time to adopt it. Past the window it is reclaimed
//             like a retired prefix. This REPLACES the old "every listed
//             manifest is live forever" rule, which existed only to guard a
//             dedup-source race that no longer exists now that the server
//             picks and LEASES the incremental base itself
//             (base_snapshot_id/publish_lease_expires_at, W01).
//   Deferred: while ANY unresolved (manifest not found in this run's listing)
//             NULL-identity row exists for this identity, OR any device with
//             a recent/in-flight backup_jobs row on this identity runs a
//             helper below BACKUP_SERVER_BASE_MIN_HELPER_VERSION, retired/
//             orphan reclamation is suppressed for the WHOLE identity this
//             run — it runs EXACTLY today's (pre-D18) algorithm instead
//             (every listed manifest is a root; only the pre-existing 48h
//             loose-object grace and 9-day manifest-less-prefix rules apply).
//   Sweep:    per snapshot-ID prefix found in the listing:
//               - rooted, manifest-bearing: per-object 48h grace
//                 (BACKUP_GC_GRACE_MS) for loose (non-live) objects.
//               - manifest-less (partial/resumable run): protected at PREFIX
//                 granularity until the newest object clears
//                 BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS (9 days default).
//               - retired or old-orphan, manifest-bearing: two-phase —
//                 non-manifest objects first, then the manifest ONLY once no
//                 deletable non-manifest key remains (none failed, none
//                 capped, none skip-set-excluded).
//   Null config_id: a backup_snapshots row with no config_id can't be
//             attributed to any storage identity — blocks the ENTIRE run,
//             fail-closed (unchanged from pre-D18).
//   Identity normalization / collision detection: unchanged from pre-D18 —
//             see normalizeStorageIdentity and detectSuspiciousStorageIdentityCollisions.
//   Transaction boundaries (spec §3.7): every DB read/write here runs inside
//             its own SHORT withSystemDbAccessContext call; every storage
//             call (list/fetch/delete) runs at depth 0 — assertOutsideHeldDbContext
//             is the runtime tripwire for this invariant.

const BACKUP_GC_GRACE_MS_DEFAULT = 48 * 60 * 60 * 1000;
// Lowest grace production will accept from the env knob. The grace is a
// production safety margin (protects an in-flight upload whose manifest
// isn't published yet) and must never be lowered on a real deployment; the
// knob exists so a lab can prove reclamation in seconds.
const BACKUP_GC_GRACE_MS_PRODUCTION_FLOOR = 60 * 60 * 1000;

/** Resolved fresh on every GC run — see resolveMsKnob for the override/floor/warn contract. */
export function resolveBackupGcGraceMs(): number {
  return resolveMsKnob('BACKUP_GC_GRACE_MS', BACKUP_GC_GRACE_MS_DEFAULT, BACKUP_GC_GRACE_MS_PRODUCTION_FLOOR);
}

// Must stay STRICTLY LARGER than agent/internal/backup/journal.go's
// journalMaxAge (7 days) — apps/api/src/services/backupAgentContract.test.ts
// greps THIS FILE's source text for this exact literal. Do not move it,
// rename it, or change its RHS expression without updating that contract test.
const BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // must equal the agent's journalMaxAge
const BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS_DEFAULT =
  BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS + BACKUP_GC_GRACE_MS_DEFAULT; // 9 days
// Floor is journalMaxAge + 1ms (not a round number): the invariant is STRICT
// inequality against journalMaxAge, not "at least 7 days" — an override of
// exactly 7 days would race a resume opened just inside day 7.
const BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS_PRODUCTION_FLOOR = BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS + 1;

/** Resolved fresh on every GC run. Replaces the old module-load export. */
export function resolveBackupManifestlessPrefixMaxAgeMs(): number {
  return resolveMsKnob(
    'BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS',
    BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS_DEFAULT,
    BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS_PRODUCTION_FLOOR,
  );
}

// Providers this GC path knows how to list-with-last-modified and delete for.
const BACKUP_GC_SUPPORTED_PROVIDERS = new Set(['s3', 'local']);

// The unit of GC work is a storage identity (possibly several backupConfigs
// rows sharing one bucket), not a single "destination" row.
//   skippedIdentities — every identity NOT swept this run, for ANY reason.
//   blockedIdentities — the SUBSET of skippedIdentities aborted fail-closed
//     because a manifest was unfetchable/unparseable — the signal of a
//     genuine, non-self-healing storage leak.
//   retiredSwept — retirement rows CONFIRMED fully gone from a fresh listing
//     this run (durable, via swept_at — see the two-pass rule below).
//   orphansSwept — best-effort per-run metric (no DB row to confirm against).
//   deferredIdentities — identities that ran today's (pre-D18) algorithm only
//     this run (legacy helper and/or unresolved NULL-identity rows).
//   unreachableIdentities — storage_identity values with rows but no current
//     config producing that identity (visibility only; see logUnreachableStorageIdentities).
export type BackupGcResult = {
  deleted: number;
  skippedIdentities: number;
  blockedIdentities: number;
  retiredSwept: number;
  orphansSwept: number;
  deferredIdentities: number;
  unreachableIdentities: number;
};

type BackupGcManifest = { files?: Array<{ backupPath?: unknown }> };

// D15 bare-metal-recovery contract (Option A): a system_image snapshot
// publishes a SEPARATE manifest under system-state/manifest.json, describing
// artifacts under system-state/<artifact.path> — never inside the ordinary
// manifest's `files[]`. Mirrors agent/internal/backup/systemstate/types.go's
// SystemStateManifest/Artifact shape (only the field GC needs: path).
type BackupGcSystemStateManifest = { artifacts?: Array<{ path?: unknown }> };

function parseBackupGcSystemStateManifest(raw: string): BackupGcSystemStateManifest {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('system state manifest is not a JSON object');
  }
  const artifacts = (parsed as { artifacts?: unknown }).artifacts;
  if (artifacts !== undefined && !Array.isArray(artifacts)) {
    throw new Error('system state manifest.artifacts is not an array');
  }
  return parsed as BackupGcSystemStateManifest;
}

/**
 * Resolves the per-run deletion cap from env on every call (not once at
 * module load) so it stays test-overridable without module-reset gymnastics.
 * 0 means unlimited; negative/NaN falls back to the default rather than
 * silently disabling the sweep. Unset OR blank/whitespace treated identically
 * as "use the default" — `Number('')` is 0 in JS, which would otherwise
 * silently mean "unlimited" for an accidentally-empty env var.
 */
export function resolveBackupGcMaxDeletesPerRun(): number {
  const envValue = process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
  const trimmed = envValue?.trim();
  if (!trimmed) return 2000;
  const raw = Number(trimmed);
  if (Number.isFinite(raw) && raw > 0) return raw;
  if (raw === 0) return Number.MAX_SAFE_INTEGER;
  return 2000;
}

function parseBackupGcManifest(raw: string): BackupGcManifest {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest is not a JSON object');
  }
  const files = (parsed as { files?: unknown }).files;
  if (files !== undefined && !Array.isArray(files)) {
    throw new Error('manifest.files is not an array');
  }
  return parsed as BackupGcManifest;
}

// ── Storage identity grouping ────────────────────────────────────────────────

type BackupGcDestination = { id: string; provider: string; providerConfig: unknown };

export type BackupGcStorageIdentity = {
  key: string;
  provider: string;
  // Representative providerConfig used for actual provider calls (list/fetch/
  // delete) — arbitrary choice among the configs sharing this identity, since
  // by construction they resolve to the same physical bucket; may still carry
  // different (but presumably equally valid) credentials or a cosmetic prefix.
  providerConfig: unknown;
  configIds: string[];
};

// AWS's own default S3 endpoints. An endpoint that's EXPLICITLY the default
// AWS endpoint must canonicalize to the same identity as a blank/omitted
// endpoint (both mean "use AWS's default").
const DEFAULT_AWS_S3_ENDPOINT_PATTERN = /^s3(\.dualstack)?([.-][a-z0-9-]+)?\.amazonaws\.com$/;

/**
 * Normalizes an S3-compatible endpoint for identity comparison: strips
 * scheme/path/trailing-slash (only host+port matter), lowercases the host,
 * and canonicalizes a blank endpoint and an explicit default-AWS endpoint to
 * the SAME value. A genuinely unparseable endpoint falls back to a
 * trimmed+lowercased raw string rather than being treated as blank — fail
 * toward "different identity" (safe), never toward "same identity".
 */
function normalizeS3Endpoint(endpoint: string | null | undefined): string {
  const raw = endpoint?.trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (DEFAULT_AWS_S3_ENDPOINT_PATTERN.test(host)) return '';
    return url.port ? `${host}:${url.port}` : host;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Identity = provider + endpoint + bucket (S3) or provider + resolved root
 * path (local) — deliberately EXCLUDING providerConfig.prefix (the agent
 * ignores prefix when writing, so two configs differing only by prefix are
 * the same physical namespace).
 */
export function normalizeStorageIdentity(provider: string, providerConfig: Record<string, unknown>): string {
  if (provider === 'local') {
    const rawPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath') || '';
    const normalizedPath = rawPath ? resolveLocalPath(rawPath) : '';
    return `local::${normalizedPath}`;
  }
  const endpoint = normalizeS3Endpoint(getStringValue(providerConfig, 'endpoint'));
  // Bucket names are case-sensitive per the S3 spec — trim whitespace only,
  // never lowercase.
  const bucket = (getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName') || '').trim();
  return `${provider}::${endpoint}::${bucket}`;
}

function groupBackupConfigsByStorageIdentity(
  configs: BackupGcDestination[],
): Map<string, BackupGcStorageIdentity> {
  const identities = new Map<string, BackupGcStorageIdentity>();
  for (const config of configs) {
    const key = normalizeStorageIdentity(config.provider, asRecord(config.providerConfig));
    const existing = identities.get(key);
    if (existing) {
      existing.configIds.push(config.id);
      continue;
    }
    identities.set(key, {
      key,
      provider: config.provider,
      providerConfig: config.providerConfig,
      configIds: [config.id],
    });
  }
  return identities;
}

/**
 * Belt-and-braces: even after normalizeStorageIdentity, an unanticipated
 * cosmetic variant could still produce two DIFFERENT identity keys for the
 * SAME physical bucket. Cross-check with a CRUDER comparison and fail-closed
 * (exclude ALL of them) if it collapses two identities normalizeStorageIdentity
 * kept apart.
 */
function detectSuspiciousStorageIdentityCollisions(
  identities: Map<string, BackupGcStorageIdentity>,
): Set<string> {
  const coarseGroups = new Map<string, Set<string>>();

  for (const identity of identities.values()) {
    if (identity.provider === 'local') continue;

    const providerConfig = asRecord(identity.providerConfig);
    const bucket = (getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName') || '')
      .trim()
      .toLowerCase();
    const rawEndpoint = getStringValue(providerConfig, 'endpoint');
    let hostOnly = '';
    if (rawEndpoint?.trim()) {
      try {
        hostOnly = new URL(rawEndpoint.includes('://') ? rawEndpoint : `https://${rawEndpoint}`).hostname.toLowerCase();
      } catch {
        hostOnly = rawEndpoint.trim().toLowerCase();
      }
    }
    const coarseKey = `${identity.provider}::${hostOnly}::${bucket}`;

    let identityKeys = coarseGroups.get(coarseKey);
    if (!identityKeys) {
      identityKeys = new Set();
      coarseGroups.set(coarseKey, identityKeys);
    }
    identityKeys.add(identity.key);
  }

  const suspicious = new Set<string>();
  for (const [coarseKey, identityKeys] of coarseGroups) {
    if (identityKeys.size <= 1) continue;
    console.error(
      `[BackupGC] ${identityKeys.size} DIFFERENT normalized storage identities (${[...identityKeys].join(', ')}) ` +
      `all resolve to the same bucket+host (${coarseKey}) under a cruder comparison — normalizeStorageIdentity ` +
      `likely missed a cosmetic variant. Excluding all of them from this run (fail-closed) to avoid two ` +
      `overlapping sweeps on the same physical bucket.`,
    );
    for (const key of identityKeys) suspicious.add(key);
  }
  return suspicious;
}

// ── Listing grouped by snapshot-ID prefix ─────────────────────────────────────

type BackupGcSnapshotGroup = {
  items: BackupObjectListing[];
  manifestItem: BackupObjectListing | null;
};

function groupListingBySnapshotId(listing: BackupObjectListing[]): Map<string, BackupGcSnapshotGroup> {
  const rootWithSlash = `${BACKUP_SNAPSHOT_ROOT_DIR}/`;
  const groups = new Map<string, BackupGcSnapshotGroup>();

  for (const item of listing) {
    if (!item.key.startsWith(rootWithSlash)) continue; // defense-in-depth; see listS3ObjectsWithLastModified
    const rest = item.key.slice(rootWithSlash.length);
    const slashIdx = rest.indexOf('/');
    const snapshotId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    if (!snapshotId) continue;

    let group = groups.get(snapshotId);
    if (!group) {
      group = { items: [], manifestItem: null };
      groups.set(snapshotId, group);
    }
    group.items.push(item);
    if (item.key === `${rootWithSlash}${snapshotId}/${BACKUP_SNAPSHOT_MANIFEST_KEY}`) {
      group.manifestItem = item;
    }
  }

  return groups;
}

/**
 * §3.4 orphan root set: a listed manifest-bearing prefix with no
 * backup_snapshots row and no retirement row is a root ONLY while its
 * manifest object is younger than the orphan window — giving reconcile
 * (backupSnapshotReconcile.ts) time to adopt a completed-but-unpersisted
 * snapshot into a real row before GC would otherwise reclaim it. A manifest
 * object with no last-modified data cannot have its age disproven, so it is
 * fail-closed treated as YOUNG (protected), never as old.
 *
 * Replaces the old listedManifestSnapshotIds, which marked EVERY listed
 * manifest live FOREVER to guard the agent's listing-based dedup-base
 * selection race. That race no longer exists: the server now picks and
 * LEASES the incremental base itself (base_snapshot_id/publish_lease_expires_at,
 * W01) — an in-flight backup's base is protected by its own retained DB row
 * and lease, not by an unbounded listing heuristic, so an orphan manifest
 * past the window really is garbage (or a retirement will already exist).
 */
export function orphanManifestSnapshotIds(
  groups: Map<string, BackupGcSnapshotGroup>,
  retainedSnapshotIds: Set<string>,
  retiredSnapshotIds: Map<string, string>,
  nowMs: number,
  windowMs: number,
): string[] {
  const ids: string[] = [];
  const threshold = nowMs - windowMs;
  for (const [snapshotId, group] of groups) {
    if (!group.manifestItem) continue;
    if (retainedSnapshotIds.has(snapshotId)) continue; // already a root via its DB row
    if (retiredSnapshotIds.has(snapshotId)) continue; // retired -> never a root, regardless of age
    const lm = group.manifestItem.lastModified;
    if (!lm || lm.getTime() > threshold) ids.push(snapshotId);
  }
  return ids;
}

/**
 * §3.6: rows carry the identity string they were PUBLISHED under, which
 * survives a later providerConfig edit. An identity with rows but no current
 * config producing that exact key is unreachable — it is never listed (no
 * config = no provider/providerConfig to list with), so it leaks silently
 * unless logged here. This is visibility only; reclaiming an unreachable
 * identity needs manual tooling (deferred).
 */
async function logUnreachableStorageIdentities(
  identities: Map<string, BackupGcStorageIdentity>,
): Promise<number> {
  const usage = await db
    .select({
      storageIdentity: backupSnapshots.storageIdentity,
      count: sql<number>`count(*)`,
    })
    .from(backupSnapshots)
    .groupBy(backupSnapshots.storageIdentity);

  let unreachable = 0;
  for (const row of usage) {
    // A NULL storage_identity is not "unreachable" — it's an unresolved row
    // the self-heal path owns.
    if (row.storageIdentity === null) continue;
    if (identities.has(row.storageIdentity)) continue;
    unreachable++;
    console.warn(`[BackupGC] unreachable identity ${row.storageIdentity}: ${row.count} rows`);
  }
  return unreachable;
}

/**
 * Mark phase for one storage identity. Returns null (never throws) on any
 * fetch/parse failure so the caller can fail-closed and skip the sweep.
 */
async function markLiveBackupObjects(
  identity: { provider: string; providerConfig: unknown },
  snapshotIds: Iterable<string>,
): Promise<Set<string> | null> {
  const live = new Set<string>();

  for (const snapshotId of snapshotIds) {
    const manifestKey = backupSnapshotManifestKey(snapshotId);
    live.add(manifestKey);

    let raw: string;
    try {
      raw = await fetchBackupObjectText({
        provider: identity.provider,
        providerConfig: identity.providerConfig,
        key: manifestKey,
      });
    } catch (error) {
      console.error(
        `[BackupGC] Manifest fetch failed for snapshot ${snapshotId} (key ${manifestKey}) — aborting sweep for this identity:`,
        error,
      );
      return null;
    }

    let manifest: BackupGcManifest;
    try {
      manifest = parseBackupGcManifest(raw);
    } catch (error) {
      console.error(
        `[BackupGC] Manifest parse failed for snapshot ${snapshotId} (key ${manifestKey}) — aborting sweep for this identity:`,
        error,
      );
      return null;
    }

    for (const file of manifest.files ?? []) {
      if (typeof file.backupPath === 'string' && file.backupPath.length > 0) {
        live.add(file.backupPath);
      }
    }

    // D15 bare-metal-recovery contract (Option A): system-state artifacts
    // live under their own manifest/prefix, never inside manifest.files[]
    // above — so without this, GC would sweep them 48h after ANY
    // system_image snapshot, live regression, not hypothetical (see the plan
    // doc referenced on backupSystemStateManifestKey). Absence is the
    // ROUTINE case for a file-mode snapshot (no system state ever
    // collected) — isBackupObjectNotFound distinguishes that from "the fetch
    // failed for some other reason", which must still fail-closed (abort
    // this identity's whole sweep) the same as an ordinary-manifest fetch
    // failure: an unproven system-state manifest must never be inferred as
    // "doesn't exist" — that would open the door to sweeping objects a
    // transient error only made unreachable, not orphaned.
    //
    // #5523 bare-metal-recovery layout manifest (layout.json): a single
    // object with nothing to enumerate, so — like the ordinary manifest key
    // above — it is marked live UNCONDITIONALLY for every snapshotId this
    // function is given, never fetched. This is what gives layout.json the
    // same protection as manifest.json in every root-set case D18 W02 builds
    // (rooted/retained roots, resolved NULL-identity roots, young orphans,
    // and every listed manifest under the deferred-identity algorithm) —
    // markLiveBackupObjects is the single call site all of them funnel
    // through. Marking a key that doesn't exist is harmless; fetching it
    // would only add a round-trip and a new failure mode.
    live.add(backupLayoutManifestKey(snapshotId));

    const stateManifestKey = backupSystemStateManifestKey(snapshotId);
    let stateRaw: string;
    try {
      stateRaw = await fetchBackupObjectText({
        provider: identity.provider,
        providerConfig: identity.providerConfig,
        key: stateManifestKey,
      });
    } catch (error) {
      if (isBackupObjectNotFound(error)) continue;
      console.error(
        `[BackupGC] System state manifest fetch failed for snapshot ${snapshotId} (key ${stateManifestKey}) — ` +
        `aborting sweep for this identity:`,
        error,
      );
      return null;
    }

    let stateManifest: BackupGcSystemStateManifest;
    try {
      stateManifest = parseBackupGcSystemStateManifest(stateRaw);
    } catch (error) {
      console.error(
        `[BackupGC] System state manifest parse failed for snapshot ${snapshotId} (key ${stateManifestKey}) — ` +
        `aborting sweep for this identity:`,
        error,
      );
      return null;
    }

    live.add(stateManifestKey);
    for (const artifact of stateManifest.artifacts ?? []) {
      if (typeof artifact.path === 'string' && artifact.path.length > 0) {
        live.add(backupSystemStateArtifactKey(snapshotId, artifact.path));
      }
    }
  }

  return live;
}

// ── Redis-backed failed-key skip set (delete-cap fairness, D18 W02) ─────────

const BACKUP_GC_FAILED_KEY_TTL_SECONDS = 7 * 24 * 60 * 60;

function backupGcFailedKeySetName(identityKey: string): string {
  return `backup-gc:failed:${createHash('sha1').update(identityKey).digest('hex')}`;
}

/** Fails open to an empty set (never blocks the sweep) if Redis is unavailable or errors. */
async function loadGcFailedKeySkipSet(identityKey: string): Promise<Set<string>> {
  if (!isRedisAvailable()) return new Set();
  const redis = getRedis();
  if (!redis) return new Set();
  try {
    const members = await redis.smembers(backupGcFailedKeySetName(identityKey));
    return new Set(members);
  } catch (error) {
    console.warn(`[BackupGC] Failed to load skip-set for identity ${identityKey} — proceeding without it:`, error);
    return new Set();
  }
}

/**
 * Best-effort; a Redis failure here must never fail the sweep that already
 * ran. Called from EVERY delete branch (rooted, manifest-less, retired/orphan
 * non-manifest phase, retired/orphan manifest phase) so a persistently-locked
 * object anywhere stops burning cap budget on repeat attempts every run.
 *
 * ACCEPTED APPROXIMATION (documented, not fixed): `EXPIRE` sets a TTL on the
 * whole per-identity SET, refreshed to a full 7 days on every call that adds
 * a new key — Redis SETs have no native per-member TTL. On a busy identity
 * that keeps failing DIFFERENT keys, an older failed key can therefore stay
 * excluded from the cap for longer than 7 days. Accepted because it only ever
 * makes the sweep MORE conservative (skips more, never deletes something it
 * shouldn't); a precise per-member TTL would need a Redis hash of
 * `key -> expiresAt` plus a separate pruning pass — unwarranted complexity
 * for a purely advisory cap-fairness mechanism.
 */
async function recordGcFailedKeys(
  identityKey: string,
  failedKeys: { key: string; error: string }[],
): Promise<void> {
  if (failedKeys.length === 0 || !isRedisAvailable()) return;
  const redis = getRedis();
  if (!redis) return;
  const setKey = backupGcFailedKeySetName(identityKey);
  try {
    await redis.sadd(setKey, ...failedKeys.map((f) => f.key));
    await redis.expire(setKey, BACKUP_GC_FAILED_KEY_TTL_SECONDS);
  } catch (error) {
    console.warn(`[BackupGC] Failed to record skip-set entries for identity ${identityKey}:`, error);
  }
}

async function deleteCandidatesWithCap(
  identity: { provider: string; providerConfig: unknown },
  candidates: BackupObjectListing[],
  cap: number,
  skipSet: Set<string>,
): Promise<{ deletedKeys: string[]; failedKeys: { key: string; error: string }[]; attempted: number }> {
  const eligible = candidates.filter((c) => !skipSet.has(c.key));
  if (eligible.length === 0 || cap <= 0) return { deletedKeys: [], failedKeys: [], attempted: 0 };
  eligible.sort((a, b) => (a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0));
  const toDelete = eligible.slice(0, cap).map((c) => c.key);
  const result = await deleteBackupObjectKeys({ provider: identity.provider, providerConfig: identity.providerConfig, keys: toDelete });
  // `attempted` (not `deletedKeys.length`) is what the caller charges against
  // the per-run cap — a failed attempt still cost a real provider call this
  // run and must not be retried unboundedly within the same run.
  return { ...result, attempted: toDelete.length };
}

function manifestOlderThanWindow(item: BackupObjectListing, nowMs: number, windowMs: number): boolean {
  if (!item.lastModified) return false;
  return item.lastModified.getTime() <= nowMs - windowMs;
}

/**
 * §3.7: pure storage-and-compute — every DB read this needs is gathered by
 * the caller in a short DB context BEFORE this runs; every DB write this
 * produces (self-heal, retirement-swept) is applied by the caller in a short
 * DB context AFTER this returns. Never touches `db` itself.
 */
async function sweepStorageIdentity(
  identity: { key: string; provider: string; providerConfig: unknown },
  retainedSnapshotIds: string[],
  nullIdentityRows: { id: string; snapshotId: string }[], // storage_identity IS NULL, configId maps to this identity
  retiredSnapshotIds: Map<string, string>, // snapshotId -> retirement row id, sweptAt IS NULL only
  nowMs: number,
  deletesRemaining: number,
  graceMs: number,
  orphanWindowMs: number,
  manifestlessWindowMs: number,
  legacyHelperDeferred: boolean,
): Promise<{
  deleted: number;
  retiredSweptIds: string[]; // retirement row ids CONFIRMED fully gone from THIS run's fresh listing
  orphansSwept: number; // best-effort metric — see the accepted-approximation note above
  selfHealRowIds: string[]; // backup_snapshots.id values to self-heal
  unresolvedNullIdentityCount: number;
  deletesUsed: number;
}> {
  assertOutsideHeldDbContext('backupGC.sweepStorageIdentity');

  const listing = await listBackupObjectsUnderPrefix({
    provider: identity.provider,
    providerConfig: identity.providerConfig,
    prefix: backupSnapshotRootPrefix(),
  });
  const groups = groupListingBySnapshotId(listing);

  // §3.4/§3.6 P1: a NULL-identity row mapped to this identity is a root of I
  // the moment it's RESOLVED (its manifest is found in THIS run's fresh
  // listing) — resolution and root-membership are decided by the same check
  // deliberately, because there is nothing to fetch/protect for a row whose
  // object was never actually written here (unresolved): attempting to fetch
  // a manifest key we already know is absent from the listing would only
  // ever 404 and needlessly fail-close the whole identity. An UNRESOLVED row
  // instead contributes only to `unresolvedNullIdentityCount`, which gates
  // deferral below — the identity still runs today's (pre-D18) algorithm
  // until every such row resolves or ages out via a human fixing the data.
  // A row that IS resolved is unconditionally rooted (never subject to the
  // orphan-window aging that a plain, row-less listed manifest would face) —
  // that unconditional-once-resolved guarantee is the "§3.6 v3 P1" fix.
  const resolvedNullRows = nullIdentityRows.filter((r) => groups.get(r.snapshotId)?.manifestItem);
  const selfHealRowIds = resolvedNullRows.map((r) => r.id);
  const unresolvedNullIdentityCount = nullIdentityRows.length - resolvedNullRows.length;
  const alwaysRootedIds = new Set([...retainedSnapshotIds, ...resolvedNullRows.map((r) => r.snapshotId)]);

  // §3.4: EITHER condition defers the WHOLE identity to exactly today's
  // (pre-D18) algorithm — no retired/orphan reclamation at all this run.
  const deferred = legacyHelperDeferred || unresolvedNullIdentityCount > 0;

  const graceThreshold = nowMs - graceMs;
  const manifestlessThreshold = nowMs - manifestlessWindowMs;
  const skipSet = await loadGcFailedKeySkipSet(identity.key);
  let deleted = 0;
  let orphansSwept = 0;
  let remaining = deletesRemaining;

  async function sweepRootedLoose(group: BackupGcSnapshotGroup, liveSet: Set<string>): Promise<void> {
    const candidates = group.items.filter(
      (item) => !liveSet.has(item.key) && item.lastModified && item.lastModified.getTime() <= graceThreshold,
    );
    const result = await deleteCandidatesWithCap(identity, candidates, remaining, skipSet);
    deleted += result.deletedKeys.length;
    remaining -= result.attempted;
    if (result.failedKeys.length > 0) await recordGcFailedKeys(identity.key, result.failedKeys);
  }

  async function sweepManifestless(group: BackupGcSnapshotGroup, liveSet: Set<string>): Promise<void> {
    let newestMs: number | null = null;
    let hasUnknownAge = false;
    for (const item of group.items) {
      if (!item.lastModified) { hasUnknownAge = true; break; }
      const ms = item.lastModified.getTime();
      if (newestMs === null || ms > newestMs) newestMs = ms;
    }
    if (hasUnknownAge || newestMs === null || newestMs > manifestlessThreshold) return;
    const candidates = group.items.filter((item) => !liveSet.has(item.key));
    const result = await deleteCandidatesWithCap(identity, candidates, remaining, skipSet);
    deleted += result.deletedKeys.length;
    remaining -= result.attempted;
    if (result.failedKeys.length > 0) await recordGcFailedKeys(identity.key, result.failedKeys);
  }

  // Retired (any age) OR old-orphan two-phase reclaim. Also handles a
  // "manifest-less retired remnant" (manifest already gone from a prior run)
  // — in that case there is no manifest-gating to do, just delete everything
  // non-live in one phase. Never sets swept_at itself.
  async function reclaimUnrooted(group: BackupGcSnapshotGroup, liveSet: Set<string>): Promise<void> {
    const manifestKey = group.manifestItem?.key;
    const nonManifestNonLive = group.items.filter((item) => !liveSet.has(item.key) && item.key !== manifestKey);
    const nonManifestResult = await deleteCandidatesWithCap(identity, nonManifestNonLive, remaining, skipSet);
    deleted += nonManifestResult.deletedKeys.length;
    remaining -= nonManifestResult.attempted;
    if (nonManifestResult.failedKeys.length > 0) await recordGcFailedKeys(identity.key, nonManifestResult.failedKeys);

    if (!group.manifestItem) return; // manifest-less remnant — nothing further to gate

    // v3 manifest-last rule: candidate only when NO deletable non-manifest
    // key remains — none failed, none capped, none skip-set-excluded.
    const remainingNonManifest = nonManifestNonLive.filter((item) => !nonManifestResult.deletedKeys.includes(item.key));
    if (remainingNonManifest.length === 0 && !liveSet.has(manifestKey!) && remaining > 0) {
      const manifestResult = await deleteCandidatesWithCap(identity, [group.manifestItem], remaining, skipSet);
      deleted += manifestResult.deletedKeys.length;
      remaining -= manifestResult.attempted;
      if (manifestResult.failedKeys.length > 0) await recordGcFailedKeys(identity.key, manifestResult.failedKeys);
    }
  }

  if (deferred) {
    // Exactly today's (pre-D18) algorithm. EVERY listed manifest is a root,
    // not just DB-rooted ids.
    const everyListedManifestIds: string[] = [];
    for (const [snapshotId, group] of groups) if (group.manifestItem) everyListedManifestIds.push(snapshotId);
    const rootsForMark = new Set([...alwaysRootedIds, ...everyListedManifestIds]);
    const liveSet = await markLiveBackupObjects(identity, rootsForMark);
    if (liveSet === null) throw new Error('mark phase failed — see prior log line for the specific snapshot/manifest');

    for (const [, group] of groups) {
      if (remaining <= 0) break;
      if (group.manifestItem) await sweepRootedLoose(group, liveSet);
      else await sweepManifestless(group, liveSet);
    }
  } else {
    const orphanIds = orphanManifestSnapshotIds(groups, alwaysRootedIds, retiredSnapshotIds, nowMs, orphanWindowMs);
    const rootsForMark = new Set([...alwaysRootedIds, ...orphanIds]);
    const liveSet = await markLiveBackupObjects(identity, rootsForMark);
    if (liveSet === null) throw new Error('mark phase failed — see prior log line for the specific snapshot/manifest');

    for (const [snapshotId, group] of groups) {
      if (remaining <= 0) break;
      if (rootsForMark.has(snapshotId)) { await sweepRootedLoose(group, liveSet); continue; }
      if (retiredSnapshotIds.has(snapshotId)) { await reclaimUnrooted(group, liveSet); continue; }
      if (!group.manifestItem) { await sweepManifestless(group, liveSet); continue; }
      if (!manifestOlderThanWindow(group.manifestItem, nowMs, orphanWindowMs)) continue; // defensive; unreachable given rootsForMark
      const before = deleted;
      await reclaimUnrooted(group, liveSet);
      if (deleted > before) orphansSwept++; // best-effort metric — see accepted approximation
    }
  }

  // swept_at confirmation — independent of `deferred`, and independent of
  // whatever this run deleted: a retirement is confirmed gone ONLY when
  // THIS run's fresh listing has NO group at all for its snapshotId.
  const retiredSweptIds: string[] = [];
  for (const [snapshotId, retirementId] of retiredSnapshotIds) {
    if (!groups.has(snapshotId)) retiredSweptIds.push(retirementId);
  }

  return { deleted, retiredSweptIds, orphansSwept, selfHealRowIds, unresolvedNullIdentityCount, deletesUsed: deletesRemaining - remaining };
}

/**
 * Capability gate (§3.4 v3): devices considered for an identity are those
 * with a backup_jobs row on it (via storageIdentity match, OR
 * storageIdentity IS NULL with configId in this identity's configs, for
 * legacy jobs predating the column) that are pending/running (any age) or
 * created within the last 30 days. If ANY such device's helper is below
 * BACKUP_SERVER_BASE_MIN_HELPER_VERSION, the whole identity defers.
 */
async function identityHasLegacyHelper(
  identity: { key: string; configIds: string[] },
  nowMs: number,
): Promise<{ deferred: boolean; deviceId?: string; version?: string | null }> {
  const cutoff = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .selectDistinct({ deviceId: backupJobs.deviceId, backupVersion: devices.backupVersion })
    .from(backupJobs)
    .innerJoin(devices, eq(backupJobs.deviceId, devices.id))
    .where(and(
      or(
        eq(backupJobs.storageIdentity, identity.key),
        and(isNull(backupJobs.storageIdentity), inArray(backupJobs.configId, identity.configIds)),
      ),
      or(inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES), gte(backupJobs.createdAt, cutoff)),
    ));

  for (const row of rows) {
    if (!backupHelperSupportsServerBase(row.backupVersion)) {
      return { deferred: true, deviceId: row.deviceId ?? undefined, version: row.backupVersion };
    }
  }
  return { deferred: false };
}

/** Per-identity DB reads gathered in ONE short system context, per §3.7. */
async function loadIdentityGcState(
  identity: BackupGcStorageIdentity,
  nowMs: number,
): Promise<{
  retainedSnapshotIds: string[];
  nullIdentityRows: { id: string; snapshotId: string }[];
  retiredSnapshotIds: Map<string, string>;
  legacyHelper: { deferred: boolean; deviceId?: string; version?: string | null };
}> {
  return withSystemDbAccessContext(async () => {
    // Storage-identity-scoped retained set — deliberately NOT filtered by
    // backupType (every mode publishes snapshots/<id>/manifest.json — the
    // spec's own investigation found the file's earlier "hyperv/mssql use a
    // different namespace" comment factually wrong; see the PR description
    // for the reasoning) and NOT filtered by configId (storage_identity is
    // denormalized onto the row at publish time, so it survives a later
    // providerConfig edit).
    const retainedRows = await db
      .select({ snapshotId: backupSnapshots.snapshotId })
      .from(backupSnapshots)
      .where(eq(backupSnapshots.storageIdentity, identity.key));

    // P1 fix: fetch the primary key `id`, not just `snapshotId` — snapshot_id
    // is NOT unique across identities, so the self-heal write-back below
    // must never match on snapshot_id alone.
    const nullIdentityRows = await db
      .select({ id: backupSnapshots.id, snapshotId: backupSnapshots.snapshotId })
      .from(backupSnapshots)
      .where(and(isNull(backupSnapshots.storageIdentity), inArray(backupSnapshots.configId, identity.configIds)));

    const retirementRows = await db
      .select({ id: backupSnapshotRetirements.id, snapshotId: backupSnapshotRetirements.snapshotId })
      .from(backupSnapshotRetirements)
      .where(and(eq(backupSnapshotRetirements.storageIdentity, identity.key), isNull(backupSnapshotRetirements.sweptAt)));

    const legacyHelper = await identityHasLegacyHelper(identity, nowMs);

    return {
      retainedSnapshotIds: retainedRows.map((r) => r.snapshotId),
      nullIdentityRows,
      retiredSnapshotIds: new Map(retirementRows.map((r) => [r.snapshotId, r.id])),
      legacyHelper,
    };
  });
}

/** Per-identity DB writes applied in ONE short system context, per §3.7 — always AFTER every storage call for this identity has already returned. */
async function applyIdentityGcWriteBacks(
  identity: { key: string },
  writeBacks: { retiredSweptIds: string[]; selfHealRowIds: string[] },
): Promise<void> {
  if (writeBacks.retiredSweptIds.length === 0 && writeBacks.selfHealRowIds.length === 0) return;
  await withSystemDbAccessContext(async () => {
    for (const retirementId of writeBacks.retiredSweptIds) {
      await db.update(backupSnapshotRetirements).set({ sweptAt: new Date() }).where(eq(backupSnapshotRetirements.id, retirementId));
    }
    if (writeBacks.selfHealRowIds.length > 0) {
      // P1 fix: heal by PRIMARY ROW ID, guarded by storage_identity IS NULL —
      // matching on snapshot_id alone could re-stamp a DIFFERENT identity's
      // row sharing the same agent-generated snapshot id; the IS NULL guard
      // also protects against re-stamping a row a concurrent run just healed.
      await db
        .update(backupSnapshots)
        .set({ storageIdentity: identity.key })
        .where(and(inArray(backupSnapshots.id, writeBacks.selfHealRowIds), isNull(backupSnapshots.storageIdentity)));
    }
  });
}

async function pruneSweptRetirements(nowMs: number): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const cutoff = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
    const deletedRows = await db
      .delete(backupSnapshotRetirements)
      .where(and(isNotNull(backupSnapshotRetirements.sweptAt), lt(backupSnapshotRetirements.sweptAt, cutoff)))
      .returning({ id: backupSnapshotRetirements.id });
    if (deletedRows.length > 0) console.log(`[BackupGC] Pruned ${deletedRows.length} swept retirement row(s) older than 30 days`);
  });
}

/**
 * Mark-and-sweep GC over every backup storage identity (provider + endpoint +
 * bucket, grouped across backupConfigs rows). Per-identity failure isolation:
 * one bad/unreachable identity never blocks GC for the others. Bounded total
 * deletes per run (BACKUP_GC_MAX_DELETES_PER_RUN, default 2000, 0 =
 * unlimited) — hitting the cap mid-run just stops cleanly; the sweep is
 * resumable by construction.
 *
 * Fail-closed on unattributed rows: a backup_snapshots row with a NULL
 * config_id can't be mapped to any storage identity, so we can't rule out
 * that its (unknown) objects live in a bucket we're about to sweep. Its mere
 * existence blocks the ENTIRE run.
 *
 * Name and signature deliberately unchanged from pre-D18 — W01's
 * backupWorker.ts call site depends on this exact export.
 */
export async function sweepUnreferencedBackupObjects(): Promise<BackupGcResult> {
  const nowMs = Date.now();
  const graceMs = resolveBackupGcGraceMs();
  const orphanWindowMs = Math.max(resolveBackupOrphanManifestMaxAgeMs(), resolveBackupBaseLeaseMs() + graceMs);
  const manifestlessWindowMs = resolveBackupManifestlessPrefixMaxAgeMs();

  const { unattributedCount, identities, unreachableIdentities } = await withSystemDbAccessContext(async () => {
    const unattributedRows = await db.select({ id: backupSnapshots.id }).from(backupSnapshots).where(isNull(backupSnapshots.configId));
    const destinations = await db
      .select({ id: backupConfigs.id, provider: backupConfigs.provider, providerConfig: backupConfigs.providerConfig })
      .from(backupConfigs);
    const identitiesInner = groupBackupConfigsByStorageIdentity(destinations);
    const unreachable = await logUnreachableStorageIdentities(identitiesInner);
    return { unattributedCount: unattributedRows.length, identities: identitiesInner, unreachableIdentities: unreachable };
  });

  await pruneSweptRetirements(nowMs);

  if (unattributedCount > 0) {
    // Ops-visible (console.error, not debug) and states the remediation:
    // nothing about this self-heals.
    const wedgeMessage =
      `[BackupGC] ${unattributedCount} backup_snapshots row(s) have no config_id — cannot attribute to a ` +
      `storage identity, so their objects could live in ANY bucket. Blocking ALL ${identities.size} identity ` +
      `sweep(s) this run (fail-closed). REMEDIATION REQUIRED: this does not self-heal — attribute the affected ` +
      `row(s) to the correct backup_configs.id, or confirm they're orphaned and delete the row(s), then GC will ` +
      `resume on its next run.`;
    console.error(wedgeMessage);
    captureException(new Error(wedgeMessage));
    console.log(`[BackupGC] Run complete: deleted 0 object(s), ${identities.size} identity/identities skipped`);
    return {
      deleted: 0, skippedIdentities: identities.size, blockedIdentities: 0,
      retiredSwept: 0, orphansSwept: 0, deferredIdentities: 0, unreachableIdentities,
    };
  }

  const suspiciousIdentityKeys = detectSuspiciousStorageIdentityCollisions(identities);
  if (suspiciousIdentityKeys.size > 0) {
    captureException(new Error(
      `[BackupGC] ${suspiciousIdentityKeys.size} storage identity/identities excluded this run: a cruder ` +
      `bucket+host comparison collapses identities normalizeStorageIdentity kept apart — likely an ` +
      `unhandled cosmetic config variant.`,
    ));
  }

  let deleted = 0;
  let skippedIdentities = 0;
  let blockedIdentities = 0;
  let retiredSwept = 0;
  let orphansSwept = 0;
  let deferredIdentities = 0;
  let deletesRemaining = resolveBackupGcMaxDeletesPerRun();

  for (const identity of identities.values()) {
    if (deletesRemaining <= 0) {
      console.log('[BackupGC] Deletion cap reached for this run — stopping cleanly; remaining identities resume next run');
      break;
    }

    if (suspiciousIdentityKeys.has(identity.key)) {
      skippedIdentities++;
      continue;
    }

    if (!BACKUP_GC_SUPPORTED_PROVIDERS.has(identity.provider)) {
      skippedIdentities++;
      console.warn(
        `[BackupGC] Identity ${identity.key}: provider '${identity.provider}' has no GC listing support — skipping (fail-closed)`,
      );
      continue;
    }

    try {
      const state = await loadIdentityGcState(identity, nowMs);
      if (state.legacyHelper.deferred) {
        deferredIdentities++;
        console.warn(`[BackupGC] reclamation deferred: legacy helper ${state.legacyHelper.deviceId} ${state.legacyHelper.version}`);
      }

      const identityResult = await sweepStorageIdentity(
        identity, state.retainedSnapshotIds, state.nullIdentityRows, state.retiredSnapshotIds,
        nowMs, deletesRemaining, graceMs, orphanWindowMs, manifestlessWindowMs,
        state.legacyHelper.deferred,
      );

      if (identityResult.unresolvedNullIdentityCount > 0) {
        console.warn(`[BackupGC] identity deferred: ${identityResult.unresolvedNullIdentityCount} unresolved rows`);
        if (!state.legacyHelper.deferred) deferredIdentities++; // avoid double-counting one identity for both reasons
      }

      deleted += identityResult.deleted;
      retiredSwept += identityResult.retiredSweptIds.length;
      orphansSwept += identityResult.orphansSwept;
      deletesRemaining -= identityResult.deletesUsed;

      await applyIdentityGcWriteBacks(identity, {
        retiredSweptIds: identityResult.retiredSweptIds,
        selfHealRowIds: identityResult.selfHealRowIds,
      });

      if (identityResult.deleted > 0) {
        console.log(`[BackupGC] Identity ${identity.key}: deleted ${identityResult.deleted} object(s)`);
      } else {
        console.debug(`[BackupGC] Identity ${identity.key}: 0 objects deleted`);
      }
    } catch (error) {
      // A sweep abort here is the fail-closed mark/list failure path (an
      // unfetchable/unparseable manifest). Count it as BOTH skipped (broad
      // "not swept" total) and blocked (the distinct signal that a genuine,
      // non-self-healing storage leak may be accumulating for this identity).
      skippedIdentities++;
      blockedIdentities++;
      console.error(`[BackupGC] Identity ${identity.key}: sweep failed — isolated, other identities proceed:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }

  console.log(
    `[BackupGC] Run complete: deleted ${deleted} object(s), ${retiredSwept} retirement(s) confirmed swept, ` +
    `${orphansSwept} orphan(s) swept, ${skippedIdentities} identity/identities skipped, ${deferredIdentities} deferred, ` +
    `${unreachableIdentities} unreachable` + (blockedIdentities > 0 ? ` (${blockedIdentities} blocked by unfetchable manifest — fail-closed)` : ''),
  );

  return { deleted, skippedIdentities, blockedIdentities, retiredSwept, orphansSwept, deferredIdentities, unreachableIdentities };
}
