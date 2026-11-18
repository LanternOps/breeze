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

/** One-shot: the next `db.execute` whose SQL text contains `match` runs `SELECT 1/0` instead. */
export const executeFault = { match: null as string | null, hits: 0 };

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<{ value?: unknown } | string> } | null)?.queryChunks ?? [];
  return chunks.map((c) => (typeof c === 'string' ? c : Array.isArray(c?.value) ? c.value.join('') : '')).join('');
}

export function resetSelectFault(): void {
  executeFault.match = null;
  executeFault.hits = 0;
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
      if (prop === 'execute') {
        return (query: unknown, ...rest: unknown[]) => {
          if (executeFault.match && executeFault.hits === 0 && sqlText(query).includes(executeFault.match)) {
            executeFault.hits += 1;
            return (value as (q: unknown, ...r: unknown[]) => unknown).call(target, sql`SELECT 1/0`);
          }
          return (value as (q: unknown, ...r: unknown[]) => unknown).call(target, query, ...rest);
        };
      }
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
