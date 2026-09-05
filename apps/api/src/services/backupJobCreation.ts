import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BackupMode } from '@breeze/shared';
import { db } from '../db';
import { backupJobs, devices } from '../db/schema';
import { backupHelperSupportsQueue } from './backupHelperCapabilities';

export const ACTIVE_BACKUP_JOB_STATUSES = ['pending', 'running'] as const;

type Row = typeof backupJobs.$inferSelect;
/** Drizzle transaction handle — extracted from db.transaction callback parameter. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Single source of truth for the mode union (mirrors backup_mode_enum).
type BackupModeValue = BackupMode;

type CreateManualBackupJobInput = {
  orgId: string;
  configId: string;
  featureLinkId: string | null;
  deviceId: string;
  createdAt?: Date;
  /** Profile fan-out: the selection this job executes. Omitted = legacy
   *  (dispatch reads the feature link's settings row). */
  backupMode?: BackupModeValue;
  modeTargets?: Record<string, unknown>;
  /** Pre-resolved deviceHelperQueues(); pass it when fanning out several
   *  selections for one device so the lookup runs once, not per selection. */
  helperQueues?: boolean;
};

type CreateScheduledBackupJobInput = {
  orgId: string;
  configId: string;
  featureLinkId: string | null;
  deviceId: string;
  occurrenceKey: string;
  createdAt?: Date;
  dedupeWindowMinutes?: number;
  backupMode?: BackupModeValue;
  modeTargets?: Record<string, unknown>;
  helperQueues?: boolean;
};

/**
 * Whether the device's installed breeze-backup helper serializes workloads
 * itself (#4923). A missing device row or unknown version reads as NOT
 * capable so the caller keeps the pre-queue server-side dedupe.
 */
export async function deviceHelperQueues(deviceId: string): Promise<boolean> {
  const [device] = await db
    .select({ backupVersion: devices.backupVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return backupHelperSupportsQueue(device?.backupVersion);
}

async function withBackupJobLock<T>(lockKey: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('backup-job'), hashtext(${lockKey}))`
    );
    return fn(tx);
  });
}

export async function createManualBackupJobIfIdle(
  input: CreateManualBackupJobInput
): Promise<{ job: Row; created: boolean } | null> {
  const createdAt = input.createdAt ?? new Date();

  // Serialization lives in the helper's device-wide execution queue, so the
  // server only deduplicates repeated requests for the same profile selection
  // and different profiles retain their own work even for the same mode.
  //
  // That relaxation is only safe when the device's helper actually has the
  // queue. An older helper runs every dispatched job concurrently, so for it
  // the pre-queue guard stays: one active job per device+mode.
  const helperQueues = input.helperQueues ?? await deviceHelperQueues(input.deviceId);

  const lockKey = helperQueues
    ? `manual:${input.orgId}:${input.deviceId}:${input.configId}:${input.featureLinkId ?? 'legacy'}:${input.backupMode ?? 'legacy'}`
    : `manual:${input.orgId}:${input.deviceId}:${input.backupMode ?? 'legacy'}`;
  const selectionScope = helperQueues
    ? [
        eq(backupJobs.configId, input.configId),
        input.featureLinkId
          ? eq(backupJobs.featureLinkId, input.featureLinkId)
          : sql`${backupJobs.featureLinkId} IS NULL`,
      ]
    : [];

  return withBackupJobLock(
    lockKey,
    async (tx) => {
    const [existing] = await tx
      .select()
      .from(backupJobs)
      .where(
        and(
          eq(backupJobs.orgId, input.orgId),
          eq(backupJobs.deviceId, input.deviceId),
          ...selectionScope,
          input.backupMode
            ? eq(backupJobs.backupMode, input.backupMode)
            : sql`${backupJobs.backupMode} IS NULL`,
          inArray(backupJobs.status, ACTIVE_BACKUP_JOB_STATUSES)
        )
      )
      .limit(1);

    if (existing) {
      return { job: existing, created: false };
    }

    const [row] = await tx
      .insert(backupJobs)
      .values({
        orgId: input.orgId,
        configId: input.configId,
        featureLinkId: input.featureLinkId,
        deviceId: input.deviceId,
        status: 'pending',
        type: 'manual',
        backupMode: input.backupMode ?? null,
        modeTargets: input.modeTargets ?? null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();

    if (!row) return null;

    return { job: row, created: true };
  });
}

export async function createScheduledBackupJobIfAbsent(
  input: CreateScheduledBackupJobInput
): Promise<{ job: Row; created: boolean } | null> {
  const createdAt = input.createdAt ?? new Date();
  const dedupeWindowMinutes = Math.max(1, input.dedupeWindowMinutes ?? 1);
  const minuteStart = new Date(createdAt.getTime() - (dedupeWindowMinutes * 60_000));
  minuteStart.setSeconds(0, 0);
  const searchEnd = new Date(createdAt.getTime() + 60_000);

  // Profile fan-out creates one job per selection per occurrence — the mode
  // participates in both the advisory-lock key and the dedupe window so a
  // Server profile's file/system_image/mssql jobs don't dedupe each other.
  // Same-config, same-mode selections from different profiles are kept apart
  // only when the device's helper queues them (see createManualBackupJobIfIdle).
  const helperQueues = input.helperQueues ?? await deviceHelperQueues(input.deviceId);
  return withBackupJobLock(
    `scheduled:${input.orgId}:${input.deviceId}:${input.featureLinkId ?? input.configId}:${input.occurrenceKey}:${input.backupMode ?? 'legacy'}`,
    async (tx) => {
      const [existing] = await tx
        .select()
        .from(backupJobs)
        .where(
          and(
            eq(backupJobs.orgId, input.orgId),
            eq(backupJobs.deviceId, input.deviceId),
            eq(backupJobs.configId, input.configId),
            eq(backupJobs.type, 'scheduled'),
            ...(helperQueues
              ? [input.featureLinkId
                  ? eq(backupJobs.featureLinkId, input.featureLinkId)
                  : sql`${backupJobs.featureLinkId} IS NULL`]
              : []),
            input.backupMode
              ? eq(backupJobs.backupMode, input.backupMode)
              : sql`${backupJobs.backupMode} IS NULL`,
            sql`${backupJobs.createdAt} >= ${minuteStart.toISOString()}::timestamptz`,
            sql`${backupJobs.createdAt} < ${searchEnd.toISOString()}::timestamptz`
          )
        )
        .limit(1);

      if (existing) {
        return { job: existing, created: false };
      }

      const [row] = await tx
        .insert(backupJobs)
        .values({
          orgId: input.orgId,
          configId: input.configId,
          featureLinkId: input.featureLinkId,
          deviceId: input.deviceId,
          status: 'pending',
          type: 'scheduled',
          backupMode: input.backupMode ?? null,
          modeTargets: input.modeTargets ?? null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();

      if (!row) return null;

      return { job: row, created: true };
    }
  );
}
