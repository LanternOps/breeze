// #11209: planner statistics for backup_snapshot_files, refreshed by the
// hydrator right after it publishes a large index.
//
// A publish writes every row of a snapshot in one transaction. Until the table
// is next analyzed the planner keeps its old estimate for that snapshot (1 row,
// measured on a test stack at 1.1M rows), so each selection page bitmap-scans
// and sorts every remaining row instead of reading one index range. A folder
// selection took 39–44 s that way, against about 3 s once analyzed. Autovacuum
// fixes it, but only on its next pass, and on a large table a single snapshot
// may never cross its 10 % threshold at all. The person who waited for the
// index browses it at once, so the hydrator analyzes the table itself.
//
// The API role does not own the table and cannot ANALYZE it, so this goes
// through public.breeze_analyze_backup_snapshot_files() (SECURITY DEFINER,
// migration 2027-01-22-210200-backup-snapshot-files-analyze.sql).
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { tightenStatementTimeout } from '../db/lockTimeout';
import { pgErrorCode } from '../utils/pgErrors';
import { recordSnapshotFileIndex } from './backupMetrics';
import { captureException } from './sentry';

/**
 * Rows one publish must write before it analyzes the table. ANALYZE samples a
 * bounded number of rows (about 30,000 at the default statistics target)
 * whatever the table's size: 210 ms at 1.1M rows on a test stack. A publish
 * this large takes several seconds to write. Below it, a page walk on stale
 * statistics is estimated at under a second (from the per-page cost measured at
 * 1.1M rows), and autovacuum catches up.
 */
export const STATISTICS_REFRESH_MIN_ROWS = 100_000;

/**
 * How long one ANALYZE may run. A sample read should take seconds; past this
 * something else is wrong, and autovacuum remains the fallback.
 */
export const STATISTICS_REFRESH_TIMEOUT_MS = 60_000;

/**
 * Attempts while the table is busy, and the pause between them. A busy table
 * is usually another ANALYZE (autovacuum's, or another hydration's), which
 * finishes in seconds. It is worth waiting for: one that sampled the table
 * before this publish committed still resets the table's change counter, so
 * autovacuum would not come back for these rows.
 */
export const STATISTICS_REFRESH_ATTEMPTS = 3;
export const STATISTICS_REFRESH_RETRY_DELAY_MS = 2_000;

/**
 * SQLSTATEs that mean the install is misconfigured, not that this attempt was
 * unlucky: the helper is missing (migration not applied), or it may not run
 * (no EXECUTE grant, or its owner does not own the table). Each repeats on
 * every large publish, so they go to Sentry.
 */
const CONFIGURATION_FAULTS = new Set(['42883', '42501']);

export type StatisticsRefreshOutcome =
  /** The publish was too small to be worth it. */
  | 'below_threshold'
  | 'analyzed'
  /**
   * A conflicting lock (another ANALYZE or a VACUUM, autovacuum's included,
   * or DDL) held the table on every attempt. Never waited for in-statement.
   */
  | 'busy'
  /** The refresh failed. The index is unaffected; autovacuum will analyze. */
  | 'error';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One attempt, in its own short system-scoped transaction. True once analyzed. */
async function analyzeOnce(): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        // Never widened, and gone when this transaction ends.
        await tightenStatementTimeout(tx, STATISTICS_REFRESH_TIMEOUT_MS);
        const rows = (await tx.execute(
          sql`SELECT public.breeze_analyze_backup_snapshot_files() AS analyzed`,
        )) as unknown as Array<{ analyzed: unknown }>;
        const analyzed = rows[0]?.analyzed;
        if (typeof analyzed !== 'boolean') {
          throw new Error(`breeze_analyze_backup_snapshot_files() returned ${JSON.stringify(analyzed)}, not a boolean`);
        }
        return analyzed;
      }),
    ),
  );
}

/**
 * Analyze backup_snapshot_files once a publish has written `rowsWritten` rows.
 * Never throws: the index it follows is already published and correct, and
 * this only makes reading it fast sooner. Each attempt opens its own
 * connection and transaction, so call it once the publish has committed: run
 * inside the publish, it could not see the new rows.
 */
export async function refreshSnapshotFileIndexStatistics(
  rowsWritten: number,
  opts?: { minRows?: number; retryDelayMs?: number },
): Promise<StatisticsRefreshOutcome> {
  if (rowsWritten < (opts?.minRows ?? STATISTICS_REFRESH_MIN_ROWS)) return 'below_threshold';

  let outcome: StatisticsRefreshOutcome = 'busy';
  try {
    for (let attempt = 1; attempt <= STATISTICS_REFRESH_ATTEMPTS; attempt += 1) {
      if (await analyzeOnce()) {
        outcome = 'analyzed';
        break;
      }
      if (attempt < STATISTICS_REFRESH_ATTEMPTS) await sleep(opts?.retryDelayMs ?? STATISTICS_REFRESH_RETRY_DELAY_MS);
    }
    if (outcome === 'busy') {
      console.info(
        `[backupSnapshotFileIndex] backup_snapshot_files was locked by other maintenance on all ${STATISTICS_REFRESH_ATTEMPTS} attempts after publishing ${rowsWritten} rows; left to autovacuum`,
      );
    }
  } catch (err) {
    const code = pgErrorCode(err);
    const message = `[backupSnapshotFileIndex] Could not refresh backup_snapshot_files statistics after publishing ${rowsWritten} rows; reads stay slow until autovacuum analyzes the table:`;
    if (code && CONFIGURATION_FAULTS.has(code)) {
      console.error(message, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    } else {
      console.warn(message, err);
    }
    outcome = 'error';
  }
  recordSnapshotFileIndex('statistics', outcome);
  return outcome;
}
