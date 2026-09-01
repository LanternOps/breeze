/**
 * Detect a Postgres unique-violation (SQLSTATE 23505) from a thrown error.
 *
 * postgres.js raises a `PostgresError` with `.code === '23505'` (and a
 * `.constraint`), but Drizzle wraps it in a `DrizzleQueryError` whose own
 * `.code`/`.constraint` are undefined — the real fields live on `.cause`.
 * Checks that only read the top-level `err.code` therefore miss every
 * Drizzle-issued insert/update and leak a raw 500 instead of mapping the
 * conflict to a friendly error. This walks the `.cause` chain so both shapes
 * are handled.
 *
 * @param constraint  When given, only matches that specific unique index.
 *   If the driver surfaced a constraint name we compare it exactly; if it
 *   didn't (some wrappers drop it), we fall back to scanning the error message
 *   for the constraint name.
 */
export function isPgUniqueViolation(err: unknown, constraint?: string): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    const e = cur as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown };
    if (e.code === '23505') {
      if (!constraint) return true;
      // postgres.js surfaces the index as `constraint_name`; node-postgres uses
      // `constraint`. Fall back to a message scan only if neither is present.
      const name = typeof e.constraint_name === 'string' ? e.constraint_name
        : typeof e.constraint === 'string' ? e.constraint : undefined;
      if (name !== undefined) return name === constraint;
      return typeof e.message === 'string' && e.message.includes(constraint);
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Returns the Postgres SQLSTATE (e.g. '23505', '23503', '22P02') from a thrown
 * error, unwrapping the DrizzleQueryError `.cause` chain. Use for error mappers
 * that branch on several codes; for a simple unique check prefer
 * {@link isPgUniqueViolation}. Returns undefined if no SQLSTATE is found.
 */
/**
 * Returns the error object that actually carries the SQLSTATE, unwrapping the
 * DrizzleQueryError `.cause` chain — so `code`, `detail`, `table_name`,
 * `constraint_name` and friends are all read from the SAME node.
 *
 * Use this instead of {@link pgErrorCode} whenever the handler needs more than
 * the code. Unwrapping only the code and then reading `detail` off the OUTER
 * error yields a blank detail on every Drizzle-issued statement, which is how a
 * mapper ends up returning "related records in undefined".
 */
export function pgErrorNode(err: unknown): Record<string, unknown> | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    if (typeof (cur as { code?: unknown }).code === 'string') {
      return cur as Record<string, unknown>;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * 40P01 = deadlock_detected, 40001 = serialization_failure, 55P03 =
 * lock_not_available. All three mean "you lost a lock race, the work was not
 * applied, try again" — never "the request was invalid". Postgres picks a
 * victim (40P01/40001) or gives up at a `lock_timeout` bound (55P03) and the
 * winner finishes immediately after, so the retry almost always succeeds.
 *
 * 55P03 is a no-op for every EXISTING caller of this function: Postgres can
 * only raise it where a `lock_timeout` is actually set, and until #3925 none
 * of this codebase's transactions set one, so no caller could have observed
 * it before. Adding it here only starts mattering once a caller starts
 * bounding its own lock waits (see `tightenLockTimeout` in `../db/lockTimeout`).
 */
export function isTransientLockError(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code === '40P01' || code === '40001' || code === '55P03';
}

/**
 * Re-run `fn` when it fails with a transient lock error (see
 * {@link isTransientLockError}). Anything else propagates untouched on the
 * first throw.
 *
 * Why this exists: the agent software-inventory ingest dropped ~4k reports in
 * six days because a deadlock (BREEZE-3) propagated straight to the global
 * error handler as a 500 and the whole report was discarded. Correct lock
 * ordering is the primary fix; this is the belt-and-braces for the remaining
 * writers of the same rows, because losing a lock race should cost a retry,
 * not an entire inventory report.
 *
 * IMPORTANT — `fn` must own a transaction boundary that the victim's rollback
 * actually reaches. Exactly two shapes qualify:
 *
 *  1. A NESTED drizzle transaction (one running inside a request-long
 *     `withDbAccessContext`, which drizzle emits as a SAVEPOINT) — it rolls
 *     back to its savepoint and leaves the outer transaction usable. See
 *     dbSavepointErrorIsolation.integration.test.ts for the isolation proof.
 *     Example: the software-inventory ingest in routes/agents/inventory.ts.
 *  2. A TOP-LEVEL transaction opened by `fn` itself from OUTSIDE any held
 *     context (e.g. `retryOnTransientLockError(..., () => correlateOrg(orgId))`
 *     in jobs/vulnerabilityJobs.ts, where each call opens its own
 *     withSystemDbAccessContext) — the victim has fully rolled back, so the
 *     retry starts clean.
 *
 * What must NEVER be wrapped is a bare statement whose failure aborted an
 * enclosing transaction the retry cannot escape: every follow-up then fails
 * with 25P02 until that transaction ends, and the retries are pure noise.
 */
export async function retryOnTransientLockError<T>(
  label: string,
  fn: () => Promise<T>,
  options: { attempts?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientLockError(error)) throw error;
      lastError = error;
      // Log every lost race, including the final one. A silent retry would hide
      // a lock-ordering regression: the symptom would shrink to added latency
      // with nothing in Sentry to explain it.
      console.warn(
        `[${label}] transient lock error ${pgErrorCode(error)} on attempt ${attempt}/${attempts}`
        + (attempt < attempts ? ' — retrying' : ' — giving up'),
      );
    }
  }

  throw lastError;
}
