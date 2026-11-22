/**
 * Real statement failures for the #11203 / #11225 catch-around-a-query suites.
 * A trigger raises on writes and a renamed table fails reads, so the failure
 * comes from Postgres on the transaction under test, not from a mock.
 *
 * Both are schema changes on the worktree's own test database. Integration files
 * run one at a time (`fileParallelism: false`), and `clearStatementFaults` must
 * run in an `afterEach`.
 */
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';

const cleanups: Array<() => Promise<void>> = [];

/**
 * Make writes to `table` raise. `when` is a trigger WHEN condition, and it may
 * only name OLD when `ops` excludes INSERT.
 */
export async function failWritesOn(
  table: string,
  { ops = 'INSERT OR UPDATE', when = 'true' }: { ops?: string; when?: string } = {},
): Promise<void> {
  const name = `caught_query_fault_${table}`;
  await getTestDb().execute(sql.raw(`
    CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fault$
    BEGIN RAISE EXCEPTION 'forced statement failure on ${table}'; END
    $fault$`));
  await getTestDb().execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}`));
  await getTestDb().execute(sql.raw(`
    CREATE TRIGGER ${name} BEFORE ${ops} ON ${table}
    FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`));
  cleanups.push(async () => {
    await getTestDb().execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}`));
    await getTestDb().execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
  });
}

/** Make every statement naming `table` fail with 42P01 until the faults are cleared. */
export async function failStatementsOn(table: string): Promise<void> {
  const hidden = `${table}_caught_query_fault`;
  await getTestDb().execute(sql.raw(`ALTER TABLE ${table} RENAME TO ${hidden}`));
  cleanups.push(async () => {
    await getTestDb().execute(sql.raw(`ALTER TABLE ${hidden} RENAME TO ${table}`));
  });
}

/**
 * Run every cleanup, newest first, even when one fails (a failed rename-back must not
 * strand the faults queued behind it), then rethrow the first failure.
 */
export async function clearStatementFaults(): Promise<void> {
  const pending = cleanups.splice(0).reverse();
  let first: unknown;
  let failed = false;
  for (const cleanup of pending) {
    try {
      await cleanup();
    } catch (err) {
      if (!failed) { failed = true; first = err; }
    }
  }
  if (failed) throw first;
}
