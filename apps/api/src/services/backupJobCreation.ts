import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs } from '../db/schema';

export const ACTIVE_BACKUP_JOB_STATUSES = ['pending', 'running'] as const;

type Row = typeof backupJobs.$inferSelect;
/** Drizzle transaction handle — extracted from db.transaction callback parameter. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type CreateManualBackupJobInput = {
  orgId: string;
  configId: string;
  featureLinkId: string | null;
  deviceId: string;
  createdAt?: Date;
};

type CreateScheduledBackupJobInput = {
  orgId: string;
  configId: string;
  featureLinkId: string | null;
  deviceId: string;
  occurrenceKey: string;
  createdAt?: Date;
  dedupeWindowMinutes?: number;
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

  return withBackupJobLock(`manual:${input.orgId}:${input.deviceId}`, async (tx) => {
    const [existing] = await tx
      .select()
      .from(backupJobs)
      .where(
        and(
          eq(backupJobs.orgId, input.orgId),
          eq(backupJobs.deviceId, input.deviceId),
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

  return withBackupJobLock(
    `scheduled:${input.orgId}:${input.deviceId}:${input.featureLinkId ?? input.configId}:${input.occurrenceKey}`,
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
          createdAt,
          updatedAt: createdAt,
        })
        .returning();

      if (!row) return null;

      return { job: row, created: true };
    }
  );
}
