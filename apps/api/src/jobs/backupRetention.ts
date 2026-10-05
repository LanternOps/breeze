/**
 * Backup Retention — GFS tagging and legal-hold-aware cleanup
 *
 * GFS (Grandfather-Father-Son) retention tags every completed backup snapshot
 * with daily/weekly/monthly/yearly labels. Retention cleanup respects legal
 * holds and immutability windows.
 */

import { realpath as fsRealpath } from 'node:fs/promises';
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
import { backupChains } from '../db/schema/applicationBackup';
import { eq, and, or, lt, gt, gte, desc, inArray, notInArray, isNull, isNotNull, sql } from 'drizzle-orm';
import {
  resolveMsKnob,
  resolveBackupRestorePinLingerMs,
  resolveBackupPublishMarginMs,
  resolveBackupBaseLeaseMs,
  resolveBackupOrphanManifestMaxAgeMs,
} from '../services/backupGcKnobs';
import { backupHelperSupportsServerBase } from '../services/backupHelperCapabilities';
import { BACKUP_KEY_LAYOUTS, isSupportedKeyLayout } from '../services/backupKeyLayout';
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
  iterateBackupObjectsUnderPrefix,
  MANIFEST_FETCH_MAX_BYTES,
  type BackupObjectListing,
} from '../services/backupSnapshotStorage';
import { asRecord, getStringValue } from '../services/recoveryBootstrap';
import { normalizeStorageIdentity } from '../services/backupStorageIdentity';
import {
  fencedIdsForeignTo,
  loadBackupErasureFences,
  loadFenceRefs,
  loadOrgLiveSnapshotIds,
  recordFenceRefsResolved,
  recordFenceRefsUnreadable,
} from '../services/backupErasureFence';

// Re-exported: jobs/backupWorker.ts and existing tests import it from here.
export { normalizeStorageIdentity };
import { captureException } from '../services/sentry';
import {
  loadReservationGcState,
  markReservationRetired,
  reclaimAbandonedReservations,
  tombstoneRetiredReservations,
} from '../services/backupSnapshotIdReservations';
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
  // #5421: a row still anchoring an ACTIVE backup_chains row as its
  // full_snapshot_id. Counted separately from skippedPinned so an operator
  // can tell "held by a live chain base" (releases when the next FULL backup
  // runs) apart from "held by an in-flight job/restore/recovery" (releases in
  // minutes). Like every other pin, it is a retry, never a permanent skip.
  skippedChainBase: number;
  prunedByMaxVersions: number;
  // D17: a row whose DELETE was rejected by the DB (most commonly a
  // NO-ACTION FK still pointing at it from a history table -- restore_jobs,
  // recovery_tokens, backup_chains, backup_verifications, or its own
  // parent_snapshot_id self-reference) is counted here rather than aborting
  // the whole pass. It is retried on the next run -- nothing here is a
  // permanent skip.
  failed: number;
  // A row written in an object-key layout this server does not understand
  // (services/backupKeyLayout.ts) is never retired: retiring it would hand
  // its prefix to storage GC. Left in place, and in its max-versions slot.
  skippedUnsupportedLayout: number;
};

type DeleteSnapshotOutcome = 'deleted' | 'pinned' | 'chainBase' | 'legalHold' | 'immutable' | 'unresolved';

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

  // Chain-base pin (#5421): an ACTIVE backup_chains row whose full_snapshot_id
  // points at this snapshot is still depending on it -- every differential /
  // log snapshot in that chain restores only on top of this full. D17 made
  // that FK `ON DELETE SET NULL` so retention could stop aborting on 23503,
  // which removed the accidental protection the NO-ACTION FK used to give:
  // the delete now silently succeeds, nulls the pointer, and leaves the chain
  // reporting `active`/healthy until the NEXT differential runs and
  // backupResultPersistence marks it `broken`/`missing_full_backup`. Between
  // those two events an operator sees a healthy chain whose base is gone.
  //
  // A chain base is not "expired" while dependants exist, so treat the
  // pointer as a retention hold. The hold is bounded and self-releasing: the
  // chain row is one-per-(device, config, target) and every new FULL backup
  // re-points `full_snapshot_id` at the new snapshot, releasing the previous
  // full on the very next run; a chain that goes `is_active = false` (a new
  // chain type, a broken chain, a removed target) stops holding immediately.
  // Deliberately NOT scoped by orgId: a hold must be maximal. The snapshot's
  // own org already bounds which rows this pass considers, and if a chain row
  // ever carried a mismatched org (data bug, mid-flight org move) the safe
  // outcome is still "hold", not "delete the base out from under it".
  const [chainPin] = await db
    .select({ id: backupChains.id })
    .from(backupChains)
    .where(and(eq(backupChains.fullSnapshotId, params.id), eq(backupChains.isActive, true)))
    .limit(1);
  if (chainPin) return 'chainBase';

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
  // The id's owner row follows: retired once no snapshot row carries the id,
  // then tombstoned when the sweep confirms the prefix gone.
  await markReservationRetired(params.snapshotId, params.orgId);
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
    case 'chainBase': result.skippedChainBase++; break;
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
    skippedChainBase: 0,
    prunedByMaxVersions: 0,
    failed: 0,
    skippedUnsupportedLayout: 0,
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
        keyLayout: backupSnapshots.keyLayout,
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
    if (!isSupportedKeyLayout(snap.keyLayout)) {
      result.skippedUnsupportedLayout++;
      continue;
    }
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
        keyLayout: backupSnapshots.keyLayout,
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
      if (!isSupportedKeyLayout(snap.keyLayout)) {
        result.skippedUnsupportedLayout++;
        continue;
      }
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
    result.skippedPinned > 0 || result.skippedUnresolved > 0 || result.skippedChainBase > 0 ||
    result.prunedByMaxVersions > 0 || result.failed > 0 || result.skippedUnsupportedLayout > 0
  ) {
    console.log(
      `[BackupRetention] Org ${orgId}: deleted ${result.deleted}, ` +
      `skipped ${result.skippedLegalHold} (legal hold), ${result.skippedImmutable} (immutable), ` +
      `${result.skippedPinned} (pinned), ${result.skippedUnresolved} (unresolved identity), ` +
      `${result.skippedChainBase} (active chain base), ` +
      `pruned ${result.prunedByMaxVersions} by maxVersions` +
      (result.skippedUnsupportedLayout > 0
        ? `, kept ${result.skippedUnsupportedLayout} written in a key layout this server cannot read`
        : '') +
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

  // #5400: retentionDays is a FLOOR, not a fallback used only when no GFS
  // tier matched. A shorter matching GFS tier (e.g. keepDaily: 7) must never
  // shorten the configured retentionDays (e.g. 14) -- take the maximum of
  // the two windows. Decision (2026-09-22): GFS may keep a snapshot LONGER
  // than retentionDays, never shorter.
  if (gfsConfig.retentionDays) {
    maxDays = Math.max(maxDays, gfsConfig.retentionDays);
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
//             config_id maps here AND whose manifest is found in THIS run's
//             fresh listing ("resolved") — self-healed by row id at that
//             point. A NULL row that never resolves contributes no root (its
//             object isn't in this bucket to protect) but still counts
//             toward the deferral gate below, since GC cannot yet rule out
//             that a later run's listing will resolve it.
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
//   Fenced:   a snapshot id or recovery-media key recorded by an org erasure
//             (backup_erasure_targets, services/backupErasureFence.ts) is
//             foreign-owned on EVERY identity, forever: never a group of any
//             org's sweep, never an orphan. Its manifests are still marked
//             (markErasureFencedSnapshots) so objects it references under
//             other prefixes stay live (resolved once per identity and
//             stored in backup_erasure_fence_refs). Fences are read after the
//             unit's ownership state and re-read before every delete call.
//             Exception: an id fenced by an org's OWN erasure (one that
//             aborted after capture) stays that org's own while it still
//             holds a live row for it. While any fenced manifest on an
//             identity is unreadable, the identity is deferred.
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
//   blockedIdentities — the SUBSET of skippedIdentities whose sweep failed
//     fail-closed after it started: an unfetchable/unparseable manifest, a
//     failed root listing, a failed per-snapshot re-list (#6834; the sweep
//     stops at that snapshot), or any other sweep error — the signal that a
//     genuine, non-self-healing storage leak may be accumulating.
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

type BackupGcDestination = { id: string; orgId: string; provider: string; providerConfig: unknown };

/**
 * One unit of GC work: a physical storage identity (`key`) AS OWNED BY ONE
 * ORG (`orgId`). Two orgs whose configs resolve to the SAME physical bucket
 * (a real possibility -- config create validates shape only, see
 * each get their OWN entry here, built only from THAT
 * org's own `backupConfigs` rows. This is what stops one tenant's job/config
 * state from deferring or blocking another tenant's sweep (`configIds`,
 * `identityHasLegacyHelper`'s device set, and `loadIdentityGcState`'s
 * root/retirement queries are all scoped to this `orgId`) -- and,
 * separately, `sweepStorageIdentity`'s `foreignOwnedSnapshotIds` argument is
 * what stops this org's sweep from ever treating an object it can attribute
 * to a DIFFERENT org as its own to reclaim, since the two entries still
 * share one physical bucket listing.
 */
export type BackupGcStorageIdentity = {
  key: string;
  orgId: string;
  provider: string;
  // Representative providerConfig used for actual provider calls (list/fetch/
  // delete) — arbitrary choice among the configs sharing this identity FOR
  // THIS ORG, since by construction they resolve to the same physical
  // bucket; may still carry different (but presumably equally valid)
  // credentials or a cosmetic prefix.
  providerConfig: unknown;
  configIds: string[];
};

/** Composite map key -- physical identity AND owning org. Never parsed back apart; only used for Map lookup/iteration. */
function identityOrgMapKey(identityKey: string, orgId: string): string {
  return `${identityKey}\u0000${orgId}`;
}

function groupBackupConfigsByStorageIdentity(
  configs: BackupGcDestination[],
): Map<string, BackupGcStorageIdentity> {
  const identities = new Map<string, BackupGcStorageIdentity>();
  for (const config of configs) {
    const key = normalizeStorageIdentity(config.provider, asRecord(config.providerConfig));
    const mapKey = identityOrgMapKey(key, config.orgId);
    const existing = identities.get(mapKey);
    if (existing) {
      existing.configIds.push(config.id);
      continue;
    }
    identities.set(mapKey, {
      key,
      orgId: config.orgId,
      provider: config.provider,
      providerConfig: config.providerConfig,
      configIds: [config.id],
    });
  }
  return identities;
}

/**
 * Coarse signature for alias detection — deliberately CRUDER than
 * normalizeStorageIdentity, to catch a physical-location alias it doesn't
 * yet know to collapse. Parses the ALREADY-NORMALIZED identity key string
 * (not raw providerConfig), so the SAME function works both for a live
 * identity object (built from a current backupConfigs row) and for a bare,
 * STALE identity string pulled from `backup_snapshots.storage_identity` that
 * no longer has any config behind it at all (review round 1 finding: an
 * edited-away config's old identity is exactly the case
 * detectSuspiciousStorageIdentityCollisions could never see, since it only
 * ever iterated CURRENT configs).
 *
 * s3: bucket lowercased, endpoint reduced to host-only (port dropped) — a
 * cruder collapse than normalizeStorageIdentity's own (virtual-hosted vs
 * path-style, an IP vs its hostname, or a non-default port some
 * self-hosted/MinIO deployments ignore).
 * local: resolved via the REAL filesystem (`fs.realpath`, follows symlinks
 * and bind mounts) — normalizeStorageIdentity's own `path.resolve` is purely
 * LEXICAL and does not collapse a symlink/bind-mount alias, which is exactly
 * review round 1's second finding (local was previously exempted from this
 * check entirely).
 *
 * Review round 2 (HOLD): a `local` root that `fs.realpath` CANNOT resolve is
 * reported, not swallowed. The lexical key is still returned as `signature`
 * (so grouping/matching stays total), but `unresolved` carries the errno so
 * the caller can fail closed — a silent lexical fallback here would be the
 * same non-symlink-following comparison normalizeStorageIdentity already
 * did, i.e. the alias guard would contribute NOTHING in exactly the failure
 * mode it exists for (EACCES / ELOOP / EMFILE / an NFS hiccup on that run).
 * ENOENT is deliberately reported too rather than special-cased here: what
 * it means depends on WHOSE root it is (a current config vs a stale
 * identity string), so that decision lives with the caller — see
 * sweepUnreferencedBackupObjects.
 */
type CoarseStorageSignature = {
  signature: string;
  /** Non-null when a `local` root could not be resolved through the real filesystem. */
  unresolved: { code: string; message: string } | null;
};

async function coarseStorageSignatureFromKey(key: string): Promise<CoarseStorageSignature> {
  if (key.startsWith('local::')) {
    const rawPath = key.slice('local::'.length);
    if (!rawPath) return { signature: 'local::', unresolved: null };
    try {
      return { signature: `local::${await fsRealpath(rawPath)}`, unresolved: null };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
      const message = error instanceof Error ? error.message : String(error);
      return { signature: `local::${rawPath}`, unresolved: { code, message } };
    }
  }
  // Normalized non-local keys are always `${provider}::${endpoint}::${bucket}`
  // (see normalizeStorageIdentity) — endpoint never itself contains `::`, so
  // splitting on the first two occurrences and rejoining the remainder keeps
  // this correct even in the (S3-illegal, but not worth crashing over) event
  // a bucket name were to contain the separator.
  const [provider = '', endpoint = '', ...bucketParts] = key.split('::');
  const bucket = bucketParts.join('::').toLowerCase();
  const hostOnly = endpoint.split(':')[0];
  return { signature: `${provider}::${hostOnly}::${bucket}`, unresolved: null };
}

/**
 * Belt-and-braces: even after normalizeStorageIdentity, an unanticipated
 * cosmetic variant could still produce two DIFFERENT identity keys for the
 * SAME physical bucket/directory — among CURRENT configs. Cross-check every
 * identity (S3 AND local, review round 1: local was previously skipped
 * entirely) with the cruder coarseStorageSignatureFromKey comparison and
 * fail-closed (exclude ALL of them) if it collapses two identities
 * normalizeStorageIdentity kept apart. This catches two live configs
 * aliasing each other; it does NOT catch a config that was EDITED AWAY from
 * an identity old rows still carry — see the separate stale-alias check in
 * sweepUnreferencedBackupObjects, which uses this same coarse signature
 * against `logUnreachableStorageIdentities`'s output.
 */
function detectSuspiciousStorageIdentityCollisions(
  identities: Map<string, BackupGcStorageIdentity>,
  coarseByKey: Map<string, CoarseStorageSignature>,
): Set<string> {
  const coarseGroups = new Map<string, Set<string>>();

  for (const identity of identities.values()) {
    const coarseKey = coarseByKey.get(identity.key)?.signature ?? identity.key;
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
      `all resolve to the same physical location (${coarseKey}) under a cruder comparison — normalizeStorageIdentity ` +
      `likely missed a cosmetic variant. Excluding all of them from this run (fail-closed) to avoid two ` +
      `overlapping sweeps on the same physical bucket/directory.`,
    );
    for (const key of identityKeys) suspicious.add(key);
  }
  return suspicious;
}

// ── Listing summarised by snapshot-ID prefix ──────────────────────────────────
//
// #6834: the sweep never holds a destination's full listing. The root pass
// streams it page by page and folds each key into a per-snapshot SUMMARY —
// just what the mark phase and the per-group decisions need (manifest item,
// newest/oldest mtime, whether any mtime is unknown) — and drops the key.
// Keys are only ever needed for deletion candidates, and those are gathered
// per group by re-listing that one snapshot's prefix at sweep time (see
// sweepStorageIdentity). Memory is O(snapshots) for the summaries plus
// O(min(cap, one group)) for candidates, instead of O(objects in bucket).

type BackupGcSnapshotSummary = {
  manifestItem: BackupObjectListing | null;
  newestMs: number | null; // over items WITH a known last-modified
  oldestMs: number | null; // over items WITH a known last-modified
  hasUnknownAge: boolean; // any item without a last-modified
  // Root pass only (#6840 review). A "bare" key is `snapshots/<id>` itself —
  // no path after the id. It groups under <id> exactly as it did pre-#6834,
  // but a `snapshots/<id>/`-scoped re-list can never return it, so the root
  // pass keeps it (at most one per group) and relistGroup replays it as a
  // member. `hasPathKeys` records whether the group had anything BELOW
  // `snapshots/<id>/`; a group without any is never re-listed at all (on a
  // local destination `<id>` is then a plain file, and walking it as a
  // directory would fail with ENOTDIR).
  bareItem: BackupObjectListing | null;
  hasPathKeys: boolean;
  // Root pass only (#6843 gap 4). A fixed-size, order-independent digest of
  // every key listed under this group EXCEPT the layout key, plus whether the
  // layout key was listed. sweepRootedLoose compares it with the same digest
  // of the group's live keys to prove "every listed key is live" without
  // holding the keys — see listedKeysProvablyAllLive.
  listedKeys: KeySetFingerprint;
  hasLayoutKey: boolean;
};

function emptySnapshotSummary(): BackupGcSnapshotSummary {
  return {
    manifestItem: null, newestMs: null, oldestMs: null, hasUnknownAge: false, bareItem: null, hasPathKeys: false,
    listedKeys: emptyKeySetFingerprint(), hasLayoutKey: false,
  };
}

// ── #6843 gap 4: skip the rooted re-list when nothing can be deleted ────────
//
// A rooted group's re-list exists only to find keys that are (a) not live and
// (b) older than the grace window. When the root pass listed EXACTLY the
// group's live keys, (a) is empty and the re-list is pure cost: one more LIST
// of every object in every rooted snapshot, on every run.
//
// "Exactly" is checked with a count plus two 32-bit lane sums of a SHA-256
// of each key — a multiset digest, O(1) memory per group, independent of
// listing order. Equal digests are taken as equal sets. That is sound in the
// only direction that matters: a false "equal" (a 2^-64 collision) SKIPS the
// group, so its garbage survives this run; it can never cause a delete. Any
// mismatch — a non-live key, a live key missing from storage, a key listed
// twice — falls back to the re-list, i.e. to exactly the pre-#6843 behaviour.
//
// The layout key (`snapshots/<id>/layout.json`) is marked live for every root
// WITHOUT being fetched, so it is live whether or not it exists. It is left
// out of both digests and checked on its own: listed ⇒ must be in the live
// set; not listed ⇒ nothing to delete either way.

type KeySetFingerprint = { count: number; lane0: number; lane1: number };

function emptyKeySetFingerprint(): KeySetFingerprint {
  return { count: 0, lane0: 0, lane1: 0 };
}

function addKeyToFingerprint(fp: KeySetFingerprint, key: string): void {
  const digest = createHash('sha256').update(key).digest();
  fp.count++;
  fp.lane0 = (fp.lane0 + digest.readUInt32BE(0)) >>> 0;
  fp.lane1 = (fp.lane1 + digest.readUInt32BE(4)) >>> 0;
}

function sameKeySetFingerprint(a: KeySetFingerprint, b: KeySetFingerprint): boolean {
  return a.count === b.count && a.lane0 === b.lane0 && a.lane1 === b.lane1;
}

function isLayoutKeyOf(snapshotId: string, key: string): boolean {
  return key === backupLayoutManifestKey(snapshotId);
}

/** Digest of the live keys that group under each snapshot id (same grouping rule as the root pass). */
export function fingerprintLiveKeysBySnapshotId(liveSet: ReadonlySet<string>): Map<string, KeySetFingerprint> {
  const bySnapshotId = new Map<string, KeySetFingerprint>();
  for (const key of liveSet) {
    const snapshotId = snapshotIdOfKey(key);
    if (!snapshotId || isLayoutKeyOf(snapshotId, key)) continue;
    let fp = bySnapshotId.get(snapshotId);
    if (!fp) {
      fp = emptyKeySetFingerprint();
      bySnapshotId.set(snapshotId, fp);
    }
    addKeyToFingerprint(fp, key);
  }
  return bySnapshotId;
}

/**
 * True only when the root pass proves every key it listed under `snapshotId`
 * is live, so the group has no deletion candidate of any age. False means
 * "not proven" (the caller re-lists), never "has garbage". Exported for a
 * direct test of the layout-key guard, which sweepUnreferencedBackupObjects
 * cannot reach today (every root's layout key is marked live).
 */
export function listedKeysProvablyAllLive(
  snapshotId: string,
  summary: BackupGcSnapshotSummary,
  liveSet: ReadonlySet<string>,
  liveFingerprints: ReadonlyMap<string, KeySetFingerprint>,
): boolean {
  if (summary.hasLayoutKey && !liveSet.has(backupLayoutManifestKey(snapshotId))) return false;
  const live = liveFingerprints.get(snapshotId) ?? emptyKeySetFingerprint();
  return sameKeySetFingerprint(summary.listedKeys, live);
}

function bareSnapshotKey(snapshotId: string): string {
  return `${BACKUP_SNAPSHOT_ROOT_DIR}/${snapshotId}`;
}

/**
 * The snapshot id a listed key is grouped under — the first path segment
 * below `snapshots/` — or null for a key outside that namespace (defense in
 * depth; see iterateS3ObjectsWithLastModified) or with an empty segment.
 */
function snapshotIdOfKey(key: string): string | null {
  const rootWithSlash = `${BACKUP_SNAPSHOT_ROOT_DIR}/`;
  if (!key.startsWith(rootWithSlash)) return null;
  const rest = key.slice(rootWithSlash.length);
  const slashIdx = rest.indexOf('/');
  const snapshotId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  return snapshotId || null;
}

function foldIntoSnapshotSummary(summary: BackupGcSnapshotSummary, snapshotId: string, item: BackupObjectListing): void {
  if (item.key === `${BACKUP_SNAPSHOT_ROOT_DIR}/${snapshotId}/${BACKUP_SNAPSHOT_MANIFEST_KEY}`) {
    summary.manifestItem = item;
  }
  if (!item.lastModified) {
    summary.hasUnknownAge = true;
    return;
  }
  const ms = item.lastModified.getTime();
  if (summary.newestMs === null || ms > summary.newestMs) summary.newestMs = ms;
  if (summary.oldestMs === null || ms < summary.oldestMs) summary.oldestMs = ms;
}

/**
 * Map iteration order is first-seen order, i.e. the same group order the
 * pre-#6834 groupListingBySnapshotId produced from the materialised array —
 * which is the order the per-run delete cap is spent across groups.
 */
async function summarizeListingBySnapshotId(
  pages: AsyncIterable<BackupObjectListing[]>,
): Promise<Map<string, BackupGcSnapshotSummary>> {
  const groups = new Map<string, BackupGcSnapshotSummary>();
  for await (const page of pages) {
    for (const item of page) {
      const snapshotId = snapshotIdOfKey(item.key);
      if (!snapshotId) continue;
      let summary = groups.get(snapshotId);
      if (!summary) {
        summary = emptySnapshotSummary();
        groups.set(snapshotId, summary);
      }
      if (item.key === bareSnapshotKey(snapshotId)) summary.bareItem = item;
      else summary.hasPathKeys = true;
      if (isLayoutKeyOf(snapshotId, item.key)) summary.hasLayoutKey = true;
      else addKeyToFingerprint(summary.listedKeys, item.key);
      foldIntoSnapshotSummary(summary, snapshotId, item);
    }
  }
  return groups;
}

/**
 * The re-list a group's candidates come from is a SECOND read of the bucket,
 * so it can observe changes made since the root pass (a manifest published
 * or re-written, a partial upload resuming). The mark set and every
 * per-group decision were made from the root pass, so a group whose manifest
 * no longer matches it is skipped this run — never swept on a mixed view.
 */
function sameManifestState(a: BackupObjectListing | null, b: BackupObjectListing | null): boolean {
  if (a === null || b === null) return a === b;
  return (a.lastModified?.getTime() ?? null) === (b.lastModified?.getTime() ?? null);
}

/** Pre-#6834 manifest-less rule: every object known-aged and the newest past the window. */
function manifestlessPrefixExpired(summary: BackupGcSnapshotSummary, manifestlessThreshold: number): boolean {
  return !summary.hasUnknownAge && summary.newestMs !== null && summary.newestMs <= manifestlessThreshold;
}

/** Thrown only by a per-group re-list, so the sweep can stop cleanly (see sweepStorageIdentity). */
class BackupGcGroupRelistError extends Error {
  constructor(readonly snapshotId: string, cause: unknown) {
    super(`re-list of snapshot prefix ${snapshotId} failed`, { cause });
    this.name = 'BackupGcGroupRelistError';
  }
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
  groups: Map<string, { manifestItem: BackupObjectListing | null }>,
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
 * unless logged here.
 *
 * Review round 1 finding: this used to be visibility-only (a warning, no
 * effect on the run). That's unsafe — an edited config (e.g. a virtual-hosted
 * vs path-style S3 endpoint, or an IP swapped for its hostname) can produce a
 * DIFFERENT normalized identity string while pointing at the SAME physical
 * bucket. Rows still carrying the OLD string become unreachable by this
 * function's own definition, but their objects are NOT actually gone — they
 * sit in the bucket the NEW identity is about to sweep, invisible to the
 * NEW identity's root query, and (once old enough) indistinguishable from
 * genuine orphan garbage. Returning the unreachable KEYS (not just a count)
 * lets the caller cross-check each identity it's about to sweep against
 * them via coarseStorageSignatureFromKey and defer instead of reclaim on a
 * coarse match — see sweepUnreferencedBackupObjects.
 */
/**
 * Unreachable is a property of the PHYSICAL identity, not of any one org's
 * ownership of it -- a row's identity string is unreachable when NO current
 * config, for ANY org, still produces it, regardless of which org the row
 * itself belongs to. Callers pass the set of distinct `.key` values from the
 * (identity, org) grouping, not the grouping map itself.
 */
async function logUnreachableStorageIdentities(
  currentIdentityKeys: ReadonlySet<string>,
): Promise<{ count: number; keys: string[] }> {
  const usage = await db
    .select({
      storageIdentity: backupSnapshots.storageIdentity,
      count: sql<number>`count(*)`,
    })
    .from(backupSnapshots)
    .groupBy(backupSnapshots.storageIdentity);

  const keys: string[] = [];
  for (const row of usage) {
    // A NULL storage_identity is not "unreachable" — it's an unresolved row
    // the self-heal path owns.
    if (row.storageIdentity === null) continue;
    if (currentIdentityKeys.has(row.storageIdentity)) continue;
    keys.push(row.storageIdentity);
    console.warn(`[BackupGC] unreachable identity ${row.storageIdentity}: ${row.count} rows`);
  }
  return { count: keys.length, keys };
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
        maxBytes: MANIFEST_FETCH_MAX_BYTES,
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
        maxBytes: MANIFEST_FETCH_MAX_BYTES,
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

/**
 * #6843 gap 5: OldestFirstCandidates buffers at most 2×cap candidates — fine
 * for the default per-run cap (2000), but resolveBackupGcMaxDeletesPerRun's
 * "0 = unlimited" convention passes Number.MAX_SAFE_INTEGER straight through
 * as `cap`, so a single snapshot's re-list would buffer EVERY non-live
 * candidate it sees before deleting any of them — unbounded memory for one
 * group, the same OOM class #6834 removed from the root listing. This bounds
 * every OldestFirstCandidates construction independently of the per-run cap:
 * a group with more deletable objects than this in one run has the rest
 * picked up by a later run (the sweep is resumable by construction either
 * way), while the overall per-run cap semantics (0 = no OVERALL limit across
 * groups/identities) are unchanged.
 */
export const BACKUP_GC_MAX_CANDIDATE_BUFFER_PER_GROUP = 5000;

function candidateBufferCap(remaining: number): number {
  return Math.min(remaining, BACKUP_GC_MAX_CANDIDATE_BUFFER_PER_GROUP);
}

/**
 * Streaming equivalent of the pre-#6834 "filter out the skip set, sort
 * oldest-first, take the first `cap`" over a fully materialised candidate
 * array: selects the IDENTICAL keys (ties keep offer order, as the stable
 * sort did) while holding at most 2×cap candidates at a time.
 */
class OldestFirstCandidates {
  private buffer: { item: BackupObjectListing; seq: number }[] = [];
  private nextSeq = 0;
  private offered = 0;
  private readonly limit: number;

  constructor(cap: number, private readonly skipSet: Set<string>) {
    // Array.prototype.slice truncated a fractional cap the same way.
    this.limit = cap > 0 ? Math.floor(cap) : 0;
  }

  offer(item: BackupObjectListing): void {
    if (this.limit === 0 || this.skipSet.has(item.key)) return;
    this.offered++;
    this.buffer.push({ item, seq: this.nextSeq++ });
    if (this.buffer.length >= this.limit * 2) this.truncate();
  }

  selected(): BackupObjectListing[] {
    this.truncate();
    return this.buffer.map((entry) => entry.item);
  }

  // #6843 review: how many offered (non-skip-set) candidates this cap
  // dropped — only meaningful after `selected()` has run (it truncates the
  // buffer down to `limit`). Used to warn when BACKUP_GC_MAX_CANDIDATE_BUFFER_PER_GROUP,
  // not the ordinary per-run cap, is what caused the drop.
  get droppedCount(): number {
    return this.offered - this.buffer.length;
  }

  private truncate(): void {
    this.buffer.sort((a, b) =>
      ((a.item.lastModified?.getTime() ?? 0) - (b.item.lastModified?.getTime() ?? 0)) || (a.seq - b.seq));
    if (this.buffer.length > this.limit) this.buffer.length = this.limit;
  }
}

async function deleteSelectedCandidates(
  identity: { provider: string; providerConfig: unknown },
  selected: BackupObjectListing[],
): Promise<{ deletedKeys: string[]; failedKeys: { key: string; error: string }[]; attempted: number }> {
  if (selected.length === 0) return { deletedKeys: [], failedKeys: [], attempted: 0 };
  const toDelete = selected.map((c) => c.key);
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
 *
 * #6834 — two storage passes, neither holding the full listing:
 *   1. ROOT pass: stream `snapshots/` into per-snapshot summaries
 *      (summarizeListingBySnapshotId). Every decision that the pre-#6834 code
 *      made from the listing — root set, NULL-row resolution, deferral,
 *      orphan ages, manifest-less expiry, retirement swept-confirmation — is
 *      made from these summaries, i.e. from THIS run's fresh root listing.
 *   2. Per-group RE-LIST: for each group the sweep acts on, stream that one
 *      snapshot's prefix and keep only its deletion candidates (bounded by
 *      the remaining cap, OldestFirstCandidates). A group whose re-list no
 *      longer matches the root pass (manifest appeared/vanished/rewritten,
 *      or a manifest-less prefix gained a fresh object) is skipped this run.
 *      Objects that appear between the two passes can only be deletion
 *      candidates if they also satisfy the same age rules as before.
 * A bare key directly under the root with no path after the id
 * (`snapshots/<x>`) is never returned by a `snapshots/<x>/`-scoped re-list,
 * so the root pass keeps it on the group summary and relistGroup replays it
 * as a member; a group consisting ONLY of a bare key is not re-listed at
 * all. Bare keys are therefore treated exactly as the pre-#6834 single
 * listing treated them (#6840 review).
 */
/**
 * ONE streamed listing pass over a physical storage identity's bucket,
 * shared by every org whose config resolves to that same identity. Listing
 * is by far the most expensive part of a sweep (network I/O over the whole
 * `snapshots/` prefix), and an MSP routinely points every one of its orgs'
 * configs at one shared bucket -- grouping GC work per (identity, org) must
 * never turn into one full bucket listing per org sharing it, or a 50-org
 * partner turns a single sweep into 50 listings of the same data (the root
 * cause of the 2026-09-23 production OOM/long-GC-run incident). The caller
 * lists once per DISTINCT physical `key` and reuses the same read-only
 * `groups` summary for every org's own `sweepStorageIdentity` call.
 */
async function listStorageIdentityGroups(
  identity: { provider: string; providerConfig: unknown },
): Promise<Map<string, BackupGcSnapshotSummary>> {
  assertOutsideHeldDbContext('backupGC.listStorageIdentityGroups');
  return summarizeListingBySnapshotId(iterateBackupObjectsUnderPrefix({
    provider: identity.provider,
    providerConfig: identity.providerConfig,
    prefix: backupSnapshotRootPrefix(),
  }));
}

async function sweepStorageIdentity(
  identity: { key: string; provider: string; providerConfig: unknown },
  // Already fetched by the caller via listStorageIdentityGroups(), ONCE per
  // physical identity -- never re-listed per org. Read-only from here; this
  // function partitions it into `ownGroups` via `foreignOwnedSnapshotIds`
  // rather than fetching its own copy.
  groups: Map<string, BackupGcSnapshotSummary>,
  retainedSnapshotIds: string[],
  nullIdentityRows: { id: string; snapshotId: string }[], // storage_identity IS NULL, configId maps to this identity
  retiredSnapshotIds: Map<string, string>, // snapshotId -> retirement row id, sweptAt IS NULL only
  // Snapshot ids this run's bucket listing may contain
  // that belong to a DIFFERENT org sharing this same physical `key`. Never a
  // root, never a deletion candidate, never even orphan-considered — every
  // group whose id is in this set is skipped entirely this run, exactly as
  // if it were not listed. This is what makes it safe for this org's sweep
  // and another org's sweep to run independently over the SAME bucket: each
  // only ever acts on the groups it can prove are its own (via its own
  // retained/retirement rows) or that NO org owns at all (genuine orphans).
  foreignOwnedSnapshotIds: ReadonlySet<string>,
  nowMs: number,
  deletesRemaining: number,
  graceMs: number,
  orphanWindowMs: number,
  manifestlessWindowMs: number,
  legacyHelperDeferred: boolean,
  // Org-erasure fences (services/backupErasureFence.ts). Fenced snapshot ids
  // are already in `foreignOwnedSnapshotIds`; `extraLiveKeys` holds every key
  // a fenced snapshot's manifests reference (wherever it lives) plus every
  // fenced recovery-media key, and is merged into the live set so no sweep
  // path can select them. `recheck` re-reads the fences immediately before
  // every delete call and drops any candidate fenced since this sweep began.
  fenceProtection: {
    extraLiveKeys: ReadonlySet<string>;
    recheck: (snapshotIds: string[], objectKeys: string[]) => Promise<{ snapshotIds: Set<string>; objectKeys: Set<string> }>;
  } | null = null,
): Promise<{
  deleted: number;
  retiredSweptIds: string[]; // retirement row ids CONFIRMED fully gone from THIS run's fresh listing
  orphansSwept: number; // best-effort metric — see the accepted-approximation note above
  selfHealRowIds: string[]; // backup_snapshots.id values to self-heal
  unresolvedNullIdentityCount: number;
  // Review round 1: an operator seeing "N unresolved rows" in the log has
  // nothing to query. These are the actual snapshot ids so the deferral is
  // actionable (`SELECT * FROM backup_snapshots WHERE snapshot_id IN (...)`).
  unresolvedSnapshotIds: string[];
  deletesUsed: number;
  // #6834: a per-group re-list failed. The sweep stopped at that group (no
  // later group was touched); everything above is still accurate — in
  // particular deletesUsed, so the per-run cap stays honest — and the caller
  // reports the identity as failed.
  relistFailure: BackupGcGroupRelistError | null;
}> {
  assertOutsideHeldDbContext('backupGC.sweepStorageIdentity');

  // Every decision below (root set, deferred-algorithm
  // rooting, orphan detection, the two sweep loops) is made from `ownGroups`,
  // never the raw `groups` — a group this run's listing found that belongs
  // to a DIFFERENT org sharing this bucket is invisible to this org's sweep,
  // full stop. `groups` itself is kept only for the final retired-swept
  // confirmation below, where using the unfiltered listing vs. `ownGroups`
  // makes no difference (this org's own retirement ids are never foreign)
  // but the unfiltered listing is the more literally correct "is this
  // snapshot id physically gone from the bucket" check.
  const ownGroups = foreignOwnedSnapshotIds.size === 0
    ? groups
    : new Map([...groups].filter(([snapshotId]) => !foreignOwnedSnapshotIds.has(snapshotId)));

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
  const resolvedNullRows = nullIdentityRows.filter((r) => ownGroups.get(r.snapshotId)?.manifestItem);
  const unresolvedNullRows = nullIdentityRows.filter((r) => !ownGroups.get(r.snapshotId)?.manifestItem);
  const selfHealRowIds = resolvedNullRows.map((r) => r.id);
  const unresolvedNullIdentityCount = unresolvedNullRows.length;
  const unresolvedSnapshotIds = unresolvedNullRows.map((r) => r.snapshotId);
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

  // Streams one snapshot's own prefix, handing each member key to `onItem`
  // and returning a fresh summary of the group for the caller to compare
  // against the root pass. Membership is re-checked with the SAME grouping
  // rule as the root pass, so a provider that ignores or widens the prefix
  // can never leak another group's key in.
  //
  // The group's bare key (if the root pass saw one) is replayed FIRST, from
  // the root pass — the position S3's lexicographic order gave it before
  // `snapshots/<id>/…` — so every per-group rule (candidates, the
  // manifest-last count, the manifest-less age gate) sees the same members
  // the pre-#6834 single listing did. A group with no keys below
  // `snapshots/<id>/` in the root pass is not re-listed.
  async function relistGroup(
    snapshotId: string,
    rootSummary: BackupGcSnapshotSummary,
    onItem: (item: BackupObjectListing) => void,
  ): Promise<BackupGcSnapshotSummary> {
    const summary = emptySnapshotSummary();
    const bareKey = bareSnapshotKey(snapshotId);
    if (rootSummary.bareItem) {
      foldIntoSnapshotSummary(summary, snapshotId, rootSummary.bareItem);
      onItem(rootSummary.bareItem);
    }
    if (!rootSummary.hasPathKeys) return summary;
    const pages = iterateBackupObjectsUnderPrefix({
      provider: identity.provider,
      providerConfig: identity.providerConfig,
      prefix: `${BACKUP_SNAPSHOT_ROOT_DIR}/${snapshotId}`,
    });
    for (;;) {
      // Only the storage read is classified as a re-list failure; an error
      // from the per-item logic below propagates unwrapped (and fails the
      // identity like any other sweep error) so it is never misreported as
      // a provider outage.
      let next: IteratorResult<BackupObjectListing[]>;
      try {
        next = await pages.next();
      } catch (error) {
        throw new BackupGcGroupRelistError(snapshotId, error);
      }
      if (next.done) break;
      for (const item of next.value) {
        if (snapshotIdOfKey(item.key) !== snapshotId) continue;
        if (item.key === bareKey) continue; // already replayed from the root pass (a provider ignoring Prefix)
        foldIntoSnapshotSummary(summary, snapshotId, item);
        onItem(item);
      }
    }
    return summary;
  }

  function logGroupChanged(snapshotId: string, what: string): void {
    console.warn(`[BackupGC] identity ${identity.key}: snapshot ${snapshotId} ${what} between listing passes — skipped this run`);
  }

  // #6843 review: BACKUP_GC_MAX_CANDIDATE_BUFFER_PER_GROUP truncating a
  // group's candidates is otherwise invisible to an operator watching GC
  // logs — a group whose stale-object count grows faster than the cap could
  // silently plateau with no signal explaining why. Only warns when the
  // GROUP cap (not the ordinary, expected per-run cap) is what bound this
  // group — `groupCap < remaining` is true only when the hard per-group cap
  // won the Math.min in candidateBufferCap.
  function warnIfCandidateBufferCapped(
    snapshotId: string,
    groupCap: number,
    remainingAtGroupStart: number,
    candidates: OldestFirstCandidates,
  ): void {
    if (groupCap < remainingAtGroupStart && candidates.droppedCount > 0) {
      console.warn(
        `[BackupGC] identity ${identity.key}: snapshot ${snapshotId} candidate buffer capped at ` +
        `${BACKUP_GC_MAX_CANDIDATE_BUFFER_PER_GROUP} — ${candidates.droppedCount} object(s) deferred to a later run`,
      );
    }
  }

  // Pre-delete fence re-read. A candidate whose snapshot id or key was fenced
  // after this sweep loaded its state (an erasure that captured mid-sweep) is
  // dropped here, so it is neither deleted nor charged; a dropped
  // non-manifest key also keeps reclaimUnrooted's manifest-last rule from
  // removing that prefix's manifest.
  async function dropNewlyFenced(selected: BackupObjectListing[]): Promise<BackupObjectListing[]> {
    if (!fenceProtection || selected.length === 0) return selected;
    const keys = selected.map((c) => c.key);
    const ids = [...new Set(keys.map(snapshotIdOfKey).filter((id): id is string => id !== null))];
    const fresh = await fenceProtection.recheck(ids, keys);
    if (fresh.snapshotIds.size === 0 && fresh.objectKeys.size === 0) return selected;
    const kept = selected.filter((c) => {
      const id = snapshotIdOfKey(c.key);
      return !fresh.objectKeys.has(c.key) && !(id !== null && fresh.snapshotIds.has(id));
    });
    console.warn(
      `[BackupGC] identity ${identity.key}: ${selected.length - kept.length} candidate(s) fenced by an org erasure ` +
      'during this sweep — kept, not deleted',
    );
    return kept;
  }

  async function deleteAndCharge(selected: BackupObjectListing[]): Promise<string[]> {
    const result = await deleteSelectedCandidates(identity, await dropNewlyFenced(selected));
    deleted += result.deletedKeys.length;
    remaining -= result.attempted;
    if (result.failedKeys.length > 0) await recordGcFailedKeys(identity.key, result.failedKeys);
    return result.deletedKeys;
  }

  async function sweepRootedLoose(
    snapshotId: string,
    summary: BackupGcSnapshotSummary,
    liveSet: Set<string>,
    liveFingerprints: ReadonlyMap<string, KeySetFingerprint>,
  ): Promise<void> {
    // A candidate needs a known last-modified at/before the grace threshold;
    // if no object in the root pass was that old, there is none to find.
    if (summary.oldestMs === null || summary.oldestMs > graceThreshold) return;
    // #6843 gap 4: a candidate must also be non-live; if the root pass listed
    // only live keys there is none to find either (see listedKeysProvablyAllLive).
    if (listedKeysProvablyAllLive(snapshotId, summary, liveSet, liveFingerprints)) return;
    const remainingAtGroupStart = remaining;
    const groupCap = candidateBufferCap(remaining);
    const candidates = new OldestFirstCandidates(groupCap, skipSet);
    const current = await relistGroup(snapshotId, summary, (item) => {
      if (!liveSet.has(item.key) && item.lastModified && item.lastModified.getTime() <= graceThreshold) {
        candidates.offer(item);
      }
    });
    if (!sameManifestState(summary.manifestItem, current.manifestItem)) {
      logGroupChanged(snapshotId, 'manifest changed');
      return;
    }
    await deleteAndCharge(candidates.selected());
    warnIfCandidateBufferCapped(snapshotId, groupCap, remainingAtGroupStart, candidates);
  }

  async function sweepManifestless(snapshotId: string, summary: BackupGcSnapshotSummary, liveSet: Set<string>): Promise<void> {
    if (!manifestlessPrefixExpired(summary, manifestlessThreshold)) return;
    const remainingAtGroupStart = remaining;
    const groupCap = candidateBufferCap(remaining);
    const candidates = new OldestFirstCandidates(groupCap, skipSet);
    const current = await relistGroup(snapshotId, summary, (item) => {
      if (!liveSet.has(item.key)) candidates.offer(item);
    });
    if (current.manifestItem !== null) {
      logGroupChanged(snapshotId, 'gained a manifest');
      return;
    }
    if (!manifestlessPrefixExpired(current, manifestlessThreshold)) {
      logGroupChanged(snapshotId, 'gained a recent or unknown-age object');
      return;
    }
    await deleteAndCharge(candidates.selected());
    warnIfCandidateBufferCapped(snapshotId, groupCap, remainingAtGroupStart, candidates);
  }

  // Retired (any age) OR old-orphan two-phase reclaim. Also handles a
  // "manifest-less retired remnant" (manifest already gone from a prior run)
  // — in that case there is no manifest-gating to do, just delete everything
  // non-live in one phase. Never sets swept_at itself.
  async function reclaimUnrooted(snapshotId: string, summary: BackupGcSnapshotSummary, liveSet: Set<string>): Promise<void> {
    const manifestKey = backupSnapshotManifestKey(snapshotId);
    const remainingAtGroupStart = remaining;
    const groupCap = candidateBufferCap(remaining);
    const candidates = new OldestFirstCandidates(groupCap, skipSet);
    let nonManifestNonLiveCount = 0;
    const current = await relistGroup(snapshotId, summary, (item) => {
      if (liveSet.has(item.key) || item.key === manifestKey) return;
      nonManifestNonLiveCount++;
      candidates.offer(item);
    });
    if (!sameManifestState(summary.manifestItem, current.manifestItem)) {
      logGroupChanged(snapshotId, 'manifest changed');
      return;
    }

    const selected = candidates.selected();
    const deletedKeys = await deleteAndCharge(selected);
    warnIfCandidateBufferCapped(snapshotId, groupCap, remainingAtGroupStart, candidates);

    if (!current.manifestItem) return; // manifest-less remnant — nothing further to gate

    // v3 manifest-last rule: candidate only when NO deletable non-manifest
    // key remains — none failed, none capped, none skip-set-excluded. The
    // count covers EVERY non-manifest non-live key (skip-set and over-cap
    // ones included), so only a fully deleted set reaches zero.
    const selectedKeys = new Set(selected.map((c) => c.key));
    const deletedFromSelected = new Set(deletedKeys.filter((key) => selectedKeys.has(key))).size;
    const remainingNonManifest = nonManifestNonLiveCount - deletedFromSelected;
    if (remainingNonManifest === 0 && !liveSet.has(manifestKey) && remaining > 0) {
      const manifestCandidate = new OldestFirstCandidates(candidateBufferCap(remaining), skipSet);
      manifestCandidate.offer(current.manifestItem);
      await deleteAndCharge(manifestCandidate.selected());
    }
  }

  let relistFailure: BackupGcGroupRelistError | null = null;
  // Runs one group's sweep; returns false (stop the loop) after a re-list
  // failure. Delete/other errors propagate exactly as before.
  async function runGroup(step: () => Promise<void>): Promise<boolean> {
    try {
      await step();
      return true;
    } catch (error) {
      if (error instanceof BackupGcGroupRelistError) {
        relistFailure = error;
        return false;
      }
      throw error;
    }
  }

  if (deferred) {
    // Exactly today's (pre-D18) algorithm. EVERY listed manifest is a root,
    // not just DB-rooted ids.
    const everyListedManifestIds: string[] = [];
    for (const [snapshotId, group] of ownGroups) if (group.manifestItem) everyListedManifestIds.push(snapshotId);
    const rootsForMark = new Set([...alwaysRootedIds, ...everyListedManifestIds]);
    const liveSet = await markLiveBackupObjects(identity, rootsForMark);
    if (liveSet === null) throw new Error('mark phase failed — see prior log line for the specific snapshot/manifest');
    for (const key of fenceProtection?.extraLiveKeys ?? []) liveSet.add(key);
    const liveFingerprints = fingerprintLiveKeysBySnapshotId(liveSet);

    for (const [snapshotId, group] of ownGroups) {
      if (remaining <= 0) break;
      const ok = await runGroup(() => (group.manifestItem
        ? sweepRootedLoose(snapshotId, group, liveSet, liveFingerprints)
        : sweepManifestless(snapshotId, group, liveSet)));
      if (!ok) break;
    }
  } else {
    const orphanIds = orphanManifestSnapshotIds(ownGroups, alwaysRootedIds, retiredSnapshotIds, nowMs, orphanWindowMs);
    const rootsForMark = new Set([...alwaysRootedIds, ...orphanIds]);
    const liveSet = await markLiveBackupObjects(identity, rootsForMark);
    if (liveSet === null) throw new Error('mark phase failed — see prior log line for the specific snapshot/manifest');
    for (const key of fenceProtection?.extraLiveKeys ?? []) liveSet.add(key);
    const liveFingerprints = fingerprintLiveKeysBySnapshotId(liveSet);

    // Review round 1 (suggestion, accepted as a known limitation rather than
    // fixed): the per-run cap is spent in LISTING order across groups here
    // (each group's own candidates are sorted oldest-first internally, via
    // OldestFirstCandidates, but there is no global oldest-first ordering
    // ACROSS groups within this identity, unlike the pre-D18 implementation
    // which collected every deletable item for the whole identity before
    // sorting once). A busy, recently-modified retired/orphan prefix
    // appearing early in the listing can therefore exhaust the cap before an
    // older, more overdue prefix later in iteration order is even reached.
    // Not fixed this wave: the identity-wide collect-then-sort shape doesn't
    // compose cleanly with the two-phase (non-manifest, then manifest)
    // per-group rule without buffering every candidate across every group
    // before deciding anything — a larger restructure than this finding
    // warrants on its own. The garbage is never lost, only delayed to a
    // later run (the sweep is resumable by construction either way).
    for (const [snapshotId, group] of ownGroups) {
      if (remaining <= 0) break;
      let step: (() => Promise<void>) | null = null;
      let countsAsOrphan = false;
      if (rootsForMark.has(snapshotId)) step = () => sweepRootedLoose(snapshotId, group, liveSet, liveFingerprints);
      else if (retiredSnapshotIds.has(snapshotId)) step = () => reclaimUnrooted(snapshotId, group, liveSet);
      else if (!group.manifestItem) step = () => sweepManifestless(snapshotId, group, liveSet);
      else if (manifestOlderThanWindow(group.manifestItem, nowMs, orphanWindowMs)) {
        step = () => reclaimUnrooted(snapshotId, group, liveSet);
        countsAsOrphan = true;
      }
      // else: defensive; unreachable given rootsForMark (a young orphan is a root)
      if (!step) continue;
      const before = deleted;
      const ok = await runGroup(step);
      if (countsAsOrphan && deleted > before) orphansSwept++; // best-effort metric — see accepted approximation
      if (!ok) break;
    }
  }

  // swept_at confirmation — independent of `deferred`, and independent of
  // whatever this run deleted: a retirement is confirmed gone ONLY when
  // THIS run's fresh (root-pass) listing has NO group at all for its
  // snapshotId. Deliberately NOT informed by the per-group re-lists.
  const retiredSweptIds: string[] = [];
  for (const [snapshotId, retirementId] of retiredSnapshotIds) {
    if (!groups.has(snapshotId)) retiredSweptIds.push(retirementId);
  }

  return {
    deleted, retiredSweptIds, orphansSwept, selfHealRowIds,
    unresolvedNullIdentityCount, unresolvedSnapshotIds,
    deletesUsed: deletesRemaining - remaining,
    relistFailure,
  };
}

/**
 * Capability gate (§3.4 v3): devices considered for an identity are those
 * with a backup_jobs row on it (via storageIdentity match, OR
 * storageIdentity IS NULL with configId in this identity's configs, for
 * legacy jobs predating the column) that are pending/running (any age) or
 * created within the last 30 days. If ANY such device's helper is below
 * BACKUP_SERVER_BASE_MIN_HELPER_VERSION, the whole identity defers.
 *
 * `eq(backupJobs.orgId, identity.orgId)` is load-bearing:
 * without it, the FIRST branch of the `storageIdentity` match (a job whose
 * denormalized `storage_identity` column equals the SAME physical bucket a
 * different org shares) would let a foreign org's own device/job defer THIS
 * org's identity, even though `identity.configIds` is already scoped to this
 * org's own configs. The second branch (NULL storageIdentity + configId IN
 * this identity's configIds) is already org-scoped through `configIds` and
 * needs no separate filter, but the org check applies uniformly for clarity.
 */
async function identityHasLegacyHelper(
  identity: { key: string; orgId: string; configIds: string[] },
  nowMs: number,
): Promise<{ deferred: boolean; deviceId?: string; version?: string | null }> {
  const cutoff = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .selectDistinct({ deviceId: backupJobs.deviceId, backupVersion: devices.backupVersion })
    .from(backupJobs)
    .innerJoin(devices, eq(backupJobs.deviceId, devices.id))
    .where(and(
      eq(backupJobs.orgId, identity.orgId),
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
    // Storage-identity-scoped retained set, now ALSO org-scoped
    // Two orgs can share the same physical `key`, and
    // this org's root set must never include another org's live snapshots —
    // that is what `foreignOwnedSnapshotIds` (built by the caller from the
    // UNION of this query across every org sharing `key`) protects against
    // during the sweep. NOT filtered by backupType (every mode publishes
    // snapshots/<id>/manifest.json — the spec's own investigation found the
    // file's earlier "hyperv/mssql use a different namespace" comment
    // factually wrong; see the PR description for the reasoning) and NOT
    // filtered by configId (storage_identity is denormalized onto the row
    // at publish time, so it survives a later providerConfig edit).
    const retainedRows = await db
      .select({ snapshotId: backupSnapshots.snapshotId })
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.storageIdentity, identity.key), eq(backupSnapshots.orgId, identity.orgId)));

    // P1 fix: fetch the primary key `id`, not just `snapshotId` — snapshot_id
    // is NOT unique across identities, so the self-heal write-back below
    // must never match on snapshot_id alone. Already org-scoped through
    // `identity.configIds` (this org's own configs only).
    const nullIdentityRows = await db
      .select({ id: backupSnapshots.id, snapshotId: backupSnapshots.snapshotId })
      .from(backupSnapshots)
      .where(and(isNull(backupSnapshots.storageIdentity), inArray(backupSnapshots.configId, identity.configIds)));

    const retirementRows = await db
      .select({ id: backupSnapshotRetirements.id, snapshotId: backupSnapshotRetirements.snapshotId })
      .from(backupSnapshotRetirements)
      .where(and(
        eq(backupSnapshotRetirements.storageIdentity, identity.key),
        eq(backupSnapshotRetirements.orgId, identity.orgId),
        isNull(backupSnapshotRetirements.sweptAt),
      ));

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
    const sweptSnapshotIds: string[] = [];
    for (const retirementId of writeBacks.retiredSweptIds) {
      const [row] = await db.update(backupSnapshotRetirements).set({ sweptAt: new Date() })
        .where(eq(backupSnapshotRetirements.id, retirementId))
        .returning({ snapshotId: backupSnapshotRetirements.snapshotId });
      if (row?.snapshotId) sweptSnapshotIds.push(row.snapshotId);
    }
    // A retired id whose prefix is confirmed gone is tombstoned for good.
    await tombstoneRetiredReservations(sweptSnapshotIds);
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
 * Test seams for the GC/erasure race scenarios (backupErasureFence.integration.test.ts).
 * Never set in production code.
 */
export const __backupGcTestHooks: {
  /** Before an (identity, org) unit loads its ownership state. */
  beforeIdentityState?: (identity: BackupGcStorageIdentity) => Promise<void>;
  /** After the unit has read its erasure fences, before it sweeps. */
  afterFenceRead?: (identity: BackupGcStorageIdentity) => Promise<void>;
} = {};

/**
 * Keys referenced by erasure-fenced snapshots on one physical identity,
 * OUTSIDE each snapshot's own prefix. A fenced snapshot is never a sweep group
 * of any org (it is foreign-owned), so keys under its own prefix are already
 * safe; but its manifests can reference objects under OTHER prefixes — an
 * incremental points into its older bases, and a base may be a row-less
 * legacy prefix nobody fenced. The org that owned the snapshot used to keep
 * those alive by marking it as a root; with that org gone, every sweep on the
 * identity protects them instead.
 *
 * Each fenced manifest is read ONCE per identity and its out-of-prefix keys
 * stored (backup_erasure_fence_refs); later runs use the stored set and make
 * no storage request. A manifest that cannot be read is recorded with an
 * exponential retry backoff and reported as unresolved — the caller defers
 * retired/orphan reclamation on the identity while any are unresolved, rather
 * than failing every sibling sweep. Only fenced ids whose manifest is in THIS
 * run's listing are considered (no manifest, nothing referenced). `cache`
 * carries results across the orgs sharing one physical identity in a run.
 */
async function resolveErasureFencedReferences(
  identity: { provider: string; providerConfig: unknown },
  physicalKey: string,
  fencedSnapshotIds: Iterable<string>,
  groups: Map<string, BackupGcSnapshotSummary>,
  cache: Map<string, Set<string> | 'unresolved'>,
  nowMs: number,
): Promise<{ liveKeys: Set<string>; unresolved: string[] }> {
  const fencedIds = [...new Set(fencedSnapshotIds)];
  const pending = fencedIds.filter((id) => groups.get(id)?.manifestItem && !cache.has(id));
  if (pending.length > 0) {
    const stored = await withSystemDbAccessContext(() => loadFenceRefs(physicalKey, pending));
    for (const snapshotId of pending) {
      const row = stored.get(snapshotId);
      if (row?.state === 'resolved') {
        cache.set(snapshotId, new Set(row.referencedKeys));
        continue;
      }
      if (row?.state === 'unreadable' && row.nextAttemptAt && row.nextAttemptAt.getTime() > nowMs) {
        cache.set(snapshotId, 'unresolved');
        continue;
      }
      const marked = await markLiveBackupObjects(identity, [snapshotId]);
      if (marked === null) {
        const attempts = await withSystemDbAccessContext(() =>
          recordFenceRefsUnreadable(physicalKey, snapshotId, 'manifest fetch/parse failed', nowMs));
        const message =
          `[BackupGC] identity ${physicalKey}: manifest of erasure-fenced snapshot ${snapshotId} could not be read ` +
          `(attempt ${attempts}); its own prefix stays protected, retired/orphan reclamation on this identity is ` +
          'deferred until it resolves.';
        console.error(message);
        captureException(new Error(message));
        cache.set(snapshotId, 'unresolved');
        continue;
      }
      const ownPrefix = `${BACKUP_SNAPSHOT_ROOT_DIR}/${snapshotId}/`;
      const outside = [...marked].filter((key) => !key.startsWith(ownPrefix) && key !== bareSnapshotKey(snapshotId));
      await withSystemDbAccessContext(() => recordFenceRefsResolved(physicalKey, snapshotId, outside));
      cache.set(snapshotId, new Set(outside));
    }
  }
  const liveKeys = new Set<string>();
  const unresolved: string[] = [];
  for (const snapshotId of fencedIds) {
    const entry = cache.get(snapshotId);
    if (entry === 'unresolved') unresolved.push(snapshotId);
    else if (entry) for (const key of entry) liveKeys.add(key);
  }
  return { liveKeys, unresolved };
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

  const {
    unattributedCount, identities, snapshotOwnersByIdentityKey, unreachableIdentities, unreachableIdentityKeys, layoutBlockedIdentityKeys,
  } =
    await withSystemDbAccessContext(async () => {
      const unattributedRows = await db.select({ id: backupSnapshots.id }).from(backupSnapshots).where(isNull(backupSnapshots.configId));
      const destinations = await db
        .select({ id: backupConfigs.id, orgId: backupConfigs.orgId, provider: backupConfigs.provider, providerConfig: backupConfigs.providerConfig })
        .from(backupConfigs);
      const identitiesInner = groupBackupConfigsByStorageIdentity(destinations);
      const identityKeysOnly = new Set([...identitiesInner.values()].map((i) => i.key));
      const unreachable = await logUnreachableStorageIdentities(identityKeysOnly);

      // For every DISTINCT physical identity two or more
      // orgs might share, this builds a snapshotId -> owning-orgId map from
      // the UNION of live (backup_snapshots) and not-yet-swept-retired
      // (backup_snapshot_retirements) rows on that identity, across every
      // org — one combined query per table, run here in system context
      // alongside the config load above, never touched again per-identity.
      // Each (identity, org) group below intersects this against its OWN
      // orgId to get the "not mine, skip entirely" set sweepStorageIdentity
      // needs; nothing here decides what gets deleted, it only tells each
      // org's independent sweep which listed groups are provably not its own.
      const identityKeys = [...identityKeysOnly];
      const snapshotOwnersByIdentityKey = new Map<string, Map<string, string>>();
      if (identityKeys.length > 0) {
        const liveRows = await db
          .select({ storageIdentity: backupSnapshots.storageIdentity, snapshotId: backupSnapshots.snapshotId, orgId: backupSnapshots.orgId })
          .from(backupSnapshots)
          .where(inArray(backupSnapshots.storageIdentity, identityKeys));
        const retiredRows = await db
          .select({ storageIdentity: backupSnapshotRetirements.storageIdentity, snapshotId: backupSnapshotRetirements.snapshotId, orgId: backupSnapshotRetirements.orgId })
          .from(backupSnapshotRetirements)
          .where(inArray(backupSnapshotRetirements.storageIdentity, identityKeys));
        for (const row of [...liveRows, ...retiredRows]) {
          if (row.storageIdentity === null) continue;
          let owners = snapshotOwnersByIdentityKey.get(row.storageIdentity);
          if (!owners) {
            owners = new Map();
            snapshotOwnersByIdentityKey.set(row.storageIdentity, owners);
          }
          if (!owners.has(row.snapshotId)) owners.set(row.snapshotId, row.orgId);
        }
      }

      // Snapshot key-layout barrier: every row (any org, any identity string,
      // or none yet) whose object-key layout this server does not understand.
      // Its objects cannot be told apart from unreferenced ones in a listing,
      // so the physical identity it lives on is not swept at all this run.
      // A row is attributed both to its recorded identity and to the identity
      // its configuration maps to now (NULL identity, or a stale string left
      // by a config edit). Only offending rows are returned.
      const layoutBlockedIdentityKeys = new Set<string>();
      if (identityKeys.length > 0) {
        const identityKeyByConfigId = new Map<string, string>();
        for (const identity of identitiesInner.values()) {
          for (const configId of identity.configIds) identityKeyByConfigId.set(configId, identity.key);
        }
        const unsupportedLayoutRows = await db
          .select({ storageIdentity: backupSnapshots.storageIdentity, configId: backupSnapshots.configId, keyLayout: backupSnapshots.keyLayout })
          .from(backupSnapshots)
          // The redundant `<> 'legacy_flat'` lets the planner use the partial
          // index instead of scanning every snapshot row each run.
          .where(and(
            sql`${backupSnapshots.keyLayout} <> 'legacy_flat'`,
            notInArray(backupSnapshots.keyLayout, [...BACKUP_KEY_LAYOUTS]),
          ));
        for (const row of unsupportedLayoutRows) {
          if (isSupportedKeyLayout(row.keyLayout)) continue;
          if (row.storageIdentity !== null) layoutBlockedIdentityKeys.add(row.storageIdentity);
          const configKey = row.configId ? identityKeyByConfigId.get(row.configId) : undefined;
          if (configKey) layoutBlockedIdentityKeys.add(configKey);
        }
      }

      return {
        unattributedCount: unattributedRows.length,
        identities: identitiesInner,
        snapshotOwnersByIdentityKey,
        unreachableIdentities: unreachable.count,
        unreachableIdentityKeys: unreachable.keys,
        layoutBlockedIdentityKeys,
      };
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

  // Coarse signature per CURRENT identity, computed once (used by both the
  // current-vs-current collision check and the current-vs-stale alias check).
  const coarseByKey = new Map<string, CoarseStorageSignature>();
  for (const identity of identities.values()) {
    coarseByKey.set(identity.key, await coarseStorageSignatureFromKey(identity.key));
  }

  const suspiciousIdentityKeys = detectSuspiciousStorageIdentityCollisions(identities, coarseByKey);
  if (suspiciousIdentityKeys.size > 0) {
    captureException(new Error(
      `[BackupGC] ${suspiciousIdentityKeys.size} storage identity/identities excluded this run: a cruder ` +
      `bucket+host comparison collapses identities normalizeStorageIdentity kept apart — likely an ` +
      `unhandled cosmetic config variant.`,
    ));
  }

  // Review round 1 (CRITICAL): a config edit can change the NORMALIZED
  // identity string while still pointing at the same physical bucket/
  // directory — old rows keep the old string, which logUnreachableStorageIdentities
  // reports but (until this fix) never acted on. Cross-checking every
  // identity we're about to sweep against the COARSE signature of every
  // unreachable (stale) identity catches this: a coarse match means "this
  // bucket/directory may still hold objects a stale identity string's rows
  // still reference", so that identity is forced into the deferred
  // (rooted-prefix-rule-only) path instead of reclaiming anything unrooted.
  //
  // Review round 2 (HOLD): a STALE `local` key whose root fs.realpath cannot
  // resolve is split by errno. ENOENT is the routine, expected case — the
  // old directory is simply gone, so there is no physical directory left for
  // any current identity to alias; its lexical signature is still added
  // (harmless: it can only ever match a lexically-identical current key,
  // which normalizeStorageIdentity would already have merged). ANY OTHER
  // errno (EACCES, ELOOP, EMFILE, an NFS hiccup, …) means the stale root may
  // well still exist and we simply could not look — the alias cannot be
  // ruled out against ANY current local identity, so every local identity
  // is deferred for this run and the failure is escalated.
  //
  // The same reasoning applies to a CURRENT local root that fails with a
  // non-ENOENT errno (review round 2 code-reviewer finding): its coarse
  // signature degrades to the lexical path while a symlink-aliased sibling
  // config's resolves to the real directory, so the two no longer collide
  // in detectSuspiciousStorageIdentityCollisions and the HEALTHY sibling
  // would run the full algorithm over the shared physical directory.
  // Deferring only the failing identity is therefore not enough — every
  // local identity is deferred for the run. ENOENT on a current root is
  // exempt from the broadcast: a path that resolves to no inode cannot be
  // the same inode as any sibling's, so only that identity is deferred.
  const unreachableCoarseSignatures = new Set<string>();
  const unresolvedLocalKeys: string[] = []; // non-ENOENT failures, stale AND current
  for (const staleKey of unreachableIdentityKeys) {
    const coarse = await coarseStorageSignatureFromKey(staleKey);
    unreachableCoarseSignatures.add(coarse.signature);
    if (coarse.unresolved && coarse.unresolved.code !== 'ENOENT') {
      unresolvedLocalKeys.push(staleKey);
      const message =
        `[BackupGC] stale/unreachable identity ${staleKey}: fs.realpath failed with ${coarse.unresolved.code} ` +
        `(${coarse.unresolved.message}) — cannot rule out that a current local identity aliases this directory; ` +
        `deferring reclamation for EVERY local identity this run (fail-closed).`;
      console.error(message);
      captureException(new Error(message));
    }
  }
  for (const [key, coarse] of coarseByKey) {
    if (coarse.unresolved && coarse.unresolved.code !== 'ENOENT') unresolvedLocalKeys.push(key);
  }

  // Snapshot id reservations, across EVERY organization: an id still being
  // written or sealed (or abandoned more recently than the orphan window) is
  // never a candidate on any identity, whoever's storage it sits in. Loaded
  // system-scoped — RLS visibility must not decide what is protected.
  const reservationState = await withSystemDbAccessContext(() => loadReservationGcState(nowMs, orphanWindowMs));
  // Snapshot ids present in each identity's fresh (pre-sweep) listing, for
  // confirming an abandoned prefix is gone before its reservation is deleted.
  const listedIdsByIdentityKey = new Map<string, Set<string>>();

  let deleted = 0;
  let skippedIdentities = 0;
  let blockedIdentities = 0;
  let retiredSwept = 0;
  let orphansSwept = 0;
  let deferredIdentities = 0;
  let deletesRemaining = resolveBackupGcMaxDeletesPerRun();

  // Group the (identity, org) units of work back by their shared PHYSICAL
  // key. An MSP routinely points every one of its orgs' configs at one
  // shared bucket, and listing is the expensive part of a sweep — grouping
  // GC work per org must never turn into one full bucket listing per org
  // sharing it (root cause of the 2026-09-23 production OOM/long-GC-run
  // incident). Insertion order is preserved (Map iteration order = first-
  // seen order from `identities`), so run behavior/ordering is otherwise
  // unchanged from a single flat loop.
  const identityGroupsByKey = new Map<string, BackupGcStorageIdentity[]>();
  for (const identity of identities.values()) {
    const group = identityGroupsByKey.get(identity.key);
    if (group) group.push(identity);
    else identityGroupsByKey.set(identity.key, [identity]);
  }

  for (const [physicalKey, orgIdentities] of identityGroupsByKey) {
    if (deletesRemaining <= 0) {
      console.log('[BackupGC] Deletion cap reached for this run — stopping cleanly; remaining identities resume next run');
      break;
    }

    if (suspiciousIdentityKeys.has(physicalKey)) {
      skippedIdentities += orgIdentities.length;
      continue;
    }

    if (layoutBlockedIdentityKeys.has(physicalKey)) {
      skippedIdentities += orgIdentities.length;
      const message =
        `[BackupGC] identity ${physicalKey}: unsupported_key_layout — a snapshot on this storage was written in an ` +
        `object-key layout this server cannot read; sweep skipped for every organization on it (fail-closed). ` +
        `Update the server before storage on this identity is reclaimed again.`;
      console.error(message);
      captureException(new Error(message));
      continue;
    }

    // Representative for calls that only need SOME valid provider/
    // providerConfig against this physical location — the actual bucket
    // listing below, and the coarse-signature/provider-support checks that
    // depend only on the physical key, never on which org's config supplied
    // the credentials.
    const representative = orgIdentities[0]!;

    if (!BACKUP_GC_SUPPORTED_PROVIDERS.has(representative.provider)) {
      skippedIdentities += orgIdentities.length;
      console.warn(
        `[BackupGC] Identity ${physicalKey}: provider '${representative.provider}' has no GC listing support — skipping (fail-closed)`,
      );
      continue;
    }

    // Review round 1 (CRITICAL): defer, don't reclaim, on an identity that
    // coarsely aliases a STALE (unreachable) identity — see the comment on
    // unreachableCoarseSignatures above.
    const identityCoarse = coarseByKey.get(physicalKey) ?? { signature: physicalKey, unresolved: null };
    const aliasDeferred = unreachableCoarseSignatures.has(identityCoarse.signature);

    // Review round 2 (HOLD): a CURRENT local root fs.realpath cannot resolve
    // is deferred for the run on ANY errno, ENOENT included. Non-ENOENT
    // (EACCES / ELOOP / EMFILE / …) is the case the HOLD was about: the
    // alias guard would otherwise silently degrade to the lexical comparison
    // and two `local` configs on one physical directory could sweep each
    // other's objects — that is logged with key + errno and escalated.
    // ENOENT is deferred too, deliberately, but NOT escalated: a current
    // config whose root does not exist is either brand-new with nothing
    // written yet (deferring costs nothing — there is nothing to reclaim)
    // or sitting on a missing/unmounted volume (deferring is exactly right —
    // a listing of the mount point would be empty and must not be trusted).
    // Either way there is no legitimate reclamation to lose by deferring.
    const realpathDeferred = identityCoarse.unresolved !== null
      || (representative.provider === 'local' && unresolvedLocalKeys.length > 0);

    // ONE streamed listing pass for this physical key, reused below by
    // every org sharing it — see listStorageIdentityGroups().
    let groups: Map<string, BackupGcSnapshotSummary>;
    try {
      groups = await listStorageIdentityGroups(representative);
    } catch (error) {
      skippedIdentities += orgIdentities.length;
      blockedIdentities += orgIdentities.length;
      console.error(`[BackupGC] Identity ${physicalKey}: listing failed — isolated, other identities proceed:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      continue;
    }

    for (const identity of orgIdentities) listedIdsByIdentityKey.set(identity.key, new Set(groups.keys()));
    const fencedRefsCache = new Map<string, Set<string> | 'unresolved'>();

    for (const identity of orgIdentities) {
      if (deletesRemaining <= 0) {
        console.log('[BackupGC] Deletion cap reached for this run — stopping cleanly; remaining identities resume next run');
        break;
      }

      try {
        await __backupGcTestHooks.beforeIdentityState?.(identity);
        const state = await loadIdentityGcState(identity, nowMs);

        // Erasure fences. Ordering rule: read AFTER every ownership read this
        // unit relies on (the run-start owner map and loadIdentityGcState just
        // above). Erasure commits its fences before deleting a single row
        // (services/backupErasureFence.ts), so a snapshot whose rows this unit
        // did not see was already fenced when those reads ran — and is
        // therefore visible here. Anything fenced after this read is caught by
        // the pre-delete recheck in sweepStorageIdentity.
        const fences = await withSystemDbAccessContext(() => loadBackupErasureFences(groups.keys()));
        await __backupGcTestHooks.afterFenceRead?.(identity);
        // Ids this org still holds a live row for: an id fenced by this org's
        // OWN (aborted) erasure stays this org's to decide while that row
        // exists — see fencedIdsForeignTo.
        const unitOwnedSnapshotIds = new Set([
          ...state.retainedSnapshotIds,
          ...state.retiredSnapshotIds.keys(),
          ...state.nullIdentityRows.map((r) => r.snapshotId),
        ]);
        const fencedForeignIds = fencedIdsForeignTo(fences.snapshotSubjects, identity.orgId, unitOwnedSnapshotIds);
        const fencedRefs = await resolveErasureFencedReferences(
          representative, physicalKey, fences.snapshotSubjects.keys(), groups, fencedRefsCache, nowMs,
        );
        const fenceProtection = {
          extraLiveKeys: new Set([...fencedRefs.liveKeys, ...fences.objectKeys]),
          // Re-reads the fences AND, for ids fenced by this org's own
          // erasure, whether the org still holds a live row NOW — the
          // unit's loaded state may predate an erasure that has since
          // deleted it.
          recheck: (snapshotIds: string[], objectKeys: string[]) => withSystemDbAccessContext(async () => {
            const fresh = await loadBackupErasureFences(snapshotIds, objectKeys);
            const ownFenced = [...fresh.snapshotSubjects].filter(([, subjects]) => subjects.has(identity.orgId)).map(([id]) => id);
            const stillOwned = await loadOrgLiveSnapshotIds(identity.orgId, ownFenced);
            return {
              snapshotIds: fencedIdsForeignTo(fresh.snapshotSubjects, identity.orgId, stillOwned),
              objectKeys: fresh.objectKeys,
            };
          }),
        };
        const fenceRefsDeferred = fencedRefs.unresolved.length > 0;
        if (fenceRefsDeferred) {
          console.warn(
            `[BackupGC] identity ${identity.key}: reclamation deferred — ${fencedRefs.unresolved.length} erasure-fenced ` +
            `manifest(s) not yet readable (${fencedRefs.unresolved.slice(0, 10).join(', ')})`,
          );
        }
        const identityDeferred = state.legacyHelper.deferred || aliasDeferred || realpathDeferred || fenceRefsDeferred;
        if (identityDeferred) deferredIdentities++; // counted once per identity regardless of how many reasons apply
        if (state.legacyHelper.deferred) {
          console.warn(`[BackupGC] identity ${identity.key}: reclamation deferred (legacy helper ${state.legacyHelper.deviceId} ${state.legacyHelper.version})`);
        }
        if (aliasDeferred) {
          // Review round 2 follow-up 4: escalate like suspiciousIdentityKeys —
          // this is the same "identity variant needs operator investigation"
          // class, and it will otherwise silently defer forever.
          const message =
            `[BackupGC] identity ${identity.key}: reclamation deferred — coarsely aliases a stale/unreachable ` +
            `identity (${identityCoarse.signature}); a config edit may have changed the identity string while ` +
            `still pointing at the same physical bucket/directory. Investigate before reclamation resumes.`;
          console.warn(message);
          captureException(new Error(message));
        }
        if (identityCoarse.unresolved) {
          const { code, message: cause } = identityCoarse.unresolved;
          if (code === 'ENOENT') {
            console.warn(
              `[BackupGC] identity ${identity.key}: reclamation deferred — local root does not exist (fs.realpath ENOENT: ` +
              `${cause}). Expected for a fresh config with no backups yet; if backups DO exist here, the volume is not mounted.`,
            );
          } else {
            const message =
              `[BackupGC] identity ${identity.key}: reclamation deferred — fs.realpath failed with ${code} (${cause}); ` +
              `cannot verify this local root is not a symlink/bind-mount alias of another identity, so every local ` +
              `identity is deferred this run (fail-closed).`;
            console.error(message);
            captureException(new Error(message));
          }
        } else if (realpathDeferred) {
          console.warn(
            `[BackupGC] identity ${identity.key}: reclamation deferred — another local identity's root could not be ` +
            `resolved this run (${unresolvedLocalKeys.join(', ')}), so a symlink/bind-mount alias with this one ` +
            `cannot be ruled out; see the error logged for that identity.`,
          );
        }

        const owners = snapshotOwnersByIdentityKey.get(identity.key);
        const foreignOwnedSnapshotIds: ReadonlySet<string> = new Set([
          ...(owners
            ? [...owners].filter(([, ownerOrgId]) => ownerOrgId !== identity.orgId).map(([snapshotId]) => snapshotId)
            : []),
          // Reserved / sealing / recently abandoned ids: skipped entirely,
          // exactly like another org's snapshot.
          ...reservationState.protectedIds,
          // Prefixes of an erased org: owned forever by the erasure record,
          // never this org's to reclaim (unless it is this org's own, still
          // live — see fencedIdsForeignTo).
          ...fencedForeignIds,
        ]);

        const identityResult = await sweepStorageIdentity(
          identity, groups, state.retainedSnapshotIds, state.nullIdentityRows, state.retiredSnapshotIds,
          foreignOwnedSnapshotIds,
          nowMs, deletesRemaining, graceMs, orphanWindowMs, manifestlessWindowMs,
          identityDeferred,
          fenceProtection,
        );

        if (identityResult.unresolvedNullIdentityCount > 0) {
          console.warn(
            `[BackupGC] identity ${identity.key}: deferred — ${identityResult.unresolvedNullIdentityCount} unresolved ` +
            `row(s) (snapshot ids: ${identityResult.unresolvedSnapshotIds.join(', ')})`,
          );
          if (!identityDeferred) deferredIdentities++; // avoid double-counting one identity across all deferral reasons
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

        // #6834: a per-group re-list failed mid-sweep. The sweep already
        // stopped at that group; its deletions, cap usage and write-backs
        // above are accurate, so they are kept — but the identity is reported
        // exactly like any other failed sweep (the catch below).
        if (identityResult.relistFailure) {
          const failure = identityResult.relistFailure;
          skippedIdentities++;
          blockedIdentities++;
          console.error(
            `[BackupGC] Identity ${identity.key}: sweep stopped — ${failure.message}; later snapshot prefixes were not swept this run:`,
            failure.cause,
          );
          captureException(failure);
        }
      } catch (error) {
        // A sweep abort here is a fail-closed failure path — an unfetchable
        // or unparseable manifest, or a delete/other sweep error (a failed
        // per-snapshot re-list is reported above, not thrown; a failed ROOT
        // listing is caught once per physical key, above this inner loop).
        // Count it as BOTH skipped (broad "not swept" total) and blocked
        // (the distinct signal that unreclaimed storage, which will not
        // clear on its own, may be accumulating for this identity).
        skippedIdentities++;
        blockedIdentities++;
        console.error(`[BackupGC] Identity ${identity.key}: sweep failed — isolated, other identities proceed:`, error);
        captureException(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  // Abandoned ids past the orphan window whose prefix this run's listing no
  // longer shows (the previous run reclaimed it): the reservation goes, the
  // id is tombstoned. Re-checked at delete time.
  const reclaimable = reservationState.reclaimable
    .filter((r) => listedIdsByIdentityKey.get(r.storageIdentity)?.has(r.snapshotId) === false)
    .map((r) => r.snapshotId);
  if (reclaimable.length > 0) {
    try {
      const n = await withSystemDbAccessContext(() => reclaimAbandonedReservations(reclaimable));
      if (n > 0) console.log(`[BackupGC] Released ${n} abandoned snapshot id reservation(s) whose storage was reclaimed`);
    } catch (error) {
      console.error('[BackupGC] Could not release abandoned snapshot id reservations:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }

  console.log(
    `[BackupGC] Run complete: deleted ${deleted} object(s), ${retiredSwept} retirement(s) confirmed swept, ` +
    `${orphansSwept} orphan(s) swept, ${skippedIdentities} identity/identities skipped, ${deferredIdentities} deferred, ` +
    `${unreachableIdentities} unreachable` + (blockedIdentities > 0 ? ` (${blockedIdentities} blocked — sweep failed fail-closed: manifest fetch/parse, listing, or delete; see errors above)` : ''),
  );

  return { deleted, skippedIdentities, blockedIdentities, retiredSwept, orphansSwept, deferredIdentities, unreachableIdentities };
}
