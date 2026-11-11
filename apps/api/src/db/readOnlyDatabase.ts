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
 * row array itself; other drivers wrap it in `{ rows }`. The query always
 * yields one row with a text `ro`, so any other shape throws: the readiness
 * evaluator then reports a probe failure instead of quietly reading it as
 * "writable".
 */
export function isReadOnlyProbeResult(result: unknown): boolean {
  const rows = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null | undefined)?.rows;
  const ro = Array.isArray(rows) ? (rows[0] as { ro?: unknown } | undefined)?.ro : undefined;
  if (typeof ro !== 'string') {
    throw new Error('transaction_read_only probe returned an unexpected result shape');
  }
  return ro === 'on';
}

/** True for Postgres's "cannot execute <command> in a read-only transaction". */
export function isReadOnlySqlError(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === '25006';
}
