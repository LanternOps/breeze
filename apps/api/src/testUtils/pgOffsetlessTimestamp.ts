/**
 * Build the Date that postgres.js ACTUALLY hands back for a `timestamp without
 * time zone` column holding a given instant.
 *
 * Tests that fabricate a DB timestamp as `new Date(Date.now() - 60_000)` are
 * unfaithful: that Date carries the true instant, whereas a Date that came off
 * the wire from an offsetless column carries the UTC wall clock re-read as
 * LOCAL time. The two are identical only when the host runs UTC — which is why
 * a whole class of timezone defect can sit under a fully green suite on CI (UTC
 * containers) and be 100% broken on a US developer's machine.
 *
 * The simulation is exactly the driver's own path:
 *   1. Postgres emits the UTC wall clock with no zone marker
 *      (`2026-08-25 18:34:15.123`), because the column has no offset to send.
 *   2. postgres.js parses OIDs 1082/1114/1184 with a bare `new Date(x)`
 *      (postgres/src/types.js) — no UTC hint.
 *   3. V8 reads an offsetless date-time as local time.
 *   4. Drizzle's UTC-correct path (`value + '+0000'`) never fires, because it
 *      is guarded on `typeof value === 'string'` and postgres.js already
 *      produced a Date.
 *
 * Verified against a live Postgres 16 through the real postgres.js client: for
 * one instant, `.getTime()` came back +6h under America/Denver, -2h under
 * Europe/Berlin, and exact under UTC.
 *
 * Pair this with `utcMsFromOffsetlessTimestamp` (services/sso.ts), which is the
 * production-side inverse.
 */
export function pgOffsetlessTimestamp(trueUtcMs: number): Date {
  // '2026-08-25T18:34:15.123Z' -> '2026-08-25 18:34:15.123'
  const wire = new Date(trueUtcMs).toISOString().slice(0, 23).replace('T', ' ');
  // Offsetless, so V8 applies the host's local zone — exactly as the driver does.
  return new Date(wire);
}
