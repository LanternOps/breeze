/**
 * #8143 — postgres.js 3.4.9 `connection.js` execute():
 *
 *   return write(toBuffer(q)) && !q.describeFirst && !q.cursorFn
 *     && sent.length < max_pipeline
 *     && (!q.options.onexecute || q.options.onexecute(connection))
 *
 * `onexecute` is what reserves the connection for `sql.begin()`. When BEGIN is
 * pipelined behind another query at the pipeline limit (or hits write
 * backpressure) the && chain short-circuits and the connection is never
 * reserved. What happens next depends on the pool size:
 *
 * - max: 1 — `begin()` rejects with "Cannot set properties of undefined
 *   (setting 'onclose')" and a TypeError escapes unhandled.
 * - max > 1 (production: DB_POOL_MAX defaults to 30) — CommandComplete's guard
 *   (`result.command === 'BEGIN' && max !== 1 && !connection.reserved`) fails
 *   the BEGIN with UNSAFE_TRANSACTION, so `begin()` rejects.
 *
 * In BOTH cases the server already ran the BEGIN, and the connection returns
 * to the pool INSIDE that transaction: later bare statements on it share one
 * leaked transaction. Reproduced 2026-10-08 with { max: 1, max_pipeline: 1 }
 * and { max: 2, max_pipeline: 1 }. Production reaches it via write
 * backpressure or 100 pipelined queries; the tests force it with
 * max_pipeline: 1.
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

  it('max > 1 (the UNSAFE_TRANSACTION path): BEGIN queued behind two busy connections still reserves', async () => {
    const sql = postgres(APP_URL!, { max: 2, max_pipeline: 1 } as postgresEsm.Options<{}>);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // Open both connections first. While they are still connecting, a queued
      // BEGIN is handed to a fresh socket with an empty pipeline and never
      // reaches the short-circuit.
      await Promise.all([sql`select pg_sleep(0.05)`, sql`select pg_sleep(0.05)`]);
      // Both connections busy, each at its pipeline limit, so BEGIN is queued
      // and then pipelined onto whichever connection frees up first.
      const busy = [sql`select pg_sleep(0.2), 1 as x`, sql`select pg_sleep(0.2), 1 as x`];
      for (const q of busy) q.then(() => {}, () => {});
      await new Promise((resolve) => setImmediate(resolve));
      const tx = sql.begin(async (t) => (await t`select 2 as y`)[0]!.y as number);

      const settled = await Promise.allSettled([...busy, tx]);
      expect(settled.slice(0, 2).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(settled[2]).toEqual({ status: 'fulfilled', value: 2 });

      // Two bare statements must be two transactions. A leaked BEGIN freezes
      // now() and txid on whichever connection carries it, so sample both
      // pool connections (concurrent pair), twice, >= 50 ms apart.
      const sample = () => Promise.all([0, 1].map(() =>
        sql<Array<{ n: string; txid: string }>>`select now()::text as n, txid_current()::text as txid, pg_sleep(0.02)`));
      const first = await sample();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await sample();
      const rows = [...first, ...second].map((r) => r[0]!);
      expect(new Set(rows.map((r) => r.txid)).size).toBe(rows.length);
      // now() across the 50 ms gap only: two concurrent statements on different
      // backends can legitimately share a microsecond.
      const earlier = new Set(first.map((r) => r[0]!.n));
      for (const r of second) expect(earlier.has(r[0]!.n)).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await sql.end({ timeout: 1 });
    }
  });
});

/**
 * #8143 — the reconnect after a backend dies INSIDE `sql.begin()` (what the
 * wedged-backend reclaimer does). Two breeze patch hunks, both builds:
 *
 * (a) execute() on a connection whose socket is already gone. `begin()` issues
 *     its ROLLBACK there; upstream buffered it and threw from the write
 *     Immediate (uncaughtException), leaving `chunk`/`nextWriteTimer` set, so
 *     the reconnect's StartupMessage was never flushed: the next query hung
 *     until connect_timeout.
 * (b) closed() keeps no per-socket protocol state. The dead backend's FATAL
 *     57P01 left `errorResponse`/`query` set, and the FIRST query on the new
 *     socket was rejected with it.
 */
describeIf.each(DRIVER_BUILDS)('postgres.js (%s): backend terminated inside a transaction', (_name, postgres) => {
  it('reconnects promptly, and the next query neither hangs nor inherits the dead backend\'s 57P01', async () => {
    const sql = postgres(APP_URL!, { max: 1, connect_timeout: 10 });
    const admin = postgres(APP_URL!, { max: 1 });
    const uncaught: unknown[] = [];
    const saved = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', (err) => uncaught.push(err));
    try {
      await sql`select 1`;
      const tx = sql.begin(async (t) => {
        const pid = (await t<Array<{ pid: number }>>`select pg_backend_pid() as pid`)[0]!.pid;
        const sleeping = t`select pg_sleep(5)`;
        // Let the sleep reach the backend, then kill it from outside.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await admin`select pg_terminate_backend(${pid})`;
        await sleeping; // rejects; the error propagates, so begin() issues ROLLBACK
      });
      await expect(tx).rejects.toBeDefined();
      // Give the ROLLBACK's write Immediate its turn (where upstream threw).
      await new Promise((resolve) => setTimeout(resolve, 50));

      const startedAt = Date.now();
      const next = await Promise.race([
        sql`select 7 as x`.then(
          (rows) => ({ ok: true as const, x: rows[0]!.x as number }),
          (err: { code?: string; message?: string }) => ({ ok: false as const, code: err.code, message: err.message }),
        ),
        new Promise<{ ok: false; code: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, code: 'HUNG_PAST_3S' }), 3_000)),
      ]);
      // (a): without it this is HUNG_PAST_3S. (b): without it, code 57P01.
      expect(next).toEqual({ ok: true, x: 7 });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(uncaught).toEqual([]);
    } finally {
      process.removeAllListeners('uncaughtException');
      for (const listener of saved) process.on('uncaughtException', listener);
      await sql.end({ timeout: 1 });
      await admin.end({ timeout: 1 });
    }
  });
});
