import { sql } from 'drizzle-orm';

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
  const row = Array.isArray(tightened)
    ? (tightened[0] as { prior_ms?: unknown } | undefined)
    : undefined;
  const raw = row?.prior_ms;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
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
  const row = Array.isArray(tightened)
    ? (tightened[0] as { prior_ms?: unknown } | undefined)
    : undefined;
  const raw = row?.prior_ms;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

/** SQLSTATEs meaning "we gave up waiting", from either bound above. */
export const LOCK_WAIT_ABORT_CODES = new Set(['55P03', '57014']);
