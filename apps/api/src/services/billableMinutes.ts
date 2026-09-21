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
 *
 * `terms` exists for the same reason one level up. An UPDATE's SET expressions
 * are evaluated against the OLD row, but the CHECK validates the NEW one — so
 * a statement that ALSO rewrites minimum_minutes / rounding_increment_minutes
 * (a manager's stop-with-override) must pass the new values here. Leaving a
 * term out reads that row's existing column, which is correct only when the
 * same statement leaves it alone.
 */
export function billableMinutesSql(
  durationExpr: SQL | number,
  terms: {
    minimumMinutes?: SQL | number | null;
    roundingIncrementMinutes?: SQL | number | null;
  } = {}
): SQL<number> {
  const d = sql`(${durationExpr})`;
  const term = (value: SQL | number | null | undefined, column: SQL): SQL =>
    value === undefined ? column : value === null ? sql`NULL::int` : sql`${value}::int`;
  const min = term(terms.minimumMinutes, sql`${timeEntries.minimumMinutes}`);
  const inc = term(terms.roundingIncrementMinutes, sql`${timeEntries.roundingIncrementMinutes}`);
  return sql<number>`GREATEST(
    COALESCE(${min}, 0),
    CASE WHEN COALESCE(${inc}, 0) > 0
         THEN (CEIL(${d}::numeric / ${inc}) * ${inc})::int
         ELSE ${d} END
  )::int`;
}
