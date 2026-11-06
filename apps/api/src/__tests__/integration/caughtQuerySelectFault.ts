/**
 * A SELECT cannot be failed by a trigger, and renaming a table is unsafe when
 * RLS functions read it (organizations). This wraps `db.select` so a select
 * whose field map names `key` runs `SELECT 1/0` on the current transaction
 * instead, which is a real statement failure on whatever scope it is called in.
 *
 * Use from a test file:
 *   vi.mock('../../db', async (importOriginal) => {
 *     const actual = await importOriginal<typeof import('../../db')>();
 *     const { faultingDb } = await import('./caughtQuerySelectFault');
 *     return { ...actual, db: faultingDb(actual.db) };
 *   });
 */
import { sql } from 'drizzle-orm';

export const selectFault = {
  key: null as string | null,
  /** Only fail a select issued from a call stack naming this (a source file), else any caller. */
  caller: null as string | null,
  /** Stop failing after this many matching selects (null: fail every one). */
  maxHits: null as number | null,
  /** How many matching selects were failed, so a case cannot pass by never reaching it. */
  hits: 0,
};

export function resetSelectFault(): void {
  selectFault.key = null;
  selectFault.caller = null;
  selectFault.maxHits = null;
  selectFault.hits = 0;
}

export function faultingDb<T extends object>(actual: T): T {
  const failingQuery = () => {
    // Bound at call time, like a real query builder, so it lands on the scope
    // the caller is in (inside a savepoint when there is one).
    const query = (actual as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(sql`SELECT 1/0`);
    const chain: unknown = new Proxy(function noop() {}, {
      get: (_target, prop) => (prop === 'then'
        ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => query.then(resolve, reject)
        : () => chain),
    });
    return chain;
  };
  return new Proxy(actual, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (prop !== 'select') return value;
      return (fields?: Record<string, unknown>) => {
        if (selectFault.key && fields && selectFault.key in fields
          && (selectFault.maxHits === null || selectFault.hits < selectFault.maxHits)
          && (!selectFault.caller || (new Error().stack ?? '').includes(selectFault.caller))) {
          selectFault.hits += 1;
          return failingQuery();
        }
        return (value as (f?: unknown) => unknown).call(target, fields);
      };
    },
  });
}
