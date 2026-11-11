/**
 * Read-only database handling (#11731).
 *
 * A managed Postgres can be switched to `default_transaction_read_only = on`
 * by its provider (storage exhaustion is the common trigger), and a
 * DATABASE_URL pointed at a hot standby behaves the same way. Reads keep
 * working; every write and every DDL statement fails with SQLSTATE 25006
 * (`read_only_sql_transaction`), including idempotent ones such as
 * `CREATE TABLE IF NOT EXISTS`.
 */

/**
 * The database cannot accept a write that startup needs. Thrown instead of the
 * raw 25006 so the operator reads what is wrong and what to do about it.
 */
export class ReadOnlyDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlyDatabaseError';
  }
}

/**
 * Readiness probe text. `transaction_read_only` is `on` both for a database or
 * role default of `default_transaction_read_only = on` and on a hot standby.
 */
export const TRANSACTION_READ_ONLY_PROBE_SQL = "select current_setting('transaction_read_only') as ro";

/**
 * Interpret the probe's result. Drizzle's postgres-js `execute` returns the
 * row array itself; other drivers wrap it in `{ rows }`. Anything unexpected
 * reads as "not read-only" rather than inventing a degraded state.
 */
export function isReadOnlyProbeResult(result: unknown): boolean {
  const rows = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null | undefined)?.rows;
  if (!Array.isArray(rows)) return false;
  return (rows[0] as { ro?: unknown } | undefined)?.ro === 'on';
}
