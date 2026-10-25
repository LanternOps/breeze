/**
 * A fake Drizzle `db` for unit tests that records every query chain and lets
 * the test answer each one. Every builder method returns the same chain;
 * awaiting the chain calls `respond(op)`.
 *
 * Assertions read the recorded ops: `tableOf(op)` names the table, and
 * `render(sqlLike)` turns a recorded `where` / `set` value / `execute` SQL into
 * `{ sql, params }` through the real Postgres dialect, so a test asserts on the
 * statement the code would really send, not on mocked operator objects.
 */
import { getTableName, is, SQL, Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

export type RecordedOp = {
  kind: 'select' | 'insert' | 'update' | 'delete' | 'execute';
  /** Arguments of the opening call: select(fields) / insert(table) / update(table) / execute(sql). */
  args: unknown[];
  /** Every chained call after it, in order: [['from', [table]], ['where', [cond]], ...]. */
  chain: Array<[string, unknown[]]>;
};

export type Responder = (op: RecordedOp) => unknown;

const dialect = new PgDialect();

export function tableOf(op: RecordedOp): string | null {
  const candidate = op.kind === 'select' ? op.chain.find(([m]) => m === 'from')?.[1][0] : op.args[0];
  return candidate && is(candidate, Table) ? getTableName(candidate) : null;
}

export function chainArg(op: RecordedOp, method: string): unknown {
  return op.chain.find(([m]) => m === method)?.[1][0];
}

export function hasChain(op: RecordedOp, method: string): boolean {
  return op.chain.some(([m]) => m === method);
}

export function render(value: unknown): { sql: string; params: unknown[] } {
  if (!is(value, SQL)) throw new Error('render() expects a drizzle SQL value');
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql, params: query.params };
}

/** Lower-cased SQL text of the op's `where` (or of the executed SQL). */
export function whereText(op: RecordedOp): string {
  const value = op.kind === 'execute' ? op.args[0] : chainArg(op, 'where');
  return value ? render(value).sql.toLowerCase() : '';
}

export function whereParams(op: RecordedOp): unknown[] {
  const value = op.kind === 'execute' ? op.args[0] : chainArg(op, 'where');
  return value ? render(value).params : [];
}

export function createRecordingDb(respond: Responder) {
  const ops: RecordedOp[] = [];
  const open = (kind: RecordedOp['kind']) => (...args: unknown[]) => {
    const op: RecordedOp = { kind, args, chain: [] };
    ops.push(op);
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => respond(op))
                .then(resolve, reject);
          }
          return (...callArgs: unknown[]) => {
            op.chain.push([String(prop), callArgs]);
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return {
    ops,
    db: {
      select: open('select'),
      selectDistinct: open('select'),
      insert: open('insert'),
      update: open('update'),
      delete: open('delete'),
      execute: open('execute'),
    },
  };
}
