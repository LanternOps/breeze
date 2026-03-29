/**
 * Backup Retention — GFS tagging and legal-hold-aware cleanup
 *
 * GFS (Grandfather-Father-Son) retention tags every completed backup snapshot
 * with daily/weekly/monthly/yearly labels. Retention cleanup respects legal
 * holds and immutability windows.
 */

import { db } from '../db';
import {
  backupSnapshots,
  backupPolicies,
  backupJobs,
} from '../db/schema';
import { eq, and, lt, sql, isNull, or } from 'drizzle-orm';

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
    .select({ policyId: backupJobs.policyId })
    .from(backupJobs)
    .where(eq(backupJobs.id, jobId))
    .limit(1);

  if (!job?.policyId) return null;

  const [policy] = await db
    .select({ gfsConfig: backupPolicies.gfsConfig })
    .from(backupPolicies)
    .where(eq(backupPolicies.id, job.policyId))
    .limit(1);

  return (policy?.gfsConfig as GfsConfig) ?? null;
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
};

/**
 * Cleans up expired snapshots for an org, respecting legal holds and immutability.
 *
 * Snapshots are deleted when:
 *   - `expiresAt` is in the past
 *   - `legalHold` is NOT true
 *   - `isImmutable` is NOT true OR `immutableUntil` is in the past
 */
export async function cleanupExpiredSnapshots(
  orgId: string
): Promise<RetentionCleanupResult> {
  const now = new Date();
  const result: RetentionCleanupResult = {
    deleted: 0,
    skippedLegalHold: 0,
    skippedImmutable: 0,
  };

  // Find all expired snapshots for this org
  const expired = await db
    .select({
      id: backupSnapshots.id,
      snapshotId: backupSnapshots.snapshotId,
      legalHold: backupSnapshots.legalHold,
      isImmutable: backupSnapshots.isImmutable,
      immutableUntil: backupSnapshots.immutableUntil,
    })
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.orgId, orgId),
        lt(backupSnapshots.expiresAt, now)
      )
    );

  for (const snap of expired) {
    // Skip legal holds
    if (snap.legalHold) {
      result.skippedLegalHold++;
      console.warn(
        `[BackupRetention] Snapshot ${snap.snapshotId} held by legal hold — skipping deletion`
      );
      continue;
    }

    // Skip immutable snapshots that haven't expired yet
    if (snap.isImmutable && snap.immutableUntil && snap.immutableUntil > now) {
      result.skippedImmutable++;
      console.warn(
        `[BackupRetention] Snapshot ${snap.snapshotId} immutable until ${snap.immutableUntil.toISOString()} — skipping deletion`
      );
      continue;
    }

    // Safe to delete
    await db
      .delete(backupSnapshots)
      .where(eq(backupSnapshots.id, snap.id));

    result.deleted++;
  }

  if (result.deleted > 0 || result.skippedLegalHold > 0 || result.skippedImmutable > 0) {
    console.log(
      `[BackupRetention] Org ${orgId}: deleted ${result.deleted}, ` +
      `skipped ${result.skippedLegalHold} (legal hold), ` +
      `${result.skippedImmutable} (immutable)`
    );
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

  if (maxDays === 0) return null;

  const expires = new Date(completedAt);
  expires.setUTCDate(expires.getUTCDate() + maxDays);
  return expires;
}
