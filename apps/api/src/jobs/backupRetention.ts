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
  configPolicyBackupSettings,
  backupConfigs,
} from '../db/schema';
import { eq, and, lt, desc } from 'drizzle-orm';
import { deleteBackupSnapshotArtifacts } from '../services/backupSnapshotStorage';

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
  prunedByMaxVersions: number;
};

async function deleteSnapshotRow(params: {
  id: string;
  snapshotId: string;
  provider: string | null | undefined;
  providerConfig: unknown;
  metadata: unknown;
}): Promise<void> {
  await deleteBackupSnapshotArtifacts({
    provider: params.provider,
    providerConfig: params.providerConfig,
    snapshotId: params.snapshotId,
    metadata: params.metadata,
  });

  await db
    .delete(backupSnapshots)
    .where(eq(backupSnapshots.id, params.id));
}

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
    prunedByMaxVersions: 0,
  };

  // Find all expired snapshots for this org
  const expired = await db
    .select({
      id: backupSnapshots.id,
      snapshotId: backupSnapshots.snapshotId,
      metadata: backupSnapshots.metadata,
      legalHold: backupSnapshots.legalHold,
      isImmutable: backupSnapshots.isImmutable,
      immutableUntil: backupSnapshots.immutableUntil,
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
    })
    .from(backupSnapshots)
    .leftJoin(backupConfigs, eq(backupSnapshots.configId, backupConfigs.id))
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
    await deleteSnapshotRow({
      id: snap.id,
      snapshotId: snap.snapshotId,
      provider: snap.provider,
      providerConfig: snap.providerConfig,
      metadata: snap.metadata,
    });

    result.deleted++;
  }

  const versionBoundSnapshots = await db
    .select({
      id: backupSnapshots.id,
      snapshotId: backupSnapshots.snapshotId,
      timestamp: backupSnapshots.timestamp,
      deviceId: backupSnapshots.deviceId,
      configId: backupSnapshots.configId,
      metadata: backupSnapshots.metadata,
      legalHold: backupSnapshots.legalHold,
      isImmutable: backupSnapshots.isImmutable,
      immutableUntil: backupSnapshots.immutableUntil,
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
      retention: configPolicyBackupSettings.retention,
    })
    .from(backupSnapshots)
    .innerJoin(backupJobs, eq(backupSnapshots.jobId, backupJobs.id))
    .leftJoin(backupConfigs, eq(backupSnapshots.configId, backupConfigs.id))
    .leftJoin(
      configPolicyBackupSettings,
      eq(backupJobs.featureLinkId, configPolicyBackupSettings.featureLinkId),
    )
    .where(eq(backupSnapshots.orgId, orgId))
    .orderBy(
      backupSnapshots.deviceId,
      backupSnapshots.configId,
      desc(backupSnapshots.timestamp),
    );

  const snapshotsByGroup = new Map<string, typeof versionBoundSnapshots>();
  for (const row of versionBoundSnapshots) {
    const groupKey = `${row.deviceId}:${row.configId ?? 'none'}`;
    const existing = snapshotsByGroup.get(groupKey);
    if (existing) {
      existing.push(row);
    } else {
      snapshotsByGroup.set(groupKey, [row]);
    }
  }

  for (const groupRows of snapshotsByGroup.values()) {
    const retention = groupRows[0]?.retention as Record<string, unknown> | null | undefined;
    const maxVersions = typeof retention?.maxVersions === 'number' ? retention.maxVersions : null;
    if (!maxVersions || maxVersions < 1 || groupRows.length <= maxVersions) {
      continue;
    }

    for (const snap of groupRows.slice(maxVersions)) {
      if (snap.legalHold) {
        result.skippedLegalHold++;
        continue;
      }

      if (snap.isImmutable && snap.immutableUntil && snap.immutableUntil > now) {
        result.skippedImmutable++;
        continue;
      }

      await deleteSnapshotRow({
        id: snap.id,
        snapshotId: snap.snapshotId,
        provider: snap.provider,
        providerConfig: snap.providerConfig,
        metadata: snap.metadata,
      });
      result.deleted++;
      result.prunedByMaxVersions++;
    }
  }

  if (
    result.deleted > 0 ||
    result.skippedLegalHold > 0 ||
    result.skippedImmutable > 0 ||
    result.prunedByMaxVersions > 0
  ) {
    console.log(
      `[BackupRetention] Org ${orgId}: deleted ${result.deleted}, ` +
      `skipped ${result.skippedLegalHold} (legal hold), ` +
      `${result.skippedImmutable} (immutable), ` +
      `pruned ${result.prunedByMaxVersions} by maxVersions`
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

  if (maxDays === 0 && gfsConfig.retentionDays) {
    maxDays = gfsConfig.retentionDays;
  }

  if (maxDays === 0) return null;

  const expires = new Date(completedAt);
  expires.setUTCDate(expires.getUTCDate() + maxDays);
  return expires;
}
