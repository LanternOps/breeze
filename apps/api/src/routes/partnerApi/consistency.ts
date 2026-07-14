import { sql } from 'drizzle-orm';
import { db, hasDbAccessContext } from '../../db';

/** Acquire the org-shared side of the partner-export watermark protocol. */
export async function acquirePartnerExportReadLocks(orgIds: readonly string[]): Promise<Date> {
  if (!hasDbAccessContext()) {
    throw new Error('Partner export consistency locks require an active database access context.');
  }
  const sortedOrgIds = [...new Set(orgIds)].sort();
  const uuidArray = sortedOrgIds.length === 0
    ? sql`ARRAY[]::uuid[]`
    : sql`ARRAY[${sql.join(sortedOrgIds.map((orgId) => sql`${orgId}::uuid`), sql`, `)}]`;
  const rows = await db.execute<{ snapshotAt: Date | string }>(sql`
    SELECT (
      public.breeze_partner_export_lock_orgs_shared_snapshot(${uuidArray}) AT TIME ZONE 'UTC'
    ) AS "snapshotAt"
  `);
  const rawSnapshotAt = rows[0]?.snapshotAt;
  const snapshotAt = rawSnapshotAt instanceof Date ? rawSnapshotAt : new Date(rawSnapshotAt ?? '');
  if (!Number.isFinite(snapshotAt.getTime())) {
    throw new Error('Partner export database snapshot timestamp is unavailable.');
  }
  return snapshotAt;
}
