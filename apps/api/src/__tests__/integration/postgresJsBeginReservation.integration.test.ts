/**
 * #8143 — postgres.js 3.4.9 `connection.js` execute():
 *
 *   return write(toBuffer(q)) && !q.describeFirst && !q.cursorFn
 *     && sent.length < max_pipeline
 *     && (!q.options.onexecute || q.options.onexecute(connection))
 *
 * `onexecute` is what reserves the connection for `sql.begin()`. When BEGIN is
 * pipelined behind another query at the pipeline limit (or hits write
 * backpressure) the && chain short-circuits, `begin()` rejects with
 * "Cannot set properties of undefined (setting 'onclose')", a TypeError escapes
 * unhandled, and the connection returns to the pool INSIDE the BEGIN: later
 * bare statements share one leaked transaction. Reproduced 2026-10-08 with
 * { max: 1, max_pipeline: 1 }. Production hits it via backpressure or 100
 * pipelined queries; the test forces it with max_pipeline: 1.
 *
 * Runs against BOTH builds (see postgresJsPoolPoisoning.test.ts for why).
 */
import { createRequire } from 'node:module';
import postgresEsm from 'postgres';
import { describe, expect, it } from 'vitest';

const postgresCjs = createRequire(import.meta.url)('postgres') as typeof postgresEsm;
const APP_URL = process.env.DATABASE_URL_APP;
const describeIf = APP_URL ? describe : describe.skip;

const DRIVER_BUILDS = [
  ['esm', postgresEsm],
  ['cjs', postgresCjs],
] as const;

describeIf.each(DRIVER_BUILDS)('postgres.js (%s): BEGIN pipelined behind a busy query', (_name, postgres) => {
  it('reserves its connection, so no transaction leaks back to the pool', async () => {
    // `max_pipeline` is a real runtime option (connection.js) missing from the typings.
    const sql = postgres(APP_URL!, { max: 1, max_pipeline: 1 } as postgresEsm.Options<{}>);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await sql`select 1`;
      const bare = sql`select pg_sleep(0.2), 1 as x`;
      bare.then(() => {}, () => {});
      // Let the bare query reach the only connection first.
      await new Promise((resolve) => setImmediate(resolve));
      const tx = sql.begin(async (t) => (await t`select 2 as y`)[0]!.y as number);

      const [bareResult, txResult] = await Promise.allSettled([bare, tx]);
      expect(bareResult.status).toBe('fulfilled');
      expect(txResult).toEqual({ status: 'fulfilled', value: 2 });

      // Two bare statements must be two transactions. A leaked BEGIN freezes now().
      const first = await sql`select now()::text as n`;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await sql`select now()::text as n`;
      expect(first[0]!.n).not.toBe(second[0]!.n);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await sql.end({ timeout: 1 });
    }
  });
});
