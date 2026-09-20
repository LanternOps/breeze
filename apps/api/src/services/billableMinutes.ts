import { sql, type SQL } from 'drizzle-orm';
import { timeEntries } from '../db/schema/timeTracking';

/**
 * Spec §3.5 (#4628 W03). ONE arithmetic, in two representations that a CHECK
 * constraint forces to agree:
 *
 *   billable_minutes = GREATEST(COALESCE(minimum_minutes, 0),
 *     CASE WHEN rounding_increment_minutes > 0
 *          THEN CEIL(duration_minutes / rounding_increment_minutes) * rounding_increment_minutes
 *          ELSE duration_minutes END)
 *
 * NULL duration (a running timer) yields NULL: an unfinished entry has no
 * billable quantity. Pre-feature rows also stay NULL, which is why every money
 * reader uses COALESCE(billable_minutes, duration_minutes) and never the column
 * bare.
 *
 * `rounding_increment_minutes = 0` is treated as "no rounding" rather than a
 * divide-by-zero. §4.2 constrains the column to NULL or 1-480, so 0 should be
 * unreachable, but the guard has to exist in BOTH representations or the CHECK
 * and the service disagree on a row the constraint would then reject.
 */
export const BILLABLE_MINUTES_CHECK_NAME = 'time_entries_billable_minutes_chk';

export function computeBillableMinutes(input: {
  durationMinutes: number | null;
  minimumMinutes: number | null;
  roundingIncrementMinutes: number | null;
}): number | null {
  const { durationMinutes } = input;
  if (durationMinutes == null) return null;
  const increment = input.roundingIncrementMinutes ?? 0;
  const rounded = increment > 0
    ? Math.ceil(durationMinutes / increment) * increment
    : durationMinutes;
  return Math.max(input.minimumMinutes ?? 0, rounded);
}

/**
 * The same expression as a Drizzle fragment, for statements that compute the
 * duration in SQL (stopRunningEntry's CAS) and for the integration test that
 * replays the TS grid through Postgres.
 *
 * `durationExpr` is inlined TWICE on purpose: the CAS sets duration_minutes in
 * the same UPDATE, so a column reference would still see the OLD value.
 */
export function billableMinutesSql(durationExpr: SQL | number): SQL<number> {
  const d = sql`(${durationExpr})`;
  return sql<number>`GREATEST(
    COALESCE(${timeEntries.minimumMinutes}, 0),
    CASE WHEN COALESCE(${timeEntries.roundingIncrementMinutes}, 0) > 0
         THEN (CEIL(${d}::numeric / ${timeEntries.roundingIncrementMinutes}) * ${timeEntries.roundingIncrementMinutes})::int
         ELSE ${d} END
  )::int`;
}
