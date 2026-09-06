/**
 * Normalize a timestamp that came out of a raw `sql\`...\`` expression.
 *
 * Drizzle maps typed columns (`timestamp(...)`) to `Date`, but a raw fragment —
 * `max(completed_at)`, a correlated `select installed_at ... limit 1` — is handed
 * back by postgres-js as the server's text form (`2026-09-02 09:00:00+00`, or
 * `2026-09-01 00:00:00` for a column WITHOUT time zone). Annotating such a
 * fragment `sql<Date>` is a lie the compiler cannot catch and unit tests (which
 * mock Date rows) never exercise; against a real database `.toISOString()`
 * throws and `Intl.DateTimeFormat.format()` raises `RangeError: Invalid time
 * value`. Both shipped in #4562 (W06, W07) and were caught by the portal QA
 * walk. Route every raw timestamp through here.
 *
 * A value without a zone designator is read as UTC — the same rule Drizzle's
 * `timestamp` column mapper applies (`new Date(value + '+0000')`) — so the
 * result does not depend on the API process's local zone.
 */
// `2026-09-02 09:00:00[.123][+00|+00:00|Z]` or the ISO `T` form. Anything else
// is refused up front: V8's legacy Date parser is lenient enough to turn junk
// into a real date, so a NaN check alone is not a guard.
const TIMESTAMP_SHAPE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?<zone>Z|[+-]\d{2}(?::?\d{2})?)?$/i;

export function sqlTimestamp(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const match = TIMESTAMP_SHAPE.exec(value);
  if (!match) {
    throw new TypeError(`sqlTimestamp: unparseable timestamp ${JSON.stringify(value)}`);
  }
  const date = new Date(match.groups?.zone ? value : `${value}+0000`);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`sqlTimestamp: unparseable timestamp ${JSON.stringify(value)}`);
  }
  return date;
}
