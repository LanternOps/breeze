/**
 * Production-side inverse of the postgres.js offsetless-`timestamp` misparse.
 *
 * `timestamp('col')` without `withTimezone: true` is this repo's default column
 * shape (~800 occurrences across `db/schema/*.ts`). Postgres emits such a value
 * with no zone marker (`2026-08-25 18:34:15.123`), postgres.js parses OIDs
 * 1082/1114 with a bare `new Date(...)`, and V8 reads an offsetless date-time
 * as LOCAL time — so the Date handed back carries the UTC wall clock re-read as
 * the API process's own zone. Drizzle's UTC-correct path (`value + '+0000'`)
 * never fires, because it is guarded on `typeof value === 'string'` and the
 * driver already produced a Date.
 *
 * The result is exact on a UTC host and wrong by the host's offset everywhere
 * else — which is why this defect class survives a fully green CI suite (see
 * #4018, #4046, #4059) and only bites on a non-UTC deployment or developer
 * machine. `testUtils/pgOffsetlessTimestamp.ts` is the test-side simulation.
 *
 * Prior art, deliberately left in place rather than migrated in this change:
 * `services/sso.ts`'s exported `utcMsFromOffsetlessTimestamp` (its own public
 * surface, imported by `routes/sso.ts`). `services/tokenRevocation.ts` now
 * delegates here.
 *
 * Only apply this to a Date that came off the wire from an offsetless column.
 * A value parsed from a string carrying an explicit offset (`...Z`) is already
 * correct and must NOT be re-corrected.
 */

/** The true UTC epoch-ms of a Date read from an offsetless `timestamp` column. */
export function utcMsFromOffsetlessDbTimestamp(value: Date): number {
  return value.getTime() - value.getTimezoneOffset() * 60_000;
}

/** As above, re-wrapped as a Date for APIs that take one. */
export function dateFromOffsetlessDbTimestamp(value: Date): Date {
  return new Date(utcMsFromOffsetlessDbTimestamp(value));
}
