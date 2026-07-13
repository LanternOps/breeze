import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs } from '../db/schema';

export const ACTIVE_BACKUP_JOB_STATUSES = ['pending', 'running'] as const;

type Row = typeof backupJobs.$inferSelect;
/** Drizzle transaction handle — extracted from db.transaction callback parameter. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type BackupModeValue = 'file' | 'hyperv' | 'mssql' | 'system_image';

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
};

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

  // Idle means "no active job for this device AND mode": profile fan-out
  // runs a device's file/system_image/mssql jobs side by side, but never two
  // of the same mode concurrently. Legacy (NULL-mode) jobs keep the original
  // one-active-job-per-device behavior.
  return withBackupJobLock(
    `manual:${input.orgId}:${input.deviceId}:${input.backupMode ?? 'legacy'}`,
    async (tx) => {
    const [existing] = await tx
      .select()
      .from(backupJobs)
      .where(
        and(
          eq(backupJobs.orgId, input.orgId),
          eq(backupJobs.deviceId, input.deviceId),
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
