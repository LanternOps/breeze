import { sql } from 'drizzle-orm';

/**
 * Postgres stores `lock_timeout` / `statement_timeout` as int4 milliseconds, so
 * this is their documented maximum. A bound above it passes every JavaScript
 * check and then fails inside `set_config`, i.e. at the point where the caller
 * has already decided it is protected.
 */
const PG_MAX_TIMEOUT_MS = 2147483647;

/**
 * Read `prior_ms` out of a driver result.
 *
 * Handles BOTH supported shapes: a postgres-js `Result` (array-like) and a
 * node-postgres `{ rows: [...] }`. Accepting only the array made a perfectly
 * readable node-pg result look "unrecoverable", which matters because the
 * catalog caller THROWS on null — it would have turned a parseable result into
 * a 500. The device-deletion suite already exercises the `{rows}` shape.
 *
 * Returns null when the value is absent, not a whole number, or outside the
 * range Postgres can actually hold (negative, or above int4 milliseconds) —
 * i.e. whenever a confident number would be a fabricated one.
 */
function readPriorMs(result: unknown): number | null {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { rows?: unknown })?.rows)
      ? (result as { rows: unknown[] }).rows
      : null;
  const raw = (rows?.[0] as { prior_ms?: unknown } | undefined)?.prior_ms;
  // Range-check every shape identically. A bare `Number.isInteger` accepts -1,
  // and `Number('9007199254740993')` silently ROUNDS to ...992 — both would
  // return a confident wrong timeout instead of the null that means "could not
  // read it". A real Postgres timeout is a non-negative int4 ms value, so
  // anything outside that is a malformed result, not a value.
  const inRange = (n: number): number | null =>
    Number.isInteger(n) && n >= 0 && n <= PG_MAX_TIMEOUT_MS ? n : null;
  if (typeof raw === 'number') return inRange(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return inRange(Number(raw));
  // `bigint`: `pg_settings.setting::bigint` is int8, and a node-postgres
  // installation with an int8 parser (or a future postgres-js transform) hands
  // it over as a bigint. Rejecting it would report a value that is present and
  // exact as unreadable — and the catalog caller THROWS on null, turning a
  // perfectly good result into a 500. Timeout values are milliseconds, so the
  // safe-integer range is never a real constraint; bail rather than round.
  if (typeof raw === 'bigint') {
    return raw >= 0n && raw <= BigInt(PG_MAX_TIMEOUT_MS) ? Number(raw) : null;
  }
  return null;
}

/**
 * Reject a bound that would not actually bound anything.
 *
 * `boundMs = 0` is the trap: Postgres reads 0 as "disable this timeout", so the
 * never-widen CASE below (`prior.ms > boundMs`) is then true for every finite
 * NON-ZERO prior value — and a prior of 0 already takes the other arm — so the
 * helper would set `'0ms'` either way — silently converting a caller's 500ms
 * limit into an unbounded wait, which is the exact failure these helpers exist
 * to prevent. Both are exported and take an unrestricted `number`, so this is
 * enforced at runtime rather than left to callers.
 */
function assertPositiveBound(boundMs: number, fn: string): void {
  if (!Number.isInteger(boundMs) || boundMs <= 0 || boundMs > PG_MAX_TIMEOUT_MS) {
    throw new Error(`${fn}: boundMs must be an integer in 1..${PG_MAX_TIMEOUT_MS} ms (got ${boundMs})`);
  }
}

/**
 * Tighten `lock_timeout` for the current transaction, and report what it was.
 *
 * NOTE the limitation, which matters whenever a single statement takes MORE
 * THAN ONE lock: `lock_timeout` applies to each lock acquisition attempt
 * separately, not as a deadline for the statement. Measured on Postgres 16 — a
 * two-row `ORDER BY id FOR UPDATE` under `lock_timeout='1000ms'`, with the two
 * rows blocked by staggered holders, ran 1214ms and SUCCEEDED. For a statement
 * that locks N rows, use {@link tightenStatementTimeout} as well, or the
 * effective ceiling is N x the bound.
 *
 * One statement, entirely in SQL. `pg_settings.setting` for `lock_timeout` is a
 * plain INTEGER of milliseconds (verified on Postgres 16: `0`, `250`, `7000`,
 * always unit `ms`), unlike `current_setting`, which renders `250ms` / `3s` /
 * `2min` and would have to be unit-parsed on the client. Doing the comparison
 * in SQL removes that parser and the failure mode it created: a caller that
 * could not decode the prior value had to choose between aborting work that may
 * already have had irreversible side effects, and proceeding on an UNBOUNDED
 * wait that pins a pooled connection. This always leaves the timeout bounded,
 * so neither branch can arise.
 *
 * `ms = 0` is Postgres's "disable the timeout", i.e. infinitely loose, so it is
 * always worth tightening. A caller already stricter than `boundMs` keeps its
 * own value: this must never WIDEN a stricter caller, because `SET LOCAL` lasts
 * for the rest of the outer transaction.
 *
 * Extracted so the invariant lives once — it is used by the device cascade and
 * by catalog bundle composition, and "never widen, restore only on success" is
 * the kind of rule that rots when copied.
 *
 * @returns the caller's prior value in ms, or null if it could not be read.
 *   Null does NOT mean unbounded: the bound has already been applied by the
 *   same statement. It only means the caller's original value cannot be
 *   restored afterwards, and leaving the tighter bound in force is the safe
 *   direction.
 */
export async function tightenLockTimeout(
  tx: { execute(q: unknown): Promise<unknown> },
  boundMs: number
): Promise<number | null> {
  assertPositiveBound(boundMs, 'tightenLockTimeout');
  const tightened = await tx.execute(sql`
    WITH prior AS (SELECT setting::bigint AS ms FROM pg_settings WHERE name = 'lock_timeout')
    SELECT prior.ms AS prior_ms,
           set_config(
             'lock_timeout',
             (CASE WHEN prior.ms = 0 OR prior.ms > ${boundMs} THEN ${boundMs} ELSE prior.ms END)::text || 'ms',
             true
           ) AS applied
    FROM prior
  `);
  return readPriorMs(tightened);
}

/**
 * True when {@link tightenLockTimeout} actually changed the setting — i.e. the
 * caller's value was 0 (disabled) or looser than the bound. Only then is there
 * anything to put back; re-issuing a stricter caller's own value is a wasted
 * round trip.
 */
export function lockTimeoutWasChanged(priorMs: number | null, boundMs: number): boolean {
  return priorMs !== null && (priorMs === 0 || priorMs > boundMs);
}

/**
 * Tighten `statement_timeout` for the current transaction, and report what it
 * was. Same never-widen / restore-on-success discipline as
 * {@link tightenLockTimeout}.
 *
 * This is the one that actually bounds a multi-lock statement: unlike
 * `lock_timeout`, it is a deadline for the whole statement, so a run of
 * staggered blockers cannot each buy another full interval. Its cancellation
 * raises SQLSTATE 57014 (`query_canceled`), not 55P03.
 *
 * Restore it as soon as the statement it guards has finished — left in force it
 * governs every later statement in the caller's transaction, which is a much
 * broader promise than intended.
 */
export async function tightenStatementTimeout(
  tx: { execute(q: unknown): Promise<unknown> },
  boundMs: number
): Promise<number | null> {
  assertPositiveBound(boundMs, 'tightenStatementTimeout');
  const tightened = await tx.execute(sql`
    WITH prior AS (SELECT setting::bigint AS ms FROM pg_settings WHERE name = 'statement_timeout')
    SELECT prior.ms AS prior_ms,
           set_config(
             'statement_timeout',
             (CASE WHEN prior.ms = 0 OR prior.ms > ${boundMs} THEN ${boundMs} ELSE prior.ms END)::text || 'ms',
             true
           ) AS applied
    FROM prior
  `);
  return readPriorMs(tightened);
}

