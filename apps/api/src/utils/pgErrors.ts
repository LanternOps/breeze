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
export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
