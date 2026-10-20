import { getTableName, is, Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * A Drizzle `db` stand-in for tests that must survive a refactor which changes
 * WHICH queries run and in WHAT order (#9402 W1b). Each
 * `select(...).from(table)` resolves to the rows registered for that table's
 * name, projected onto the selected keys exactly as Drizzle would (a selected
 * key missing from the fixture row throws, so a fixture gap cannot read as
 * `undefined`). WHERE/JOIN clauses are recorded, not evaluated: the rows
 * registered for a table are what its SQL filter is assumed to return. Register
 * an `Error` for a table to make its reads reject.
 *
 * Writes throw: these tests cover read paths only.
 */
export type TableRows = readonly Record<string, unknown>[] | Error;

export interface RecordedSelect {
  table: string;
  /** The context label `contextOf()` returned when the select was awaited. */
  ctx: string;
  where: unknown;
  joins: { table: string; on: unknown }[];
}

export interface TableKeyedDb {
  db: { select: (fields?: Record<string, unknown>) => unknown; update: () => never; insert: () => never; delete: () => never };
  /** Table names read, in call order. */
  reads: string[];
  /** Every awaited select with its WHERE/JOIN arguments, in call order. */
  selects: RecordedSelect[];
}

const dialect = new PgDialect();
/** Render a recorded WHERE/ON clause to `{ sql, params }` for assertions. */
export function renderSql(clause: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(clause as Parameters<PgDialect['sqlToQuery']>[0]);
}

export function createTableKeyedDb(
  rowsByTable: () => Record<string, TableRows>,
  contextOf: () => string = () => 'none',
): TableKeyedDb {
  const reads: string[] = [];
  const selects: RecordedSelect[] = [];
  const select = (fields?: Record<string, unknown>) => {
    let table: string | null = null;
    let where: unknown;
    const joins: { table: string; on: unknown }[] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['orderBy', 'limit', 'offset', 'for', 'groupBy']) chain[m] = () => chain;
    const join = (t: unknown, on: unknown) => { joins.push({ table: is(t, Table) ? getTableName(t) : '?', on }); return chain; };
    chain.leftJoin = join;
    chain.innerJoin = join;
    chain.from = (t: unknown) => {
      if (!is(t, Table)) throw new Error('tableKeyedDb: from() needs a Drizzle table');
      table = getTableName(t);
      return chain;
    };
    chain.where = (w: unknown) => { where = w; return chain; };
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve().then(() => {
        if (!table) throw new Error('tableKeyedDb: select awaited without from()');
        reads.push(table);
        selects.push({ table, ctx: contextOf(), where, joins });
        const rows = rowsByTable()[table] ?? [];
        if (rows instanceof Error) throw rows;
        if (!fields) return rows.map((r) => ({ ...r }));
        return rows.map((r) => Object.fromEntries(Object.keys(fields).map((k) => {
          if (!(k in r)) throw new Error(`tableKeyedDb: fixture row for ${table} has no "${k}"`);
          return [k, r[k]];
        })));
      }).then(resolve, reject);
    return chain;
  };
  const refuse = (): never => { throw new Error('tableKeyedDb: unexpected write'); };
  return { db: { select, update: refuse, insert: refuse, delete: refuse }, reads, selects };
}
