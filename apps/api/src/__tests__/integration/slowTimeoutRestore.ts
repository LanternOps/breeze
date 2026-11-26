import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { getTestDb } from './setup';

interface Executor { execute: (query: SQL) => PromiseLike<unknown> }

/**
 * Makes the next unqualified `set_config('statement_timeout', …)` on a
 * transaction take 2 s, so a restore of `statement_timeout` made that way would
 * outrun the limit in force and Postgres itself would cancel it (#12656). Call
 * `slow` inside the bounded callback, after its last read: it puts a schema
 * holding a slow `set_config` first on that transaction's search_path, armed
 * by a transaction-local setting and disarmed by its first `statement_timeout`
 * call (a rollback reverts both). Other settings, and the calls after that
 * one, go through untouched, so statements after a check that stood are not
 * slowed. `withFilterStatementTimeout` restores the limit with `SET LOCAL`,
 * which calls no function, so it must not be slowed by this (#12715).
 */
export async function withSlowTimeoutRestore<T>(fn: (slow: (executor: Executor) => Promise<void>) => Promise<T>): Promise<T> {
  const schema = `slow_restore_${randomUUID().replaceAll('-', '')}`;
  const armed = `${schema}.armed`;
  const admin = getTestDb();
  await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
  try {
    await admin.execute(sql.raw(`
      CREATE FUNCTION ${schema}.set_config(text, text, boolean) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        IF $1 = 'statement_timeout' AND pg_catalog.current_setting('${armed}', true) = 'on' THEN
          PERFORM pg_catalog.set_config('${armed}', 'off', true);
          PERFORM pg_catalog.pg_sleep(2);
        END IF;
        RETURN pg_catalog.set_config($1, $2, $3);
      END $$`));
    await admin.execute(sql.raw(`GRANT USAGE ON SCHEMA ${schema} TO breeze_app`));
    await admin.execute(sql.raw(`GRANT EXECUTE ON FUNCTION ${schema}.set_config(text, text, boolean) TO breeze_app`));
    return await fn(async (executor) => {
      await executor.execute(sql`select pg_catalog.set_config(${armed}, 'on', true)`);
      await executor.execute(sql`select pg_catalog.set_config('search_path', ${`${schema}, pg_catalog, public`}, true)`);
    });
  } finally {
    await admin.execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
  }
}
