import { getTableName, is, Table } from 'drizzle-orm';

/**
 * A Drizzle `db` stand-in for characterization tests that must survive a
 * refactor which changes WHICH queries run and in WHAT order (#9402 W1b). Each
 * `select(...).from(table)` resolves to the rows registered for that table's
 * name, projected onto the selected keys exactly as Drizzle would (a selected
 * key missing from the fixture row throws, so a fixture gap cannot read as
 * `undefined`). WHERE/JOIN clauses are recorded, not evaluated: the rows
 * registered for a table are what its SQL filter is assumed to return.
 *
 * Writes throw: these pins cover read paths only.
 */
export interface TableKeyedDb {
  db: { select: (fields?: Record<string, unknown>) => unknown; update: () => never; insert: () => never; delete: () => never };
  /** Table names read, in call order. */
  reads: string[];
  /** The `where()` argument of each select, in call order, with its table. */
  wheres: { table: string; where: unknown }[];
}

export function createTableKeyedDb(rowsByTable: () => Record<string, readonly Record<string, unknown>[]>): TableKeyedDb {
  const reads: string[] = [];
  const wheres: { table: string; where: unknown }[] = [];
  const select = (fields?: Record<string, unknown>) => {
    let table: string | null = null;
    const chain: Record<string, unknown> = {};
    for (const m of ['leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset', 'for', 'groupBy']) chain[m] = () => chain;
    chain.from = (t: unknown) => {
      if (!is(t, Table)) throw new Error('tableKeyedDb: from() needs a Drizzle table');
      table = getTableName(t);
      reads.push(table);
      return chain;
    };
    chain.where = (w: unknown) => { wheres.push({ table: table ?? '?', where: w }); return chain; };
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve().then(() => {
        if (!table) throw new Error('tableKeyedDb: select awaited without from()');
        const rows = rowsByTable()[table] ?? [];
        if (!fields) return rows.map((r) => ({ ...r }));
        return rows.map((r) => Object.fromEntries(Object.keys(fields).map((k) => {
          if (!(k in r)) throw new Error(`tableKeyedDb: fixture row for ${table} has no "${k}"`);
          return [k, r[k]];
        })));
      }).then(resolve, reject);
    return chain;
  };
  const refuse = (): never => { throw new Error('tableKeyedDb: unexpected write'); };
  return { db: { select, update: refuse, insert: refuse, delete: refuse }, reads, wheres };
}
