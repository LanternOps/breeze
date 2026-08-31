import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { c2cBackupJobs } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { captureRecoveryAuthorizationSubject } from './recoveryAuthorizationSubject';

export const ACTIVE_C2C_SYNC_JOB_STATUSES = ['pending', 'running'] as const;

type CreateC2cSyncJobInput = {
  orgId: string;
  configId: string;
  auth: AuthContext;
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
          eq(c2cBackupJobs.operationKind, 'sync'),
          inArray(c2cBackupJobs.authorizationState, ['pending', 'authorized']),
          inArray(c2cBackupJobs.status, ACTIVE_C2C_SYNC_JOB_STATUSES),
        ),
      )
      .limit(1);

    if (existing) {
      return { job: existing, created: false };
    }

    const authorizationSubject = await captureRecoveryAuthorizationSubject(
      input.auth,
      input.orgId,
      { operation: 'c2c_sync', requiredAiTool: 'trigger_c2c_sync' },
    );

    const [created] = await tx
      .insert(c2cBackupJobs)
      .values({
        orgId: input.orgId,
        configId: input.configId,
        status: 'pending',
        operationKind: 'sync',
        ...authorizationSubject,
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
