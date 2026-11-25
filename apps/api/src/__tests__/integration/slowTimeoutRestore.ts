import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { getTestDb } from './setup';

interface Executor { execute: (query: SQL) => PromiseLike<unknown> }

/**
 * Makes the NEXT unqualified `set_config` on a transaction take 2 s, so the
 * statement that restores `statement_timeout` outruns the limit in force and
 * Postgres itself cancels it (#12656). Call `slow` inside the bounded callback,
 * after its last read: it puts a schema holding a slow `set_config` ahead of
 * `pg_catalog` on that transaction's search_path.
 */
export async function withSlowTimeoutRestore<T>(fn: (slow: (executor: Executor) => Promise<void>) => Promise<T>): Promise<T> {
  const schema = `slow_restore_${randomUUID().replaceAll('-', '')}`;
  const admin = getTestDb();
  await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
  try {
    await admin.execute(sql.raw(`
      CREATE FUNCTION ${schema}.set_config(text, text, boolean) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_catalog.pg_sleep(2);
        RETURN pg_catalog.set_config($1, $2, $3);
      END $$`));
    await admin.execute(sql.raw(`GRANT USAGE ON SCHEMA ${schema} TO breeze_app`));
    await admin.execute(sql.raw(`GRANT EXECUTE ON FUNCTION ${schema}.set_config(text, text, boolean) TO breeze_app`));
    return await fn(async (executor) => {
      await executor.execute(sql`select pg_catalog.set_config('search_path', ${`${schema}, pg_catalog, public`}, true)`);
    });
  } finally {
    await admin.execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
  }
}
