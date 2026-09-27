import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs, backupSnapshots } from '../db/schema';

/**
 * `backup_snapshots.snapshot_id` carries no uniqueness constraint
 * (schema/backup.ts) and the agent, not the server, chooses the value. Two
 * write paths accept it with no ownership check today: the mid-run
 * registration in `backupProgress.ts` (`backup_jobs.snapshot_id`) and the
 * terminal-result upsert in `backupResultPersistence.ts`
 * (`backup_snapshots`, keyed only on `(job_id, snapshot_id)`). Either lets a
 * device adopt an id another device — or, on a bucket shared across orgs,
 * another org — already claimed, producing a product-verified restore point
 * over objects it never uploaded.
 *
 * `backupSnapshotReconcile.ts` already defends its own adoption path with an
 * equivalent `foreignClaimed` check; this is the same check for the two
 * write paths that do not go through it. Deliberately NOT scoped by storageIdentity:
 * an id collision against a snapshot or job on a DIFFERENT device is
 * suspicious regardless of destination, and refusing it costs nothing since
 * agent-chosen snapshot ids are expected to be globally distinct.
 */
export interface SnapshotOwnershipConflict {
  ownerDeviceId: string;
  ownerOrgId: string;
  crossOrg: boolean;
}

export async function findForeignSnapshotClaim(params: {
  snapshotId: string;
  callerDeviceId: string;
  callerOrgId: string;
}): Promise<SnapshotOwnershipConflict | null> {
  const { snapshotId, callerDeviceId, callerOrgId } = params;

  const [snapshotRow] = await db
    .select({ deviceId: backupSnapshots.deviceId, orgId: backupSnapshots.orgId })
    .from(backupSnapshots)
    .where(and(eq(backupSnapshots.snapshotId, snapshotId), ne(backupSnapshots.deviceId, callerDeviceId)))
    .limit(1);
  if (snapshotRow) {
    return {
      ownerDeviceId: snapshotRow.deviceId,
      ownerOrgId: snapshotRow.orgId,
      crossOrg: snapshotRow.orgId !== callerOrgId,
    };
  }

  const [jobRow] = await db
    .select({ deviceId: backupJobs.deviceId, orgId: backupJobs.orgId })
    .from(backupJobs)
    .where(and(eq(backupJobs.snapshotId, snapshotId), ne(backupJobs.deviceId, callerDeviceId)))
    .limit(1);
  if (jobRow) {
    return {
      ownerDeviceId: jobRow.deviceId,
      ownerOrgId: jobRow.orgId,
      crossOrg: jobRow.orgId !== callerOrgId,
    };
  }

  return null;
}
