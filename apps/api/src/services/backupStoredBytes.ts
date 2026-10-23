/**
 * Stored bytes for backup snapshots — what "Storage Used", Storage by
 * Provider, the storage trend and the AI backup summaries report (#9631).
 *
 * `backup_snapshots.size` is the LOGICAL size of everything a snapshot
 * protects, including unchanged files it only references from an earlier
 * snapshot (the agent counts reference entries into the manifest size).
 * Summing it counts a device's unchanged data once per retained incremental,
 * so the figure grows with retention depth instead of with what the
 * destination holds. The referenced share of a run is recorded on its job
 * (`backup_jobs.referenced_size`, set from the agent's `referencedBytes`).
 *
 * Per chain — one device writing one backup type to one storage identity —
 * the stored figure is:
 *   - the OLDEST retained snapshot at its full `size`: its own uploads plus
 *     the objects it references from snapshots that have since aged out of
 *     retention (GC keeps an object while a live snapshot references it,
 *     and nothing older is left to count those objects);
 *   - every later snapshot at `size - referenced_size` (what that run
 *     uploaded). A job that reported no dedup (a full, a non-file backup, a
 *     legacy agent) has a NULL `referenced_size` and counts in full.
 *
 * Counting uploads alone would UNDER-count once the base full expires: the
 * oldest incremental's referenced objects are still stored but no live row
 * would count them. This is still an estimate, not object-level accounting:
 * an object referenced by a later snapshot but not by the oldest retained
 * one (possible only when a non-adjacent base was chosen) is missed. Exact
 * figures need a live-object sum per storage identity from the GC mark.
 */
import { eq, gte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { backupConfigs, backupJobs, backupSnapshots } from '../db/schema';

/**
 * One row per snapshot matching `where`, with its stored-bytes share.
 * `where` must not narrow by time: the oldest retained snapshot of each chain
 * has to be in the set for its full-size share to be assigned correctly.
 * Device- and org-level filters are safe (a chain never spans devices).
 *
 * `day` is the snapshot's UTC capture day when it was captured at or after
 * `dayFrom`, else null. Computed here, not in the outer GROUP BY, because
 * Postgres cannot match two separately-parameterised copies of the same
 * expression between the select list and the GROUP BY.
 */
function storedSnapshotRows(where: SQL | undefined, dayFrom?: Date) {
  const size = sql`coalesce(${backupSnapshots.size}, 0)`;
  // backup_snapshots.timestamp is timestamp WITHOUT time zone holding UTC
  // wall time, so the day key is read straight off the stored value.
  const day = dayFrom
    ? sql<string | null>`case
        when ${gte(backupSnapshots.timestamp, dayFrom)} then to_char(${backupSnapshots.timestamp}, 'YYYY-MM-DD')
        else null
      end`
    : sql<string | null>`null::text`;
  return db
    .select({
      configId: backupSnapshots.configId,
      day: day.as('day'),
      storedBytes: sql<number>`(case
        when row_number() over (
          partition by ${backupSnapshots.deviceId},
            coalesce(${backupSnapshots.storageIdentity}, ${backupSnapshots.configId}::text, ''),
            ${backupSnapshots.backupType}
          order by ${backupSnapshots.timestamp} asc, ${backupSnapshots.id} asc
        ) = 1 then ${size}
        else greatest(${size} - coalesce(${backupJobs.referencedSize}, 0), 0)
      end)`.as('stored_bytes'),
    })
    .from(backupSnapshots)
    .leftJoin(backupJobs, eq(backupSnapshots.jobId, backupJobs.id))
    .where(where)
    .as('stored_snapshots');
}

/** Stored bytes and snapshot count over every snapshot matching `where`. */
export async function sumStoredSnapshotBytes(
  where: SQL | undefined,
): Promise<{ totalBytes: number; count: number }> {
  const rows = storedSnapshotRows(where);
  const [row] = await db
    .select({
      totalBytes: sql<string>`coalesce(sum(${rows.storedBytes}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(rows);
  // sum() over bigint comes back from the driver as a string.
  return { totalBytes: Number(row?.totalBytes ?? 0) || 0, count: Number(row?.count ?? 0) || 0 };
}

/**
 * Stored bytes per destination provider. A snapshot whose config was deleted
 * reports a null provider.
 */
export async function sumStoredSnapshotBytesByProvider(
  where: SQL | undefined,
): Promise<Array<{ provider: string | null; bytes: number; snapshots: number }>> {
  const rows = storedSnapshotRows(where);
  const result = await db
    .select({
      provider: backupConfigs.provider,
      bytes: sql<string>`coalesce(sum(${rows.storedBytes}), 0)::bigint`,
      snapshots: sql<number>`count(*)::int`,
    })
    .from(rows)
    .leftJoin(backupConfigs, eq(rows.configId, backupConfigs.id))
    .groupBy(backupConfigs.provider);
  return result.map((row) => ({
    provider: row.provider ?? null,
    bytes: Number(row.bytes ?? 0) || 0,
    snapshots: Number(row.snapshots) || 0,
  }));
}

/**
 * Stored bytes per provider per UTC day from `since` on, plus one
 * `day: null` row per provider holding everything captured before `since`
 * (the trend's starting level), so baseline + days sums to the total.
 */
export async function storedSnapshotBytesByProviderSince(
  where: SQL | undefined,
  since: Date,
): Promise<Array<{ provider: string | null; day: string | null; bytes: number }>> {
  const rows = storedSnapshotRows(where, since);
  const result = await db
    .select({
      provider: backupConfigs.provider,
      day: rows.day,
      bytes: sql<string>`coalesce(sum(${rows.storedBytes}), 0)::bigint`,
    })
    .from(rows)
    .leftJoin(backupConfigs, eq(rows.configId, backupConfigs.id))
    .groupBy(backupConfigs.provider, rows.day);
  return result.map((row) => ({
    provider: row.provider ?? null,
    day: row.day ?? null,
    bytes: Number(row.bytes ?? 0) || 0,
  }));
}
