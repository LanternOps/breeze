import { sql, type SQL } from 'drizzle-orm';

/**
 * Safe binding of JS values into hand-written Drizzle `sql` templates.
 *
 * ## Why this exists
 *
 * Drizzle's typed helpers (`eq`, `ne`, `lt`, `gt`, `lte`, `gte`, `between`,
 * `inArray`, and `.set({ col: value })`) encode a value through the **column's**
 * driver encoder. That is why `.where(gte(devices.lastSeenAt, someDate))` works.
 *
 * A value interpolated into a raw ``sql`...${value}...` `` template has no
 * column to consult, so Drizzle wraps it in a `Param` carrying the **noop**
 * encoder and the untouched JS object is handed to postgres.js. For a `Date`,
 * the driver's Bind step throws:
 *
 * ```
 * TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string
 * or an instance of Buffer or ArrayBuffer. Received an instance of Date
 *     at Bind (postgres/src/connection.js:954)
 * ```
 *
 * Request handlers run inside `withDbAccessContext`, a postgres.js `begin()`
 * transaction that re-throws query errors at commit *even when the application
 * already caught and handled them*. So this does not surface as a handled
 * error — it escapes as an HTTP 500 for the whole request, past the caller's
 * own `catch`. That is what made it so hard to read from the outside in #3329.
 *
 * ## Using it
 *
 * Interpolate the returned fragment, not the raw value:
 *
 * ```ts
 * sql`${columnRef} < ${sqlValue(cutoff)}`          // safe
 * sql`${columnRef} < ${cutoff}`                    // 500s when cutoff is a Date
 * ```
 *
 * Prefer a typed helper (`lt(devices.lastSeenAt, cutoff)`) whenever the left
 * side is a real `Column` — that is the better fix and needs nothing from here.
 * These helpers are for the cases where it is not: an arbitrary `SQL`
 * expression, a correlated subquery, or an arithmetic context.
 *
 * History: #3329 (first sighting), #3368 (fix), #3369 (remaining sites).
 */

/**
 * Bind a `Date` as an ISO-8601 string parameter, with **no** cast.
 *
 * This is the default and should be preferred. It is exactly what Drizzle's own
 * `PgTimestamp.mapToDriverValue` does, so it is correct against both
 * `timestamp` and `timestamptz` columns: Postgres resolves the untyped
 * parameter from whatever it is being compared or assigned to.
 *
 * Deliberately uncast. The repo mixes both column flavours — `devices.
 * last_seen_at` is `timestamp` (no tz) while `oauth_revocation_retries.
 * expires_at` is `timestamptz` — and a blanket `::timestamptz` would be a
 * *worse* bug than the one being fixed: comparing a naive `timestamp` column
 * against a `timestamptz` makes Postgres reinterpret the column in the session
 * time zone, silently shifting every result on any deployment not running UTC.
 */
export function sqlTimestamp(value: Date): SQL<unknown> {
  return sql`${value.toISOString()}`;
}

/**
 * Bind a `Date` as an explicitly-cast `timestamptz` parameter.
 *
 * Only for contexts where Postgres has no column to infer the parameter's type
 * from — arithmetic (`$1 + interval '1 second'` has no unique operator
 * resolution) or a polymorphic function (`GREATEST($1, col)` would resolve off
 * the other argument).
 *
 * The target column must genuinely be `timestamptz`; against a naive
 * `timestamp` column use {@link sqlTimestamp} instead, for the reason in its
 * docblock.
 */
export function sqlTimestamptz(value: Date): SQL<unknown> {
  return sql`${value.toISOString()}::timestamptz`;
}

/**
 * Bind an arbitrary scalar, serialising a `Date` via {@link sqlTimestamp} and
 * passing everything else through unchanged.
 *
 * For values whose runtime type is not statically known — user-supplied filter
 * values, for instance, where one code path carries strings, numbers, booleans
 * and `Date`s.
 *
 * Not for arrays or plain objects: those have their own binding rules per call
 * site (an array may need an explicit `IN` list rather than `ANY($1)`), so they
 * pass through and remain the caller's responsibility.
 */
export function sqlValue(value: unknown): SQL<unknown> {
  return value instanceof Date ? sqlTimestamp(value) : sql`${value}`;
}
