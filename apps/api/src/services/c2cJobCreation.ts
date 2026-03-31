import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { c2cBackupJobs } from '../db/schema';

export const ACTIVE_C2C_SYNC_JOB_STATUSES = ['pending', 'running'] as const;

type CreateC2cSyncJobInput = {
  orgId: string;
  configId: string;
  createdAt?: Date;
};

export async function createC2cSyncJobIfIdle(
  input: CreateC2cSyncJobInput,
): Promise<{ job: typeof c2cBackupJobs.$inferSelect; created: boolean } | null> {
  const createdAt = input.createdAt ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('c2c-sync-job'), hashtext(${`${input.orgId}:${input.configId}`}))`
    );

    const [existing] = await tx
      .select()
      .from(c2cBackupJobs)
      .where(
        and(
          eq(c2cBackupJobs.orgId, input.orgId),
          eq(c2cBackupJobs.configId, input.configId),
          inArray(c2cBackupJobs.status, ACTIVE_C2C_SYNC_JOB_STATUSES),
        ),
      )
      .limit(1);

    if (existing) {
      return { job: existing, created: false };
    }

    const [created] = await tx
      .insert(c2cBackupJobs)
      .values({
        orgId: input.orgId,
        configId: input.configId,
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
      })
      .returning();

    if (!created) {
      return null;
    }

    return { job: created, created: true };
  });
}
