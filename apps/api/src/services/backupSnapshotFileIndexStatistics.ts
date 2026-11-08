// #11209: planner statistics for backup_snapshot_files, refreshed by the
// hydrator right after it publishes a large index.
//
// A publish writes every row of a snapshot in one transaction. Until the table
// is next analyzed, the planner still estimates a few thousand rows for a
// snapshot that has a million, so each selection page bitmap-scans and sorts
// every remaining row instead of reading one index range. At 1.1M rows a
// folder selection took 39–44 s that way, against about 3 s once analyzed.
// Autovacuum fixes it, but only on its next pass, and on a large table a single
// snapshot may never cross its 10 % threshold at all. The person who waited for
// the index browses it at once, so the hydrator analyzes the table itself.
//
// The API role does not own the table and cannot ANALYZE it, so this goes
// through public.breeze_analyze_backup_snapshot_files() (SECURITY DEFINER,
// migration 2027-01-22-210200-backup-snapshot-files-analyze.sql).
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { tightenStatementTimeout } from '../db/lockTimeout';
import { recordSnapshotFileIndex } from './backupMetrics';

/**
 * Rows one publish must write before it analyzes the table. ANALYZE reads a
 * fixed sample (300 × default_statistics_target rows) whatever the table's
 * size, a fraction of a second to a few seconds; a publish this large takes far
 * longer to write. Below it, a page walk with stale statistics still finishes
 * in well under a second, and autovacuum catches up.
 */
export const STATISTICS_REFRESH_MIN_ROWS = 100_000;

/**
 * How long the ANALYZE may run. A sample read should take seconds; past this
 * something else is wrong, and autovacuum remains the fallback.
 */
export const STATISTICS_REFRESH_TIMEOUT_MS = 60_000;

export type StatisticsRefreshOutcome =
  /** The publish was too small to be worth it. */
  | 'below_threshold'
  | 'analyzed'
  /** Another ANALYZE or a VACUUM held the table: skipped rather than waited for. */
  | 'busy'
  /** The refresh failed. The index is unaffected; autovacuum will analyze. */
  | 'error';

/**
 * Analyze backup_snapshot_files once a publish has written `rowsWritten` rows.
 * Never throws: the index it follows is already published and correct, and
 * this only makes reading it fast sooner. Opens its own short system-scoped
 * transaction, so call it after the publish has committed, never inside it.
 */
export async function refreshSnapshotFileIndexStatistics(
  rowsWritten: number,
  opts?: { minRows?: number },
): Promise<StatisticsRefreshOutcome> {
  if (rowsWritten < (opts?.minRows ?? STATISTICS_REFRESH_MIN_ROWS)) return 'below_threshold';

  let outcome: StatisticsRefreshOutcome;
  try {
    const analyzed = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          // Never widened, and gone when this transaction ends.
          await tightenStatementTimeout(tx, STATISTICS_REFRESH_TIMEOUT_MS);
          const rows = (await tx.execute(
            sql`SELECT public.breeze_analyze_backup_snapshot_files() AS analyzed`,
          )) as unknown as Array<{ analyzed: boolean | null }>;
          return rows[0]?.analyzed === true;
        }),
      ),
    );
    outcome = analyzed ? 'analyzed' : 'busy';
  } catch (err) {
    console.warn(
      `[backupSnapshotFileIndex] Could not refresh backup_snapshot_files statistics after publishing ${rowsWritten} rows; reads stay slow until autovacuum analyzes the table:`,
      err,
    );
    outcome = 'error';
  }
  recordSnapshotFileIndex('statistics', outcome);
  return outcome;
}
